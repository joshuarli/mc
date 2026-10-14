import type { PolicyActivityEvent } from "../../packages/arena-runner/src/runtime/live-policy-loop.js";

export type MeasuredValue<T> =
  | Readonly<{ status: "available"; value: T }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export interface HungerDurationEvidence {
  readonly count: number;
  readonly totalMilliseconds: MeasuredValue<number>;
  readonly maximumMilliseconds: MeasuredValue<number>;
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

export interface HungerRunMeasurementEvidence {
  readonly activeBoundary: MeasuredValue<Readonly<{ source: "observed_active_clock" }>>;
  readonly timingMetrics: Readonly<{
    readonly maximumEventLoopDelayMilliseconds: MeasuredValue<number>;
    readonly serverTickTimeMilliseconds: MeasuredValue<number>;
    readonly diagnosticOverheadMilliseconds: MeasuredValue<number>;
  }>;
  readonly policyBySeat: ReadonlyMap<number, HungerPolicySeatEvidence>;
  readonly resources: MeasuredValue<never>;
}

export function createHungerRunMeasurements(seats: readonly number[]): {
  readonly onPolicyActivity: (event: PolicyActivityEvent) => void;
  markActiveBoundary(atNs: bigint): void;
  snapshot(): HungerRunMeasurementEvidence;
} {
  const policy = new Map(seats.map((seat) => [seat, makePolicySeatEvidence()] as const));
  let activeBoundaryNs: bigint | undefined;

  return {
    onPolicyActivity: (event) => recordPolicyActivity(requirePolicySeat(policy, event.seat), event),
    markActiveBoundary: (atNs) => {
      if (activeBoundaryNs !== undefined) throw new Error("active phase boundary was already recorded");
      if (atNs < 0n) throw new RangeError("active resource boundary must not be negative");
      activeBoundaryNs = atNs;
    },
    snapshot: () => Object.freeze({
      activeBoundary: activeBoundaryNs === undefined
        ? unavailable("active phase was not observed")
        : available(Object.freeze({ source: "observed_active_clock" as const })),
      timingMetrics: Object.freeze({
        maximumEventLoopDelayMilliseconds: unavailable("the acceptance runner does not measure general event-loop delay"),
        serverTickTimeMilliseconds: unavailable("the runner does not expose authoritative server tick duration"),
        diagnosticOverheadMilliseconds: unavailable("the acceptance runner does not measure diagnostic instrumentation overhead"),
      }),
      policyBySeat: new Map([...policy].map(([seat, evidence]) => [seat, snapshotPolicySeat(evidence)])),
      resources: unavailable("host resource sampling is disabled"),
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

function available<T>(value: T): MeasuredValue<T> {
  return Object.freeze({ status: "available", value });
}

function unavailable<T = never>(reason: string): MeasuredValue<T> {
  return Object.freeze({ status: "unavailable", reason });
}
