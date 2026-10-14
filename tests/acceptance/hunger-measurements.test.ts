import assert from "node:assert/strict";
import { test } from "node:test";

import { entityId } from "@arena/core";
import { createHungerRunMeasurements } from "./hunger-measurements.js";

test("hunger measurements identify disabled host resources and unavailable attack internals", () => {
  const measurements = createHungerRunMeasurements([0]);
  const evidence = measurements.snapshot();

  assert.equal(evidence.activeBoundary.status, "unavailable");
  assert.deepEqual(evidence.resources, {
    status: "unavailable",
    reason: "host resource sampling is disabled",
  });
  assert.equal(evidence.policyBySeat.get(0)?.attackMissCount.status, "unavailable");
  assert.equal(evidence.policyBySeat.get(0)?.attackReceiptWaitMilliseconds.status, "unavailable");
  assert.deepEqual(evidence.timingMetrics, {
    maximumEventLoopDelayMilliseconds: {
      status: "unavailable",
      reason: "the acceptance runner does not measure general event-loop delay",
    },
    serverTickTimeMilliseconds: {
      status: "unavailable",
      reason: "the runner does not expose authoritative server tick duration",
    },
    diagnosticOverheadMilliseconds: {
      status: "unavailable",
      reason: "the acceptance runner does not measure diagnostic instrumentation overhead",
    },
  });
});

test("hunger measurements include action callbacks received during run cleanup", () => {
  const measurements = createHungerRunMeasurements([3]);
  const target = entityId(7);
  measurements.markActiveBoundary(100n);
  measurements.onPolicyActivity({
    kind: "action",
    seat: 3,
    actionSequence: "1",
    intent: { kind: "attack", target },
    startedAtNs: 200n,
    settledAtNs: 1_000_200n,
    outcome: { kind: "cancelled", reason: "shutdown" },
    cleanupIncluded: true,
  });
  const evidence = measurements.snapshot();
  const policy = evidence.policyBySeat.get(3);
  assert.ok(policy);
  assert.equal(policy.actionCount, 1);
  assert.deepEqual(policy.actionOutcomeCounts, { "cancelled:shutdown": 1 });
  assert.deepEqual(policy.actionDuration.maximumMilliseconds, { status: "available", value: 1 });
});

test("hunger measurements preserve decision and skill timing while naming attack limits", () => {
  const measurements = createHungerRunMeasurements([3]);
  const target = entityId(7);
  measurements.onPolicyActivity({
    kind: "decision",
    seat: 3,
    tick: 4,
    sequence: "1",
    disposition: { kind: "start", action_sequence: "1" },
    goal: { kind: "engageVisibleOpponent", target },
    intent: { kind: "attack", target },
    tickReceivedAtNs: 100n,
    decisionStartedAtNs: 130n,
    acceptedAtNs: 150n,
  });
  measurements.onPolicyActivity({
    kind: "action",
    seat: 3,
    actionSequence: "1",
    intent: { kind: "attack", target },
    startedAtNs: 200n,
    settledAtNs: 1_000_200n,
    outcome: { kind: "failed", cause: "timedOut" },
    cleanupIncluded: true,
  });

  const policy = measurements.snapshot().policyBySeat.get(3);
  assert.ok(policy);
  assert.equal(policy.decisionCount, 1);
  assert.equal(policy.decisionStartLatency.maximumMilliseconds.status, "available");
  assert.deepEqual(policy.actionDuration.maximumMilliseconds, { status: "available", value: 1 });
  assert.deepEqual(policy.failedActionDuration.maximumMilliseconds, { status: "unavailable", reason: "no duration samples were recorded" });
  assert.equal(policy.settledActionDurationIncludesCleanup, true);
  assert.equal(policy.attackActionCount, 1);
  assert.equal(policy.attackNoObservedDamageTimeoutCount, 1);
  assert.equal(policy.attackMissCount.status, "unavailable");
  assert.equal(policy.attackReceiptWaitMilliseconds.status, "unavailable");
});
