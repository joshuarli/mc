import { SpecError, SpecErrorKind, withExternalSeat as applyExternalSeat, type ScenarioIr } from '@arena/spec';
import { RunnerError } from './errors.js';

export interface ExternalSeatRequest {
  readonly seat: number;
  readonly username: string;
}

export function withExternalSeat(scenario: ScenarioIr, request: ExternalSeatRequest): ScenarioIr {
  try {
    return applyExternalSeat(scenario, request);
  } catch (error) {
    if (error instanceof SpecError) throw mapExternalSeatError(error);
    throw error;
  }
}

export function externalSeats(scenario: ScenarioIr): readonly Readonly<{ seat: number; username: string }>[] {
  return scenario.roster.seats.flatMap(({ seat, controller }) =>
    controller.kind === 'external' ? [{ seat, username: controller.username }] : []);
}

function mapExternalSeatError(error: SpecError): RunnerError {
  const field = error.path.endsWith('.username') ? 'username' : error.path.endsWith('.seat') ? 'seat' : undefined;
  const reject = (kind: string): RunnerError => new RunnerError('invalid_input', 'external seat', {
    kind,
    ...(field === undefined ? {} : { field }),
  });
  switch (error.kind) {
    case SpecErrorKind.Range:
      return reject('external_seat_outside_roster');
    case SpecErrorKind.Conflict:
      if (field === 'seat') return reject('external_seat_already_assigned');
      return reject(error.message.includes('unique') ? 'duplicate_external_username' : 'reserved_external_username');
    default:
      if (field === 'username') return reject('invalid_external_username');
      return reject(error.message.includes('natural') ? 'external_seat_requires_natural_terrain' : 'external_seat_requires_hunger_games');
  }
}
