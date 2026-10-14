import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { blockPosition } from "@arena/core";

import { waitForActivePhase } from "./support/duel.js";
import {
  concludeByDisconnect,
  CurriculumAgent,
  serverDamageEvents,
  fineMove,
  seatFor,
  stageSeat,
  swingAndMeasure,
} from "./support/curriculum-support.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

const MELEE_SEED = 481516n;
const MAX_ENGAGEMENT_TICKS = 120;
const MIN_ISSUED_ATTACKS = 20;
const MIN_DAMAGE_EVENTS = 10;
const MAX_ADMISSION_FAILURE_RATE = 0.05;
const MIN_VICTIM_HEALTH = 4;

const vec = (value: { readonly x: number; readonly y: number; readonly z: number }) => ({
  x: Number(value.x.toFixed(2)), y: Number(value.y.toFixed(2)), z: Number(value.z.toFixed(2)),
});

interface PhaseReport {
  readonly phase: string;
  readonly attacks: number;
  readonly rejections: number;
  readonly victimHealthLost: number;
}

test("curriculum-melee", { timeout: 600_000 }, async (t) => {
  const calibration = { knockbackAndCooldown: [] as { interval: number; full: number; quick: number; knockbackBlocks: number }[] };
  const phases: PhaseReport[] = [];
  const trace: unknown[] = [];
  let agentAttacks = 0;
  let agentRejections = 0;
  const run = await runOwnedAcceptanceScenario(
    "tests/integration/fixtures/curriculum-melee.toml",
    "curriculum-melee",
    async (active: AcceptanceRunContext, signal) => {
      const seat0 = seatFor(active, 0);
      const seat1 = seatFor(active, 1);
      const seat2 = seatFor(active, 2);
      const healthiest = () => (seat1.bot.health >= seat2.bot.health ? seat1 : seat2);
      await active.start();
      await waitForActivePhase(active, signal);
      const agent = new CurriculumAgent(seat0, 0, MELEE_SEED);
      const events: string[] = [];
      for (const name of ["path_update", "goal_reached", "path_reset", "path_stop", "goal_updated"] as const) {
        seat0.bot.on(name as never, ((payload: { status?: string; path?: unknown[] } | undefined) => {
          events.push(`${name}${payload?.status === undefined ? "" : `:${payload.status}`}${Array.isArray(payload?.path) ? `:${payload.path.length}` : ""}`);
          if (events.length > 60) events.shift();
        }) as never);
      }

      const engage = async (phase: string, iterations: number, fixedVictim?: typeof seat1): Promise<void> => {
        let victim = fixedVictim ?? healthiest();
        const attacksBefore = agent.tally.attacks;
        const rejectionsBefore = agent.tally.attackRejections;
        const healthBefore = victim.bot.health;
        let lowestHealth = healthBefore;
        await seat0.bot.lookAt(victim.bot.entity.position.offset(0, 1.6, 0), true);
        for (let index = 0; index < iterations; index += 1) {
          if (victim.bot.health <= MIN_VICTIM_HEALTH) {
            const next = fixedVictim === undefined ? healthiest() : undefined;
            if (next === undefined || next.bot.health <= MIN_VICTIM_HEALTH) break;
            victim = next;
          }
          const separation = Math.hypot(
            seat0.bot.entity.position.x - victim.bot.entity.position.x,
            seat0.bot.entity.position.z - victim.bot.entity.position.z,
          );
          if (separation > 5) {
            const here = seat0.bot.entity.position;
            const dz = here.z > 20 ? -2 : 2;
            await stageSeat(victim, blockPosition(Math.floor(here.x), 65, Math.floor(here.z) + dz), signal);
            await seat0.bot.lookAt(victim.bot.entity.position.offset(0, 1.6, 0), true);
          }
          const step = await agent.step(signal);
          lowestHealth = Math.min(lowestHealth, victim.bot.health);
          trace.push({
            phase,
            goal: step.decision.goal.kind,
            intent: step.decision.intent,
            outcome: step.outcome,
            funnel: step.funnel,
            ticks: step.ticks,
            victimHealth: victim.bot.health,
            self: vec(seat0.bot.entity.position),
            victim: vec(victim.bot.entity.position),
            selfVelocity: vec(seat0.bot.entity.velocity),
            victimVelocity: vec(victim.bot.entity.velocity),
            gap: Math.hypot(
              seat0.bot.entity.position.x - victim.bot.entity.position.x,
              seat0.bot.entity.position.z - victim.bot.entity.position.z,
            ),
          });
          const combat = step.decision.intent.kind === "attack" || step.decision.intent.kind === "approach";
          if (combat && step.outcome !== null && step.ticks > MAX_ENGAGEMENT_TICKS) {
            assert.fail(`${phase}: a single engagement waited ${step.ticks} ticks: ${JSON.stringify(trace.slice(-3))} events=${events.slice(-40).join(',')}`);
          }
        }
        phases.push({
          phase,
          attacks: agent.tally.attacks - attacksBefore,
          rejections: agent.tally.attackRejections - rejectionsBefore,
          victimHealthLost: healthBefore - lowestHealth,
        });
      };

      await stageSeat(seat0, blockPosition(20, 65, 30), signal);
      await stageSeat(seat1, blockPosition(20, 65, 28), signal);
      await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
      const probe = calibration.knockbackAndCooldown;
      for (const interval of [5, 2]) {
        await delay(700, undefined, { signal });
        const startedAt = seat1.bot.entity.position.clone();
        const full = await swingAndMeasure(seat0.bot, seat1.bot, signal);
        const displacement = startedAt.distanceTo(seat1.bot.entity.position);
        await delay(interval * 50, undefined, { signal });
        const quick = await swingAndMeasure(seat0.bot, seat1.bot, signal);
        probe.push({ interval, full, quick, knockbackBlocks: Number(displacement.toFixed(2)) });
      }
      process.stderr.write(`CALIBRATION fist-cooldown-knockback ${JSON.stringify(probe)}\n`);
      await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
      await engage("static", 22);

      const boundaryVictim = healthiest();
      await stageSeat(seat0, blockPosition(20, 65, 40), signal);
      await stageSeat(boundaryVictim, blockPosition(20, 65, 37), signal);
      for (let correction = 0; correction < 6; correction += 1) {
        const wanted = Math.floor(seat0.bot.entity.position.z) - 3 + 0.2;
        const delta = wanted - boundaryVictim.bot.entity.position.z;
        if (Math.abs(delta) < 0.06) break;
        await fineMove(boundaryVictim.bot, "z", delta, signal);
      }
      await seat0.bot.lookAt(boundaryVictim.bot.entity.position.offset(0, 1.6, 0), true);
      const gap = Math.abs(seat0.bot.entity.position.z - boundaryVictim.bot.entity.position.z);
      assert.ok(gap > 3.15 && gap < 3.95, `fractional boundary staging produced a ${gap} block gap (agent z ${seat0.bot.entity.position.z}, victim z ${boundaryVictim.bot.entity.position.z})`);
      assert.equal(
        Math.floor(seat0.bot.entity.position.z) - Math.floor(boundaryVictim.bot.entity.position.z),
        3,
        "the staged pair must have integer distance 3",
      );
      await engage("fractional-boundary", 12, boundaryVictim);

      agentAttacks = agent.tally.attacks;
      agentRejections = agent.tally.attackRejections;

      const covered = healthiest();
      await stageSeat(seat0, blockPosition(43, 65, 48), signal);
      await stageSeat(covered, blockPosition(46, 65, 41), signal);
      await stageSeat(covered, blockPosition(45, 65, 48), signal);
      await seat0.bot.lookAt(covered.bot.entity.position.offset(0, 1.6, 0), true);
      await delay(300, undefined, { signal });
      const coveredHealth = covered.bot.health;
      const behindWall = agent.observe();
      assert.ok(
        behindWall.opponents.kind === "current"
          && !behindWall.opponents.value.some((opponent) => opponent.id === covered.bot.entity.id),
        "an opponent behind a one-block wall must not be a visible opponent",
      );
      const forced = await agent.runIntent({ kind: "attack", target: covered.bot.entity.id as never }, signal);
      assert.deepStrictEqual(forced.outcome, { kind: "failed", cause: "preconditionsNotMet" });
      assert.ok(
        forced.funnel !== null && forced.funnel.kind === "stopped" && forced.funnel.reason === "blockedLineOfSight",
        `cover must be reported as blockedLineOfSight, saw ${JSON.stringify(forced.funnel)}`,
      );
      await delay(300, undefined, { signal });
      assert.equal(covered.bot.health, coveredHealth, "no damage may pass through the wall");
      agentAttacks = agent.tally.attacks - 1;
      agentRejections = agent.tally.attackRejections - 1;

      await stageSeat(seat0, blockPosition(20, 65, 20), signal);
      await stageSeat(seat1, blockPosition(20, 65, 18), signal);
      await stageSeat(seat2, blockPosition(23, 65, 20), signal);
      await seat0.bot.lookAt(seat1.bot.entity.position.offset(1.5, 1.6, 1.5), true);
      await seat2.bot.lookAt(seat0.bot.entity.position.offset(0, 1.6, 0), true);
      const aggressor = await seat2.client.run({ kind: "attack", target: seat0.bot.entity.id as never });
      t.diagnostic(`aggressor swing: ${JSON.stringify(aggressor)}`);
      const choice = agent.decideOnly();
      t.diagnostic(`two-opponent choice: ${JSON.stringify(choice.goal)} ${JSON.stringify(choice.intent)}`);
      assert.deepStrictEqual(
        choice.goal,
        { kind: "engageVisibleOpponent", target: seat2.bot.entity.id },
        "the attacked client must engage the opponent that attacked it, not the nearer bystander",
      );

      await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
      await stageSeat(seat0, blockPosition(20, 65, 21), signal);
      await seat0.bot.lookAt(seat1.bot.entity.position.offset(0, 1.6, 0), true);
      const disconnecting = agent.step(signal);
      setTimeout(() => {
        try {
          seat1.bot.quit("mid-swing disconnect");
        } catch {
          // already disconnected
        }
      }, 120);
      const interrupted = await disconnecting;
      assert.ok(interrupted.ticks <= MAX_ENGAGEMENT_TICKS, `a vanished target must retire the action promptly, took ${interrupted.ticks} ticks`);
      await delay(1_000, undefined, { signal });
      const afterwards = agent.decideOnly();
      assert.ok(
        !(afterwards.goal.kind === "engageVisibleOpponent" && afterwards.goal.target === seat1.bot.entity.id),
        "the departed opponent must not remain the engagement target",
      );
      await concludeByDisconnect(active, [2], signal);
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  t.diagnostic(`calibration fist cooldown and knockback: ${JSON.stringify(calibration.knockbackAndCooldown)}`);
  const attackerName = "ArenaBot0";
  const serverHits = serverDamageEvents(run.runId).filter((event) => event.attacker === attackerName).length;
  for (const phase of phases) {
    t.diagnostic(`${phase.phase}: attacks=${phase.attacks} rejections=${phase.rejections} victimHealthLost=${phase.victimHealthLost}`);
  }
  t.diagnostic(`server-attributed hits=${serverHits} attacks=${agentAttacks} rejections=${agentRejections}`);
  assert.ok(agentAttacks >= MIN_ISSUED_ATTACKS, `at least ${MIN_ISSUED_ATTACKS} attacks must be issued, saw ${agentAttacks}`);
  assert.ok(serverHits >= MIN_DAMAGE_EVENTS, `at least ${MIN_DAMAGE_EVENTS} server-attributed damage events, saw ${serverHits}`);
  assert.ok(agentRejections / agentAttacks < MAX_ADMISSION_FAILURE_RATE, "self-inflicted admission failures must stay below 5%");
});
