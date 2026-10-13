import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructEventResult } from '../src/event-report.js';
import { TraceError } from '../src/trace.js';
import type { ControlMessage, PreparePayload } from '../src/control/types.js';

const runId = 'event-report-test';

function prepare(rosterSize = 2, maxTicks = 10n): PreparePayload {
  return {
    map_semantic_id: 'a'.repeat(64),
    scenario_semantic_id: 'b'.repeat(64),
    seed: 1n,
    mode: 'hunger_games',
    settings: {
      match: {
        countdown_ticks: 0n,
        grace_ticks: 0n,
        authoritative_max_ticks: maxTicks,
        respawn: false,
        block_breaking: false,
        block_placing: false,
        natural_mobs: false,
        natural_random_ticks: false,
      },
      border: {
        initial_diameter_blocks: 126,
        shrink_start_tick: 0n,
        shrink_end_tick: maxTicks,
        final_diameter_blocks: 16,
      },
    },
    roster: Array.from({ length: rosterSize }, (_, seat) => ({
      kind: 'bot' as const,
      seat,
      participant_id: `bot-${seat}`,
      username: `bot_${seat}`,
      offline_uuid: `00000000-0000-0000-0000-${String(seat + 1).padStart(12, '0')}`,
    })),
  };
}

function clock(
  sequence: bigint,
  phase: 'active' | 'finished',
  value: bigint,
): ControlMessage {
  return {
    protocol: 1,
    run_id: runId,
    sequence,
    type: 'public_clock',
    payload: {
      phase,
      tick: { domain: 'match', value },
      border_diameter_blocks: 126,
    },
  };
}

function state(sequence: bigint, value: bigint, alive_seats: readonly number[]): ControlMessage {
  return {
    protocol: 1,
    run_id: runId,
    sequence,
    type: 'public_state',
    payload: { at: { domain: 'match', value }, alive_seats },
  };
}

function elimination(
  sequence: bigint,
  value: bigint,
  eliminations: readonly { readonly seat: number; readonly cause: 'death' | 'disconnect' }[],
): ControlMessage {
  return {
    protocol: 1,
    run_id: runId,
    sequence,
    type: 'elimination',
    payload: { at: { domain: 'match', value }, eliminations },
  };
}

test('report reconstructs a winner and counts only resolved elimination causes', () => {
  const result = reconstructEventResult(runId, prepare(), [
    clock(3n, 'active', 0n),
    state(4n, 0n, [0, 1]),
    elimination(5n, 8n, [{ seat: 1, cause: 'death' }]),
    state(6n, 8n, [0]),
    clock(7n, 'finished', 8n),
    {
      protocol: 1,
      run_id: runId,
      sequence: 8n,
      type: 'outcome',
      payload: { kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: 8n } },
    },
  ]);

  assert.deepEqual(result, {
    outcome: { kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: '8' } },
    outcome_status: 'reconstructed_from_authoritative_events',
    statistics: {
      competitor_count: 2,
      elimination_count: 1,
      death_count: 1,
      disconnect_count: 0,
      survivor_seats: [0],
    },
  });
});

test('report accepts a same-tick zero-survivor draw and retains the emitted causes', () => {
  const result = reconstructEventResult(runId, prepare(), [
    state(3n, 4n, [0, 1]),
    elimination(4n, 4n, [
      { seat: 0, cause: 'death' },
      { seat: 1, cause: 'disconnect' },
    ]),
    state(5n, 4n, []),
    clock(6n, 'finished', 4n),
    {
      protocol: 1,
      run_id: runId,
      sequence: 7n,
      type: 'outcome',
      payload: { kind: 'draw', reason: 'no_survivors', survivors: [], at: { domain: 'match', value: 4n } },
    },
  ]);

  assert.equal(result.statistics.elimination_count, 2);
  assert.equal(result.statistics.death_count, 1);
  assert.equal(result.statistics.disconnect_count, 1);
  assert.deepEqual(result.statistics.survivor_seats, []);
});

test('report validates tick-limit draws against prepared rules and surviving seats', () => {
  const result = reconstructEventResult(runId, prepare(2, 10n), [
    clock(3n, 'active', 0n),
    state(4n, 0n, [0, 1]),
    clock(5n, 'finished', 10n),
    {
      protocol: 1,
      run_id: runId,
      sequence: 6n,
      type: 'outcome',
      payload: { kind: 'draw', reason: 'tick_limit', survivors: [0, 1], at: { domain: 'match', value: 10n } },
    },
  ]);

  assert.equal(result.outcome_status, 'reconstructed_from_authoritative_events');
  assert.deepEqual(result.statistics.survivor_seats, [0, 1]);
});

test('report handles a single-seat match and an abort while waiting', () => {
  const singleSeat = reconstructEventResult(runId, prepare(1), [
    clock(3n, 'finished', 0n),
    state(4n, 0n, [0]),
    {
      protocol: 1,
      run_id: runId,
      sequence: 5n,
      type: 'outcome',
      payload: { kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: 0n } },
    },
  ]);
  assert.deepEqual(singleSeat.statistics.survivor_seats, [0]);

  const waitingAbort = reconstructEventResult(runId, prepare(), [
    {
      protocol: 1,
      run_id: runId,
      sequence: 3n,
      type: 'public_clock',
      payload: { phase: 'aborted', tick: null, border_diameter_blocks: 126 },
    },
    {
      protocol: 1,
      run_id: runId,
      sequence: 4n,
      type: 'outcome',
      payload: { kind: 'abort', reason: 'operator', survivors: [0, 1], at: null },
    },
  ]);
  assert.equal(waitingAbort.outcome.kind, 'abort');
  assert.deepEqual(waitingAbort.statistics.survivor_seats, [0, 1]);

  assert.throws(() => reconstructEventResult(runId, prepare(1), [
    clock(3n, 'finished', 0n),
    state(4n, 9n, [0]),
    {
      protocol: 1,
      run_id: runId,
      sequence: 5n,
      type: 'outcome',
      payload: { kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: 0n } },
    },
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'event_after_terminal_clock');
});

test('report rejects terminal summaries that contradict eliminations, state, or the tick limit', () => {
  const winnerEvents: ControlMessage[] = [
    clock(3n, 'active', 0n),
    state(4n, 0n, [0, 1]),
    elimination(5n, 8n, [{ seat: 1, cause: 'death' }]),
    state(6n, 8n, [0]),
    clock(7n, 'finished', 8n),
  ];
  assert.throws(() => reconstructEventResult(runId, prepare(), [
    ...winnerEvents,
    {
      protocol: 1,
      run_id: runId,
      sequence: 8n,
      type: 'outcome',
      payload: { kind: 'draw', reason: 'no_survivors', survivors: [], at: { domain: 'match', value: 8n } },
    },
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'outcome_survivors_mismatch');

  assert.throws(() => reconstructEventResult(runId, prepare(), [
    clock(3n, 'active', 0n),
    state(4n, 0n, [0, 1]),
    elimination(5n, 8n, [{ seat: 1, cause: 'death' }]),
    state(6n, 8n, [1]),
    clock(7n, 'finished', 8n),
    {
      protocol: 1,
      run_id: runId,
      sequence: 8n,
      type: 'outcome',
      payload: { kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: 8n } },
    },
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'public_state_mismatch');

  assert.throws(() => reconstructEventResult(runId, prepare(2, 10n), [
    state(3n, 0n, [0, 1]),
    clock(4n, 'finished', 8n),
    {
      protocol: 1,
      run_id: runId,
      sequence: 5n,
      type: 'outcome',
      payload: { kind: 'draw', reason: 'tick_limit', survivors: [0, 1], at: { domain: 'match', value: 8n } },
    },
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'tick_limit_draw_mismatch');
});

test('report rejects duplicate seats, repeated elimination ticks, and decreasing event ticks', () => {
  assert.throws(() => reconstructEventResult(runId, prepare(), [
    state(3n, 0n, [0, 1]),
    elimination(4n, 1n, [
      { seat: 1, cause: 'disconnect' },
      { seat: 1, cause: 'death' },
    ]),
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'duplicate_or_unknown_elimination');

  assert.throws(() => reconstructEventResult(runId, prepare(), [
    state(3n, 0n, [0, 1]),
    elimination(4n, 2n, [{ seat: 1, cause: 'death' }]),
    state(5n, 2n, [0]),
    elimination(6n, 2n, [{ seat: 0, cause: 'death' }]),
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'duplicate_elimination_tick');

  assert.throws(() => reconstructEventResult(runId, prepare(), [
    state(3n, 2n, [0, 1]),
    clock(4n, 'active', 1n),
  ]), (error: unknown) => error instanceof TraceError && error.source.kind === 'event_tick_out_of_order');
});
