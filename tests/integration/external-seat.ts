import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import { prepareRun } from "../../packages/arena-runner/src/prepare.js";
import { runPreparedRun } from "../../packages/arena-runner/src/runtime/run.js";
import type { RunPreparedRunOptions } from "../../packages/arena-runner/src/runtime/run.js";
import type { ClockPayload } from "../../packages/arena-runner/src/control/types.js";
import { assertCompletedMatchOutcome } from "./support/match-rules-authority.js";
import { competitorForSeat, waitForActivePhase } from "./support/duel.js";
import {
  attemptConnection,
  engage,
  ExternalSurrogate,
  waitUntil,
  type ConnectionAttempt,
  type GameAddress,
} from "./support/external-surrogate.js";
import type { AcceptanceRunContext } from "./support/owned-run.js";
import { inspectOwnedAcceptanceRun } from "./support/owned-run.js";

const USERNAME = "ExtSeat_A";
const FIXTURE_DIRECTORY = ".work/tmp/external-seat-fixture";
const ROW_TIMEOUT_MS = 420_000;
const ELIMINATION_TIMEOUT_MS = 10_000;
const PORT = 25565;

type Seats = 2 | 3;

interface StackPaths {
  readonly helperPath: string;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
}

interface MatchRow {
  readonly name: string;
  readonly seats: Seats;
  readonly username?: string;
  readonly joinTimeoutMs?: number;
  readonly signal: AbortSignal;
  readonly onPhase?: (phase: ClockPayload["phase"]) => void;
  readonly onRosterReady?: (address: GameAddress, attempts: ConnectionAttempt[]) => void;
  readonly evaluate?: (
    active: AcceptanceRunContext,
    signal: AbortSignal,
    surrogate: () => Promise<ExternalSurrogate>,
    address: GameAddress,
  ) => Promise<void>;
}

test("external-seat", { timeout: 3_600_000 }, async (t) => {
  const fixtures = writeFixtures();

  await t.test("surrogate occupies one competitive seat, loots, damages its opponent and wins", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const result = await playMatch(fixtures, {
      name: "win",
      seats: 2,
      signal: row.signal,
      evaluate: async (active, signal, surrogate) => {
        assert.deepStrictEqual(active.prepare.payload.roster.map(({ kind }) => kind), ["external", "bot"]);
        assert.ok("roster_version" in active.prepare.payload && active.prepare.payload.roster_version === 2);
        assert.deepStrictEqual(active.competitors.map(({ seat }) => seat), [1], "the runner owns only the bot seat");
        const external = active.prepare.payload.roster[0]!;
        const player = await surrogate();
        assert.equal(player.bot.username, external.username);
        assert.equal(player.bot.player.uuid, external.offline_uuid);

        await active.start();
        await waitForActivePhase(active, signal);
        assert.ok((await player.lootNearestChest(signal)).length > 0);
        const opponent = competitorForSeat(active, 1);
        await player.strike(opponent.identity.username, signal, () => hasElimination(active, 1, "death"));
        assert.ok(opponent.bot.health < 20 || hasElimination(active, 1, "death"), "the opponent must take damage");
        await active.waitForOutcome();
      },
    });
    assertCompletedMatchOutcome(result.run, {
      kind: "winner",
      winner_seat: 0,
      survivors: [0],
      at: result.run.outcome.at!,
    }, { competitorCount: 2, eliminationCount: 1, deathCount: 1, disconnectCount: 0, survivorSeats: [0] });
  });

  await t.test("surrogate is damaged by an ordinary opponent and dies", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const result = await playMatch(fixtures, {
      name: "death",
      seats: 2,
      signal: row.signal,
      evaluate: async (active, signal, surrogate) => {
        const player = await surrogate();
        await active.start();
        await waitForActivePhase(active, signal);
        const attacker = competitorForSeat(active, 1);
        await engage(attacker.client, attacker.bot, player.username, signal, () => hasElimination(active, 0, "death"));
        assert.ok(player.minimumHealth < 20, "the surrogate must observe damage taken");
        await waitUntil(() => hasElimination(active, 0, "death"), "the surrogate's death was not reported", ELIMINATION_TIMEOUT_MS, signal);
        await active.waitForOutcome();
      },
    });
    assertCompletedMatchOutcome(result.run, {
      kind: "winner",
      winner_seat: 1,
      survivors: [1],
      at: result.run.outcome.at!,
    }, { competitorCount: 2, eliminationCount: 1, deathCount: 1, disconnectCount: 0, survivorSeats: [1] });
  });

  await t.test("a different or case-variant identity is rejected and never satisfies the wait", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const attempts: ConnectionAttempt[] = [];
    let probe: Promise<{ variantReason: string; otherMode: string }> | undefined;
    const failure = await playMatch(fixtures, {
      name: "wrong-identity",
      seats: 2,
      joinTimeoutMs: 15_000,
      signal: row.signal,
      onRosterReady: (address) => {
        probe = (async () => {
          const variant = attemptConnection(address, USERNAME.toLowerCase());
          attempts.push(variant);
          const ended = await variant.ended;
          const other = attemptConnection(address, "Other_9");
          attempts.push(other);
          await other.spawned;
          await waitUntil(() => other.bot.game.gameMode !== undefined, "the other player did not receive a game mode", 5_000, row.signal);
          return { variantReason: ended.reason, otherMode: other.bot.game.gameMode };
        })();
      },
    }).then(() => undefined, (error: unknown) => error);
    try {
      assert.ok(failure instanceof RunnerError, "the run must fail before the countdown");
      assert.equal(failure.source.kind, "external_join_timeout");
      assert.ok(probe, "the probe connections must have started");
      const observed = await probe;
      assert.ok(observed.variantReason.length > 0, "the case-variant identity must be disconnected");
      assert.equal(observed.otherMode, "spectator", "an unreserved identity may only spectate");
    } finally {
      for (const attempt of attempts) attempt.close();
    }
  });

  await t.test("a duplicate holder of the reserved identity is rejected", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const result = await playMatch(fixtures, {
      name: "duplicate",
      seats: 2,
      signal: row.signal,
      evaluate: async (active, signal, surrogate, address) => {
        const original = await surrogate();
        const duplicate = attemptConnection(address, USERNAME);
        try {
          const ended = await Promise.race([
            duplicate.ended,
            delay(20_000, undefined, { signal }).then(() => undefined),
          ]);
          assert.ok(ended, "the duplicate connection must be closed by the server");
          assert.equal(original.bot._client.ended, false, "the original holder must remain connected");
        } finally {
          duplicate.close();
        }
        await active.start();
        await waitForActivePhase(active, signal);
        assert.deepStrictEqual(latestAliveSeats(active), [0, 1]);
        await active.waitForOutcome();
      },
    });
    assert.equal(result.run.outcome.kind, "draw");
    assert.deepStrictEqual(result.run.outcome.survivors, [0, 1]);
  });

  await t.test("the join wait times out before the countdown when nobody connects", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const phases: ClockPayload["phase"][] = [];
    const failure = await playMatch(fixtures, {
      name: "timeout",
      seats: 2,
      joinTimeoutMs: 8_000,
      signal: row.signal,
      onPhase: (phase) => phases.push(phase),
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof RunnerError);
    assert.equal(failure.source.kind, "external_join_timeout");
    assert.equal(failure.source.field, USERNAME);
    assert.ok(!phases.includes("countdown"), "the countdown must never begin without the reserved player");
    await assertPortClosed();
  });

  await t.test("cancelling during the wait cleans up the server", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const operator = new AbortController();
    const failure = await playMatch(fixtures, {
      name: "cancel",
      seats: 2,
      joinTimeoutMs: 60_000,
      signal: AbortSignal.any([row.signal, operator.signal]),
      onRosterReady: () => { setTimeout(() => operator.abort(new RunnerError("cancelled", "arena run", { kind: "cancelled" })), 1_000); },
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof RunnerError);
    assert.equal(failure.category, "cancelled");
    await assertPortClosed();
  });

  await t.test("a living competitor cannot toggle to spectator and a late client cannot become a competitor", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const attempts: ConnectionAttempt[] = [];
    try {
      const result = await playMatch(fixtures, {
        name: "spectator-attempt",
        seats: 3,
        signal: row.signal,
        evaluate: async (active, signal, surrogate, address) => {
          const player = await surrogate();
          await active.start();
          await waitForActivePhase(active, signal);
          player.bot.chat("/gamemode spectator");
          await delay(2_000, undefined, { signal });
          assert.notEqual(player.gameMode, "spectator", "a living competitor must keep survival rules");
          assert.ok(latestAliveSeats(active).includes(0));

          const late = attemptConnection(address, "Watcher_1");
          attempts.push(late);
          const attemptedAt = Date.now();
          await waitUntil(() => late.bot.game?.gameMode === "spectator", "the late client did not become a spectator", 20_000, signal);
          const spawnedAfterMs = Date.now() - attemptedAt;
          assert.deepStrictEqual(latestAliveSeats(active), [0, 1, 2],
            `${eliminationSummary(active)} spawnedAfterMs=${spawnedAfterMs}`);
          await active.waitForOutcome();
        },
      });
      assert.equal(result.run.outcome.kind, "draw");
      assert.deepStrictEqual(result.run.outcome.survivors, [0, 1, 2]);
    } finally {
      for (const attempt of attempts) attempt.close();
    }
  });

  await t.test("a disconnected competitor is eliminated and its reconnect is spectator only", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const attempts: ConnectionAttempt[] = [];
    try {
      const result = await playMatch(fixtures, {
        name: "late-reconnect",
        seats: 3,
        signal: row.signal,
        evaluate: async (active, signal, surrogate, address) => {
          const player = await surrogate();
          await active.start();
          await waitForActivePhase(active, signal);
          const ended = player.ended;
          player.bot.quit("external surrogate leaves");
          await ended;
          await waitUntil(() => hasElimination(active, 0, "disconnect"),
            "the disconnect elimination was not reported", ELIMINATION_TIMEOUT_MS, signal);

          const returning = attemptConnection(address, USERNAME);
          attempts.push(returning);
          await waitUntil(() => returning.bot.game?.gameMode === "spectator",
            "the reconnected identity did not become a spectator", 20_000, signal);
          assert.deepStrictEqual(latestAliveSeats(active), [1, 2], eliminationSummary(active));
          await active.waitForOutcome();
        },
      });
      assert.equal(result.run.outcome.kind, "draw");
      assert.deepStrictEqual(result.run.outcome.survivors, [1, 2]);
      const eliminations = result.run.events.flatMap((event) => event.type === "elimination" ? event.payload.eliminations : []);
      assert.deepStrictEqual(eliminations, [{ seat: 0, cause: "disconnect" }]);
    } finally {
      for (const attempt of attempts) attempt.close();
    }
  });
});

async function playMatch(
  fixtures: Readonly<Record<Seats, string>>,
  row: MatchRow,
) {
  const stack = resolveStack();
  const username = row.username ?? USERNAME;
  const ownedRoot = Buffer.from(process.cwd(), "utf8");
  const runId = `ext-${row.name.slice(0, 14)}-${randomUUID()}`;
  const preparedRun = await prepareRun(
    stack.helperPath,
    ownedRoot,
    Buffer.from(fixtures[row.seats], "utf8"),
    runId,
    row.signal,
    { externalSeat: { seat: 0, username } },
  );
  const attempts: ConnectionAttempt[] = [];
  let surrogate: Promise<ExternalSurrogate> | undefined;
  const address = (host: string): GameAddress => ({
    host,
    port: PORT,
    version: preparedRun.scenario.server.minecraft,
    viewDistance: preparedRun.scenario.server.viewDistanceChunks,
  });
  const options: RunPreparedRunOptions = {
    preparedRun,
    helperPath: stack.helperPath,
    ownedRoot,
    javaExecutable: stack.javaExecutable,
    paperJarPath: stack.paperJarPath,
    pluginJarPath: stack.pluginJarPath,
    acceptMinecraftEula: true,
    signal: row.signal,
    competitorDriver: "evaluator",
    spectatorMode: "reserveExternalSlot",
    ...(row.joinTimeoutMs === undefined ? {} : { externalJoinTimeoutMs: row.joinTimeoutMs }),
    ...(row.onPhase === undefined ? {} : { onPhase: row.onPhase }),
    onRosterReady: (details) => {
      if (row.evaluate !== undefined) {
        surrogate = ExternalSurrogate.join(address(details.host), username, row.signal);
        void surrogate.catch(() => undefined);
      }
      row.onRosterReady?.(address(details.host), attempts);
    },
    evaluate: async (active, signal) => {
      if (row.evaluate === undefined) throw new Error("this row must fail before the match starts");
      await row.evaluate(active, signal, () => {
        assert.ok(surrogate, "the surrogate must have been launched when the roster became ready");
        return surrogate;
      }, address("127.0.0.1"));
    },
  };
  try {
    const run = await runPreparedRun(options);
    const inspection = await inspectOwnedAcceptanceRun(run.runId);
    return { run: { ...run, inspection } };
  } finally {
    for (const attempt of attempts) attempt.close();
    if (surrogate !== undefined) await (await surrogate.catch(() => undefined))?.close();
  }
}

function hasElimination(active: AcceptanceRunContext, seat: number, cause: "death" | "disconnect"): boolean {
  return active.events().some((event) => event.type === "elimination"
    && event.payload.eliminations.some((entry) => entry.seat === seat && entry.cause === cause));
}

function eliminationSummary(active: AcceptanceRunContext): string {
  const list = active.events().flatMap((event) => event.type === "elimination"
    ? event.payload.eliminations.map((entry) => `seat ${entry.seat} ${entry.cause} at ${event.payload.at.domain}:${event.payload.at.value}`)
    : []);
  const clock = active.events().findLast((event) => event.type === "public_clock");
  return `eliminations=[${list.join("; ")}] clock=${clock?.type === "public_clock" ? `${clock.payload.phase}:${clock.payload.tick?.value}` : "none"}`;
}

function latestAliveSeats(active: AcceptanceRunContext): readonly number[] {
  const state = active.events().findLast((event) => event.type === "public_state");
  assert.ok(state?.type === "public_state", "no public state has been published");
  return state.payload.alive_seats;
}

async function assertPortClosed(): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    socket.once("connect", () => { socket.destroy(); reject(new Error("the Paper listener is still accepting connections")); });
    socket.once("error", () => { socket.destroy(); resolveClosed(); });
  });
}

function writeFixtures(): Readonly<Record<Seats, string>> {
  const repositoryRoot = process.cwd();
  const mapSource = readFileSync(join(repositoryRoot, "maps/hunger-six.toml"), "utf8");
  const scenarioSource = readFileSync(join(repositoryRoot, "scenarios/hunger-six.toml"), "utf8");
  mkdirSync(join(repositoryRoot, FIXTURE_DIRECTORY), { recursive: true });
  const written = {} as Record<Seats, string>;
  for (const seats of [2, 3] as const) {
    const mapName = `map-${seats}.toml`;
    const map = mapSource.replace(
      /\[\[operations\]\]\nkind = "spawn"\nseat = (\d+)\nposition = [^\n]*\n\n?/g,
      (block, seat: string) => Number(seat) < seats ? block : "",
    );
    assert.notEqual(map, mapSource, "the fixture map must drop the surplus spawn seats");
    const scenario = [
      ['name = "hunger-six"', `name = "external-seat-${seats}"`],
      ['map = "../maps/hunger-six.toml"', `map = "${mapName}"`],
      ['policy = "../policies/baseline.toml"', 'policy = "../../../policies/baseline.toml"'],
      ["competitors = 6", `competitors = ${seats}`],
      ["spectator_capacity = 4", "spectator_capacity = 2"],
      ["countdown_ticks = 100", "countdown_ticks = 40"],
      ["grace_ticks = 200", "grace_ticks = 20"],
      ["authoritative_max_ticks = 7200", "authoritative_max_ticks = 2400"],
      ["shrink_start_tick = 1200", "shrink_start_tick = 2200"],
      ["shrink_end_tick = 6000", "shrink_end_tick = 2380"],
      ["final_diameter_blocks = 16", "final_diameter_blocks = 100"],
    ].reduce((text, [from, to]) => {
      assert.ok(text.includes(from!), `scenario source must contain ${from}`);
      return text.replace(from!, to!);
    }, scenarioSource);
    writeFileSync(join(repositoryRoot, FIXTURE_DIRECTORY, mapName), map);
    writeFileSync(join(repositoryRoot, FIXTURE_DIRECTORY, `scenario-${seats}.toml`), scenario);
    written[seats] = `${FIXTURE_DIRECTORY}/scenario-${seats}.toml`;
  }
  return written;
}

function resolveStack(): StackPaths {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs");
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome, "the pinned JDK must be configured by the arena test selector");
  const paperFile = lockedString("paper", "server_file");
  const paths = {
    helperPath,
    javaExecutable: join(javaHome, "bin/java"),
    paperJarPath: join(repositoryRoot, ".work/arena/downloads", paperFile),
    pluginJarPath: join(repositoryRoot, ".work/arena/gradle-build/libs/arena-plugin-0.1.0.jar"),
  };
  for (const path of Object.values(paths)) {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `required stack file must be a regular file: ${path}`);
  }
  return paths;
}

function lockedString(section: string, key: string): string {
  const values: string[] = [];
  let active = false;
  for (const line of readFileSync(join(process.cwd(), "versions.lock.toml"), "utf8").split(/\r?\n/)) {
    if (line.startsWith("[")) {
      active = line === `[${section}]`;
    } else if (active && line.startsWith(`${key} = `)) {
      const value = line.slice(key.length + 3).trim();
      assert.ok(value.startsWith('"') && value.endsWith('"'), `${section}.${key} must be a quoted string`);
      values.push(value.slice(1, -1));
    }
  }
  assert.equal(values.length, 1, `versions.lock.toml must define one ${section}.${key}`);
  return values[0]!;
}
