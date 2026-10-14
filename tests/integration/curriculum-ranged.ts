import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { blockPosition, type ActionFunnelRecord } from "@arena/core";

import { waitForActivePhase } from "./support/duel.js";
import {
  concludeByDisconnect,
  countItem,
  CurriculumAgent,
  seatFor,
  stageSeat,
  strafeUntilAborted,
  takeFromChest,
  trackArrow,
} from "./support/curriculum-support.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

const RANGED_SEED = 481516n;
const MIN_SHOTS = 3;
const MIN_VICTIM_HEALTH = 12;
const MAX_STEPS = 40;

test("curriculum-ranged", { timeout: 600_000 }, async (t) => {
  const shots: ActionFunnelRecord[] = [];
  let arrowsBefore = 0;
  let arrowsAfter = 0;
  let coverArrowsBefore = 0;
  let coverArrowsAfter = 0;
  let coverRecord: ActionFunnelRecord | undefined;
  let heldDuringShots = new Set<string>();
  let victimHealthLost = 0;
  await runOwnedAcceptanceScenario(
    "tests/integration/fixtures/curriculum-ranged.toml",
    "curriculum-ranged",
    async (active: AcceptanceRunContext, signal) => {
      const archer = seatFor(active, 0);
      const target = seatFor(active, 1);
      await active.start();
      await waitForActivePhase(active, signal);
      const agent = new CurriculumAgent(archer, 0, RANGED_SEED);

      assert.deepStrictEqual(
        await takeFromChest(archer, { x: 10, y: 65, z: 50 }, signal),
        { kind: "succeeded" },
        "the archer must receive the declared bow and arrows through an ordinary chest interaction",
      );
      assert.ok(countItem(archer.bot, "bow") === 1, "the archer must hold the bow");
      arrowsBefore = countItem(archer.bot, "arrow");
      assert.ok(arrowsBefore >= 10, `the archer must receive arrows, saw ${arrowsBefore}`);

      await stageSeat(archer, blockPosition(10, 65, 46), signal);
      await stageSeat(target, blockPosition(21, 65, 46), signal);
      const bowItem = archer.bot.inventory.items().find((item) => item.name === "bow");
      assert.ok(bowItem, "the archer must hold a bow");
      await archer.bot.equip(bowItem, "hand");
      await archer.bot.lookAt(target.bot.entity.position.offset(0, 1.2, 0), true);
      const flights: { drawTicks: number; flights: unknown[] }[] = [];
      for (const drawTicks of [20, 10]) {
        const tracker = trackArrow(archer.bot);
        archer.bot.activateItem();
        await delay(drawTicks * 50 + 30, undefined, { signal });
        archer.bot.deactivateItem();
        await delay(900, undefined, { signal });
        flights.push({ drawTicks, flights: tracker.stop() });
      }
      process.stderr.write(`CALIBRATION bow-flight ${JSON.stringify(flights)}\n`);
      arrowsBefore = countItem(archer.bot, "arrow");

      const victims = [target, seatFor(active, 2)];
      let lowestTotal = 0;
      for (const [victimIndex, victim] of victims.entries()) {
        if (victimIndex > 0) {
          await stageSeat(archer, blockPosition(10, 65, 46), signal);
          await stageSeat(victim, blockPosition(21, 65, 46), signal);
        }
        const strafing = new AbortController();
        const stop = () => strafing.abort();
        signal.addEventListener("abort", stop, { once: true });
        const strafe = strafeUntilAborted(victim.bot, strafing.signal);
        const healthStart = victim.bot.health;
        let lowest = healthStart;
        try {
          for (let step = 0; step < MAX_STEPS && victim.bot.health > MIN_VICTIM_HEALTH; step += 1) {
            const result = await agent.step(signal);
            lowest = Math.min(lowest, victim.bot.health);
            process.stderr.write(`STEP ${JSON.stringify({
              goal: result.decision.goal.kind,
              intent: result.decision.intent,
              outcome: result.outcome,
              funnel: result.funnel,
              ticks: result.ticks,
              gap: Number(Math.hypot(
                archer.bot.entity.position.x - victim.bot.entity.position.x,
                archer.bot.entity.position.z - victim.bot.entity.position.z,
              ).toFixed(1)),
              victimHealth: victim.bot.health,
            })}\n`);
            if (result.funnel?.action === "shoot" && archer.bot.heldItem !== null) {
              heldDuringShots.add(archer.bot.heldItem.name);
            }
            if (result.decision.intent.kind === "hold") await delay(100, undefined, { signal });
          }
        } finally {
          strafing.abort();
          await strafe;
        }
        lowestTotal += healthStart - lowest;
      }
      victimHealthLost = lowestTotal;
      arrowsAfter = countItem(archer.bot, "arrow");
      shots.push(...agent.tally.funnel.filter((record) => record.action === "shoot"));

      await stageSeat(archer, blockPosition(40, 65, 48), signal);
      await stageSeat(target, blockPosition(46, 65, 41), signal);
      await stageSeat(target, blockPosition(46, 65, 48), signal);
      coverArrowsBefore = countItem(archer.bot, "arrow");
      const forced = await agent.runIntent({ kind: "approach", target: target.bot.entity.id as never }, signal);
      coverArrowsAfter = countItem(archer.bot, "arrow");
      coverRecord = forced.funnel ?? undefined;
      assert.equal(forced.outcome?.kind, "failed", "an occluded target must not be engaged");

      await concludeByDisconnect(active, [1, 2], signal);
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  const hits = shots.filter((record) => record.kind === "reached").length;
  const misses = shots.filter((record) => record.kind === "stopped" && record.reason === "shotMissed").length;
  const consumed = arrowsBefore - arrowsAfter;
  t.diagnostic(`shots=${shots.length} hits=${hits} misses=${misses} arrowsConsumed=${consumed} held=${[...heldDuringShots]} victimHealthLost=${victimHealthLost}`);
  assert.ok(shots.length >= MIN_SHOTS, `at least ${MIN_SHOTS} shots must be taken, saw ${shots.length}`);
  assert.equal(consumed, hits + misses, "every consumed arrow must be reported as a hit or a miss");
  assert.ok(hits >= 1, "at least one arrow must be confirmed to hit by the received damage");
  assert.ok(victimHealthLost > 0, "the target's server-sent health must fall");
  assert.ok(heldDuringShots.has("bow"), "the archer must switch to the bow to shoot");
  assert.equal(coverArrowsAfter, coverArrowsBefore, "no arrow may be spent against a target behind cover");
  assert.ok(
    coverRecord !== undefined && coverRecord.kind === "stopped" && coverRecord.reason === "blockedLineOfSight",
    `cover must be reported as blockedLineOfSight, saw ${JSON.stringify(coverRecord)}`,
  );
});
