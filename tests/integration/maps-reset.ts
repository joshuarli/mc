import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { test } from "node:test";

import type { StoppedPlayerStats } from "../../packages/arena-runner/src/runtime/observations.js";
import { assertDeathWinner, competitorForSeat as duelCompetitorForSeat } from "./support/duel.js";
import {
  assertPlayerDeathStatsReset,
  assertPlayerDeathWasRecorded,
  assertPlayerInventoryEmpty,
  assertResetWorldMatchesFirst,
  assertSemanticWorldMatchesMap,
  captureSemanticWorld,
  type SemanticWorldObservation,
} from "./support/semantic-world.js";
import { createMineflayerSemanticWorldReader, observePlayerInventory } from "./support/mineflayer-world.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

const scenarioPath = "tests/acceptance/fixtures/maps-reset-scenario.toml";
const chestItem = "minecraft:stone_sword";

test("maps-reset", { timeout: 300_000 }, async (t) => {
  let firstWorld: { readonly seatZero: SemanticWorldObservation; readonly seatOne: SemanticWorldObservation } | undefined;
  let seatZeroUuid: string | undefined;
  let seatOneUuid: string | undefined;

  const firstRun = await runOwnedAcceptanceScenario(scenarioPath, "maps-reset-first", async (active, signal) => {
    const seatZero = duelCompetitorForSeat(active, 0);
    const seatOne = duelCompetitorForSeat(active, 1);
    seatZeroUuid = seatZero.identity.offlineUuid;
    seatOneUuid = seatOne.identity.offlineUuid;
    const map = active.preparedRun.scenario.map;
    const usernamesBySeat = competitorUsernamesBySeat(active);
    const seatZeroReader = createMineflayerSemanticWorldReader(seatZero.bot, usernamesBySeat);
    const seatOneReader = createMineflayerSemanticWorldReader(seatOne.bot, usernamesBySeat);

    assertPlayerInventoryEmpty(observePlayerInventory(seatZero.bot));
    assertPlayerInventoryEmpty(observePlayerInventory(seatOne.bot));
    const seatZeroWorld = await captureSemanticWorld(map, seatZeroReader, signal);
    const seatOneWorld = await captureSemanticWorld(map, seatOneReader, signal);
    assertSemanticWorldMatchesMap(map, seatZeroWorld, {
      blocksByName: seatZero.bot.registry.blocksByName,
    });
    assertSemanticWorldMatchesMap(map, seatOneWorld, {
      blocksByName: seatOne.bot.registry.blocksByName,
    });
    firstWorld = { seatZero: seatZeroWorld, seatOne: seatOneWorld };

    const chest = map.lootContainers[0];
    assert.ok(chest, "maps-reset fixture must declare a loot container");
    await active.start();
    await waitForActivePhase(active, signal);
    assert.deepStrictEqual(
      await seatZero.client.run({ kind: "containerOpen", position: chest.position }),
      { kind: "succeeded" },
      "the ordinary Mineflayer skill must collect items from the map chest",
    );
    const collectedInventory = observePlayerInventory(seatZero.bot);
    assert.ok(
      collectedInventory.items.some(({ item }) => item === chestItem),
      `the player inventory must contain ${chestItem} before death`,
    );

    await leavePlatformAndDie(seatZero.bot, signal);
    await active.waitForOutcome();
  }, t.signal);

  assert.ok(firstWorld, "first run must retain its initial client-observed map");
  assert.ok(seatZeroUuid && seatOneUuid, "first run must assign stable offline UUIDs to both seats");
  const firstDeathCount = stoppedDeaths(firstRun.inspection.stats, seatZeroUuid);
  assertPlayerDeathWasRecorded({ deaths: firstDeathCount });
  assertDeathWinner(firstRun, 1, 0, 2);

  const resetRuns = ["maps-reset-second", "maps-reset-third"] as const;
  for (const runId of resetRuns) {
    const resetRun = await runOwnedAcceptanceScenario(scenarioPath, runId, async (active, signal) => {
      const seatZero = duelCompetitorForSeat(active, 0);
      const seatOne = duelCompetitorForSeat(active, 1);
      const map = active.preparedRun.scenario.map;
      const usernamesBySeat = competitorUsernamesBySeat(active);
      const seatZeroWorld = await captureSemanticWorld(
        map,
        createMineflayerSemanticWorldReader(seatZero.bot, usernamesBySeat),
        signal,
      );
      const seatOneWorld = await captureSemanticWorld(
        map,
        createMineflayerSemanticWorldReader(seatOne.bot, usernamesBySeat),
        signal,
      );
      assertSemanticWorldMatchesMap(map, seatZeroWorld, {
        blocksByName: seatZero.bot.registry.blocksByName,
      });
      assertSemanticWorldMatchesMap(map, seatOneWorld, {
        blocksByName: seatOne.bot.registry.blocksByName,
      });
      assertResetWorldMatchesFirst(firstWorld!.seatZero, seatZeroWorld);
      assertResetWorldMatchesFirst(firstWorld!.seatOne, seatOneWorld);
      assertPlayerInventoryEmpty(observePlayerInventory(seatZero.bot));
      assertPlayerInventoryEmpty(observePlayerInventory(seatOne.bot));

      await active.start();
      await active.waitForOutcome();
    }, t.signal);

    assert.ok(seatZeroUuid && seatOneUuid);
    assertPlayerDeathStatsReset({ deaths: stoppedDeaths(resetRun.inspection.stats, seatZeroUuid) });
    assertPlayerDeathStatsReset({ deaths: stoppedDeaths(resetRun.inspection.stats, seatOneUuid) });
  }
});

function competitorUsernamesBySeat(active: AcceptanceRunContext): ReadonlyMap<number, string> {
  assert.equal(active.prepare.type, "prepare");
  return new Map(active.prepare.payload.roster.map(({ seat, username }) => [seat, username] as const));
}

async function waitForActivePhase(active: AcceptanceRunContext, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (active.events().some((event) => event.type === "public_clock" && event.payload.phase === "active")) return;
    await delay(50, undefined, { signal });
  }
  throw new Error("maps-reset match did not reach the active phase within 20000 ms");
}

async function leavePlatformAndDie(bot: Bot, signal: AbortSignal): Promise<void> {
  await bot.look(0, 0);
  const movementController = new AbortController();
  const movementSignal = AbortSignal.any([signal, movementController.signal]);
  const death = waitForDeath(bot, movementSignal);
  try {
    bot.setControlState("forward", true);
    await death;
  } finally {
    movementController.abort();
    bot.clearControlStates();
  }
}

function waitForDeath(bot: Bot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timeout);
      bot.removeListener("death", onDeath);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onDeath = (): void => finish();
    const onAbort = (): void => finish(signal.reason ?? new Error("maps-reset run aborted"));
    const timeout = setTimeout(() => finish(new Error("seat zero did not die within 20000 ms")), 20_000);
    bot.once("death", onDeath);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function stoppedDeaths(stats: readonly StoppedPlayerStats[], offlineUuid: string): number {
  const player = stats.find((entry) => entry.offlineUuid === offlineUuid);
  assert.ok(player, `stopped server inspection must include offline UUID ${offlineUuid}`);
  assert.equal(player.status, "present", `reset acceptance requires a present stats file for ${offlineUuid}`);
  if (player.deaths === null) throw new Error(`stopped server inspection must include a death counter for ${offlineUuid}`);
  return player.deaths;
}
