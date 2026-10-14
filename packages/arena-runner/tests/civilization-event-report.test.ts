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

function countdownDisconnectEvents(allSeats: boolean, resolutionTick = 0n): ControlMessage[] {
  const initial = { domain: 'countdown' as const, value: 0n };
  const disconnectedAt = { domain: 'countdown' as const, value: 1n };
  const resolvedAt = { domain: 'match' as const, value: resolutionTick };
  const survivors = allSeats ? [] : [0, 1, 2];
  const disconnected = allSeats ? [0, 1, 2, 3, 4, 5] : [3, 4, 5];
  const zeroScores = [{ faction_id: 'ember' as const, points: 0n }, { faction_id: 'tide' as const, points: 0n }] as const;
  return [
    { protocol: 1, run_id: runId, sequence: 1n, type: 'public_clock', payload: { phase: 'countdown', tick: initial, border_diameter_blocks: 192 } },
    { protocol: 1, run_id: runId, sequence: 2n, type: 'public_state', payload: { at: initial, alive_seats: [0, 1, 2, 3, 4, 5] } },
    { protocol: 1, run_id: runId, sequence: 3n, type: 'elimination', payload: { at: disconnectedAt,
      eliminations: disconnected.map((seat) => ({ seat, cause: 'disconnect' as const })) } },
    { protocol: 1, run_id: runId, sequence: 4n, type: 'public_state', payload: { at: disconnectedAt, alive_seats: survivors } },
    { protocol: 1, run_id: runId, sequence: 5n, type: 'civilization_state', payload: {
      at: resolvedAt, occupants: [], owner_faction: null, challenger_faction: null, capture_progress_ticks: 0n, scores: zeroScores } },
    { protocol: 1, run_id: runId, sequence: 6n, type: 'public_clock', payload: { phase: 'finished', tick: resolvedAt, border_diameter_blocks: 192 } },
    { protocol: 1, run_id: runId, sequence: 7n, type: 'outcome', payload: allSeats
      ? { kind: 'draw', reason: 'no_survivors', scores: zeroScores, survivors, at: resolvedAt }
      : { kind: 'faction_winner', winner_faction_id: 'ember', reason: 'elimination', scores: zeroScores, survivors, at: resolvedAt } },
  ];
}

test('civilization report resolves a faction disconnected during countdown at match zero', () => {
  const records = countdownDisconnectEvents(false);
  const report = reconstructEventResult(runId, prepare, records);
  assert.equal(report.outcome.kind, 'faction_winner');
  assert.deepEqual(report.outcome.at, { domain: 'match', value: '0' });
  assert.equal(report.statistics.disconnect_count, 3);
  assert.deepEqual(report.statistics.survivor_seats, [0, 1, 2]);
  const elimination = records[2]!;
  if (elimination.type !== 'elimination') throw new Error('elimination required');
  assert.deepEqual(elimination.payload.at, { domain: 'countdown', value: 1n });
});

test('civilization report resolves all countdown disconnects as a match-zero draw', () => {
  const report = reconstructEventResult(runId, prepare, countdownDisconnectEvents(true));
  assert.equal(report.outcome.kind, 'draw');
  assert.equal(report.outcome.reason, 'no_survivors');
  assert.deepEqual(report.outcome.at, { domain: 'match', value: '0' });
  assert.equal(report.statistics.disconnect_count, 6);
  assert.deepEqual(report.statistics.survivor_seats, []);
});

test('civilization report rejects countdown elimination resolution delayed to match one', () => {
  for (const allSeats of [false, true]) {
    assert.throws(() => reconstructEventResult(runId, prepare, countdownDisconnectEvents(allSeats, 1n)),
      (error: unknown) => error instanceof TraceError && error.source.kind ===
        (allSeats ? 'no_survivors_draw_mismatch' : 'faction_winner_does_not_match_eliminations'));
  }
});
