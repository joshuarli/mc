import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { blockPosition } from "@arena/core";

import { waitForActivePhase } from "./support/duel.js";
import {
  concludeByDisconnect,
  countItem,
  CurriculumAgent,
  fineMove,
  seatFor,
  stageSeat,
  swingAndMeasure,
  takeFromChest,
} from "./support/curriculum-support.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

const SURVIVAL_SEED = 481516n;
const PEN_EXIT_X = 31;

test("curriculum-survival", { timeout: 600_000 }, async (t) => {
  const facts: Record<string, unknown> = {};
  await runOwnedAcceptanceScenario(
    "tests/integration/fixtures/curriculum-survival.toml",
    "curriculum-survival",
    async (active: AcceptanceRunContext, signal) => {
      const seat0 = seatFor(active, 0);
      const seat1 = seatFor(active, 1);
      const seat2 = seatFor(active, 2);
      await active.start();
      await waitForActivePhase(active, signal);

      await stageSeat(seat0, blockPosition(40, 65, 40), signal);
      await stageSeat(seat1, blockPosition(40, 65, 37), signal);
      await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
      const reach: { gap: number; damage: number }[] = [];
      for (const step of [0, 0.25, 0.25, 0.25, 0.25]) {
        if (step > 0) await fineMove(seat1.bot, "z", -step, signal);
        await delay(800, undefined, { signal });
        const gap = Number(Math.hypot(
          seat0.bot.entity.position.x - seat1.bot.entity.position.x,
          seat0.bot.entity.position.z - seat1.bot.entity.position.z,
        ).toFixed(2));
        reach.push({ gap, damage: await swingAndMeasure(seat0.bot, seat1.bot, signal) });
      }
      process.stderr.write(`CALIBRATION reach ${JSON.stringify(reach)}\n`);

      const penAgent = new CurriculumAgent(seat2, 2, SURVIVAL_SEED);
      const penDeadline = Date.now() + 60_000;
      while (seat2.bot.entity.position.x < PEN_EXIT_X && Date.now() < penDeadline) {
        await penAgent.step(signal);
      }
      facts.penExitX = seat2.bot.entity.position.x;
      assert.ok(seat2.bot.entity.position.x >= PEN_EXIT_X, "the boxed-in seat must keep probing until it leaves the pen");

      await stageSeat(seat0, blockPosition(29, 65, 30), signal);
      await stageSeat(seat1, blockPosition(31, 65, 30), signal);
      const [first, second] = await Promise.all([
        seat0.client.run({ kind: "containerOpen", position: { x: 30, y: 65, z: 30 } as never }),
        seat1.client.run({ kind: "containerOpen", position: { x: 30, y: 65, z: 30 } as never }),
      ]);
      await delay(500, undefined, { signal });
      const breads = [countItem(seat0.bot, "bread"), countItem(seat1.bot, "bread")];
      const swords = [countItem(seat0.bot, "iron_sword"), countItem(seat1.bot, "iron_sword")];
      facts.contendedChest = { outcomes: [first, second], breads, swords };
      assert.equal(breads[0]! + breads[1]!, 1, "the single bread must be held by exactly one client");
      assert.equal(swords[0]! + swords[1]!, 1, "the single sword must be held by exactly one client");
      for (const [index, outcome] of [first, second].entries()) {
        const held = breads[index]! + swords[index]!;
        if (outcome.kind === "succeeded") assert.ok(held > 0, `seat ${index} reported success without receiving an item`);
      }

      assert.deepStrictEqual(
        await takeFromChest(seat0, { x: 14, y: 65, z: 50 }, signal),
        { kind: "succeeded" },
      );
      const goldenSlot = seat0.bot.inventory.items().find((item) => item.name === "golden_apple");
      assert.ok(goldenSlot, "the always-edible item must be received");
      await stageSeat(seat0, blockPosition(20, 65, 40), signal);
      await stageSeat(seat1, blockPosition(20, 65, 20), signal);
      const foodBefore = countItem(seat0.bot, "golden_apple");
      const eating = seat0.client.run({ kind: "eat", inventorySlot: goldenSlot.slot as never });
      await delay(400, undefined, { signal });
      const approach = seat1.client.run({ kind: "navigate", target: { x: 20, y: 65, z: 38 } as never });
      const eatOutcome = await eating;
      await approach;
      facts.eating = { outcome: eatOutcome, apples: countItem(seat0.bot, "golden_apple"), before: foodBefore };
      assert.deepStrictEqual(eatOutcome, { kind: "failed", cause: "preconditionsNotMet" });
      assert.equal(countItem(seat0.bot, "golden_apple"), foodBefore, "an abandoned meal must not consume the item");

      const agent = new CurriculumAgent(seat0, 0, SURVIVAL_SEED);
      const shield = seat0.bot.inventory.items().find((item) => item.name === "shield");
      assert.ok(shield, "the shield must have been received from the declared chest");
      await seat0.bot.equip(shield, "off-hand");
      await stageSeat(seat0, blockPosition(24, 65, 36), signal);
      await stageSeat(seat1, blockPosition(24, 65, 34), signal);
      await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
      await seat1.bot.lookAt(seat0.bot.entity.position.offset(0, 1.6, 0), true);
      const blockedDamage: number[] = [];
      seat0.bot.activateItem(true);
      for (let hit = 0; hit < 3; hit += 1) {
        await delay(700, undefined, { signal });
        blockedDamage.push(await swingAndMeasure(seat1.bot, seat0.bot, signal));
      }
      seat0.bot.deactivateItem();
      await delay(700, undefined, { signal });
      const openDamage = await swingAndMeasure(seat1.bot, seat0.bot, signal);
      process.stderr.write(`CALIBRATION shield ${JSON.stringify({ blockedDamage, openDamage })}\n`);
      const usingSamples: boolean[] = [];
      const sampler = setInterval(() => usingSamples.push(seat0.bot.usingHeldItem), 50);
      try {
        for (let step = 0; step < 5; step += 1) {
          await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
          await agent.step(signal);
          await delay(300, undefined, { signal });
        }
      } finally {
        clearInterval(sampler);
      }
      facts.shieldRaisedSamples = usingSamples.filter(Boolean).length;
      assert.ok(usingSamples.some(Boolean), "the engagement must raise the offhand shield during the weapon cooldown");
      await stageSeat(seat1, blockPosition(21, 65, 41), signal);
      let escaped = false;
      const deadline = Date.now() + 200_000;
      while (Date.now() < deadline) {
        const observation = agent.observe();
        if (observation.border.kind === "current" && observation.border.value.radiusBlocks <= 15) {
          const decision = agent.decideOnly();
          facts.borderDecision = decision.goal.kind;
          escaped = true;
          break;
        }
        await delay(1_000, undefined, { signal });
      }
      assert.ok(escaped, "the border must shrink within the observation window");

      await concludeByDisconnect(active, [1, 2], signal);
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );
  t.diagnostic(JSON.stringify(facts));
});
