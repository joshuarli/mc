import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import {
  agentObservation, agentState, blockPosition, currentKnowledge, emptyEquipment, observationSequence,
  tick, unknownKnowledge, worldBorder,
} from '@arena/core';
import { canonicalJson } from '../src/canonical.js';
import { RunnerError } from '../src/errors.js';
import { partitionSeats, parseWorkerCount, workerForSeat } from '../src/workers/assignment.js';
import { WorkerCohort, launchWorkerProcess, type WorkerChannel, type WorkerLauncher } from '../src/workers/cohort.js';
import { BoundedCriticalIngest, DiagnosticCoalescer } from '../src/workers/outbox.js';
import { MAX_WORKER_MESSAGE_BYTES, assertWorkerMessageBound, decodeWorkerMessage,
  type SupervisorToWorker, type WorkerToSupervisor } from '../src/workers/protocol.js';
import { WorkerRuntime, type WorkerCompetitor } from '../src/workers/worker-runtime.js';
import type { WorkerEventRecord } from '../src/worker-record.js';

const repositoryRoot = process.cwd();
const POLICY_SOURCE = readFileSync(join(repositoryRoot, 'policies/baseline.toml'), 'utf8');
const SEATS = [0, 1, 2, 3].map((seat) => ({ seat, username: `ArenaBot${seat}`, offline_uuid: `uuid-${seat}` }));

function fakeCompetitor(seat: number): WorkerCompetitor {
  const bot = Object.assign(new EventEmitter(), { health: 20, game: { gameMode: 'survival' }, entities: {} }) as unknown as Bot;
  const client = {
    observe: (value: number) => agentObservation({
      tick: tick(value), sequence: observationSequence(value + 1),
      agent: currentKnowledge(agentState({
        position: blockPosition(10 + seat * 17, 64, 5 + (value % 7)), healthHalfHearts: 40, hungerPoints: 20,
        foodStacks: [], equipped: emptyEquipment(), upgrades: [],
      })),
      border: currentKnowledge(worldBorder(0, 0, 100)), opponents: currentKnowledge([]), loot: unknownKnowledge(),
    }),
    run: async () => ({ kind: 'succeeded' as const }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return {
    seat, bot, gameplay: { mode: 'hunger_games', client } as WorkerCompetitor['gameplay'],
    connect: async () => undefined, close: async () => undefined, failure: () => undefined,
  };
}

interface LoopbackWorker {
  readonly channel: WorkerChannel;
  die(): void;
}

function loopbackLauncher(created: LoopbackWorker[]): WorkerLauncher {
  return () => {
    let listener: ((message: unknown) => void) | undefined;
    let exitListener: (() => void) | undefined;
    let exited = false;
    let chain: Promise<void> = Promise.resolve();
    const runtime = new WorkerRuntime({
      createCompetitor: (seat) => fakeCompetitor(seat),
      send: async (message: WorkerToSupervisor) => {
        const copy: unknown = JSON.parse(JSON.stringify(message));
        setImmediate(() => { if (!exited) listener?.(copy); });
      },
    });
    const channel: WorkerChannel = {
      send: (message: SupervisorToWorker) => {
        const copy = JSON.parse(JSON.stringify(message)) as SupervisorToWorker;
        chain = chain.then(() => exited ? undefined : runtime.handle(copy));
      },
      onMessage: (value) => { listener = value; },
      onExit: (value) => { exitListener = value; },
      terminate: async () => { exited = true; },
    };
    created.push({ channel, die: () => { exited = true; exitListener?.(); } });
    return channel;
  };
}

interface Collected {
  decisions: Record<string, any>[];
  effects: Record<string, any>[];
  funnels: Record<string, any>[];
  worker: WorkerEventRecord[];
  checkpoints: number[];
}

function collectingTrace(): { trace: ConstructorParameters<typeof WorkerCohort>[0]['trace']; collected: Collected } {
  const collected: Collected = { decisions: [], effects: [], funnels: [], worker: [], checkpoints: [] };
  return {
    collected,
    trace: {
      recordPolicyDecision: async (record) => { collected.decisions.push(record as never); },
      recordPolicyEffect: async (record) => { collected.effects.push(record as never); },
      recordActionFunnel: async (record) => { collected.funnels.push(record as never); },
      recordWorkerEvent: async (record) => { collected.worker.push(record); },
      checkpoint: async (count) => { collected.checkpoints.push(count); },
    },
  };
}

function cohortFor(workerCount: number, launcher: WorkerLauncher, trace: ReturnType<typeof collectingTrace>['trace'], tickBox: { value: number | null } = { value: null }) {
  return new WorkerCohort({
    workerCount, seats: SEATS, launcher, trace, currentTick: () => tickBox.value,
    base: {
      host: '127.0.0.1', port: 25565, minecraft: '26.1.2', view_distance_chunks: 6, seed: '481516',
      strategy_interval_ticks: '1', opening_style_cycle: null, record_policy: true, policy_source: POLICY_SOURCE,
      roster: SEATS.map(({ seat, username }) => ({ seat, username })),
    },
  });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function runDecisions(workerCount: number): Promise<Collected> {
  const { trace, collected } = collectingTrace();
  const cohort = cohortFor(workerCount, loopbackLauncher([]), trace);
  await cohort.start();
  for (let value = 0; value < 12; value += 1) {
    cohort.onTick(value);
    await settle();
  }
  await cohort.stopAndDrain();
  await cohort.terminate();
  assert.deepEqual(cohort.losses, []);
  return collected;
}

function perSeatDecisions(collected: Collected): Record<number, string[]> {
  const seats: Record<number, string[]> = {};
  for (const record of collected.decisions) {
    const entry = {
      decision: record.decision, rng_state_after: record.rng_state_after,
      input: record.input, disposition: record.disposition.kind,
    };
    (seats[record.seat] ??= []).push(canonicalJson(entry));
  }
  return seats;
}

test('seat to worker assignment depends only on the seat and the worker count', () => {
  assert.equal(workerForSeat(7, 3), 1);
  assert.deepEqual(partitionSeats([0, 1, 2, 3, 4], 2), [[0, 2, 4], [1, 3]]);
  assert.deepEqual(partitionSeats([0, 1, 2], 1), [[0, 1, 2]]);
  for (const bad of [0, 17, 1.5, -1]) {
    assert.throws(() => parseWorkerCount(bad), (error: unknown) => error instanceof RunnerError
      && error.source.kind === 'invalid_worker_count');
  }
});

test('one and two workers produce identical per-seat policy decisions from the same seeded inputs', async () => {
  const single = perSeatDecisions(await runDecisions(1));
  const pair = perSeatDecisions(await runDecisions(2));
  assert.deepEqual(Object.keys(single).sort(), ['0', '1', '2', '3']);
  for (const seat of [0, 1, 2, 3]) {
    assert.ok(single[seat]!.length >= 4, `seat ${seat} must have decided repeatedly`);
    assert.deepEqual(pair[seat], single[seat], `seat ${seat} decisions must not depend on the worker layout`);
  }
});

test('worker evidence is ingested with unique global sequences, mapped references, and source stamps', async () => {
  const collected = await runDecisions(2);
  const sequences = collected.decisions.map((record) => BigInt(record.sequence));
  assert.equal(new Set(sequences.map(String)).size, sequences.length);
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left < right ? -1 : 1));
  const known = new Set(collected.decisions.map((record) => record.sequence));
  assert.ok(collected.effects.length > 0);
  for (const effect of collected.effects) assert.ok(known.has(effect.decision_sequence));
  for (const record of collected.decisions) {
    const disposition = record.disposition as { action_sequence?: string; replaces_action_sequence?: string };
    if (disposition.action_sequence !== undefined) assert.ok(known.has(disposition.action_sequence));
    if (disposition.replaces_action_sequence !== undefined) assert.ok(known.has(disposition.replaces_action_sequence));
  }
  for (const funnel of collected.funnels) {
    assert.ok(known.has(funnel.action_sequence));
    assert.equal(typeof funnel.source.worker, 'number');
    assert.equal(funnel.source.epoch, 1);
  }
  const topology = collected.worker.find((record) => record.schema === 'worker-topology-v1');
  assert.ok(topology?.schema === 'worker-topology-v1');
  assert.deepEqual(topology.assignments.map((entry) => entry.seats), [[0, 2], [1, 3]]);
});

test('a lost worker leaves the run degraded, is recorded once, and is never relaunched', async () => {
  const { trace, collected } = collectingTrace();
  const created: LoopbackWorker[] = [];
  const tickBox = { value: 5 as number | null };
  const cohort = cohortFor(2, loopbackLauncher(created), trace, tickBox);
  await cohort.start();
  let failed = false;
  void cohort.failure.catch(() => { failed = true; });
  cohort.onTick(0);
  await settle();
  created[1]!.die();
  await settle();
  cohort.onTick(1);
  await settle();
  assert.equal(failed, false, 'worker loss is a degraded run, not a run failure');
  assert.equal(created.length, 2, 'a lost worker is never relaunched');
  assert.deepEqual(cohort.losses.map((loss) => [loss.worker, loss.seats, loss.reason]), [[1, [1, 3], 'worker_exit']]);
  const loss = collected.worker.filter((record) => record.schema === 'worker-loss-v1');
  assert.equal(loss.length, 1);
  assert.deepEqual(loss[0], { schema: 'worker-loss-v1', worker: 1, epoch: 1, seats: [1, 3], reason: 'worker_exit', tick: 5 });
  await cohort.stopAndDrain();
  await cohort.terminate();
  assert.equal(cohort.losses.length, 1);
});

test('critical ingest declares a bounded failure on backlog overflow and on a stalled writer', async () => {
  const backlog: RunnerError[] = [];
  const blocked = new BoundedCriticalIngest<number>({
    handler: () => new Promise<void>(() => undefined), fail: (error) => backlog.push(error), maxBacklog: 2, stallTimeoutMs: 60_000,
  });
  for (let index = 0; index < 5; index += 1) blocked.push(index);
  assert.deepEqual(backlog.map((error) => error.source.kind), ['critical_backlog_exceeded']);
  blocked.close();

  const stalls: RunnerError[] = [];
  const stalled = new BoundedCriticalIngest<number>({
    handler: () => new Promise<void>(() => undefined), fail: (error) => stalls.push(error), stallTimeoutMs: 20,
  });
  stalled.push(1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(stalls.map((error) => error.source.kind), ['critical_writer_stalled']);
  await stalled.idle();
});

test('optional diagnostics are coalesced with counters and a drop count', () => {
  const coalescer = new DiagnosticCoalescer();
  for (let index = 0; index < 5; index += 1) coalescer.note('decision.start');
  for (let index = 0; index < 70; index += 1) coalescer.note(`key-${index}`);
  const drained = coalescer.drain()!;
  assert.equal(drained.counters['decision.start'], 5);
  assert.equal(Object.keys(drained.counters).length, 64);
  assert.equal(drained.dropped, 7);
  assert.equal(coalescer.drain(), undefined);
});

test('worker protocol rejects malformed and oversized messages', () => {
  assert.throws(() => decodeWorkerMessage({ type: 'critical', worker: 0, epoch: 1, kind: 'other', source_sequence: 0, source_tick: null, record: {} }));
  assert.throws(() => decodeWorkerMessage({ type: 'ready', worker: -1, epoch: 1 }));
  assert.throws(() => decodeWorkerMessage('ready'));
  assert.equal(decodeWorkerMessage({ type: 'ready', worker: 0, epoch: 1 }).type, 'ready');
  assert.throws(() => assertWorkerMessageBound({ type: 'critical', kind: 'decision', worker: 0, epoch: 1, source_sequence: 0,
    source_tick: null, record: { blob: 'x'.repeat(MAX_WORKER_MESSAGE_BYTES) } }), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'worker_message_too_large');
});

test('a real worker process that cannot reach the server reports a loss instead of hanging the cohort', async () => {
  const { trace, collected } = collectingTrace();
  const cohort = new WorkerCohort({
    workerCount: 1, seats: SEATS.slice(0, 1), launcher: launchWorkerProcess(), trace, currentTick: () => null,
    base: {
      host: '127.0.0.1', port: 1, minecraft: '26.1.2', view_distance_chunks: 2, seed: '1',
      strategy_interval_ticks: '1', opening_style_cycle: null, record_policy: true, policy_source: POLICY_SOURCE,
      roster: [{ seat: 0, username: 'ArenaBot0' }],
    },
  });
  await assert.rejects(cohort.start(), (error: unknown) => error instanceof RunnerError
    && error.category === 'runtime_failure');
  await cohort.terminate();
  assert.equal(cohort.losses.length, 1);
  assert.ok(collected.worker.some((record) => record.schema === 'worker-loss-v1'));
});
