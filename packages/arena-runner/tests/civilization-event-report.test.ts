import { TraceError } from '../src/trace.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeControlEnvelope } from '../src/control/index.js';
import type { ControlMessage, PreparePayload } from '../src/control/types.js';
import { reconstructEventResult } from '../src/event-report.js';

const prepared = decodeControlEnvelope(readFileSync('fixtures/protocol/control-prepare-civilization.json'));
if (prepared.type !== 'prepare') throw new Error('prepare fixture required');
const prepare: PreparePayload = prepared.payload;
const runId = 'civilization-report';
const at = { domain: 'match' as const, value: 18000n };
const scores = [{ faction_id: 'ember' as const, points: 12n }, { faction_id: 'tide' as const, points: 10n }] as const;
function events(): ControlMessage[] {
  return [
    { protocol: 1, run_id: runId, sequence: 1n, type: 'public_state', payload: { at, alive_seats: [0, 1, 2, 3, 4, 5] } },
    { protocol: 1, run_id: runId, sequence: 2n, type: 'civilization_state', payload: {
      at, occupants: [0], owner_faction: 'ember', challenger_faction: null, capture_progress_ticks: 0n, scores } },
    { protocol: 1, run_id: runId, sequence: 3n, type: 'public_clock', payload: { phase: 'finished', tick: at, border_diameter_blocks: 192 } },
    { protocol: 1, run_id: runId, sequence: 4n, type: 'outcome', payload: {
      kind: 'faction_winner', winner_faction_id: 'ember', reason: 'tick_limit', scores, survivors: [0, 1, 2, 3, 4, 5], at } },
  ];
}

test('civilization report reconstructs exact terminal faction scores', () => {
  const report = reconstructEventResult(runId, prepare, events());
  assert.deepEqual(report.outcome.scores, [{ faction_id: 'ember', points: '12' }, { faction_id: 'tide', points: '10' }]);
  assert.equal(report.statistics.elimination_count, 0);
});

test('civilization report rejects altered terminal scores and missing exact state', () => {
  const altered = events();
  const outcome = altered[3]!;
  if (outcome.type !== 'outcome' || outcome.payload.kind !== 'faction_winner') throw new Error('outcome required');
  altered[3] = { ...outcome, payload: { ...outcome.payload, scores: [scores[0], { faction_id: 'tide', points: 11n }] } };
  assert.throws(() => reconstructEventResult(runId, prepare, altered), (error: unknown) => error instanceof TraceError && error.source.kind === 'civilization_outcome_scores_mismatch');
  assert.throws(() => reconstructEventResult(runId, prepare, events().filter((event) => event.type !== 'civilization_state')),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'civilization_terminal_state_missing');
});

test('civilization report requires equal authoritative scores for a scored draw', () => {
  const records = events();
  const equalScores = [scores[0], { faction_id: 'tide' as const, points: 12n }] as const;
  const state = records[1]!;
  if (state.type !== 'civilization_state') throw new Error('state required');
  records[1] = { ...state, payload: { ...state.payload, scores: equalScores } };
  records[3] = { protocol: 1, run_id: runId, sequence: 4n, type: 'outcome', payload: {
    kind: 'draw', reason: 'tick_limit', scores: equalScores, survivors: [0, 1, 2, 3, 4, 5], at } };
  assert.equal(reconstructEventResult(runId, prepare, records).outcome.kind, 'draw');
});
