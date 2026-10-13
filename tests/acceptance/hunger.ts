import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { recordHungerGameplayEvidence, type HungerGameplayEvidence } from "./hunger-gameplay.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "../integration/support/owned-run.js";

const SCENARIOS = [
  { path: "tests/acceptance/fixtures/hunger-six-seed-481516.toml", seed: 481516n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481517.toml", seed: 481517n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481518.toml", seed: 481518n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481519.toml", seed: 481519n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481520.toml", seed: 481520n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481521.toml", seed: 481521n },
] as const;

const DEATH_TIMEOUT_MS = 420_000;
const ELIMINATION_TIMEOUT_MS = 10_000;

test("hunger-six", { timeout: 2_700_000 }, async (t) => {
  let hasWinnerWithTwoPvpEngagements = false;

  for (const [index, scenario] of SCENARIOS.entries()) {
    let gameplayEvidence: HungerGameplayEvidence | undefined;
    const run = await runOwnedAcceptanceScenario(
      scenario.path,
      `hunger-six-seed-${scenario.seed}`,
      async (active, signal) => {
        assertCanonicalHungerScenario(active, scenario.seed);
        prepareSixBotRoster(active);
        const recorder = recordHungerGameplayEvidence(active);
        try {
          await active.start();

          if (index === 0) {
            await waitForActivePhase(active, signal);
            const eliminatedSeat = await waitForDeathElimination(active, signal);
            const victim = competitorForSeat(active, eliminatedSeat);
            await waitForEliminatedState(active, eliminatedSeat, signal);

            const identityBeforeReconnect = victim.identity;
            const reconnected = await active.reconnectCompetitor(eliminatedSeat);
            assert.equal(reconnected.identity.username, identityBeforeReconnect.username);
            assert.equal(reconnected.identity.offlineUuid, identityBeforeReconnect.offlineUuid);
            assert.equal(reconnected.bot.username, identityBeforeReconnect.username);
            const eventCountAfterReconnect = active.events().length;
            await waitForGameMode(reconnected.bot, "spectator", signal);
            assert.equal(
              reconnected.bot.game.gameMode,
              "spectator",
              "a reconnect after death must join in actual spectator mode",
            );
            await waitForEliminatedState(active, eliminatedSeat, signal, eventCountAfterReconnect);
          }

          await active.waitForOutcome();
          gameplayEvidence = recorder.snapshot();
        } finally {
          recorder.close();
        }
      },
      t.signal,
    );

    assert.equal(run.inspection.run_id, run.runId);
    assert.ok(run.outcome.kind === "winner" || run.outcome.kind === "draw", "seeded run must reach an ordinary outcome");
    assert.ok(gameplayEvidence, "the clients must retain live gameplay observations for each seed");
    assert.ok(
      run.events.some((event) => event.type === "outcome" && event.payload.kind === run.outcome.kind),
      "the completed outcome must come from the authenticated event stream",
    );
    const report = object(run.inspection.report, "arena inspect report must be an object");
    assert.equal(report.outcome_status, "reconstructed_from_authoritative_events");
    const inspectedOutcome = object(report.outcome, "arena inspect must include the reconstructed outcome");
    assert.equal(inspectedOutcome.kind, run.outcome.kind);
    assert.equal(run.competitors.length, 6, "completed evidence must retain all six competitor identities");
    for (const competitor of run.competitors) {
      const stats = run.inspection.stats.find(({ offlineUuid }) => offlineUuid === competitor.offlineUuid);
      assert.ok(stats, `stopped inspection must include competitor ${competitor.username}`);
      assert.equal(stats.status, "present", `stopped stats must be present for competitor ${competitor.username}`);
    }

    const deathSeats = new Set(run.events.flatMap((event) => event.type === "elimination"
      ? event.payload.eliminations.filter(({ cause }) => cause === "death").map(({ seat }) => seat)
      : []));
    for (const seat of [0, 1, 2, 3, 4, 5]) {
      const movement = gameplayEvidence.maximumMovementBySeat.get(seat) ?? 0;
      assert.ok(
        movement >= 2 || deathSeats.has(seat),
        `seat ${seat} must make useful movement or be legitimately eliminated in seed ${scenario.seed}`,
      );
    }
    assert.ok(gameplayEvidence.lootedSeats.size > 0, `seed ${scenario.seed} must include a legal chest transfer`);
    assert.ok(gameplayEvidence.pvpEngagements.size > 0, `seed ${scenario.seed} must include an ordinary PvP hit`);
    if (run.outcome.kind === "winner" && gameplayEvidence.pvpEngagements.size >= 2) {
      hasWinnerWithTwoPvpEngagements = true;
    }

    if (index === 0) {
      const deathEventIndex = run.events.findIndex((event) => event.type === "elimination"
        && event.payload.eliminations.some(({ cause }) => cause === "death"));
      assert.notEqual(deathEventIndex, -1, "the automated competitor must be eliminated by ordinary death");
      const death = run.events[deathEventIndex];
      if (death?.type !== "elimination") throw new Error("ordinary death event is unavailable in the completed run");
      const deadSeat = death.payload.eliminations.find(({ cause }) => cause === "death")!.seat;
      const laterStates = run.events.slice(deathEventIndex + 1).filter((event) => event.type === "public_state");
      assert.ok(laterStates.length > 0, "the event stream must include public state after the death");
      assert.ok(
        laterStates.every((event) => !event.payload.alive_seats.includes(deadSeat)),
        "reconnecting must not restore the eliminated seat to the active roster",
      );
      assert.ok(
        !run.outcome.survivors.includes(deadSeat),
        "an eliminated reconnecting competitor must not become a match survivor",
      );
    }
  }

  assert.ok(
    hasWinnerWithTwoPvpEngagements,
    "at least one seeded run must have one survivor and two distinct ordinary PvP engagements",
  );
});

function prepareSixBotRoster(active: AcceptanceRunContext): void {
  assert.equal(active.prepare.type, "prepare");
  const roster = active.prepare.payload.roster;
  assert.equal(roster.length, 6, "the prepared match must contain six bot competitors");
  assert.deepStrictEqual(roster.map(({ seat }) => seat), [0, 1, 2, 3, 4, 5]);
  assert.equal(active.competitors.length, 6, "the runner must connect all six bot competitors");
  const spectatorCapacity = Number(active.preparedRun.scenario.roster.spectatorCapacity);
  assert.equal(active.spectators.length, spectatorCapacity, "the runner must connect every configured automated spectator");

  const usernames = new Set<string>();
  const offlineUuids = new Set<string>();
  for (const planned of roster) {
    const handle = competitorForSeat(active, planned.seat);
    assert.equal(handle.identity.username, planned.username);
    assert.equal(handle.identity.offlineUuid, planned.offline_uuid);
    assert.equal(handle.bot.username, planned.username);
    assert.ok(!usernames.has(handle.identity.username), "competitor usernames must be unique");
    assert.ok(!offlineUuids.has(handle.identity.offlineUuid), "competitor UUIDs must be unique");
    usernames.add(handle.identity.username);
    offlineUuids.add(handle.identity.offlineUuid);
  }

  const spectatorUsernames = new Set<string>();
  const spectatorUuids = new Set<string>();
  for (const spectator of active.spectators) {
    assert.ok(!usernames.has(spectator.identity.username), "automated spectators must not occupy competitor seats");
    assert.ok(!offlineUuids.has(spectator.identity.offlineUuid), "automated spectators must have their own offline UUIDs");
    assert.ok(!spectatorUsernames.has(spectator.identity.username), "automated spectator usernames must be unique");
    assert.ok(!spectatorUuids.has(spectator.identity.offlineUuid), "automated spectator UUIDs must be unique");
    assert.equal(spectator.bot.username, spectator.identity.username);
    assert.equal(spectator.bot.game.gameMode, "spectator", "each noncompetitor client must receive spectator game mode");
    spectatorUsernames.add(spectator.identity.username);
    spectatorUuids.add(spectator.identity.offlineUuid);
  }
}

function assertCanonicalHungerScenario(active: AcceptanceRunContext, seed: bigint): void {
  const scenario = active.preparedRun.scenario;
  assert.equal(scenario.seed, seed, "each match must use its declared distinct seed");
  assert.equal(scenario.roster.competitors, 6);
  assert.equal(scenario.roster.spectatorCapacity, 4n);
  assert.equal(scenario.matchSettings.countdownTicks, 100n);
  assert.equal(scenario.matchSettings.graceTicks, 200n);
  assert.equal(scenario.matchSettings.authoritativeMaxTicks, 7200n);
  assert.equal(scenario.border.shrinkStartTick, 1200n);
  assert.equal(scenario.border.shrinkEndTick, 6000n);
}

function competitorForSeat(active: AcceptanceRunContext, seat: number) {
  assert.equal(active.prepare.type, "prepare");
  const planned = active.prepare.payload.roster.find((competitor) => competitor.seat === seat);
  assert.ok(planned, `prepared roster must contain competitor seat ${seat}`);
  const handle = active.competitors.find(({ identity }) => identity.username === planned.username);
  assert.ok(handle, `runtime must connect prepared competitor ${planned.username}`);
  assert.equal(handle.identity.offlineUuid, planned.offline_uuid);
  return handle;
}

async function waitForActivePhase(active: AcceptanceRunContext, signal: AbortSignal): Promise<void> {
  await waitForCondition(
    () => active.events().some((event) => event.type === "public_clock" && event.payload.phase === "active"),
    "match did not reach the active phase",
    30_000,
    signal,
  );
}

async function waitForEliminatedState(
  active: AcceptanceRunContext,
  seat: number,
  signal: AbortSignal,
  afterEventCount = 0,
): Promise<void> {
  await waitForCondition(
    () => {
      const latest = active.events().slice(afterEventCount).findLast((event) => event.type === "public_state");
      return latest !== undefined && !latest.payload.alive_seats.includes(seat);
    },
    `seat ${seat} remained alive after elimination`,
    ELIMINATION_TIMEOUT_MS,
    signal,
  );
}

async function waitForGameMode(
  bot: AcceptanceRunContext["competitors"][number]["bot"],
  mode: "spectator",
  signal: AbortSignal,
): Promise<void> {
  await waitForCondition(
    () => bot.game.gameMode === mode,
    `reconnected bot did not enter ${mode} mode`,
    10_000,
    signal,
  );
}

async function waitForDeathElimination(active: AcceptanceRunContext, signal: AbortSignal): Promise<number> {
  const deadline = Date.now() + DEATH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const death = active.events().find((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ cause }) => cause === "death"));
    if (death?.type === "elimination") {
      const elimination = death.payload.eliminations.find(({ cause }) => cause === "death");
      assert.ok(elimination);
      return elimination.seat;
    }
    if (active.events().some((event) => event.type === "outcome")) {
      throw new Error("hunger-six seed 1 reached an outcome before any competitor died");
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`hunger-six did not record an ordinary death within ${DEATH_TIMEOUT_MS} ms`);
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (condition()) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(`${description} within ${timeoutMs} ms`);
}

function object(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", description);
  return value as Record<string, unknown>;
}
