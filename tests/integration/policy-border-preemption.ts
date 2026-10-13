import assert from "node:assert/strict";
import { test } from "node:test";

import type { PolicyActivityEvent } from "../../packages/arena-runner/src/runtime/live-policy-loop.js";
import { runOwnedAcceptanceScenario } from "./support/owned-run.js";

const STRATEGY_INTERVAL_TICKS = 4;
const FIRST_POLICY_TICK = 0;
const BORDER_ESCAPE_TICK = FIRST_POLICY_TICK + STRATEGY_INTERVAL_TICKS;
const BASELINE_BORDER_MARGIN_BLOCKS = 2;

test("policy-border-preemption", { timeout: 300_000 }, async (t) => {
  const activity: PolicyActivityEvent[] = [];
  const run = await runOwnedAcceptanceScenario(
    "tests/integration/fixtures/policy-border-preemption.toml",
    "policy-border-preemption",
    async (active) => {
      const scenario = active.preparedRun.scenario;
      const seatZeroSpawn = scenario.map.spawns.find(({ seat }) => seat === 0);
      assert.deepStrictEqual(seatZeroSpawn?.position, { x: 4, y: 65, z: 32 },
        "the policy probe must begin at its validated western spawn");
      assert.equal(scenario.matchSettings.authoritativeMaxTicks, 120n,
        "the diagnostic run must end shortly after the bounded replacement window");
      assert.equal(scenario.matchSettings.graceTicks, 0n, "policy tick zero must begin in the active phase");
      assert.equal(scenario.bots.strategyIntervalTicks, BigInt(STRATEGY_INTERVAL_TICKS));
      assert.deepStrictEqual(scenario.border, {
        initialDiameterBlocks: 62,
        shrinkStartTick: 0n,
        shrinkEndTick: 4n,
        finalDiameterBlocks: 56,
      }, "natural border geometry must cross the policy threshold at tick four");
      const spawnDistance = Math.abs(seatZeroSpawn!.position.x - scenario.map.dimensions.width / 2);
      const initialSafeRadius = scenario.border.initialDiameterBlocks / 2 - BASELINE_BORDER_MARGIN_BLOCKS;
      const finalPhysicalRadius = scenario.border.finalDiameterBlocks / 2;
      const finalSafeRadius = finalPhysicalRadius - BASELINE_BORDER_MARGIN_BLOCKS;
      assert.ok(spawnDistance < initialSafeRadius, "seat zero must start safely inside the policy margin");
      assert.ok(spawnDistance >= finalSafeRadius, "the final natural border must make seat zero policy-unsafe");
      assert.ok(spawnDistance <= finalPhysicalRadius, "the final natural border must still contain the spawn physically");
      await active.start();
      await active.waitForOutcome();
    },
    t.signal,
    {
      competitorDriver: "baselinePolicy",
      onPolicyActivity: (event) => activity.push(event),
    },
  );

  assertObserved(
    run.outcome.kind === "draw"
      && run.outcome.reason === "tick_limit"
      && run.outcome.at.domain === "match"
      && run.outcome.at.value === 120n
      && run.outcome.survivors.length === 2,
    "baseline policy fixture must reach its natural two-survivor tick-limit draw",
    activity,
  );

  const firstNavigation = activity.find((event) => event.kind === "decision"
    && event.seat === 0 && event.tick === FIRST_POLICY_TICK);
  assertObserved(firstNavigation?.kind === "decision", "seat zero must receive its tick-zero policy decision", activity);
  assertObserved(firstNavigation.goal.kind === "loot", "seat zero must choose the visible chest before border danger", activity);
  assertObserved(firstNavigation.intent.kind === "navigate", "the lower-priority chest goal must be an active navigation", activity);
  assertObserved(firstNavigation.disposition.kind === "start", "the tick-zero navigation must start a new action", activity);

  const escape = activity.find((event) => event.kind === "decision"
    && event.seat === 0 && event.tick === BORDER_ESCAPE_TICK);
  assertObserved(escape?.kind === "decision", "seat zero must be reobserved at the next configured policy tick", activity);
  assertObserved(escape.goal.kind === "escapeBorder", "the natural shrink must make the policy choose border escape", activity);
  assertObserved(escape.intent.kind === "navigate"
    && escape.intent.target.x === 32 && escape.intent.target.z === 32,
  "the border policy must navigate toward the authoritative map center", activity);
  assertObserved(escape.disposition.kind === "replace", "border escape must replace the active navigation", activity);
  if (escape.disposition.kind !== "replace") throw new Error("border escape replacement was not recorded");
  assertObserved(
    escape.disposition.reason === "higherPriority"
      && escape.disposition.replaces_action_sequence === firstNavigation.sequence,
    "border escape must replace the exact lower-priority action for priority reasons",
    activity,
  );

  const priorAction = actionEvent(activity, firstNavigation.sequence);
  const escapeAction = actionEvent(activity, escape.sequence);
  assertObserved(priorAction.startedAtNs !== null, "the original navigation must have started before preemption", activity);
  assertObserved(priorAction.outcome.kind === "cancelled" && priorAction.outcome.reason === "replaced",
    "the original navigation must settle through replacement cancellation", activity);
  assertObserved(priorAction.cleanupIncluded, "the original action settlement must include resource cleanup", activity);
  assertObserved(escapeAction.startedAtNs !== null, "the border-escape navigation must start after replacement", activity);

  const cleanupWaitNs = priorAction.settledAtNs - escape.acceptedAtNs;
  const successorStartDelayNs = escapeAction.startedAtNs - priorAction.settledAtNs;
  assertObserved(cleanupWaitNs > 0n, "the border decision must be accepted while the original action is still unsettled", activity);
  assertObserved(successorStartDelayNs >= 0n, "the replacement must start only after prior cleanup settles", activity);
  t.diagnostic(`seat 0 ticks ${firstNavigation.tick}->${escape.tick}; cancel settlement ${formatMilliseconds(cleanupWaitNs)} ms after acceptance; border action start ${formatMilliseconds(successorStartDelayNs)} ms after settlement`);
});

function actionEvent(
  events: readonly PolicyActivityEvent[],
  sequence: string,
): Extract<PolicyActivityEvent, { readonly kind: "action" }> {
  const event = events.find((candidate): candidate is Extract<PolicyActivityEvent, { readonly kind: "action" }> =>
    candidate.kind === "action" && candidate.seat === 0 && candidate.actionSequence === sequence,
  );
  assertObserved(event !== undefined, `seat-zero action ${sequence} must settle`, events);
  return event;
}

function assertObserved(condition: boolean, message: string, events: readonly PolicyActivityEvent[]): asserts condition {
  assert.ok(condition, `${message}; recent policy activity: ${summarizeActivity(events)}`);
}

function summarizeActivity(events: readonly PolicyActivityEvent[]): string {
  const relevant = events.filter((event) => event.seat === 0 && (
    event.kind === "decision" ? event.tick <= BORDER_ESCAPE_TICK : true
  ));
  const summaries = relevant.slice(0, 12).map((event) => {
    if (event.kind === "decision") {
      return { kind: event.kind, tick: event.tick, sequence: event.sequence, goal: event.goal.kind,
        intent: event.intent.kind, disposition: event.disposition };
    }
    if (event.kind === "action") {
      return { kind: event.kind, sequence: event.actionSequence, startedAtNs: event.startedAtNs?.toString() ?? null,
        settledAtNs: event.settledAtNs.toString(), outcome: event.outcome, cleanupIncluded: event.cleanupIncluded };
    }
    return { kind: event.kind, sequence: event.actionSequence, startedAtNs: event.startedAtNs?.toString() ?? null,
      settledAtNs: event.settledAtNs.toString() };
  });
  return JSON.stringify(summaries);
}

function formatMilliseconds(nanoseconds: bigint): string {
  return (Number(nanoseconds) / 1_000_000).toFixed(3);
}
