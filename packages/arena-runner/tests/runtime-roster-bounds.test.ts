import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';
import { assertEventSeatsInRoster } from '../src/runtime/roster-bounds.js';
import type { RuntimeAuthorityEvent } from '../src/runtime/types.js';

const at = { domain: 'match', value: 10n } as const;
const envelope = { protocol: 1, run_id: 'bounds', sequence: 1n } as const;

function state(seats: readonly number[]): RuntimeAuthorityEvent {
  return { ...envelope, type: 'public_state', payload: { at, alive_seats: seats } };
}

function rejectsSeat(event: RuntimeAuthorityEvent, rosterSize: number, field: string): void {
  assert.throws(() => assertEventSeatsInRoster(event, rosterSize), (error: unknown) =>
    error instanceof RunnerError && error.category === 'runtime_failure'
      && error.source.kind === 'seat_outside_roster' && error.source.field === field);
}

test('runtime events accept seats inside the prepared roster and reject the first seat beyond it', () => {
  assertEventSeatsInRoster(state([0, 1, 23]), 24);
  rejectsSeat(state([0, 24]), 24, 'alive_seats');
  assertEventSeatsInRoster(state([255]), 256);
});

test('elimination and outcome seats are bounded by the prepared roster', () => {
  rejectsSeat({ ...envelope, type: 'elimination', payload: { at, eliminations: [{ seat: 9, cause: 'death' }] } },
    8, 'eliminations');
  rejectsSeat({ ...envelope, type: 'outcome', payload: { kind: 'winner', winner_seat: 8, survivors: [8], at } },
    8, 'winner_seat');
  rejectsSeat({ ...envelope, type: 'outcome', payload: { kind: 'draw', reason: 'tick_limit', survivors: [3, 8], at } },
    8, 'survivors');
  assertEventSeatsInRoster(
    { ...envelope, type: 'outcome', payload: { kind: 'winner', winner_seat: 7, survivors: [7], at } }, 8);
});
