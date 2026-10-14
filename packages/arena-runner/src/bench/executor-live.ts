import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { blockPosition, DeterministicRandom, RandomStream, seatId } from '@arena/core';
import type { ResourceReference } from '@arena/spec';
import { RunnerError } from '../errors.js';
import { createOwnedDirectory, OwnedFilesError, stageOwnedFile } from '../owned-files/index.js';
import { prepareRun, resolveScenarioResource } from '../prepare.js';
import { runPreparedRun, type RunPreparedRunOptions } from '../runtime/run.js';
import type { WorkerCohortTelemetry } from '../workers/cohort.js';
import { DelayTracker, delaySummary, summaryFromTelemetry, type WorkerTelemetry } from './delays.js';
import type { BenchExecutor, BenchRunSpec } from './matrix.js';
import type { RunMeasurement, WorkerMeasurement } from './measurement.js';
import { benchMapSource, benchScenarioSource, type BenchWorld } from './scenario.js';
import { summarize } from './stats.js';

const MAX_FILE_BYTES = 1024 * 1024;
const TICKS_PER_SECOND = 20;

export interface LiveBenchOptions {
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
  readonly profileId: string;
  readonly templatePath: Buffer;
  readonly templateSource: string;
}

export class LiveBenchExecutor implements BenchExecutor {
  readonly #options: LiveBenchOptions;
  readonly #primed = new Set<number>();

  constructor(options: LiveBenchOptions) {
    this.#options = options;
  }

  async execute(spec: BenchRunSpec, signal: AbortSignal): Promise<RunMeasurement> {
    const worldSeed = worldSeedFor(spec);
    if (spec.regime === 'prepared_world' && !this.#primed.has(spec.level)) {
      this.#primed.add(spec.level);
      await this.#once({ ...spec, warmupSeconds: 0, steadySeconds: 0 }, worldSeed, signal, false);
    }
    return await this.#once(spec, worldSeed, signal, true);
  }

  async #once(spec: BenchRunSpec, worldSeed: number, signal: AbortSignal, measured: boolean): Promise<RunMeasurement> {
    const options = this.#options;
    const maxTicks = (spec.warmupSeconds + spec.steadySeconds + 90) * TICKS_PER_SECOND + 800;
    const world: BenchWorld = { seed: worldSeed, level: spec.level, authoritativeMaxTicks: maxTicks };
    const scenarioPath = await this.#materialize(world);
    const runId = `bench-${spec.workload.slice(0, 8)}-${spec.level}-${randomUUID().slice(0, 8)}`;
    const preparedRun = await prepareRun(options.helperPath, options.ownedRoot, scenarioPath, runId, signal);

    const abort = new AbortController();
    const runSignal = AbortSignal.any([signal, abort.signal]);
    const tracker = new DelayTracker();
    tracker.start();
    const clock: { tick: bigint; arrival: bigint }[] = [];
    const metrics: { micros: number; depth: number; dropped: number }[] = [];
    let windowOpen = false;
    let alive: number | null = null;
    let aliveAtStart: number | null = null;
    let expected = 0;
    let lastExpectedTick = -1;
    let serverPid: number | undefined;
    let serverCpuStart: number | null = null;
    let cpuSupervisorStart = process.cpuUsage();
    let workerTelemetry: readonly WorkerCohortTelemetry[] = [];
    let cohortHandle: { reset(): void; request(): Promise<readonly WorkerCohortTelemetry[]> } | undefined;
    let windowStartedAtMs = 0;
    const strategyInterval = Number(preparedRun.scenario.bots.strategyIntervalTicks);
    let timers: ReturnType<typeof setTimeout>[] = [];

    const finishWindow = async (): Promise<void> => {
      windowOpen = false;
      workerTelemetry = cohortHandle === undefined ? [] : await cohortHandle.request();
      abort.abort(new RunnerError('cancelled', 'arena bench', { kind: 'cancelled' }));
    };
    const openWindow = (): void => {
      windowOpen = true;
      windowStartedAtMs = Date.now();
      tracker.reset();
      cohortHandle?.reset();
      aliveAtStart = alive;
      cpuSupervisorStart = process.cpuUsage();
      void processCpuMs(serverPid).then((value) => { serverCpuStart = value; });
      timers.push(setTimeout(() => { void finishWindow(); }, spec.steadySeconds * 1000));
    };
    const onActive = (): void => {
      if (timers.length > 0) return;
      timers.push(setTimeout(openWindow, spec.warmupSeconds * 1000));
    };

    const base: RunPreparedRunOptions = {
      preparedRun,
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      javaExecutable: options.javaExecutable,
      paperJarPath: options.paperJarPath,
      pluginJarPath: options.pluginJarPath,
      acceptMinecraftEula: true,
      signal: runSignal,
      onServerStarted: (pid) => { serverPid = pid; },
      onPhase: (phase) => { if (phase === 'active') onActive(); },
      onMetrics: (payload) => {
        if (!windowOpen) return;
        metrics.push({
          micros: payload.server_tick_duration_micros,
          depth: payload.critical_queue_depth,
          dropped: payload.dropped_optional_metrics,
        });
      },
      onAuthorityEvent: (event, arrivalNs) => {
        if (event.type === 'public_state') {
          alive = event.payload.alive_seats.length;
          return;
        }
        if (event.type !== 'public_clock' || event.payload.tick === null || event.payload.tick.domain !== 'match') return;
        if (!windowOpen) return;
        const tick = event.payload.tick.value;
        clock.push({ tick, arrival: arrivalNs });
        const asNumber = Number(tick);
        if (asNumber % strategyInterval === 0 && asNumber !== lastExpectedTick && alive !== null) {
          lastExpectedTick = asNumber;
          expected += alive;
        }
      },
    };

    const runOptions: RunPreparedRunOptions = spec.workload === 'natural_hunger'
      ? {
        ...base,
        workers: spec.layout,
        onPolicyActivity: (event) => { if (windowOpen) tracker.onActivity(event); },
        onWorkerCohort: (handle) => { cohortHandle = handle; },
      }
      : {
        ...base,
        competitorDriver: 'evaluator',
        evaluate: async (active, evaluateSignal) => {
          await active.start();
          if (spec.workload === 'distributed_traversal') {
            await Promise.all(active.competitors.map(async (competitor) => {
              const random = DeterministicRandom.forStream(BigInt(worldSeed), RandomStream.policy(seatId(competitor.seat)));
              while (!evaluateSignal.aborted) {
                const position = competitor.bot.entity?.position;
                if (position === undefined) { await sleep(250); continue; }
                const angle = Number(random.nextU64() % 360n) * Math.PI / 180;
                const target = blockPosition(
                  Math.floor(position.x + Math.cos(angle) * 48), Math.floor(position.y), Math.floor(position.z + Math.sin(angle) * 48));
                if (windowOpen) tracker.noteDecision(true);
                const outcome = await competitor.client.run({ kind: 'navigate', target }).catch(() => ({ kind: 'failed' as const }));
                if (windowOpen) {
                  tracker.noteOutcome(outcome.kind);
                }
              }
            }));
          } else {
            await new Promise<void>((resolve) => evaluateSignal.addEventListener('abort', () => resolve(), { once: true }));
          }
        },
      };

    let failure: string | undefined;
    try {
      await runPreparedRun(runOptions);
    } catch (error) {
      const category = error instanceof RunnerError ? error.category : 'runtime_failure';
      if (!(category === 'cancelled' && abort.signal.aborted && !signal.aborted)) {
        if (signal.aborted) throw error;
        failure = error instanceof RunnerError ? `${error.category}:${error.source.kind}` : 'runtime_exception';
      }
    } finally {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      tracker.stop();
    }
    if (!measured) {
      return emptyMeasurement(spec, failure);
    }
    const supervisorTelemetry = tracker.snapshot();
    const cpuSupervisorDelta = process.cpuUsage(cpuSupervisorStart);
    const serverCpuEnd = await processCpuMs(serverPid);
    const elapsedSeconds = Math.max(1, (Date.now() - windowStartedAtMs) / 1000);
    const workers = workerTelemetry.length > 0
      ? workerTelemetry.map((entry) => workerMeasurement(entry.worker, entry.seats, entry.telemetry))
      : [workerMeasurement(0, preparedRun.scenario.roster.competitors, supervisorTelemetry)];
    const merged = workerTelemetry.length > 0 ? workerTelemetry.map((entry) => entry.telemetry) : [supervisorTelemetry];
    const outcomes: Record<string, number> = {};
    for (const entry of merged) for (const [kind, count] of Object.entries(entry.outcomes)) outcomes[kind] = (outcomes[kind] ?? 0) + count;
    const queueDepths = metrics.map((entry) => entry.depth);
    return Object.freeze({
      steadySeconds: elapsedSeconds,
      tickServiceMs: metrics.length === 0 ? null : metrics.map((entry) => entry.micros / 1000),
      tpsPerSecond: tpsPerSecond(clock),
      workers,
      actors: Object.freeze({
        expectedDecisions: spec.workload === 'idle_connections' ? 0
          : spec.workload === 'distributed_traversal' ? merged.reduce((sum, entry) => sum + entry.decisions, 0) : expected,
        usefulDecisions: merged.reduce((sum, entry) => sum + entry.useful, 0),
        waitingWithReason: merged.reduce((sum, entry) => sum + entry.waitingWithReason, 0),
        aliveAtStart,
        aliveAtEnd: alive,
      }),
      queueDepthSamples: queueDepths,
      droppedOptionalMetrics: metrics.length === 0 ? null : metrics[metrics.length - 1]!.dropped - metrics[0]!.dropped,
      criticalEvidenceLost: 0,
      actionOutcomes: Object.freeze(outcomes),
      searchWork: null,
      chunkGeneration: Object.freeze({ count: null, milliseconds: null }),
      encodedBytes: null,
      logBytesPerSecond: null,
      serverCpuMs: serverCpuStart === null || serverCpuEnd === null ? null : serverCpuEnd - serverCpuStart,
      supervisorCpuMs: (cpuSupervisorDelta.user + cpuSupervisorDelta.system) / 1000,
      ...(failure === undefined ? {} : { operationalFailure: failure }),
    });
  }

  async #materialize(world: BenchWorld): Promise<Buffer> {
    const options = this.#options;
    const directory = `.work/arena/bench/${options.profileId}/w${world.level}-${world.seed}`;
    const up = '../'.repeat(directory.split('/').length);
    const policy = `${up}${resolveScenarioResource({
      scenarioPath: options.templatePath, reference: '../policies/baseline.toml' as ResourceReference,
    }).toString('utf8')}`;
    const files: readonly [string, string][] = [
      ['map.toml', benchMapSource(world)],
      ['scenario.toml', benchScenarioSource(options.templateSource, world, 'map.toml', policy)],
    ];
    try {
      await createOwnedDirectory({ helperPath: options.helperPath, ownedRoot: options.ownedRoot, relativePath: Buffer.from(directory) });
    } catch (error) {
      if (!(error instanceof OwnedFilesError) || error.category !== 'conflict') throw error;
    }
    for (const [name, contents] of files) {
      try {
        await stageOwnedFile({
          helperPath: options.helperPath, ownedRoot: options.ownedRoot, relativePath: Buffer.from(`${directory}/${name}`),
          contents: Buffer.from(contents, 'utf8'), maxBytes: MAX_FILE_BYTES,
        });
      } catch (error) {
        if (!(error instanceof OwnedFilesError) || error.category !== 'conflict') throw error;
      }
    }
    return Buffer.from(`${directory}/scenario.toml`);
  }
}

export function worldSeedFor(spec: BenchRunSpec): number {
  if (spec.regime === 'prepared_world') return 8_000_000 + spec.level;
  const workloadIndex = ['idle_connections', 'distributed_traversal', 'natural_hunger'].indexOf(spec.workload);
  return 9_000_000 + spec.level * 1000 + Math.max(0, workloadIndex) * 100 + spec.runIndex * 10 + spec.attempt;
}

export function tpsPerSecond(clock: readonly { tick: bigint; arrival: bigint }[]): readonly number[] {
  if (clock.length < 2) return [];
  const origin = clock[0]!.arrival;
  const buckets = new Map<number, { ticks: number; nanos: bigint }>();
  for (let index = 1; index < clock.length; index += 1) {
    const previous = clock[index - 1]!;
    const current = clock[index]!;
    const nanos = current.arrival - previous.arrival;
    if (nanos <= 0n || current.tick < previous.tick) continue;
    const bucket = Number((current.arrival - origin) / 1_000_000_000n);
    const entry = buckets.get(bucket) ?? { ticks: 0, nanos: 0n };
    entry.ticks += Number(current.tick - previous.tick);
    entry.nanos += nanos;
    buckets.set(bucket, entry);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b)
    .filter(([, entry]) => entry.nanos > 0n)
    .map(([, entry]) => entry.ticks / (Number(entry.nanos) / 1e9));
}

function workerMeasurement(worker: number, seats: number, telemetry: WorkerTelemetry): WorkerMeasurement {
  return Object.freeze({
    worker, seats,
    eventLoopDelayMs: summaryFromTelemetry(telemetry.eventLoopDelayMs),
    eventLoopUtilization: telemetry.eventLoopUtilization,
    arrivalToDecisionMs: delaySummary(telemetry.arrivalToDecisionMs),
    decisionToExecutionMs: delaySummary(telemetry.decisionToExecutionMs),
    decisions: telemetry.decisions,
    cpuMs: telemetry.cpuMs,
  });
}

function emptyMeasurement(spec: BenchRunSpec, failure: string | undefined): RunMeasurement {
  void spec;
  void summarize;
  return Object.freeze({
    steadySeconds: 0, tickServiceMs: null, tpsPerSecond: [], workers: [],
    actors: Object.freeze({ expectedDecisions: 0, usefulDecisions: 0, waitingWithReason: 0, aliveAtStart: null, aliveAtEnd: null }),
    queueDepthSamples: [], droppedOptionalMetrics: null, criticalEvidenceLost: 0, actionOutcomes: {},
    searchWork: null, chunkGeneration: { count: null, milliseconds: null }, encodedBytes: null, logBytesPerSecond: null,
    serverCpuMs: null, supervisorCpuMs: null, ...(failure === undefined ? {} : { operationalFailure: failure }),
  });
}

async function processCpuMs(pid: number | undefined): Promise<number | null> {
  if (pid === undefined) return null;
  return await new Promise<number | null>((resolve) => {
    execFile('ps', ['-o', 'cputime=', '-p', String(pid)], (error, stdout) => {
      if (error !== null) { resolve(null); return; }
      const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(stdout);
      if (match === null) { resolve(null); return; }
      const days = Number(match[1] ?? 0);
      const hours = Number(match[2] ?? 0);
      resolve((((days * 24 + hours) * 60 + Number(match[3])) * 60 + Number(match[4])) * 1000);
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
