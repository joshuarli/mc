import assert from 'node:assert/strict';
import test from 'node:test';
import { type ControlMessage } from '../src/control/index.js';
import { parseSegment } from '../src/trace.js';
import { RunnerError } from '../src/errors.js';
import { RuntimeTraceBuilder } from '../src/runtime/trace.js';

const RUN_ID = 'runtime-trace-test';
const READY: Extract<ControlMessage, { readonly type: 'ready' }> = {
  protocol: 1,
  run_id: RUN_ID,
  sequence: 2n,
  correlation: 1n,
  type: 'ready',
  payload: {
    server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 1 },
    plugin: { name: 'Arena', version: 'test' },
    capabilities: ['hunger_games_v1'],
  },
};

test('runtime trace retains critical clocks and terminal outcome', () => {
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(READY);
  trace.record(clockMessage(3n, 'waiting'));
  trace.record({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 3n,
    type: 'heartbeat',
    payload: {},
  });
  trace.record(clockMessage(5n, 'waiting'));
  trace.record({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 6n,
    type: 'outcome',
    payload: {
      kind: 'abort',
      reason: 'operator',
      survivors: [],
      at: null,
    },
  });

  const bytes = trace.finalize();
  const segment = parseSegment(bytes);
  assert.equal(segment.runId, RUN_ID);
  assert.equal(segment.firstSequence, 1n);
  assert.equal(segment.lastSequence, 4n);
  assert.deepEqual(segment.records.map((record) => record.type), [
    'ready',
    'public_clock',
    'public_clock',
    'outcome',
  ]);
  assert.deepEqual(segment.records[0], {
    protocol: 1,
    run_id: RUN_ID,
    sequence: '2',
    correlation: '1',
    type: 'ready',
    payload: READY.payload,
  });
  assert.equal(trace.finalize().equals(bytes), true);
  assert.throws(() => trace.record(clockMessage(6n, 'aborted')), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'trace_finalized');
});

test('runtime trace refuses to finalize without an authoritative outcome', () => {
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(READY);

  assert.throws(() => trace.finalize(), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'outcome_missing');
});

test('runtime trace refuses plugin events before readiness is recorded', () => {
  const trace = new RuntimeTraceBuilder(RUN_ID);

  assert.throws(() => trace.record({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'outcome',
    payload: { kind: 'abort', reason: 'operator', survivors: [], at: null },
  }), (error: unknown) => error instanceof RunnerError && error.source.kind === 'readiness_missing');
});

test('runtime trace rejects hello frames so credentials cannot enter evidence', () => {
  const trace = new RuntimeTraceBuilder(RUN_ID);
  const hello: ControlMessage = {
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'hello',
    payload: { token: 'never-write-this-token', capabilities: ['hunger_games_v1'] },
  };

  assert.throws(() => trace.record(hello), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unexpected_handshake');
  trace.recordReady(READY);
  trace.record({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 3n,
    type: 'outcome',
    payload: { kind: 'abort', reason: 'operator', survivors: [], at: null },
  });
  assert.equal(trace.finalize().toString('utf8').includes('never-write-this-token'), false);
});

test('runtime trace fails before its bounded record buffer can grow without limit', () => {
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(READY);
  let failure: unknown;
  for (let index = 0; index < 100_000; index += 1) {
    try {
      trace.record({
        protocol: 1,
        run_id: RUN_ID,
        sequence: BigInt(index + 3),
        type: 'public_state',
        payload: { at: { domain: 'match', value: BigInt(index + 1) }, alive_seats: [0, 1] },
      });
    } catch (error) {
      failure = error;
      break;
    }
  }

  assert.ok(failure instanceof RunnerError);
  assert.equal(failure.source.kind, 'trace_limit_exceeded');
});

function clockMessage(sequence: bigint, phase: 'waiting' | 'aborted'): ControlMessage {
  return {
    protocol: 1,
    run_id: RUN_ID,
    sequence,
    type: 'public_clock',
    payload: { phase, tick: null, border_diameter_blocks: 100 },
  };
}
