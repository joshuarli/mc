import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, type Bot } from "mineflayer";
import { test } from "node:test";

import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import type { OutcomePayload } from "../../packages/arena-runner/src/control/types.js";
import {
  assertCompletedMatchOutcome,
  assertInspectedMatchOutcome,
  assertMatchOutcomeEvents,
  type ExpectedMatchStatistics,
} from "./support/match-rules-authority.js";
import { competitorForSeat, waitForActivePhase } from "./support/duel.js";
import {
  inspectOwnedAcceptanceRun,
  runOwnedAcceptanceScenario,
  type AcceptanceRunContext,
} from "./support/owned-run.js";

const DEATH_TIMEOUT_MS = 30_000;
const ELIMINATION_TIMEOUT_MS = 5_000;

test("match-rules-border-death", { timeout: 180_000 }, async (t) => {
  let minimumHealth = Number.POSITIVE_INFINITY;
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-border-death-scenario.toml",
    "match-rules-border-death",
    async (active, signal) => {
      const edgeSeat = competitorForSeat(active, 0);
      const centerSeat = competitorForSeat(active, 1);
      assertSpawnAt(edgeSeat.bot, { x: 0.5, y: 65, z: 31.5 });
      assertSpawnAt(centerSeat.bot, { x: 32.5, y: 65, z: 31.5 });
      const recordHealth = (): void => { minimumHealth = Math.min(minimumHealth, edgeSeat.bot.health); };
      recordHealth();
      edgeSeat.bot.on("health", recordHealth);
      try {
        await active.start();
        await waitForActivePhase(active, signal);
        await active.waitForOutcome();
      } finally {
        edgeSeat.bot.removeListener("health", recordHealth);
      }
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.ok(minimumHealth < 20, "the border-exposed competitor must take client-observed damage");
  assert.ok(
    run.events.some((event) => event.type === "public_clock"
      && event.payload.border_diameter_blocks === 8),
    "the authenticated match clock must report the configured final border diameter",
  );
  const death = run.events.find((event) => event.type === "elimination");
  assert.ok(death?.type === "elimination", "the edge competitor must be eliminated");
  assert.deepStrictEqual(death.payload.eliminations, [{ seat: 0, cause: "death" }]);
  const expected: OutcomePayload = {
    kind: "winner",
    winner_seat: 1,
    survivors: [1],
    at: death.payload.at,
  };
  assertCompletedMatchOutcome(run, expected, {
    competitorCount: 2,
    eliminationCount: 1,
    deathCount: 1,
    disconnectCount: 0,
    survivorSeats: [1],
  });
});

test("match-rules-disconnect", { timeout: 180_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-disconnect-scenario.toml",
    "match-rules-disconnect",
    async (active, signal) => {
      const disconnected = competitorForSeat(active, 1);
      await active.start();
      await waitForActivePhase(active, signal);
      const ended = waitForBotEnd(disconnected.bot, signal);
      disconnected.bot.quit("match-rules disconnect acceptance");
      await ended;
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  const elimination = run.events.find((event) => event.type === "elimination");
  assert.ok(elimination?.type === "elimination", "the disconnect must produce an authoritative elimination");
  assert.deepStrictEqual(elimination.payload.eliminations, [{ seat: 1, cause: "disconnect" }]);
  assertCompletedMatchOutcome(run, {
    kind: "winner",
    winner_seat: 0,
    survivors: [0],
    at: elimination.payload.at,
  }, {
    competitorCount: 2,
    eliminationCount: 1,
    deathCount: 0,
    disconnectCount: 1,
    survivorSeats: [0],
  });
});

test("match-rules-timeout", { timeout: 180_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-timeout-scenario.toml",
    "match-rules-timeout",
    async (active) => {
      await active.start();
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assertCompletedMatchOutcome(run, {
    kind: "draw",
    reason: "tick_limit",
    survivors: [0, 1],
    at: { domain: "match", value: 40n },
  }, {
    competitorCount: 2,
    eliminationCount: 0,
    deathCount: 0,
    disconnectCount: 0,
    survivorSeats: [0, 1],
  });
});

test("match-rules-abort", { timeout: 180_000 }, async (t) => {
  const runAbort = new AbortController();
  let runId: string | undefined;
  let activeContext: AcceptanceRunContext | undefined;
  const running = runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-abort-scenario.toml",
    "match-rules-abort",
    async (active, signal) => {
      runId = active.preparedRun.runId;
      activeContext = active;
      await active.start();
      await waitForActivePhase(active, signal);
      runAbort.abort();
    },
    AbortSignal.any([t.signal, runAbort.signal]),
    { competitorDriver: "evaluator" },
  );

  await assert.rejects(running, (error: unknown) =>
    error instanceof RunnerError && error.category === "cancelled" && error.source.kind === "cancelled");
  assert.ok(runId, "the cancelled run must retain its prepared run identity");
  assert.ok(activeContext, "the active evaluator must retain its authoritative event view");
  const outcomeEvent = activeContext.events().findLast((event) => event.type === "outcome");
  assert.ok(outcomeEvent?.type === "outcome", "runner cancellation must record a plugin outcome before cleanup");
  const expected = outcomeEvent.payload;
  assert.equal(expected.kind, "abort");
  if (expected.kind !== "abort") throw new Error("runner cancellation did not produce an abort outcome");
  assert.equal(expected.reason, "operator");
  assert.deepStrictEqual(expected.survivors, [0, 1]);
  assert.ok(expected.at, "an abort after the active phase must retain its match tick");
  assert.equal(expected.at.domain, "match");

  const statistics = {
    competitorCount: 2,
    eliminationCount: 0,
    deathCount: 0,
    disconnectCount: 0,
    survivorSeats: [0, 1],
  } satisfies ExpectedMatchStatistics;
  assertMatchOutcomeEvents(activeContext.events(), expected, statistics);
  const inspection = await inspectOwnedAcceptanceRun(runId);
  assertInspectedMatchOutcome(inspection, expected, statistics);
});

test("match-rules-spectator-identity", { timeout: 180_000 }, async (t) => {
  let competitorNames: string[] = [];
  let spectatorName: string | undefined;
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-spectator-scenario.toml",
    "match-rules-spectator-identity",
    async (active) => {
      assert.equal(active.prepare.type, "prepare");
      assert.equal(active.prepare.payload.roster.length, 2);
      assert.equal(active.competitors.length, 2);
      assert.equal(active.spectators.length, 1);
      competitorNames = active.competitors.map(({ identity }) => identity.username);
      spectatorName = active.spectators[0]!.identity.username;
      const usernames = new Set(active.competitors.map(({ identity }) => identity.username));
      const uuids = new Set(active.competitors.map(({ identity }) => identity.offlineUuid));
      assert.equal(usernames.size, 2, "competitive usernames must be unique");
      assert.equal(uuids.size, 2, "competitive offline UUIDs must be unique");
      assert.ok(!usernames.has(active.spectators[0]!.identity.username));
      assert.ok(!uuids.has(active.spectators[0]!.identity.offlineUuid));
      assert.equal(active.spectators[0]!.bot.username, active.spectators[0]!.identity.username);
      assert.equal(active.spectators[0]!.bot.game.gameMode, "spectator");
      for (const competitor of active.competitors) {
        assert.notEqual(competitor.bot.game.gameMode, "spectator");
      }
      await active.start();
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.equal(new Set(competitorNames).size, 2);
  assert.ok(spectatorName);
  assert.ok(!competitorNames.includes(spectatorName), "the spectator must not occupy a prepared competitor identity");
  assertCompletedMatchOutcome(run, {
    kind: "draw",
    reason: "tick_limit",
    survivors: [0, 1],
    at: { domain: "match", value: 40n },
  }, {
    competitorCount: 2,
    eliminationCount: 0,
    deathCount: 0,
    disconnectCount: 0,
    survivorSeats: [0, 1],
  });
});

test("match-rules-duplicate-identity", { timeout: 240_000 }, async (t) => {
  let duplicateUsername: string | undefined;
  let duplicateOfflineUuid: string | undefined;
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-duplicate-identity-scenario.toml",
    "match-rules-duplicate-identity",
    async (active, signal) => {
      const original = competitorForSeat(active, 0);
      duplicateUsername = original.identity.username;
      duplicateOfflineUuid = original.identity.offlineUuid;
      await active.start();
      await waitForActivePhase(active, signal);

      const originalEnded = waitForBotEnd(original.bot, signal);
      const replacement = createBot({
        host: active.gameAddress.host,
        port: active.gameAddress.port,
        username: original.identity.username,
        auth: "offline",
        version: active.preparedRun.scenario.server.minecraft,
        viewDistance: active.preparedRun.scenario.server.viewDistanceChunks,
        logErrors: false,
      });
      let replacementEnded = false;
      const replacementErrors: Error[] = [];
      replacement.on("error", (error) => replacementErrors.push(error));
      replacement.once("end", () => { replacementEnded = true; });
      try {
        await Promise.all([originalEnded, waitForBotSpawn(replacement, signal)]);
        assert.equal(replacement.player.uuid, original.identity.offlineUuid);
        await waitForGameMode(replacement, signal);
        assert.equal(replacement.game.gameMode, "spectator");
        const disconnect = active.events().findLast((event) => event.type === "elimination"
          && event.payload.eliminations.some(({ seat, cause }) => seat === 0 && cause === "disconnect"));
        assert.ok(disconnect?.type === "elimination", "the original seat must be eliminated by duplicate login");
        assert.deepStrictEqual(disconnect.payload.eliminations, [{ seat: 0, cause: "disconnect" }]);
        await waitForCondition(
          () => latestAliveSeats(active).length === 2 && !latestAliveSeats(active).includes(0),
          "duplicate identity replacement must stay outside the active competitor roster",
          ELIMINATION_TIMEOUT_MS,
          signal,
        );
        assert.deepStrictEqual(latestAliveSeats(active), [1, 2]);
        assert.deepStrictEqual(replacementErrors, [], "the replacement spectator connection must remain healthy");
        await active.waitForOutcome();
      } finally {
        if (!replacementEnded) {
          const replacementClosed = waitForBotEnd(replacement, new AbortController().signal);
          replacement.end("duplicate identity acceptance cleanup");
          replacement._client.socket.destroy();
          await replacementClosed;
        }
      }
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.ok(duplicateUsername);
  assert.ok(duplicateOfflineUuid);
  assertCompletedMatchOutcome(run, {
    kind: "draw",
    reason: "tick_limit",
    survivors: [1, 2],
    at: { domain: "match", value: 240n },
  }, {
    competitorCount: 3,
    eliminationCount: 1,
    deathCount: 0,
    disconnectCount: 1,
    survivorSeats: [1, 2],
  });
  assert.ok(
    run.events.some((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ seat, cause }) => seat === 0 && cause === "disconnect")),
    `duplicate login for ${duplicateUsername} (${duplicateOfflineUuid}) must not restore the eliminated seat`,
  );
});

test("match-rules-eliminated-reconnect", { timeout: 240_000 }, async (t) => {
  let eliminatedIdentity: { readonly username: string; readonly offlineUuid: string } | undefined;
  let aliveSeatsAfterReconnect: readonly number[] | undefined;
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-eliminated-reconnect-scenario.toml",
    "match-rules-eliminated-reconnect",
    async (active, signal) => {
      const eliminated = competitorForSeat(active, 0);
      const identityBefore = eliminated.identity;
      eliminatedIdentity = identityBefore;
      assertCompetitorIdentitiesUnique(active);

      await active.start();
      await waitForActivePhase(active, signal);
      await walkOffPlatformAndDie(eliminated.bot, signal);
      await waitForCondition(
        () => active.events().some((event) => event.type === "elimination"
          && event.payload.eliminations.some(({ seat, cause }) => seat === 0 && cause === "death")),
        "seat zero did not receive an authoritative death elimination",
        ELIMINATION_TIMEOUT_MS,
        signal,
      );

      const reconnected = await active.reconnectCompetitor(0);
      assert.equal(reconnected.identity.username, identityBefore.username);
      assert.equal(reconnected.identity.offlineUuid, identityBefore.offlineUuid);
      assert.equal(reconnected.bot.username, identityBefore.username);
      await waitForGameMode(reconnected.bot, signal);
      assert.equal(reconnected.bot.game.gameMode, "spectator");
      aliveSeatsAfterReconnect = latestAliveSeats(active);
      assert.deepStrictEqual(aliveSeatsAfterReconnect, [1, 2]);
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.ok(eliminatedIdentity);
  assert.deepStrictEqual(aliveSeatsAfterReconnect, [1, 2]);
  assertCompletedMatchOutcome(run, {
    kind: "draw",
    reason: "tick_limit",
    survivors: [1, 2],
    at: { domain: "match", value: 240n },
  }, {
    competitorCount: 3,
    eliminationCount: 1,
    deathCount: 1,
    disconnectCount: 0,
    survivorSeats: [1, 2],
  });
  assert.ok(
    run.events.some((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ seat, cause }) => seat === 0 && cause === "death")),
    `reconnected identity ${eliminatedIdentity.username} must remain eliminated by death`,
  );
});

test("match-rules-same-tick-zero-survivors", { timeout: 180_000 }, async (t) => {
  let minimumHealthBySeat = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const run = await runOwnedAcceptanceScenario(
    "tests/acceptance/fixtures/match-rules-same-tick-scenario.toml",
    "match-rules-same-tick-zero-survivors",
    async (active, signal) => {
      const seatZero = competitorForSeat(active, 0);
      const seatOne = competitorForSeat(active, 1);
      assertSpawnAt(seatZero.bot, { x: 0.5, y: 65, z: 31.5 });
      assertSpawnAt(seatOne.bot, { x: 63.5, y: 65, z: 31.5 });
      const recordHealth = (seat: number, bot: Bot) => (): void => {
        minimumHealthBySeat[seat] = Math.min(minimumHealthBySeat[seat]!, bot.health);
      };
      const recordZero = recordHealth(0, seatZero.bot);
      const recordOne = recordHealth(1, seatOne.bot);
      recordZero();
      recordOne();
      seatZero.bot.on("health", recordZero);
      seatOne.bot.on("health", recordOne);
      try {
        await active.start();
        await waitForActivePhase(active, signal);
        await active.waitForOutcome();
      } finally {
        seatZero.bot.removeListener("health", recordZero);
        seatOne.bot.removeListener("health", recordOne);
      }
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.ok(minimumHealthBySeat.every((health) => health < 20), "both symmetric edge seats must take border damage");
  assert.ok(
    run.events.some((event) => event.type === "public_clock"
      && event.payload.border_diameter_blocks === 8),
    "the server must complete the configured border shrink before elimination",
  );
  const elimination = run.events.find((event) => event.type === "elimination");
  assert.ok(elimination?.type === "elimination");
  assert.deepStrictEqual(elimination.payload.eliminations, [
    { seat: 0, cause: "death" },
    { seat: 1, cause: "death" },
  ], "symmetric border damage must eliminate both competitors in the same authoritative tick");
  const expected: OutcomePayload = {
    kind: "draw",
    reason: "no_survivors",
    survivors: [],
    at: elimination.payload.at,
  };
  assertCompletedMatchOutcome(run, expected, {
    competitorCount: 2,
    eliminationCount: 2,
    deathCount: 2,
    disconnectCount: 0,
    survivorSeats: [],
  });
});

function assertCompetitorIdentitiesUnique(active: AcceptanceRunContext): void {
  const usernames = active.competitors.map(({ identity }) => identity.username);
  const uuids = active.competitors.map(({ identity }) => identity.offlineUuid);
  assert.equal(new Set(usernames).size, active.competitors.length);
  assert.equal(new Set(uuids).size, active.competitors.length);
}

function assertSpawnAt(
  bot: Bot,
  expected: { readonly x: number; readonly y: number; readonly z: number },
): void {
  assert.ok(Math.abs(bot.entity.position.x - expected.x) < 0.1);
  assert.ok(Math.abs(bot.entity.position.y - expected.y) < 0.1);
  assert.ok(Math.abs(bot.entity.position.z - expected.z) < 0.1);
}

async function walkOffPlatformAndDie(bot: Bot, signal: AbortSignal): Promise<void> {
  await bot.look(Math.PI, 0);
  const death = waitForBotDeath(bot, signal);
  bot.setControlState("forward", true);
  try {
    await death;
  } finally {
    bot.clearControlStates();
  }
}

function waitForBotDeath(bot: Bot, signal: AbortSignal): Promise<void> {
  return waitForBotEvent(bot, "death", DEATH_TIMEOUT_MS, signal, "competitor did not die after leaving the platform");
}

function waitForBotEnd(bot: Bot, signal: AbortSignal): Promise<void> {
  return waitForBotEvent(bot, "end", 10_000, signal, "disconnected competitor did not close its client connection");
}

function waitForBotSpawn(bot: Bot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timeout);
      bot.removeListener("spawn", onSpawn);
      bot.removeListener("error", onError);
      bot.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onEnd = (reason: string): void => finish(new Error(`duplicate identity connection ended before spawn: ${reason}`));
    const onAbort = (): void => finish(signal.reason ?? new Error("match-rules run aborted"));
    const timeout = setTimeout(() => finish(new Error("duplicate identity connection did not spawn within 30 seconds")), 30_000);
    bot.once("spawn", onSpawn);
    bot.once("error", onError);
    bot.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForBotEvent(
  bot: Bot,
  event: "death" | "end",
  timeoutMs: number,
  signal: AbortSignal,
  description: string,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timeout);
      bot.removeListener(event, onEvent);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onEvent = (): void => finish();
    const onAbort = (): void => finish(signal.reason ?? new Error("match-rules run aborted"));
    const timeout = setTimeout(() => finish(new Error(description)), timeoutMs);
    bot.once(event, onEvent);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForGameMode(bot: Bot, signal: AbortSignal): Promise<void> {
  await waitForCondition(
    () => bot.game.gameMode === "spectator",
    "reconnected eliminated seat did not join in spectator mode",
    10_000,
    signal,
  );
}

function latestAliveSeats(active: AcceptanceRunContext): readonly number[] {
  const state = active.events().findLast((event) => event.type === "public_state");
  assert.ok(state?.type === "public_state", "the event stream must include alive-seat state");
  return state.payload.alive_seats;
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
