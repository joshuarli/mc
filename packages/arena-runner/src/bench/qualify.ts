import type { RunMeasurement } from './measurement.js';
import type { QualityFloors } from './profile.js';
import { queueGrowthIsUnbounded, summarize } from './stats.js';

export interface FloorResult {
  readonly floor: string;
  readonly status: 'pass' | 'fail' | 'unavailable' | 'insufficient_samples' | 'not_applicable';
  readonly observed: number | null;
  readonly limit: number;
}

export interface RunEvaluation {
  readonly qualified: boolean;
  readonly floors: readonly FloorResult[];
}

export function evaluateRun(
  measurement: RunMeasurement,
  floors: QualityFloors,
  notApplicable: readonly string[] = [],
): RunEvaluation {
  const results: FloorResult[] = [];
  const push = (floor: string, status: FloorResult['status'], observed: number | null, limit: number): void => {
    const exempt = notApplicable.some((name) => floor === name || (name === 'engaged_worker_event_loop_p99_ms' && floor.startsWith('worker_')));
    results.push(Object.freeze({ floor, status: exempt && status !== 'pass' ? 'not_applicable' as const : status, observed, limit }));
  };

  if (measurement.operationalFailure !== undefined) {
    push('operational_failure', 'fail', null, 0);
  }

  if (measurement.tpsPerSecond.length === 0) {
    push('tps_mean', 'unavailable', null, floors.tpsTarget * floors.tpsMeanFractionOfTarget);
  } else {
    const meanTps = measurement.tpsPerSecond.reduce((sum, value) => sum + value, 0) / measurement.tpsPerSecond.length;
    const limit = floors.tpsTarget * floors.tpsMeanFractionOfTarget;
    push('tps_mean', meanTps >= limit ? 'pass' : 'fail', meanTps, limit);
  }

  if (measurement.tickServiceMs === null) {
    push('tick_service_p95_ms', 'unavailable', null, floors.tickServiceP95Ms);
    push('tick_service_p99_ms', 'unavailable', null, floors.tickServiceP99Ms);
  } else {
    const summary = summarize(measurement.tickServiceMs);
    push('tick_service_p95_ms', summary.p95 === null ? 'insufficient_samples' : summary.p95 < floors.tickServiceP95Ms ? 'pass' : 'fail',
      summary.p95, floors.tickServiceP95Ms);
    push('tick_service_p99_ms', summary.p99 === null ? 'insufficient_samples' : summary.p99 < floors.tickServiceP99Ms ? 'pass' : 'fail',
      summary.p99, floors.tickServiceP99Ms);
  }

  const engaged = measurement.workers.filter((worker) => worker.decisions > 0);
  if (engaged.length === 0) {
    push('engaged_worker_event_loop_p99_ms', 'unavailable', null, floors.engagedWorkerEventLoopP99Ms);
  } else {
    for (const worker of engaged) {
      const p99 = worker.eventLoopDelayMs.p99;
      push(`worker_${worker.worker}_event_loop_p99_ms`,
        p99 === null ? 'insufficient_samples' : p99 < floors.engagedWorkerEventLoopP99Ms ? 'pass' : 'fail',
        p99, floors.engagedWorkerEventLoopP99Ms);
    }
  }

  const { expectedDecisions, usefulDecisions, waitingWithReason } = measurement.actors;
  if (expectedDecisions === 0) {
    push('useful_actor_fraction', 'unavailable', null, floors.usefulActorFraction);
  } else {
    const fraction = (usefulDecisions + waitingWithReason) / expectedDecisions;
    push('useful_actor_fraction', fraction >= floors.usefulActorFraction ? 'pass' : 'fail', fraction, floors.usefulActorFraction);
  }

  const growth = queueGrowthIsUnbounded(measurement.queueDepthSamples);
  push('queue_growth_bounded', growth === null ? 'unavailable' : growth ? 'fail' : 'pass',
    measurement.queueDepthSamples.length === 0 ? null : Math.max(...measurement.queueDepthSamples), 0);
  push('critical_evidence_lost', measurement.criticalEvidenceLost <= floors.criticalEvidenceLossAllowed ? 'pass' : 'fail',
    measurement.criticalEvidenceLost, floors.criticalEvidenceLossAllowed);

  return Object.freeze({ qualified: results.every((result) => result.status === 'pass' || result.status === 'not_applicable'), floors: Object.freeze(results) });
}

export function bottleneckOf(evaluations: readonly RunEvaluation[]): string | null {
  let worst: { floor: string; ratio: number } | undefined;
  for (const evaluation of evaluations) {
    for (const result of evaluation.floors) {
      if (result.status === 'pass' || result.status === 'not_applicable') continue;
      const ratio = result.observed !== null && result.limit > 0 ? result.observed / result.limit : Number.POSITIVE_INFINITY;
      if (worst === undefined || ratio > worst.ratio) worst = { floor: result.floor, ratio };
    }
  }
  return worst?.floor ?? null;
}
