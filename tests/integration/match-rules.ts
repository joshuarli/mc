import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

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
      const chest = active.preparedRun.scenario.map.lootContainers[0];
      assert.ok(chest, "match-rules fixture must declare a chest within spawn reach");
      await seatZero.bot.look(0, 0);

      await assertPreReleaseLocked(active, seatZero, chest.position, "waiting", signal);
      await active.start();
      await assertPreReleaseLocked(active, seatZero, chest.position, "countdown", signal);

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
      await active.waitForOutcome();
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
  phase: "waiting" | "countdown",
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
  phase: "waiting" | "countdown",
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

function latestPhase(active: AcceptanceRunContext): string | undefined {
  return active.events().findLast((event) => event.type === "public_clock")?.payload.phase;
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
