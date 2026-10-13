import assert from "node:assert/strict";
import { test } from "node:test";

import { entityId } from "@arena/core";
import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import type { ResourceMonitorSampleEvent } from "../../packages/arena-runner/src/runtime/resource-monitor.js";
import { createHungerRunMeasurements } from "./hunger-measurements.js";

test("hunger measurements mark unsampled phases and attack internals unavailable", () => {
  const measurements = createHungerRunMeasurements([0]);
  const evidence = measurements.snapshot();

  assert.equal(evidence.activeBoundary.status, "unavailable");
  assert.equal(evidence.resources.startup.sampleCount, 0);
  assert.equal(evidence.resources.startup.peakSummedRssBytes.status, "unavailable");
  assert.equal(evidence.resources.active.nodeUserCpuTime.totalMilliseconds.status, "unavailable");
  assert.equal(evidence.resources.startup.commands.status, "unavailable");
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
  assert.equal(evidence.resourcePhaseScope, "active_samples_include_post_outcome_action_settlement_and_final_resource_sample");
});

test("hunger measurements split resource samples at the observed active boundary", () => {
  const measurements = createHungerRunMeasurements([0]);
  measurements.onResourceSample(resourceSample(100n, 10, 3, 15n, 0n));
  measurements.markActiveBoundary(150n);
  measurements.onResourceSample(resourceSample(200n, 20, 5, 30n, 0n, [closedPs(201n, 20n)]));
  measurements.onResourceSample(resourceSample(300n, 25, 9, 45n, 4n, [timedOutPs(301n, 30n), reapedPs(302n, 40n)]));

  const evidence = measurements.snapshot();
  const startup = evidence.resources.startup;
  const active = evidence.resources.active;
  assert.equal(startup.sampleCount, 1);
  assert.equal(startup.peakNodeRssBytes.status, "available");
  assert.equal(startup.swapInDelta.status, "unavailable");
  assert.equal(startup.nodeUserCpuTime.totalMilliseconds.status, "unavailable");
  assert.equal(active.sampleCount, 2);
  assert.deepEqual(active.peakSummedRssBytes, { status: "available", value: "300" });
  assert.deepEqual(active.nodeUserCpuTime, { deltaSampleCount: 1, totalMilliseconds: { status: "available", value: 0.005 } });
  assert.deepEqual(active.nodeSystemCpuTime, { deltaSampleCount: 1, totalMilliseconds: { status: "available", value: 0.004 } });
  assert.deepEqual(active.javaCpuTime, { deltaSampleCount: 1, totalMilliseconds: { status: "available", value: 0.015 } });
  assert.deepEqual(active.swapInDelta, { status: "available", value: "4" });
  assert.deepEqual(active.maximumResourcePollIntervalOvershoot, { status: "available", value: 0.000006 });
  assert.equal(active.commands.status, "available");
  if (active.commands.status !== "available") throw new Error("sampled command observations must be available");
  assert.equal(active.commands.value.ps?.count, 3);
  assert.equal(active.commands.value.ps?.closedCount, 1);
  assert.equal(active.commands.value.ps?.timedOutCount, 1);
  assert.equal(active.commands.value.ps?.reapTimedOutCount, 1);
  assert.deepEqual(active.commands.value.ps?.maximumDurationMilliseconds, { status: "available", value: 0.00004 });
});

test("hunger measurements include action and resource callbacks received during run cleanup", () => {
  const measurements = createHungerRunMeasurements([3]);
  const target = entityId(7);
  measurements.markActiveBoundary(100n);
  measurements.onResourceSample(resourceSample(100n, 10, 5, 20n, 1n));

  // Runtime cleanup can settle an owned action and emit a final resource sample after outcome observation.
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
  measurements.onResourceSample(resourceSample(200n, 15, 9, 30n, 3n));

  const evidence = measurements.snapshot();
  const policy = evidence.policyBySeat.get(3);
  assert.ok(policy);
  assert.equal(policy.actionCount, 1);
  assert.deepEqual(policy.actionOutcomeCounts, { "cancelled:shutdown": 1 });
  assert.deepEqual(policy.actionDuration.maximumMilliseconds, { status: "available", value: 1 });
  assert.equal(evidence.resources.active.sampleCount, 2);
  assert.equal(evidence.resources.active.nodeUserCpuTime.deltaSampleCount, 1);
});

test("hunger measurements keep failed resource samples distinct from zero-valued samples", () => {
  const measurements = createHungerRunMeasurements([0]);
  measurements.onResourceSample({
    status: "failed",
    source: new RunnerError("runtime_failure", "resource monitor", { kind: "vm_stat_failed" }),
    timing: {
      sampleStartedAtNs: 100n,
      sampleCompletedAtNs: 300n,
      pollTimerDelayNs: null,
      commands: [],
    },
  });

  const startup = measurements.snapshot().resources.startup;
  assert.equal(startup.sampleCount, 1);
  assert.equal(startup.failedSampleCount, 1);
  assert.deepEqual(startup.failureKinds, { vm_stat_failed: 1 });
  assert.equal(startup.peakNodeRssBytes.status, "unavailable");
  assert.equal(startup.peakJavaRssBytes.status, "unavailable");
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

function resourceSample(
  startedAtNs: bigint,
  nodeUserMicroseconds: number,
  nodeSystemMicroseconds: number,
  javaMicroseconds: bigint,
  swapIns: bigint,
  commands: readonly unknown[] = [],
): ResourceMonitorSampleEvent {
  return {
    status: "sampled",
    observation: {
      source: "host",
      sample: {
        ownedRssBytes: 300n,
        availableMemoryBytes: 1_000n,
        swapIns,
        swapOuts: swapIns + 1n,
      },
      node: {
        rssBytes: 100,
        cpuUserMicroseconds: nodeUserMicroseconds,
        cpuSystemMicroseconds: nodeSystemMicroseconds,
      },
      java: {
        rssBytes: 200n,
        cpuTime: { status: "available", microseconds: javaMicroseconds },
      },
      timing: {
        sampleStartedAtNs: startedAtNs,
        sampleCompletedAtNs: startedAtNs + 100n,
        pollTimerDelayNs: startedAtNs === 100n ? null : startedAtNs / 50n,
        commands,
      },
    },
  } as unknown as ResourceMonitorSampleEvent;
}

function closedPs(requestedAtNs: bigint, durationNs: bigint): Readonly<Record<string, unknown>> {
  return {
    status: "closed",
    command: "ps",
    requestedAtNs,
    spawnedAtNs: requestedAtNs + 1n,
    exitedAtNs: requestedAtNs + durationNs - 1n,
    closedAtNs: requestedAtNs + durationNs,
    exitCode: 0,
    exitSignal: null,
  };
}

function timedOutPs(requestedAtNs: bigint, durationNs: bigint): Readonly<Record<string, unknown>> {
  return {
    status: "timed_out",
    command: "ps",
    requestedAtNs,
    spawnedAtNs: requestedAtNs + 1n,
    deadlineAtNs: requestedAtNs + durationNs,
    timeoutFiredAtNs: requestedAtNs + durationNs,
  };
}

function reapedPs(requestedAtNs: bigint, durationNs: bigint): Readonly<Record<string, unknown>> {
  return {
    status: "reap_timed_out",
    command: "ps",
    requestedAtNs,
    spawnedAtNs: requestedAtNs + 1n,
    reapDeadlineAtNs: requestedAtNs + durationNs - 1n,
    reapTimeoutFiredAtNs: requestedAtNs + durationNs,
    exit: { atNs: requestedAtNs + durationNs - 2n, code: 0, signal: null },
  };
}
