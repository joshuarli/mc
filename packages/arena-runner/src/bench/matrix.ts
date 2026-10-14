import type { RunMeasurement } from './measurement.js';
import { bracketTimedRun, type PerfGate } from './perf-gate.js';
import type { BenchProfile, WorkerLayout, WorkloadKind, WorldRegime } from './profile.js';
import { bottleneckOf, evaluateRun, type RunEvaluation } from './qualify.js';
import { summarize, type SampleSummary } from './stats.js';

export interface BenchRunSpec {
  readonly workload: WorkloadKind;
  readonly level: number;
  readonly layout: WorkerLayout;
  readonly regime: WorldRegime;
  readonly runIndex: number;
  readonly attempt: number;
  readonly warmupSeconds: number;
  readonly steadySeconds: number;
}

export interface BenchExecutor {
  execute(spec: BenchRunSpec, signal: AbortSignal): Promise<RunMeasurement>;
}

export type StopReason =
  | 'top_level_qualified'
  | 'quality_floor_failed'
  | 'operational_failure'
  | 'insufficient_valid_runs'
  | 'perf_gate_deferred_host_busy'
  | 'perf_gate_unavailable'
  | 'workload_not_implemented';

export interface RunRecord {
  readonly run: number;
  readonly attempts: number;
  readonly status: 'valid' | 'discarded_overlapped_load' | 'deferred';
  readonly qualified: boolean | null;
  readonly floors: RunEvaluation['floors'] | null;
  readonly tickServiceMs: SampleSummary | null;
  readonly tpsSamples: number;
  readonly workers: RunMeasurement['workers'] | null;
  readonly actors: RunMeasurement['actors'] | null;
  readonly actionOutcomes: RunMeasurement['actionOutcomes'] | null;
  readonly nullMetrics: readonly string[];
}

export interface LevelRecord {
  readonly level: number;
  readonly qualified: boolean;
  readonly runs: readonly RunRecord[];
}

export interface CellReport {
  readonly workload: WorkloadKind;
  readonly layout: WorkerLayout;
  readonly regime: WorldRegime;
  readonly levels: readonly LevelRecord[];
  readonly highest_qualifying_level: number | null;
  readonly stop_reason: StopReason;
  readonly stop_level: number | null;
  readonly bottleneck: string | null;
}

export interface MatrixFilter {
  readonly workloads?: readonly WorkloadKind[];
  readonly layouts?: readonly WorkerLayout[];
  readonly regimes?: readonly WorldRegime[];
  readonly maxLevel?: number;
}

export async function runMatrix(options: Readonly<{
  profile: BenchProfile;
  executor: BenchExecutor;
  gate: PerfGate;
  signal: AbortSignal;
  filter?: MatrixFilter;
  progress?: (message: string) => void;
}>): Promise<readonly CellReport[]> {
  const { profile, executor, gate, signal } = options;
  const filter = options.filter ?? {};
  const cells: CellReport[] = [];
  for (const workload of profile.workloads) {
    if (filter.workloads !== undefined && !filter.workloads.includes(workload.kind)) continue;
    for (const layout of workload.layouts) {
      if (filter.layouts !== undefined && !filter.layouts.includes(layout)) continue;
      for (const regime of profile.regimes) {
        if (filter.regimes !== undefined && !filter.regimes.includes(regime)) continue;
        if (workload.status === 'not_implemented') {
          cells.push(Object.freeze({
            workload: workload.kind, layout, regime, levels: Object.freeze([]), highest_qualifying_level: null,
            stop_reason: 'workload_not_implemented' as const, stop_level: null, bottleneck: null,
          }));
          continue;
        }
        cells.push(await runCell(options, workload.kind, layout, regime, filter.maxLevel, workload.notApplicableFloors));
      }
    }
  }
  void signal;
  return Object.freeze(cells);
}

async function runCell(
  options: Readonly<{ profile: BenchProfile; executor: BenchExecutor; gate: PerfGate; signal: AbortSignal;
    progress?: (message: string) => void }>,
  workload: WorkloadKind,
  layout: WorkerLayout,
  regime: WorldRegime,
  maxLevel: number | undefined,
  notApplicable: readonly string[],
): Promise<CellReport> {
  const { profile, executor, gate, signal } = options;
  const levels: LevelRecord[] = [];
  let highest: number | null = null;
  let stopReason: StopReason = 'top_level_qualified';
  let stopLevel: number | null = null;
  let stopEvaluations: RunEvaluation[] = [];

  for (const level of profile.levels) {
    if (maxLevel !== undefined && level > maxLevel) break;
    const runs: RunRecord[] = [];
    const evaluations: RunEvaluation[] = [];
    let blocked: StopReason | undefined;
    let floorFailed = false;
    for (let runIndex = 0; runIndex < profile.runsPerLevel && blocked === undefined && !floorFailed; runIndex += 1) {
      let record: RunRecord | undefined;
      for (let attempt = 1; attempt <= profile.maxAttemptsPerRun; attempt += 1) {
        signal.throwIfAborted();
        options.progress?.(`${workload} layout=${layout} ${regime} level=${level} run=${runIndex + 1} attempt=${attempt}`);
        const bracket = await bracketTimedRun(gate, () => executor.execute({
          workload, level, layout, regime, runIndex, attempt,
          warmupSeconds: profile.warmupSeconds, steadySeconds: profile.steadySeconds,
        }, signal));
        if (bracket.kind === 'deferred') {
          blocked = bracket.reason === 'host_busy' ? 'perf_gate_deferred_host_busy' : 'perf_gate_unavailable';
          record = deferredRecord(runIndex, attempt);
          break;
        }
        const evaluation = evaluateRun(bracket.value, profile.floors, notApplicable);
        if (bracket.kind === 'discarded') {
          record = recordOf(runIndex, attempt, 'discarded_overlapped_load', bracket.value, evaluation);
          runs.push(record);
          record = undefined;
          continue;
        }
        record = recordOf(runIndex, attempt, 'valid', bracket.value, evaluation);
        evaluations.push(evaluation);
        if (!evaluation.qualified) floorFailed = true;
        break;
      }
      if (record !== undefined) runs.push(record);
      else if (blocked === undefined) blocked = 'insufficient_valid_runs';
    }
    const valid = runs.filter((run) => run.status === 'valid');
    const qualified = blocked === undefined && valid.length >= profile.runsPerLevel && valid.every((run) => run.qualified === true);
    levels.push(Object.freeze({ level, qualified, runs: Object.freeze(runs) }));
    if (qualified) {
      highest = level;
      continue;
    }
    stopLevel = level;
    stopEvaluations = evaluations;
    if (blocked !== undefined) stopReason = blocked;
    else if (evaluations.some((evaluation) => evaluation.floors.some((floor) => floor.floor === 'operational_failure'))) {
      stopReason = 'operational_failure';
    } else stopReason = 'quality_floor_failed';
    break;
  }
  return Object.freeze({
    workload, layout, regime, levels: Object.freeze(levels), highest_qualifying_level: highest,
    stop_reason: stopReason, stop_level: stopLevel, bottleneck: stopLevel === null ? null : bottleneckOf(stopEvaluations),
  });
}

function deferredRecord(run: number, attempts: number): RunRecord {
  return Object.freeze({
    run, attempts, status: 'deferred' as const, qualified: null, floors: null, tickServiceMs: null, tpsSamples: 0,
    workers: null, actors: null, actionOutcomes: null, nullMetrics: Object.freeze([]),
  });
}

function recordOf(
  run: number,
  attempts: number,
  status: 'valid' | 'discarded_overlapped_load',
  measurement: RunMeasurement,
  evaluation: RunEvaluation,
): RunRecord {
  const nulls: string[] = [];
  const track = (name: string, value: unknown): void => { if (value === null) nulls.push(name); };
  track('tick_service_ms', measurement.tickServiceMs);
  track('search_work', measurement.searchWork);
  track('chunk_generation_count', measurement.chunkGeneration.count);
  track('chunk_generation_ms', measurement.chunkGeneration.milliseconds);
  track('encoded_bytes', measurement.encodedBytes);
  track('log_bytes_per_second', measurement.logBytesPerSecond);
  track('server_cpu_ms', measurement.serverCpuMs);
  track('dropped_optional_metrics', measurement.droppedOptionalMetrics);
  return Object.freeze({
    run, attempts, status, qualified: status === 'valid' ? evaluation.qualified : null,
    floors: evaluation.floors,
    tickServiceMs: measurement.tickServiceMs === null ? null : summarize(measurement.tickServiceMs),
    tpsSamples: measurement.tpsPerSecond.length,
    workers: measurement.workers, actors: measurement.actors, actionOutcomes: measurement.actionOutcomes,
    nullMetrics: Object.freeze(nulls),
  });
}

export function benchReport(profile: BenchProfile, cells: readonly CellReport[]): object {
  const deferred = cells.some((cell) => cell.stop_reason === 'perf_gate_deferred_host_busy');
  return {
    schema: 1,
    profile: profile.id,
    floors: profile.floors,
    window: { warmup_seconds: profile.warmupSeconds, steady_seconds: profile.steadySeconds, runs_per_level: profile.runsPerLevel },
    ...(deferred ? { notice: 'perf gate deferred: host busy' } : {}),
    cells,
    highest_qualifying_population: cells.map((cell) => ({
      workload: cell.workload, layout: cell.layout, regime: cell.regime,
      level: cell.highest_qualifying_level, stop_reason: cell.stop_reason, bottleneck: cell.bottleneck,
    })),
  };
}
