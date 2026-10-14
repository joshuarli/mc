import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeControlEnvelope, encodeControlEnvelope, type ControlMessage } from '../src/control/index.js';
import { reconstructRunEvidence, type Evidence } from '../src/evidence.js';
import { TraceError, type TraceRecord } from '../src/trace.js';

const runId = 'civilization-pending-abort';
const survivors = [0, 1, 2, 3, 4, 5];
const at = { domain: 'match' as const, value: 2500n };
const next = { domain: 'match' as const, value: 2501n };
const prepared = decodeControlEnvelope(readFileSync('fixtures/protocol/control-prepare-civilization.json'));
if (prepared.type !== 'prepare' || prepared.payload.mode !== 'civilization') throw new Error('civilization prepare required');

function messages(): ControlMessage[] {
  return [
    { protocol: 1, run_id: runId, sequence: 2n, correlation: 1n, type: 'ready', payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: '26.1.2', protocol_version: 775 },
      plugin: { name: 'Arena', version: 'test' }, capabilities: ['civilization_v1'],
    } },
    { ...prepared, run_id: runId },
    { protocol: 1, run_id: runId, sequence: 3n, correlation: 2n, type: 'ack', payload: {} },
    { protocol: 1, run_id: runId, sequence: 4n, type: 'public_clock', payload: {
      phase: 'waiting', tick: null, border_diameter_blocks: 192,
    } },
    { protocol: 1, run_id: runId, sequence: 3n, type: 'start', payload: {} },
    { protocol: 1, run_id: runId, sequence: 5n, correlation: 3n, type: 'ack', payload: {} },
    { protocol: 1, run_id: runId, sequence: 6n, type: 'public_clock', payload: {
      phase: 'active', tick: at, border_diameter_blocks: 192,
    } },
    { protocol: 1, run_id: runId, sequence: 7n, type: 'public_state', payload: { at, alive_seats: survivors } },
    { protocol: 1, run_id: runId, sequence: 8n, type: 'civilization_state', payload: {
      at, occupants: [0], owner_faction: 'ember', challenger_faction: null, capture_progress_ticks: 0n,
      scores: [{ faction_id: 'ember', points: 12n }, { faction_id: 'tide', points: 0n }],
    } },
    { protocol: 1, run_id: runId, sequence: 4n, type: 'abort', payload: { reason: 'runtime_timeout' } },
    { protocol: 1, run_id: runId, sequence: 9n, type: 'civilization_state', payload: {
      at: next, occupants: [0], owner_faction: 'ember', challenger_faction: null, capture_progress_ticks: 0n,
      scores: [{ faction_id: 'ember', points: 13n }, { faction_id: 'tide', points: 0n }],
    } },
    { protocol: 1, run_id: runId, sequence: 10n, correlation: 4n, type: 'ack', payload: {} },
    { protocol: 1, run_id: runId, sequence: 11n, type: 'public_clock', payload: {
      phase: 'aborted', tick: next, border_diameter_blocks: 192,
    } },
    { protocol: 1, run_id: runId, sequence: 12n, type: 'outcome', payload: {
      kind: 'abort', reason: 'runtime_timeout', survivors, at: next,
    } },
  ];
}

function evidence(messages: readonly ControlMessage[]): Evidence {
  const records: TraceRecord[] = messages.map((message) => ({
    ...JSON.parse(Buffer.from(encodeControlEnvelope(message)).toString('utf8')),
    direction: message.type === 'prepare' || message.type === 'start' || message.type === 'abort' ? 'runner' : 'plugin',
  }));
  return { run_id: runId, first_sequence: '1', last_sequence: String(records.length), segments: [], records };
}

function rejectsEvidence(kind: string) {
  return (error: unknown) => error instanceof TraceError && error.source.kind === kind;
}

test('civilization pending abort accepts ongoing faction state before its matching acknowledgment', () => {
  const result = reconstructRunEvidence(evidence(messages()));
  assert.deepEqual(result.report.outcome, {
    kind: 'abort', reason: 'runtime_timeout', survivors, at: { domain: 'match', value: '2501' },
  });
});

test('civilization pending abort preserves faction score and tick validation', () => {
  const decreased = messages();
  const state = decreased[10]!;
  if (state.type !== 'civilization_state') throw new Error('faction state required');
  decreased[10] = { ...state, payload: { ...state.payload,
    scores: [{ faction_id: 'ember', points: 11n }, { faction_id: 'tide', points: 0n }],
  } };
  assert.throws(() => reconstructRunEvidence(evidence(decreased)), rejectsEvidence('civilization_score_decreased'));
  const duplicateTick = messages();
  duplicateTick[10] = { ...state, payload: { ...state.payload, at } };
  assert.throws(() => reconstructRunEvidence(evidence(duplicateTick)), rejectsEvidence('duplicate_civilization_state_tick'));
});

test('civilization pending abort still rejects terminal effects before acknowledgment', () => {
  const records = messages();
  for (const terminal of [records[12]!, records[13]!]) {
    assert.throws(() => reconstructRunEvidence(evidence([...records.slice(0, 11), terminal, ...records.slice(11)])),
      rejectsEvidence('event_before_command_acknowledgment'));
  }
});
