export const WORKLOAD_KINDS = [
  'idle_connections',
  'distributed_traversal',
  'natural_hunger',
  'distributed_economy',
  'siege',
  'dense_combat',
] as const;
export type WorkloadKind = typeof WORKLOAD_KINDS[number];
export type WorkloadStatus = 'implemented' | 'not_implemented';
export type WorldRegime = 'cold_world' | 'prepared_world';
export type WorkerLayout = 1 | 2 | 4;

export interface QualityFloors {
  readonly tpsTarget: number;
  readonly tpsMeanFractionOfTarget: number;
  readonly tickServiceP95Ms: number;
  readonly tickServiceP99Ms: number;
  readonly engagedWorkerEventLoopP99Ms: number;
  readonly usefulActorFraction: number;
  readonly criticalEvidenceLossAllowed: 0;
}

export interface WorkloadSpec {
  readonly kind: WorkloadKind;
  readonly status: WorkloadStatus;
  readonly layouts: readonly WorkerLayout[];
  readonly notApplicableFloors: readonly string[];
}

export interface BenchProfile {
  readonly id: string;
  readonly levels: readonly number[];
  readonly runsPerLevel: number;
  readonly maxAttemptsPerRun: number;
  readonly warmupSeconds: number;
  readonly steadySeconds: number;
  readonly regimes: readonly WorldRegime[];
  readonly floors: QualityFloors;
  readonly workloads: readonly WorkloadSpec[];
}

function workload(
  kind: WorkloadKind,
  status: WorkloadStatus,
  layouts: readonly WorkerLayout[],
  notApplicableFloors: readonly string[],
): WorkloadSpec {
  return Object.freeze({
    kind, status, layouts: Object.freeze([...layouts]), notApplicableFloors: Object.freeze([...notApplicableFloors]),
  });
}

export const SCALE_V1: BenchProfile = Object.freeze({
  id: 'scale-v1',
  levels: Object.freeze([6, 12, 24, 48, 96, 128, 256]),
  runsPerLevel: 3,
  maxAttemptsPerRun: 2,
  warmupSeconds: 30,
  steadySeconds: 120,
  regimes: Object.freeze(['cold_world', 'prepared_world'] as const),
  floors: Object.freeze({
    tpsTarget: 20,
    tpsMeanFractionOfTarget: 0.97,
    tickServiceP95Ms: 40,
    tickServiceP99Ms: 50,
    engagedWorkerEventLoopP99Ms: 25,
    usefulActorFraction: 0.9,
    criticalEvidenceLossAllowed: 0 as const,
  }),
  workloads: Object.freeze([
    workload('idle_connections', 'implemented', [1], ['useful_actor_fraction', 'engaged_worker_event_loop_p99_ms']),
    workload('distributed_traversal', 'implemented', [1], ['engaged_worker_event_loop_p99_ms']),
    workload('natural_hunger', 'implemented', [1, 2, 4], []),
    workload('distributed_economy', 'not_implemented', [1], []),
    workload('siege', 'not_implemented', [1], []),
    workload('dense_combat', 'not_implemented', [1], []),
  ]),
});

export function profileById(id: string): BenchProfile | undefined {
  return id === SCALE_V1.id ? SCALE_V1 : undefined;
}
