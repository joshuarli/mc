import { RunnerError } from '../errors.js';
import type { RuntimeAuthorityEvent } from './types.js';

export function assertEventSeatsInRoster(event: RuntimeAuthorityEvent, rosterSize: number): void {
  switch (event.type) {
    case 'public_clock':
      return;
    case 'public_state':
      assertSeats(event.payload.alive_seats, rosterSize, 'alive_seats');
      return;
    case 'civilization_state':
      assertSeats(event.payload.occupants, rosterSize, 'occupants');
      return;
    case 'damage':
      assertSeats(event.payload.entries.map((entry) => entry.victim), rosterSize, 'damage_victims');
      assertSeats(event.payload.entries.flatMap((entry) => entry.attacker === null ? [] : [entry.attacker]),
        rosterSize, 'damage_attackers');
      return;
    case 'mechanics_receipt':
      assertSeats(event.payload.receipts.map((receipt) => receipt.seat), rosterSize, 'mechanics_receipts');
      return;
    case 'elimination':
      assertSeats(event.payload.eliminations.map((entry) => entry.seat), rosterSize, 'eliminations');
      return;
    case 'outcome':
      if (event.payload.kind === 'winner') assertSeats([event.payload.winner_seat], rosterSize, 'winner_seat');
      assertSeats(event.payload.survivors, rosterSize, 'survivors');
      return;
  }
}

function assertSeats(seats: readonly number[], rosterSize: number, field: string): void {
  for (const seat of seats) {
    if (!Number.isSafeInteger(seat) || seat < 0 || seat >= rosterSize) {
      throw new RunnerError('runtime_failure', 'control events', { kind: 'seat_outside_roster', field });
    }
  }
}
