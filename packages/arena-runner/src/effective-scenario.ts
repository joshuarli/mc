import { createHash } from 'node:crypto';
import { EXTERNAL_USERNAME_PATTERN, type ScenarioIr, type SeatIr, type SemanticId } from '@arena/spec';
import { RunnerError } from './errors.js';

export interface ExternalSeatRequest {
  readonly seat: number;
  readonly username: string;
}

const RESERVED_USERNAME_PREFIXES = ['arenabot', 'arenaspec'] as const;
const EFFECTIVE_IDENTITY_DOMAIN = 'arena.scenario.effective-roster.v1\0';

export function withExternalSeat(scenario: ScenarioIr, request: ExternalSeatRequest): ScenarioIr {
  if (scenario.mode !== 'hunger_games') {
    throw invalidExternalSeat('external_seat_requires_hunger_games');
  }
  if (scenario.map.terrain !== 'vanilla') {
    throw invalidExternalSeat('external_seat_requires_natural_terrain');
  }
  if (!Number.isSafeInteger(request.seat) || request.seat < 0 || request.seat >= scenario.roster.competitors) {
    throw invalidExternalSeat('external_seat_outside_roster', 'seat');
  }
  if (!EXTERNAL_USERNAME_PATTERN.test(request.username)) {
    throw invalidExternalSeat('invalid_external_username', 'username');
  }
  const folded = request.username.toLowerCase();
  if (RESERVED_USERNAME_PREFIXES.some((prefix) => folded.startsWith(prefix))) {
    throw invalidExternalSeat('reserved_external_username', 'username');
  }
  const configured = scenario.roster.seats[request.seat]!;
  if (configured.controller.kind !== 'bot') {
    throw invalidExternalSeat('external_seat_already_assigned', 'seat');
  }
  for (const { controller } of scenario.roster.seats) {
    if (controller.kind === 'external' && controller.username.toLowerCase() === folded) {
      throw invalidExternalSeat('duplicate_external_username', 'username');
    }
  }

  const seats: readonly SeatIr[] = Object.freeze(scenario.roster.seats.map((entry) => entry.seat === request.seat
    ? Object.freeze({
      seat: entry.seat,
      controller: Object.freeze({ kind: 'external' as const, username: request.username }),
    })
    : entry));
  const hash = createHash('sha256');
  hash.update(EFFECTIVE_IDENTITY_DOMAIN, 'utf8');
  hash.update(scenario.semanticId, 'utf8');
  hash.update(`\0${request.seat}\0${request.username}`, 'utf8');
  return Object.freeze({
    ...scenario,
    roster: Object.freeze({ ...scenario.roster, seats }),
    semanticId: hash.digest('hex') as SemanticId,
  });
}

export function externalSeats(scenario: ScenarioIr): readonly Readonly<{ seat: number; username: string }>[] {
  return scenario.roster.seats.flatMap(({ seat, controller }) =>
    controller.kind === 'external' ? [{ seat, username: controller.username }] : []);
}

function invalidExternalSeat(kind: string, field?: string): RunnerError {
  return new RunnerError('invalid_input', 'external seat', { kind, ...(field === undefined ? {} : { field }) });
}
