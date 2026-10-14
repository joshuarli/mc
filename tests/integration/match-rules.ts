import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import type { ClockPayload } from "../../packages/arena-runner/src/control/index.js";
import { MAX_OWNED_READ_BYTES, readOwnedFile } from "../../packages/arena-runner/src/owned-files/index.js";
import {
  assertDeathWinner,
  competitorForSeat,
  eliminateOpponentWithSkillAttacks,
  waitForActivePhase,
} from "./support/duel.js";
import { createMineflayerSemanticWorldReader, observePlayerInventory } from "./support/mineflayer-world.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

const PHASE_TIMEOUT_MS = 20_000;
const WALK_ATTEMPT_MS = 250;

test("match-rules", { timeout: 300_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-freeze-scenario.toml",
    "match-rules",
    async (active, signal) => {
      const seatZero = competitorForSeat(active, 0);
      const seatOne = competitorForSeat(active, 1);
      const chest = active.preparedRun.scenario.map.lootContainers[0];
      assert.ok(chest, "match-rules fixture must declare a chest within spawn reach");
      const healthBeforeGrace = seatOne.bot.health;
      let minimumHealth = healthBeforeGrace;
      let damageReceipts = 0;
      const onHealth = (): void => { minimumHealth = Math.min(minimumHealth, seatOne.bot.health); };
      const onHurt = (entity: typeof seatOne.bot.entity | undefined): void => {
        if (entity?.id === seatOne.bot.entity.id) damageReceipts += 1;
      };
      seatOne.bot.on("health", onHealth);
      seatOne.bot.on("entityHurt", onHurt);
      try {
        await seatZero.bot.look(0, 0);

        await assertPreReleaseLocked(active, seatZero, chest.position, "waiting", signal);
        await active.start();
        await assertPreReleaseLocked(active, seatZero, chest.position, "countdown", signal);

        await waitForPhase(active, "grace", signal);
        const target = seatZero.bot.players[seatOne.identity.username]?.entity;
        assert.ok(target, "the attacker must receive its opponent before the grace-phase attack");
        await seatZero.bot.lookAt(target.position.offset(0, target.height * 0.6, 0), true);
        const observation = await waitForVisibleOpponent(seatZero, target.id, signal);
        assert.ok(
          distance(point(seatZero.bot.entity.position), point(target.position)) <= 3,
          "the grace-phase target must be within ordinary melee reach",
        );
        assert.equal(observation.opponents.kind, "current");
        seatZero.bot.attack(target);
        await waitForPaperCancelledDamage(active, seatZero.identity.username, seatOne.identity.username, signal);
        await delay(200, undefined, { signal });
        assert.equal(latestPhase(active), "grace", "the denied attack must occur during grace");
        assert.equal(minimumHealth, healthBeforeGrace, "grace-phase PvP must not lower the target's health");
        assert.equal(damageReceipts, 0, "grace-phase PvP must not produce a target damage receipt");

        await waitForActivePhase(active, signal);
        const positionBeforeReleaseMove = point(seatZero.bot.entity.position);
        await walkForward(seatZero.bot, signal);
        assert.ok(
          distance(positionBeforeReleaseMove, point(seatZero.bot.entity.position)) > 0.1,
          "the same walking input must move the competitor after the active phase is released",
        );

        assert.equal(active.prepare.type, "prepare");
        const usernamesBySeat = new Map(active.prepare.payload.roster.map(({ seat, username }) => [seat, username] as const));
        const reader = createMineflayerSemanticWorldReader(seatZero.bot, usernamesBySeat);
        const chestBeforeLoot = await reader.readContainer(chest.position, signal);
        assert.deepStrictEqual(
          chestBeforeLoot.slots.filter((item) => item !== null).map(({ item }) => item),
          chest.inventory,
          "waiting and countdown chest attempts must leave every declared item in the server chest",
        );
        assert.equal(observePlayerInventory(seatZero.bot).items.length, 0);

        assert.deepStrictEqual(
          await seatZero.client.run({ kind: "containerOpen", position: chest.position }),
          { kind: "succeeded" },
          "the same chest interaction must transfer its items after release",
        );
        const inventory = observePlayerInventory(seatZero.bot);
        for (const item of chest.inventory) {
          assert.ok(inventory.items.some((entry) => entry.item === item), `released player must receive ${item}`);
        }

        await eliminateOpponentWithSkillAttacks(active, 0, 1, signal);
        assert.ok(minimumHealth < healthBeforeGrace, "active-phase Mineflayer attacks must lower the target's health");
        assert.ok(damageReceipts > 0, "active-phase Mineflayer attacks must produce a target damage receipt");
        await active.waitForOutcome();
      } finally {
        seatOne.bot.removeListener("health", onHealth);
        seatOne.bot.removeListener("entityHurt", onHurt);
      }
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.equal(run.inspection.run_id, run.runId);
  assertDeathWinner(run, 0, 1, 2);
  assert.ok(
    !run.events.some((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ seat, cause }) => seat === 1 && cause === "disconnect")),
    "a death result must not be reconstructed from a disconnect",
  );
});

async function assertPreReleaseLocked(
  active: AcceptanceRunContext,
  competitor: ReturnType<typeof competitorForSeat>,
  chestPosition: { readonly x: number; readonly y: number; readonly z: number },
  phase: "waiting" | "countdown" | "grace",
  signal: AbortSignal,
): Promise<void> {
  await waitForPhase(active, phase, signal);
  const before = point(competitor.bot.entity.position);
  const chestCenter = { x: chestPosition.x + 0.5, y: chestPosition.y + 0.5, z: chestPosition.z + 0.5 };
  assert.ok(distance(before, chestCenter) <= 3, `${phase} chest must be within ordinary interaction reach`);

  await walkForward(competitor.bot, signal);
  assertPositionUnchanged(before, point(competitor.bot.entity.position), phase);

  const opening = await competitor.client.run({ kind: "containerOpen", position: chestPosition });
  assert.deepStrictEqual(opening, { kind: "failed", cause: "timedOut" }, `${phase} chest access must be rejected`);
  assert.equal(competitor.bot.currentWindow, null, `${phase} attempt must not open a chest window`);
  assert.equal(observePlayerInventory(competitor.bot).items.length, 0, `${phase} attempt must not grant chest items`);
  assert.equal(latestPhase(active), phase, `the match must remain in ${phase} during the locked action`);
}

async function waitForPhase(
  active: AcceptanceRunContext,
  phase: ClockPayload["phase"],
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (latestPhase(active) === phase) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(`match did not reach ${phase} within ${PHASE_TIMEOUT_MS} ms`);
}

function latestPhase(active: AcceptanceRunContext): ClockPayload["phase"] | undefined {
  return active.events().findLast((event) => event.type === "public_clock")?.payload.phase;
}

async function waitForVisibleOpponent(
  competitor: ReturnType<typeof competitorForSeat>,
  entityId: number,
  signal: AbortSignal,
) {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const gameplay = competitor.gameplay;
    if (gameplay.mode !== "hunger_games") throw new Error("opponent visibility evaluator requires Hunger Games");
    const observation = gameplay.client.observe(0);
    if (observation.opponents.kind === "current"
        && observation.opponents.value.some(({ id }) => id === entityId)) {
      return observation;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error("grace-phase target did not enter the attacker's current client perception");
}

async function waitForPaperCancelledDamage(
  active: AcceptanceRunContext,
  attackerUsername: string,
  victimUsername: string,
  signal: AbortSignal,
): Promise<void> {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work", "arena-fs", "arena-fs");
  const logPath = Buffer.concat([
    active.preparedRun.runDirectoryPath,
    Buffer.from("/server/logs/latest.log", "ascii"),
  ]);
  const expectedAttempt = `ARENA_DAMAGE_ATTEMPT|${attackerUsername}|${victimUsername}|cancelled=true|`;
  const expectedSwing = `ARENA_SWING|${attackerUsername}`;
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const log = await readOwnedFile({
      helperPath,
      ownedRoot: Buffer.from(repositoryRoot, "utf8"),
      relativePath: logPath,
      maxBytes: MAX_OWNED_READ_BYTES,
      signal,
    });
    const text = log.toString("utf8");
    if (text.includes(expectedSwing) && text.includes(expectedAttempt)) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(`Paper did not record a cancelled grace-phase damage attempt from ${attackerUsername} to ${victimUsername}`);
}

async function walkForward(bot: ReturnType<typeof competitorForSeat>["bot"], signal: AbortSignal): Promise<void> {
  bot.setControlState("forward", true);
  try {
    await delay(WALK_ATTEMPT_MS, undefined, { signal });
  } finally {
    bot.clearControlStates();
  }
}

function point(position: { readonly x: number; readonly y: number; readonly z: number }) {
  return { x: position.x, y: position.y, z: position.z };
}

function distance(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function assertPositionUnchanged(
  before: { readonly x: number; readonly y: number; readonly z: number },
  after: { readonly x: number; readonly y: number; readonly z: number },
  phase: string,
): void {
  assert.ok(distance(before, after) <= 0.05, `${phase} movement must leave the client-observed position unchanged`);
}
