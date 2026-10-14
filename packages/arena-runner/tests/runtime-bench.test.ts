import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileScenario } from '@arena/spec';
import { tpsPerSecond, worldSeedFor } from '../src/bench/executor-live.js';
import { benchReport, runMatrix, type BenchExecutor, type BenchRunSpec } from '../src/bench/matrix.js';
import type { RunMeasurement } from '../src/bench/measurement.js';
import { bracketTimedRun, type PerfGate } from '../src/bench/perf-gate.js';
import { SCALE_V1 } from '../src/bench/profile.js';
import { evaluateRun } from '../src/bench/qualify.js';
import { benchMapSource, benchScenarioSource } from '../src/bench/scenario.js';
import { nearestRankPercentile, queueGrowthIsUnbounded, summarize } from '../src/bench/stats.js';

const repositoryRoot = process.cwd();

function samples<T = number>(count: number, value: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => value(index));
}

function healthy(overrides: Partial<RunMeasurement> = {}): RunMeasurement {
  const summary = (value: number) => summarize(samples(300, () => value));
  return {
    steadySeconds: 120,
    tickServiceMs: samples(2400, (index) => 10 + (index % 5)),
    tpsPerSecond: samples(120, () => 20),
    workers: [{
      worker: 0, seats: 24, eventLoopDelayMs: summary(3), eventLoopUtilization: 0.4,
      arrivalToDecisionMs: summary(2), decisionToExecutionMs: summary(1), decisions: 500, cpuMs: 1000,
    }],
    actors: { expectedDecisions: 1000, usefulDecisions: 800, waitingWithReason: 150, aliveAtStart: 24, aliveAtEnd: 20 },
    queueDepthSamples: samples(60, () => 3),
    droppedOptionalMetrics: 0,
    criticalEvidenceLost: 0,
    actionOutcomes: { succeeded: 10 },
    searchWork: null,
    chunkGeneration: { count: null, milliseconds: null },
    encodedBytes: null,
    logBytesPerSecond: null,
    serverCpuMs: 5000,
    supervisorCpuMs: 2000,
    ...overrides,
  };
}

const openGate: PerfGate = { ready: async () => true, settled: async () => true };

test('percentiles use nearest rank and refuse a p99 from fewer than 100 samples', () => {
  const sorted = samples(100, (index) => index + 1);
  assert.equal(nearestRankPercentile(sorted, 0.99), 99);
  assert.equal(nearestRankPercentile(sorted, 0.5), 50);
  assert.equal(nearestRankPercentile([7], 1), 7);
  const few = summarize(samples(99, (index) => index));
  assert.equal(few.p99, null);
  assert.ok(few.insufficient_samples.includes('p99'));
  assert.notEqual(few.p95, null);
  const enough = summarize(samples(100, (index) => index));
  assert.equal(enough.p99, 98);
  assert.deepEqual(summarize(samples(10, () => 1)).insufficient_samples, ['p95', 'p99']);
  assert.throws(() => summarize([Number.NaN]));
});

test('queue growth is unbounded only when depth keeps rising above a floor', () => {
  assert.equal(queueGrowthIsUnbounded(samples(30, () => 5)), false);
  assert.equal(queueGrowthIsUnbounded(samples(30, (index) => index * 10)), true);
  assert.equal(queueGrowthIsUnbounded(samples(4, (index) => index * 100)), null);
});

test('a run qualifies only when every floor is measured and met', () => {
  assert.equal(evaluateRun(healthy(), SCALE_V1.floors).qualified, true);
  const slow = evaluateRun(healthy({ tickServiceMs: samples(2400, () => 55) }), SCALE_V1.floors);
  assert.equal(slow.qualified, false);
  assert.equal(slow.floors.find((floor) => floor.floor === 'tick_service_p99_ms')?.status, 'fail');
  const unmeasured = evaluateRun(healthy({ tickServiceMs: null }), SCALE_V1.floors);
  assert.equal(unmeasured.qualified, false);
  assert.equal(unmeasured.floors.find((floor) => floor.floor === 'tick_service_p95_ms')?.status, 'unavailable');
  const thin = evaluateRun(healthy({ tickServiceMs: samples(60, () => 10) }), SCALE_V1.floors);
  assert.equal(thin.floors.find((floor) => floor.floor === 'tick_service_p99_ms')?.status, 'insufficient_samples');
  assert.equal(evaluateRun(healthy({ criticalEvidenceLost: 1 }), SCALE_V1.floors).qualified, false);
  assert.equal(evaluateRun(healthy({ tpsPerSecond: samples(120, () => 17) }), SCALE_V1.floors).qualified, false);
  const idle = healthy({ workers: [], actors: { expectedDecisions: 0, usefulDecisions: 0, waitingWithReason: 0, aliveAtStart: 6, aliveAtEnd: 6 } });
  assert.equal(evaluateRun(idle, SCALE_V1.floors).qualified, false);
  assert.equal(evaluateRun(idle, SCALE_V1.floors, ['useful_actor_fraction', 'engaged_worker_event_loop_p99_ms']).qualified, true);
  const lagging = healthy({ workers: [{ ...healthy().workers[0]!, eventLoopDelayMs: summarize(samples(300, () => 40)) }] });
  assert.equal(evaluateRun(lagging, SCALE_V1.floors).floors.find((floor) => floor.floor === 'worker_0_event_loop_p99_ms')?.status, 'fail');
});

function executorByLevel(failAt: number, mutate: (spec: BenchRunSpec) => Partial<RunMeasurement> = () => ({})): BenchExecutor & { calls: BenchRunSpec[] } {
  const calls: BenchRunSpec[] = [];
  return {
    calls,
    async execute(spec) {
      calls.push(spec);
      return healthy({
        ...(spec.level >= failAt ? { tickServiceMs: samples(2400, () => 60) } : {}),
        ...mutate(spec),
      });
    },
  };
}

test('levels escalate only while the previous level qualifies and report the stopping bottleneck', async () => {
  const executor = executorByLevel(48);
  const cells = await runMatrix({
    profile: SCALE_V1, executor, gate: openGate, signal: new AbortController().signal,
    filter: { workloads: ['natural_hunger'], layouts: [1], regimes: ['cold_world'] },
  });
  assert.equal(cells.length, 1);
  const cell = cells[0]!;
  assert.deepEqual(cell.levels.map((level) => [level.level, level.qualified]), [[6, true], [12, true], [24, true], [48, false]]);
  assert.equal(cell.highest_qualifying_level, 24);
  assert.equal(cell.stop_reason, 'quality_floor_failed');
  assert.equal(cell.stop_level, 48);
  assert.equal(cell.bottleneck, 'tick_service_p95_ms');
  assert.equal(executor.calls.filter((call) => call.level === 48).length, 1, 'a failing level stops after its first failing run set');
  assert.equal(executor.calls.filter((call) => call.level === 6).length, 3);
  assert.equal(Math.max(...executor.calls.map((call) => call.level)), 48);
  assert.ok(executor.calls.every((call) => call.warmupSeconds === 30 && call.steadySeconds === 120));
});

test('every layout, regime and workload slot is reported separately and unbuilt workloads stay typed slots', async () => {
  const executor = executorByLevel(Number.POSITIVE_INFINITY);
  const cells = await runMatrix({
    profile: SCALE_V1, executor, gate: openGate, signal: new AbortController().signal,
    filter: { maxLevel: 12 },
  });
  const keys = cells.map((cell) => `${cell.workload}/${cell.layout}/${cell.regime}`);
  assert.ok(keys.includes('natural_hunger/4/prepared_world'));
  assert.ok(keys.includes('idle_connections/1/cold_world'));
  assert.ok(!keys.includes('idle_connections/2/cold_world'));
  const slots = cells.filter((cell) => cell.stop_reason === 'workload_not_implemented');
  assert.deepEqual([...new Set(slots.map((cell) => cell.workload))].sort(), ['dense_combat', 'distributed_economy', 'siege']);
  assert.ok(slots.every((cell) => cell.levels.length === 0 && cell.highest_qualifying_level === null));
  assert.equal(executor.calls.filter((call) => ['siege', 'dense_combat', 'distributed_economy'].includes(call.workload)).length, 0);
  const idle = cells.find((cell) => cell.workload === 'idle_connections')!;
  assert.equal(idle.highest_qualifying_level, 12);
});

test('an overlapped run is discarded and retried, and exhausting attempts blocks the level', async () => {
  let settledCalls = 0;
  const flaky: PerfGate = { ready: async () => true, settled: async () => { settledCalls += 1; return settledCalls !== 1; } };
  const executor = executorByLevel(Number.POSITIVE_INFINITY);
  const cells = await runMatrix({
    profile: SCALE_V1, executor, gate: flaky, signal: new AbortController().signal,
    filter: { workloads: ['natural_hunger'], layouts: [1], regimes: ['cold_world'], maxLevel: 6 },
  });
  const level = cells[0]!.levels[0]!;
  assert.equal(level.qualified, true);
  assert.deepEqual(level.runs.map((run) => run.status), ['discarded_overlapped_load', 'valid', 'valid', 'valid']);
  assert.equal(executor.calls.length, 4);

  const alwaysOverlapped: PerfGate = { ready: async () => true, settled: async () => false };
  const blocked = await runMatrix({
    profile: SCALE_V1, executor: executorByLevel(Number.POSITIVE_INFINITY), gate: alwaysOverlapped,
    signal: new AbortController().signal,
    filter: { workloads: ['natural_hunger'], layouts: [1], regimes: ['cold_world'], maxLevel: 6 },
  });
  assert.equal(blocked[0]!.stop_reason, 'insufficient_valid_runs');
  assert.equal(blocked[0]!.highest_qualifying_level, null);
});

test('a busy host defers the gate and is never counted as a pass', async () => {
  const busy: PerfGate = { ready: async () => false, settled: async () => true };
  const executor = executorByLevel(Number.POSITIVE_INFINITY);
  const cells = await runMatrix({
    profile: SCALE_V1, executor, gate: busy, signal: new AbortController().signal,
    filter: { workloads: ['natural_hunger'], layouts: [1], regimes: ['cold_world'] },
  });
  assert.equal(executor.calls.length, 0);
  assert.equal(cells[0]!.stop_reason, 'perf_gate_deferred_host_busy');
  assert.equal(cells[0]!.highest_qualifying_level, null);
  const report = benchReport(SCALE_V1, cells) as { notice?: string };
  assert.equal(report.notice, 'perf gate deferred: host busy');
  const missing: PerfGate = { ready: async () => 'unavailable', settled: async () => 'unavailable' };
  const result = await bracketTimedRun(missing, async () => 1);
  assert.deepEqual(result, { kind: 'deferred', reason: 'perf_gate_unavailable' });
});

test('an operational failure stops escalation with its own reason', async () => {
  const executor = executorByLevel(Number.POSITIVE_INFINITY, (spec) => spec.level === 12 ? { operationalFailure: 'runtime_failure:paper_exit' } : {});
  const cells = await runMatrix({
    profile: SCALE_V1, executor, gate: openGate, signal: new AbortController().signal,
    filter: { workloads: ['natural_hunger'], layouts: [1], regimes: ['cold_world'] },
  });
  assert.equal(cells[0]!.stop_reason, 'operational_failure');
  assert.equal(cells[0]!.highest_qualifying_level, 6);
  assert.equal(cells[0]!.bottleneck, 'operational_failure');
});

test('the profile floors are fixed data', () => {
  assert.deepEqual(SCALE_V1.levels, [6, 12, 24, 48, 96, 128, 256]);
  assert.equal(SCALE_V1.runsPerLevel, 3);
  assert.equal(SCALE_V1.steadySeconds, 120);
  assert.equal(SCALE_V1.floors.tickServiceP95Ms, 40);
  assert.equal(SCALE_V1.floors.tickServiceP99Ms, 50);
  assert.equal(SCALE_V1.floors.engagedWorkerEventLoopP99Ms, 25);
  assert.equal(SCALE_V1.floors.usefulActorFraction, 0.9);
  assert.throws(() => { (SCALE_V1.floors as { tpsTarget: number }).tpsTarget = 10; }, TypeError);
});

test('tps is derived from authoritative clock ticks over arrival time', () => {
  const clock = samples(61, (index) => ({ tick: BigInt(index), arrival: BigInt(index) * 50_000_000n }));
  const rates = tpsPerSecond(clock);
  assert.ok(rates.length >= 3);
  for (const rate of rates) assert.ok(Math.abs(rate - 20) < 1e-9);
  const slow = tpsPerSecond(samples(31, (index) => ({ tick: BigInt(index), arrival: BigInt(index) * 100_000_000n })));
  assert.ok(slow.every((rate) => Math.abs(rate - 10) < 1e-9));
  assert.deepEqual(tpsPerSecond([]), []);
});

test('cold runs use distinct world seeds and prepared runs share one per level', () => {
  const spec = (runIndex: number, regime: 'cold_world' | 'prepared_world', attempt = 1): BenchRunSpec => ({
    workload: 'natural_hunger', level: 24, layout: 1, regime, runIndex, attempt, warmupSeconds: 30, steadySeconds: 120,
  });
  const cold = [0, 1, 2].map((index) => worldSeedFor(spec(index, 'cold_world')));
  assert.equal(new Set(cold).size, 3);
  assert.notEqual(worldSeedFor(spec(0, 'cold_world', 1)), worldSeedFor(spec(0, 'cold_world', 2)));
  assert.equal(worldSeedFor(spec(0, 'prepared_world')), worldSeedFor(spec(2, 'prepared_world')));
});

test('generated bench worlds compile for every profile level within the prepared chunk budget', () => {
  const template = readFileSync(join(repositoryRoot, 'scenarios/hunger-24.toml'), 'utf8');
  for (const level of SCALE_V1.levels) {
    const world = { seed: 9_000_000 + level, level, authoritativeMaxTicks: 6000 };
    const scenario = compileScenario(
      benchScenarioSource(template, world, 'map.toml', '../policies/baseline.toml'),
      benchMapSource(world),
    );
    assert.equal(scenario.roster.competitors, level);
    assert.equal(scenario.map.spawns.length, level);
    assert.equal(scenario.server.viewDistanceChunks, 4);
  }
});
