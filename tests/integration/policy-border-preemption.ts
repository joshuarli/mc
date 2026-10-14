import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { isNearOrOutsideBorder, rehydratePolicyReplayInput } from "@arena/core";
import { canonicalJson } from "../../packages/arena-runner/src/canonical.js";
import { stageOwnedFile } from "../../packages/arena-runner/src/owned-files/index.js";
import { replayPolicyJson } from "../../packages/arena-runner/src/policy-replay.js";
import { readRunEvidence } from "../../packages/arena-runner/src/runtime/inspect.js";
import type { PolicyActivityEvent } from "../../packages/arena-runner/src/runtime/live-policy-loop.js";
import { runOwnedAcceptanceScenario } from "./support/owned-run.js";

type DecisionReceipt = Extract<PolicyActivityEvent, { kind: "decision" }>;
type ActionReceipt = Extract<PolicyActivityEvent, { kind: "action" }>;
const STRATEGY_INTERVAL_TICKS = 4;
const MAX_TICKS = 120;
const SUMMARY_MAX_BYTES = 16 * 1024;

test("policy-border-preemption", { timeout: 300_000 }, async (t) => {
  const activity: PolicyActivityEvent[] = [];
  const run = await runOwnedAcceptanceScenario(
    "tests/integration/fixtures/policy-border-preemption.toml",
    "policy-border-preemption",
    async (active) => {
      const scenario = active.preparedRun.scenario;
      assert.deepStrictEqual(scenario.map.spawns.find(({ seat }) => seat === 0)?.position,
        { x: 4, y: 65, z: 32 });
      assert.equal(scenario.matchSettings.authoritativeMaxTicks, BigInt(MAX_TICKS));
      assert.equal(scenario.matchSettings.graceTicks, 0n);
      assert.equal(scenario.bots.strategyIntervalTicks, BigInt(STRATEGY_INTERVAL_TICKS));
      assert.deepStrictEqual(scenario.border, {
        initialDiameterBlocks: 62, shrinkStartTick: 0n,
        shrinkEndTick: 4n, finalDiameterBlocks: 56,
      });
      await active.start();
      await active.waitForOutcome();
    },
    t.signal,
    {
      onPolicyActivity: (event) => {
        if (activity.length >= MAX_TICKS * 2) throw new Error("bounded preemption activity overflow");
        activity.push(event);
      },
    },
  );
  assert.equal(run.outcome.kind, "draw");
  if (run.outcome.kind !== "draw") throw new Error("the diagnostic match did not reach a draw");
  assert.equal(run.outcome.reason, "tick_limit");
  assert.deepStrictEqual(run.outcome.at, { domain: "match", value: BigInt(MAX_TICKS) });
  assert.deepStrictEqual(run.outcome.survivors, [0, 1]);

  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(process.cwd(), ".work/arena-fs/arena-fs");
  const ownedRoot = Buffer.from(process.cwd(), "utf8");
  const runPath = Buffer.from(`.work/arena/runs/${run.runId}`, "ascii");
  const { evidence } = await readRunEvidence(helperPath, ownedRoot, runPath, run.runId);
  const replay = replayPolicyJson(evidence);
  assert.equal(replay.verified, true);
  const inputs = evidence.records.flatMap((record) => {
    if (record.schema !== "policy-replay-v2" || record.seat !== 0) return [];
    const input = rehydratePolicyReplayInput(record.input);
    assert.equal(input.schema, "policy-input-v2");
    const { agent, border } = input.observation;
    if (agent.kind !== "current" || border.kind !== "current") return [];
    const receipt = activity.find((event): event is DecisionReceipt =>
      event.kind === "decision" && event.seat === 0 && event.sequence === record.sequence);
    assert.ok(receipt, "every recorded decision must have its actual timing receipt");
    assert.equal(receipt.tick, input.observation.tick);
    const decision = record.decision;
    assert.ok(decision !== null && typeof decision === "object" && !Array.isArray(decision));
    assert.ok("goal" in decision && "intent" in decision);
    assertSameJson(receipt.goal, decision.goal);
    assertSameJson(receipt.intent, decision.intent);
    assertSameJson(receipt.disposition, record.disposition);
    return [{ receipt, position: agent.value.position, border: border.value,
      unsafe: isNearOrOutsideBorder(border.value, agent.value.position, input.params.values.borderMarginBlocks) }];
  });
  const firstUnsafe = inputs.findIndex(({ unsafe }) => unsafe);
  const escape = inputs[firstUnsafe];
  const previous = inputs[firstUnsafe - 1];
  const replacement = escape?.receipt.disposition;
  const priorSequence = replacement?.kind === "replace" ? replacement.replaces_action_sequence : undefined;
  const priorDecision = activity.find((event): event is DecisionReceipt =>
    event.kind === "decision" && event.seat === 0 && event.sequence === priorSequence);
  const priorAction = actionReceipt(activity, priorSequence);
  const escapeAction = actionReceipt(activity, escape?.receipt.sequence);
  const cleanupWaitNs = escape !== undefined && priorAction !== undefined
    ? priorAction.settledAtNs - escape.receipt.acceptedAtNs : null;
  const successorWaitNs = priorAction !== undefined && escapeAction?.startedAtNs !== null
      && escapeAction?.startedAtNs !== undefined
    ? escapeAction.startedAtNs - priorAction.settledAtNs : null;

  // Clock messages and Minecraft border packets arrive independently; only recorded client inputs establish danger.
  const summary = {
    schema: 1, run_id: run.runId, outcome: run.outcome, replay,
    previous_safe_input: previous ?? null, first_unsafe_input: escape ?? null,
    replaced_decision: priorDecision ?? null, replaced_action: priorAction ?? null,
    replacement_action: escapeAction ?? null,
    cancel_settlement_after_acceptance_ns: cleanupWaitNs,
    replacement_start_after_settlement_ns: successorWaitNs,
  };
  const contents = Buffer.from(`${JSON.stringify(summary, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value)}\n`, "utf8");
  assert.ok(contents.length <= SUMMARY_MAX_BYTES, "compact preemption summary must fit its fixed byte bound");
  await stageOwnedFile({ helperPath, ownedRoot,
    relativePath: Buffer.concat([runPath, Buffer.from("/policy-preemption-summary.json", "ascii")]),
    contents, maxBytes: SUMMARY_MAX_BYTES });

  assert.ok(escape && previous, "the first unsafe eligible input must follow a safe eligible input");
  assert.equal(previous.unsafe, false);
  assert.equal(escape.receipt.tick - previous.receipt.tick, STRATEGY_INTERVAL_TICKS);
  assert.equal(escape.receipt.goal.kind, "escapeBorder");
  assert.equal(escape.receipt.intent.kind, "navigate");
  if (escape.receipt.intent.kind !== "navigate") throw new Error("escape intent was not navigation");
  assert.deepStrictEqual(escape.receipt.intent.target,
    { x: escape.border.centerX, y: escape.position.y, z: escape.border.centerZ });
  assert.ok(replacement?.kind === "replace");
  assert.equal(replacement.reason, "higherPriority");
  assert.ok(priorDecision && priorAction && escapeAction);
  assert.ok(priorDecision.goal.kind === "loot" || priorDecision.goal.kind === "explore");
  assert.equal(priorDecision.intent.kind, "navigate");
  assert.ok(priorAction.startedAtNs !== null && priorAction.startedAtNs < escape.receipt.acceptedAtNs);
  assert.deepStrictEqual(priorAction.outcome, { kind: "cancelled", reason: "replaced" });
  assert.equal(priorAction.cleanupIncluded, true);
  assert.ok(cleanupWaitNs !== null && cleanupWaitNs > 0n,
    "danger must be accepted while the replaced navigation is still unsettled");
  assert.ok(successorWaitNs !== null && successorWaitNs >= 0n,
    "replacement controls must start after prior cleanup settles");
  t.diagnostic(`seat 0 ticks ${previous.receipt.tick}->${escape.receipt.tick}; `
    + `cancellation settles ${Number(cleanupWaitNs) / 1e6} ms after acceptance; `
    + `replacement starts ${Number(successorWaitNs) / 1e6} ms after settlement`);
});

function actionReceipt(events: readonly PolicyActivityEvent[], sequence: string | undefined): ActionReceipt | undefined {
  return events.find((event): event is ActionReceipt =>
    event.kind === "action" && event.seat === 0 && event.actionSequence === sequence);
}

function assertSameJson(actual: unknown, expected: unknown): void {
  assert.deepStrictEqual(canonicalJson(actual), canonicalJson(expected));
}
