import type { PolicyActivityEvent } from "../../packages/arena-runner/src/runtime/live-policy-loop.js";
import type {
  ResourceMonitorCommandObservation,
  ResourceMonitorSampleEvent,
} from "../../packages/arena-runner/src/runtime/resource-monitor.js";

export type MeasuredValue<T> =
  | Readonly<{ status: "available"; value: T }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export interface HungerDurationEvidence {
  readonly count: number;
  readonly totalMilliseconds: MeasuredValue<number>;
  readonly maximumMilliseconds: MeasuredValue<number>;
}

export interface HungerCpuEvidence {
  readonly deltaSampleCount: number;
  readonly totalMilliseconds: MeasuredValue<number>;
}

export interface HungerPolicySeatEvidence {
  readonly decisionCount: number;
  readonly intentCounts: Readonly<Record<string, number>>;
  readonly dispositionCounts: Readonly<Record<string, number>>;
  readonly decisionStartLatency: HungerDurationEvidence;
  readonly decisionEvaluationLatency: HungerDurationEvidence;
  readonly actionCount: number;
  readonly actionOutcomeCounts: Readonly<Record<string, number>>;
  readonly actionDuration: HungerDurationEvidence;
  readonly failedActionDuration: HungerDurationEvidence;
  readonly unstartedActionCount: number;
  readonly attackActionCount: number;
  readonly attackOutcomeCounts: Readonly<Record<string, number>>;
  readonly attackTargetCounts: Readonly<Record<string, number>>;
  readonly settledActionDurationIncludesCleanup: true;
  readonly attackNoObservedDamageTimeoutCount: number;
  readonly attackMissCount: MeasuredValue<number>;
  readonly attackReceiptWaitMilliseconds: MeasuredValue<number>;
}

export interface HungerResourcePhaseEvidence {
  readonly sampleCount: number;
  readonly failedSampleCount: number;
  readonly failureKinds: Readonly<Record<string, number>>;
  readonly sourceCounts: Readonly<Record<string, number>>;
  readonly peakNodeRssBytes: MeasuredValue<number>;
  readonly peakJavaRssBytes: MeasuredValue<string>;
  readonly peakSummedRssBytes: MeasuredValue<string>;
  readonly minimumAvailableMemoryBytes: MeasuredValue<string>;
  readonly swapInDelta: MeasuredValue<string>;
  readonly swapOutDelta: MeasuredValue<string>;
  readonly nodeUserCpuTime: HungerCpuEvidence;
  readonly nodeSystemCpuTime: HungerCpuEvidence;
  readonly javaCpuTime: HungerCpuEvidence;
  readonly maximumSampleDuration: MeasuredValue<number>;
  readonly maximumPollTimerDelay: MeasuredValue<number>;
  readonly commands: MeasuredValue<Readonly<Record<string, Readonly<{
    readonly count: number;
    readonly closedCount: number;
    readonly timedOutCount: number;
    readonly spawnFailedCount: number;
    readonly reapTimedOutCount: number;
    readonly maximumDurationMilliseconds: MeasuredValue<number>;
  }>>>>;
  readonly rssMeaning: "node_plus_java_sum_not_unique_physical_memory";
}

export interface HungerRunMeasurementEvidence {
  readonly activeBoundary: MeasuredValue<Readonly<{ source: "observed_active_clock" }>>;
  readonly policyBySeat: ReadonlyMap<number, HungerPolicySeatEvidence>;
  readonly resources: Readonly<{
    readonly startup: HungerResourcePhaseEvidence;
    readonly active: HungerResourcePhaseEvidence;
  }>;
}

/** Aggregates live runtime callbacks into fixed-size per-seat and per-phase summaries. */
export function createHungerRunMeasurements(seats: readonly number[]): {
  readonly onPolicyActivity: (event: PolicyActivityEvent) => void;
  readonly onResourceSample: (event: ResourceMonitorSampleEvent) => void;
  markActiveBoundary(atNs: bigint): void;
  snapshot(): HungerRunMeasurementEvidence;
} {
  const policy = new Map(seats.map((seat) => [seat, makePolicySeatEvidence()] as const));
  const startup = makeResourcePhaseAccumulator();
  const active = makeResourcePhaseAccumulator();
  let activeBoundaryNs: bigint | undefined;

  return {
    onPolicyActivity: (event) => recordPolicyActivity(requirePolicySeat(policy, event.seat), event),
    onResourceSample: (event) => {
      const sampleStartedAtNs = event.status === "sampled"
        ? event.observation.timing.sampleStartedAtNs
        : event.timing.sampleStartedAtNs;
      const phase = activeBoundaryNs !== undefined && sampleStartedAtNs >= activeBoundaryNs ? active : startup;
      recordResourceSample(phase, event);
    },
    markActiveBoundary: (atNs) => {
      if (activeBoundaryNs !== undefined) throw new Error("active resource boundary was already recorded");
      if (atNs < 0n) throw new RangeError("active resource boundary must not be negative");
      activeBoundaryNs = atNs;
    },
    snapshot: () => Object.freeze({
      activeBoundary: activeBoundaryNs === undefined
        ? unavailable("active phase was not observed")
        : available(Object.freeze({ source: "observed_active_clock" as const })),
      policyBySeat: new Map([...policy].map(([seat, evidence]) => [seat, snapshotPolicySeat(evidence)])),
      resources: Object.freeze({
        startup: snapshotResourcePhase(startup),
        active: snapshotResourcePhase(active),
      }),
    }),
  };
}

interface DurationAccumulator {
  count: number;
  totalNs: bigint;
  maximumNs: bigint;
}

interface MutablePolicySeatEvidence {
  decisionCount: number;
  readonly intentCounts: Map<string, number>;
  readonly dispositionCounts: Map<string, number>;
  readonly decisionStartLatency: DurationAccumulator;
  readonly decisionEvaluationLatency: DurationAccumulator;
  actionCount: number;
  readonly actionOutcomeCounts: Map<string, number>;
  readonly actionDuration: DurationAccumulator;
  readonly failedActionDuration: DurationAccumulator;
  unstartedActionCount: number;
  attackActionCount: number;
  readonly attackOutcomeCounts: Map<string, number>;
  readonly attackTargetCounts: Map<string, number>;
  attackNoObservedDamageTimeoutCount: number;
}

function makePolicySeatEvidence(): MutablePolicySeatEvidence {
  return {
    decisionCount: 0,
    intentCounts: new Map(),
    dispositionCounts: new Map(),
    decisionStartLatency: makeDurationAccumulator(),
    decisionEvaluationLatency: makeDurationAccumulator(),
    actionCount: 0,
    actionOutcomeCounts: new Map(),
    actionDuration: makeDurationAccumulator(),
    failedActionDuration: makeDurationAccumulator(),
    unstartedActionCount: 0,
    attackActionCount: 0,
    attackOutcomeCounts: new Map(),
    attackTargetCounts: new Map(),
    attackNoObservedDamageTimeoutCount: 0,
  };
}

function makeDurationAccumulator(): DurationAccumulator {
  return { count: 0, totalNs: 0n, maximumNs: 0n };
}

function requirePolicySeat(policy: ReadonlyMap<number, MutablePolicySeatEvidence>, seat: number): MutablePolicySeatEvidence {
  const evidence = policy.get(seat);
  if (evidence === undefined) throw new Error(`policy activity references unknown seat ${seat}`);
  return evidence;
}

function recordPolicyActivity(evidence: MutablePolicySeatEvidence, event: PolicyActivityEvent): void {
  if (event.kind === "decision") {
    evidence.decisionCount += 1;
    increment(evidence.intentCounts, event.intent.kind);
    increment(evidence.dispositionCounts, event.disposition.kind);
    recordDuration(evidence.decisionStartLatency, event.tickReceivedAtNs, event.decisionStartedAtNs);
    recordDuration(evidence.decisionEvaluationLatency, event.decisionStartedAtNs, event.acceptedAtNs);
    return;
  }

  if (event.kind === "action") {
    evidence.actionCount += 1;
    const outcomeKey = event.outcome.kind === "failed"
      ? `failed:${event.outcome.cause}`
      : event.outcome.kind === "cancelled"
        ? `cancelled:${event.outcome.reason}`
        : event.outcome.kind;
    increment(evidence.actionOutcomeCounts, outcomeKey);
    if (event.startedAtNs === null) evidence.unstartedActionCount += 1;
    else recordDuration(evidence.actionDuration, event.startedAtNs, event.settledAtNs);
    if (event.intent.kind !== "attack") return;
    evidence.attackActionCount += 1;
    increment(evidence.attackTargetCounts, String(event.intent.target));
    increment(evidence.attackOutcomeCounts, outcomeKey);
    if (event.outcome.kind === "failed" && event.outcome.cause === "timedOut") {
      evidence.attackNoObservedDamageTimeoutCount += 1;
    }
    return;
  }

  evidence.actionCount += 1;
  evidence.unstartedActionCount += event.startedAtNs === null ? 1 : 0;
  increment(evidence.actionOutcomeCounts, "action_failed");
  if (event.startedAtNs !== null) recordDuration(evidence.failedActionDuration, event.startedAtNs, event.settledAtNs);
  if (event.intent.kind === "attack") {
    evidence.attackActionCount += 1;
    increment(evidence.attackTargetCounts, String(event.intent.target));
    increment(evidence.attackOutcomeCounts, "action_failed");
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function recordDuration(accumulator: DurationAccumulator, startedAtNs: bigint, finishedAtNs: bigint): void {
  const duration = finishedAtNs - startedAtNs;
  if (duration < 0n) throw new RangeError("runtime activity clock moved backwards");
  accumulator.count += 1;
  accumulator.totalNs += duration;
  accumulator.maximumNs = accumulator.maximumNs > duration ? accumulator.maximumNs : duration;
}

function snapshotPolicySeat(evidence: MutablePolicySeatEvidence): HungerPolicySeatEvidence {
  return Object.freeze({
    decisionCount: evidence.decisionCount,
    intentCounts: countRecord(evidence.intentCounts),
    dispositionCounts: countRecord(evidence.dispositionCounts),
    decisionStartLatency: snapshotDuration(evidence.decisionStartLatency),
    decisionEvaluationLatency: snapshotDuration(evidence.decisionEvaluationLatency),
    actionCount: evidence.actionCount,
    actionOutcomeCounts: countRecord(evidence.actionOutcomeCounts),
    actionDuration: snapshotDuration(evidence.actionDuration),
    failedActionDuration: snapshotDuration(evidence.failedActionDuration),
    unstartedActionCount: evidence.unstartedActionCount,
    attackActionCount: evidence.attackActionCount,
    attackOutcomeCounts: countRecord(evidence.attackOutcomeCounts),
    attackTargetCounts: countRecord(evidence.attackTargetCounts),
    settledActionDurationIncludesCleanup: true,
    attackNoObservedDamageTimeoutCount: evidence.attackNoObservedDamageTimeoutCount,
    attackMissCount: unavailable("policy outcomes do not distinguish a mechanical miss from an unconfirmed attack"),
    attackReceiptWaitMilliseconds: unavailable("runtime reports full skill duration; it does not expose the internal damage-receipt wait interval"),
  });
}

function snapshotDuration(accumulator: DurationAccumulator): HungerDurationEvidence {
  return Object.freeze({
    count: accumulator.count,
    totalMilliseconds: accumulator.count === 0
      ? unavailable("no duration samples were recorded")
      : available(Number(accumulator.totalNs) / 1_000_000),
    maximumMilliseconds: accumulator.count === 0
      ? unavailable("no duration samples were recorded")
      : available(Number(accumulator.maximumNs) / 1_000_000),
  });
}

function countRecord(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counts));
}

interface CommandAccumulator {
  count: number;
  closedCount: number;
  timedOutCount: number;
  spawnFailedCount: number;
  reapTimedOutCount: number;
  maximumDurationNs: bigint;
}

interface ResourcePhaseAccumulator {
  sampleCount: number;
  successfulSampleCount: number;
  failedSampleCount: number;
  readonly failureKinds: Map<string, number>;
  readonly sourceCounts: Map<string, number>;
  peakNodeRssBytes: number | null;
  peakJavaRssBytes: bigint | null;
  peakSummedRssBytes: bigint | null;
  minimumAvailableMemoryBytes: bigint | null;
  firstSwapIns: bigint | null;
  lastSwapIns: bigint | null;
  firstSwapOuts: bigint | null;
  lastSwapOuts: bigint | null;
  readonly nodeUserCpuTime: CpuAccumulator;
  readonly nodeSystemCpuTime: CpuAccumulator;
  readonly javaCpuTime: JavaCpuAccumulator;
  maximumSampleDurationNs: bigint | null;
  maximumPollTimerDelayNs: bigint | null;
  readonly commands: Map<string, CommandAccumulator>;
}

interface CpuAccumulator {
  previous: number | undefined;
  totalMicroseconds: bigint;
  deltaCount: number;
  resetObserved: boolean;
}

interface JavaCpuAccumulator {
  previous: bigint | undefined;
  totalMicroseconds: bigint;
  deltaCount: number;
  unavailableReason: string | undefined;
  resetObserved: boolean;
}

function makeResourcePhaseAccumulator(): ResourcePhaseAccumulator {
  return {
    sampleCount: 0,
    successfulSampleCount: 0,
    failedSampleCount: 0,
    failureKinds: new Map(),
    sourceCounts: new Map(),
    peakNodeRssBytes: null,
    peakJavaRssBytes: null,
    peakSummedRssBytes: null,
    minimumAvailableMemoryBytes: null,
    firstSwapIns: null,
    lastSwapIns: null,
    firstSwapOuts: null,
    lastSwapOuts: null,
    nodeUserCpuTime: makeCpuAccumulator(),
    nodeSystemCpuTime: makeCpuAccumulator(),
    javaCpuTime: { previous: undefined, totalMicroseconds: 0n, deltaCount: 0, unavailableReason: undefined, resetObserved: false },
    maximumSampleDurationNs: null,
    maximumPollTimerDelayNs: null,
    commands: new Map(),
  };
}

function makeCpuAccumulator(): CpuAccumulator {
  return { previous: undefined, totalMicroseconds: 0n, deltaCount: 0, resetObserved: false };
}

function recordResourceSample(phase: ResourcePhaseAccumulator, event: ResourceMonitorSampleEvent): void {
  phase.sampleCount += 1;
  const timing = event.status === "sampled" ? event.observation.timing : event.timing;
  recordMaximumNs(phase, "sample", timing.sampleCompletedAtNs - timing.sampleStartedAtNs);
  if (timing.pollTimerDelayNs !== null) recordMaximumNs(phase, "poll", timing.pollTimerDelayNs);
  for (const command of timing.commands) recordCommand(phase.commands, command);
  if (event.status === "failed") {
    phase.failedSampleCount += 1;
    increment(phase.failureKinds, event.source.source.kind);
    return;
  }

  const observation = event.observation;
  phase.successfulSampleCount += 1;
  increment(phase.sourceCounts, observation.source);
  phase.peakNodeRssBytes = maximumNumber(phase.peakNodeRssBytes, observation.node.rssBytes);
  phase.peakJavaRssBytes = maximumBigInt(phase.peakJavaRssBytes, observation.java.rssBytes);
  phase.peakSummedRssBytes = maximumBigInt(phase.peakSummedRssBytes, observation.sample.ownedRssBytes);
  phase.minimumAvailableMemoryBytes = minimumBigInt(phase.minimumAvailableMemoryBytes, observation.sample.availableMemoryBytes);
  phase.firstSwapIns ??= observation.sample.swapIns;
  phase.lastSwapIns = observation.sample.swapIns;
  phase.firstSwapOuts ??= observation.sample.swapOuts;
  phase.lastSwapOuts = observation.sample.swapOuts;
  recordCpuDelta(phase.nodeUserCpuTime, observation.node.cpuUserMicroseconds);
  recordCpuDelta(phase.nodeSystemCpuTime, observation.node.cpuSystemMicroseconds);
  if (observation.java.cpuTime.status === "available") recordJavaCpuDelta(phase.javaCpuTime, observation.java.cpuTime.microseconds);
  else {
    phase.javaCpuTime.previous = undefined;
    phase.javaCpuTime.unavailableReason ??= observation.java.cpuTime.reason;
  }
}

function recordMaximumNs(phase: ResourcePhaseAccumulator, metric: "sample" | "poll", durationNs: bigint): void {
  if (durationNs < 0n) throw new RangeError("resource sample clock moved backwards");
  if (metric === "sample") {
    phase.maximumSampleDurationNs = maximumBigInt(phase.maximumSampleDurationNs, durationNs);
  } else {
    phase.maximumPollTimerDelayNs = maximumBigInt(phase.maximumPollTimerDelayNs, durationNs);
  }
}

function recordCommand(commands: Map<string, CommandAccumulator>, event: ResourceMonitorCommandObservation): void {
  let accumulator = commands.get(event.command);
  if (accumulator === undefined) {
    accumulator = {
      count: 0,
      closedCount: 0,
      timedOutCount: 0,
      spawnFailedCount: 0,
      reapTimedOutCount: 0,
      maximumDurationNs: 0n,
    };
    commands.set(event.command, accumulator);
  }
  accumulator.count += 1;
  let durationNs: bigint;
  if (event.status === "closed") {
    accumulator.closedCount += 1;
    durationNs = event.closedAtNs - event.requestedAtNs;
  } else if (event.status === "timed_out") {
    accumulator.timedOutCount += 1;
    durationNs = event.timeoutFiredAtNs - event.requestedAtNs;
  } else if (event.status === "spawn_failed") {
    accumulator.spawnFailedCount += 1;
    durationNs = event.failedAtNs - event.requestedAtNs;
  } else {
    accumulator.reapTimedOutCount += 1;
    durationNs = event.reapTimeoutFiredAtNs - event.requestedAtNs;
  }
  if (durationNs >= 0n && durationNs > accumulator.maximumDurationNs) accumulator.maximumDurationNs = durationNs;
}

function recordCpuDelta(accumulator: CpuAccumulator, current: number): void {
  if (!Number.isSafeInteger(current) || current < 0) {
    accumulator.resetObserved = true;
    return;
  }
  if (accumulator.previous !== undefined) {
    if (current < accumulator.previous) accumulator.resetObserved = true;
    else {
      accumulator.totalMicroseconds += BigInt(current - accumulator.previous);
      accumulator.deltaCount += 1;
    }
  }
  accumulator.previous = current;
}

function recordJavaCpuDelta(accumulator: JavaCpuAccumulator, current: bigint): void {
  if (current < 0n) {
    accumulator.resetObserved = true;
    return;
  }
  if (accumulator.previous !== undefined) {
    if (current < accumulator.previous) accumulator.resetObserved = true;
    else {
      accumulator.totalMicroseconds += current - accumulator.previous;
      accumulator.deltaCount += 1;
    }
  }
  accumulator.previous = current;
}

function maximumNumber(previous: number | null, current: number): number {
  return previous === null ? current : Math.max(previous, current);
}

function maximumBigInt(previous: bigint | null, current: bigint): bigint {
  return previous === null || current > previous ? current : previous;
}

function minimumBigInt(previous: bigint | null, current: bigint): bigint {
  return previous === null || current < previous ? current : previous;
}

function snapshotResourcePhase(phase: ResourcePhaseAccumulator): HungerResourcePhaseEvidence {
  const noSamples = "no successful resource samples were recorded in this phase";
  const insufficientSwapSamples = "fewer than two successful resource samples were recorded in this phase";
  const swapIns = phase.successfulSampleCount < 2 || phase.firstSwapIns === null || phase.lastSwapIns === null
    ? unavailable(insufficientSwapSamples)
    : measuredBigIntDelta(phase.firstSwapIns, phase.lastSwapIns);
  const swapOuts = phase.successfulSampleCount < 2 || phase.firstSwapOuts === null || phase.lastSwapOuts === null
    ? unavailable(insufficientSwapSamples)
    : measuredBigIntDelta(phase.firstSwapOuts, phase.lastSwapOuts);
  return Object.freeze({
    sampleCount: phase.sampleCount,
    failedSampleCount: phase.failedSampleCount,
    failureKinds: countRecord(phase.failureKinds),
    sourceCounts: countRecord(phase.sourceCounts),
    peakNodeRssBytes: phase.peakNodeRssBytes === null ? unavailable(noSamples) : available(phase.peakNodeRssBytes),
    peakJavaRssBytes: phase.peakJavaRssBytes === null ? unavailable(noSamples) : available(phase.peakJavaRssBytes.toString()),
    peakSummedRssBytes: phase.peakSummedRssBytes === null ? unavailable(noSamples) : available(phase.peakSummedRssBytes.toString()),
    minimumAvailableMemoryBytes: phase.minimumAvailableMemoryBytes === null
      ? unavailable(noSamples)
      : available(phase.minimumAvailableMemoryBytes.toString()),
    swapInDelta: swapIns,
    swapOutDelta: swapOuts,
    nodeUserCpuTime: snapshotCpuDuration(phase.nodeUserCpuTime),
    nodeSystemCpuTime: snapshotCpuDuration(phase.nodeSystemCpuTime),
    javaCpuTime: snapshotJavaCpuDuration(phase.javaCpuTime),
    maximumSampleDuration: phase.maximumSampleDurationNs === null
      ? unavailable(noSamples)
      : available(Number(phase.maximumSampleDurationNs) / 1_000_000),
    maximumPollTimerDelay: phase.maximumPollTimerDelayNs === null
      ? unavailable("the host timer delay was not observed")
      : available(Number(phase.maximumPollTimerDelayNs) / 1_000_000),
    commands: phase.commands.size === 0
      ? unavailable("no sample command observations were recorded in this phase")
      : available(Object.freeze(Object.fromEntries([...phase.commands].map(([command, evidence]) => [command, Object.freeze({
        count: evidence.count,
        closedCount: evidence.closedCount,
        timedOutCount: evidence.timedOutCount,
        spawnFailedCount: evidence.spawnFailedCount,
        reapTimedOutCount: evidence.reapTimedOutCount,
        maximumDurationMilliseconds: available(Number(evidence.maximumDurationNs) / 1_000_000),
      })])))),
    rssMeaning: "node_plus_java_sum_not_unique_physical_memory",
  });
}

function snapshotCpuDuration(accumulator: CpuAccumulator): HungerCpuEvidence {
  if (accumulator.resetObserved) return unavailableCpuDuration(accumulator.deltaCount, "CPU counter reset during the phase");
  if (accumulator.deltaCount === 0) return unavailableCpuDuration(0, "fewer than two CPU samples were recorded in the phase");
  return cpuFromMicroseconds(accumulator.deltaCount, accumulator.totalMicroseconds);
}

function snapshotJavaCpuDuration(accumulator: JavaCpuAccumulator): HungerCpuEvidence {
  if (accumulator.resetObserved) return unavailableCpuDuration(accumulator.deltaCount, "Java CPU counter reset during the phase");
  if (accumulator.deltaCount === 0) {
    return unavailableCpuDuration(0, accumulator.unavailableReason ?? "fewer than two available Java CPU samples were recorded in the phase");
  }
  return cpuFromMicroseconds(accumulator.deltaCount, accumulator.totalMicroseconds);
}

function cpuFromMicroseconds(deltaSampleCount: number, totalMicroseconds: bigint): HungerCpuEvidence {
  return Object.freeze({
    deltaSampleCount,
    totalMilliseconds: available(Number(totalMicroseconds) / 1_000),
  });
}

function unavailableCpuDuration(deltaSampleCount: number, reason: string): HungerCpuEvidence {
  return Object.freeze({ deltaSampleCount, totalMilliseconds: unavailable(reason) });
}

function measuredBigIntDelta(first: bigint, last: bigint): MeasuredValue<string> {
  return last < first ? unavailable("counter moved backwards during the phase") : available((last - first).toString());
}

function available<T>(value: T): MeasuredValue<T> {
  return Object.freeze({ status: "available", value });
}

function unavailable<T = never>(reason: string): MeasuredValue<T> {
  return Object.freeze({ status: "unavailable", reason });
}
