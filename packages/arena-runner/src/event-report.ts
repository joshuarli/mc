import type { AuthoritativeTick, CivilizationStatePayload, ControlMessage, OutcomePayload, PreparePayload } from './control/types.js';
import { TraceError } from './trace.js';

export interface EventDerivedResult {
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly outcome_status: 'reconstructed_from_authoritative_events';
  readonly statistics: {
    readonly competitor_count: number;
    readonly elimination_count: number;
    readonly death_count: number;
    readonly disconnect_count: number;
    readonly survivor_seats: readonly number[];
  };
}

/** Reconstructs terminal survivors from the prepared roster and resolved elimination events. */
export function reconstructEventResult(
  runId: string,
  prepare: PreparePayload,
  events: readonly ControlMessage[],
): EventDerivedResult {
  const alive = new Set(prepare.roster.map((competitor) => competitor.seat));
  const initialSeats = [...alive].sort(compareNumber);
  let deaths = 0;
  let disconnects = 0;
  let eliminationCount = 0;
  let lastSequence = 0n;
  let previousTick: AuthoritativeTick | undefined;
  let lastEliminationTick: AuthoritativeTick | undefined;
  let lastPublicState: { readonly at: AuthoritativeTick; readonly seats: readonly number[] } | undefined;
  let terminalClock: { readonly phase: string; readonly tick: AuthoritativeTick | null } | undefined;
  let outcome: OutcomePayload | undefined;
  let lastCivilizationState: CivilizationStatePayload | undefined;
  let initialStateSeen = false;
  let terminalStartStateSeen = false;
  let pendingEliminationStateTick: AuthoritativeTick | undefined;

  for (const [index, event] of events.entries()) {
    const record = index + 1;
    if (event.protocol !== 1 || event.run_id !== runId || event.sequence <= lastSequence) {
      throw reportFailure('invalid_event_envelope', record);
    }
    lastSequence = event.sequence;
    if (outcome !== undefined) throw reportFailure('event_after_outcome', record);
    if (pendingEliminationStateTick !== undefined && event.type !== 'public_state') {
      throw reportFailure('elimination_state_missing', record);
    }

    switch (event.type) {
      case 'public_clock': {
        const { phase, tick } = event.payload;
        if (tick !== null) {
          previousTick = requireMonotonicTick(previousTick, tick, record);
        }
        if (phase === 'finished' || phase === 'aborted') {
          if (terminalClock !== undefined) throw reportFailure('duplicate_terminal_clock', record);
          terminalClock = { phase, tick };
        } else if (terminalClock !== undefined) {
          throw reportFailure('event_after_terminal_clock', record);
        }
        break;
      }
      case 'public_state': {
        if (terminalClock !== undefined) {
          const singleSeatStartState = terminalClock.phase === 'finished'
            && terminalClock.tick !== null
            && prepare.roster.length === 1
            && eliminationCount === 0
            && lastEliminationTick === undefined
            && lastPublicState === undefined
            && !terminalStartStateSeen
            && sameTick(terminalClock.tick, event.payload.at);
          if (!singleSeatStartState) throw reportFailure('event_after_terminal_clock', record);
          terminalStartStateSeen = true;
        }
        const expected = [...alive].sort(compareNumber);
        const actual = [...event.payload.alive_seats];
        if (!sameSeats(actual, expected)) throw reportFailure('public_state_mismatch', record);
        if (!initialStateSeen) {
          if (eliminationCount !== 0 || !sameSeats(actual, initialSeats)) {
            throw reportFailure('initial_public_state_missing', record);
          }
          initialStateSeen = true;
        }
        if (pendingEliminationStateTick !== undefined
            && !sameTick(pendingEliminationStateTick, event.payload.at)) {
          throw reportFailure('elimination_state_tick_mismatch', record);
        }
        pendingEliminationStateTick = undefined;
        previousTick = requireMonotonicTick(previousTick, event.payload.at, record);
        lastPublicState = { at: event.payload.at, seats: actual };
        break;
      }
      case 'elimination': {
        if (terminalClock !== undefined) throw reportFailure('event_after_terminal_clock', record);
        const { at, eliminations } = event.payload;
        previousTick = requireMonotonicTick(previousTick, at, record);
        if (lastEliminationTick !== undefined && sameTick(lastEliminationTick, at)) {
          throw reportFailure('duplicate_elimination_tick', record);
        }
        if (lastPublicState !== undefined && sameTick(lastPublicState.at, at)) {
          throw reportFailure('elimination_after_public_state', record);
        }
        for (const elimination of eliminations) {
          if (!alive.delete(elimination.seat)) throw reportFailure('duplicate_or_unknown_elimination', record);
          eliminationCount += 1;
          if (elimination.cause === 'death') deaths += 1;
          else disconnects += 1;
        }
        lastEliminationTick = at;
        pendingEliminationStateTick = at;
        break;
      }
      case 'civilization_state': {
        if (prepare.mode !== 'civilization') throw reportFailure('civilization_event_in_hunger_games', record);
        if (terminalClock !== undefined) throw reportFailure('event_after_terminal_clock', record);
        const state = event.payload;
        if (state.occupants.some((seat) => !alive.has(seat))) throw reportFailure('civilization_dead_occupant', record);
        if ((state.challenger_faction === null) !== (state.capture_progress_ticks === 0n)
            || state.capture_progress_ticks >= BigInt(prepare.settings.civilization.capture_zone.uncontested_ticks)) {
          throw reportFailure('civilization_capture_progress_mismatch', record);
        }
        if (lastCivilizationState !== undefined) {
          if (sameTick(lastCivilizationState.at, state.at)) throw reportFailure('duplicate_civilization_state_tick', record);
          if (state.scores.some((score, index) => score.points < lastCivilizationState!.scores[index]!.points)) {
            throw reportFailure('civilization_score_decreased', record);
          }
        }
        previousTick = requireMonotonicTick(previousTick, state.at, record);
        lastCivilizationState = state;
        break;
      }
      case 'outcome':
        outcome = event.payload;
        validateOutcome(outcome, prepare, initialSeats, alive, lastEliminationTick, terminalClock, lastPublicState, lastCivilizationState, record);
        break;
      default:
        throw reportFailure('non_authoritative_event', record);
    }
  }

  if (outcome === undefined) throw reportFailure('missing_terminal_outcome');
  if (pendingEliminationStateTick !== undefined) throw reportFailure('elimination_state_missing');
  const survivors = [...alive].sort(compareNumber);
  return {
    outcome: outcomeJson(outcome),
    outcome_status: 'reconstructed_from_authoritative_events',
    statistics: {
      competitor_count: prepare.roster.length,
      elimination_count: eliminationCount,
      death_count: deaths,
      disconnect_count: disconnects,
      survivor_seats: survivors,
    },
  };
}

function validateOutcome(
  outcome: OutcomePayload,
  prepare: PreparePayload,
  initialSeats: readonly number[],
  alive: ReadonlySet<number>,
  lastEliminationTick: AuthoritativeTick | undefined,
  terminalClock: { readonly phase: string; readonly tick: AuthoritativeTick | null } | undefined,
  lastPublicState: { readonly at: AuthoritativeTick; readonly seats: readonly number[] } | undefined,
  lastCivilizationState: CivilizationStatePayload | undefined,
  record: number,
): void {
  const survivors = [...alive].sort(compareNumber);
  if (!sameSeats(outcome.survivors, survivors)) throw reportFailure('outcome_survivors_mismatch', record);
  if (outcome.kind === 'abort') {
    if (terminalClock?.phase !== 'aborted' || !sameNullableTick(terminalClock.tick, outcome.at)) {
      throw reportFailure('abort_clock_mismatch', record);
    }
    return;
  }

  if (prepare.mode === 'civilization') {
    if (outcome.kind === 'winner' || (outcome.kind === 'draw' && !('scores' in outcome))) {
      throw reportFailure('hunger_games_outcome_in_civilization', record);
    }
    if (lastCivilizationState === undefined || !sameTick(lastCivilizationState.at, outcome.at)) {
      throw reportFailure('civilization_terminal_state_missing', record);
    }
    if (outcome.scores.some((score, index) => score.faction_id !== lastCivilizationState.scores[index]!.faction_id
        || score.points !== lastCivilizationState.scores[index]!.points)) {
      throw reportFailure('civilization_outcome_scores_mismatch', record);
    }
    if (terminalClock?.phase !== 'finished' || terminalClock.tick === null || !sameTick(terminalClock.tick, outcome.at)) {
      throw reportFailure('terminal_clock_mismatch', record);
    }
    if (lastPublicState === undefined || !sameSeats(lastPublicState.seats, survivors)) {
      throw reportFailure('terminal_public_state_mismatch', record);
    }
    const factions = new Set(survivors.map((seat) => seat < 3 ? 'ember' : 'tide'));
    if (outcome.kind === 'faction_winner' && outcome.reason === 'elimination') {
      if (factions.size !== 1 || !factions.has(outcome.winner_faction_id)
          || lastEliminationTick === undefined || !sameTick(lastEliminationTick, outcome.at)) {
        throw reportFailure('faction_winner_does_not_match_eliminations', record);
      }
    } else if (outcome.kind === 'draw' && outcome.reason === 'no_survivors') {
      if (survivors.length !== 0 || lastEliminationTick === undefined || !sameTick(lastEliminationTick, outcome.at)) {
        throw reportFailure('no_survivors_draw_mismatch', record);
      }
    } else {
      if (outcome.at.domain !== 'match' || outcome.at.value !== prepare.settings.match.authoritative_max_ticks || factions.size !== 2) {
        throw reportFailure('civilization_tick_limit_mismatch', record);
      }
      const [ember, tide] = lastCivilizationState.scores;
      if (outcome.kind === 'draw' ? ember.points !== tide.points
          : (outcome.winner_faction_id === 'ember' ? ember.points <= tide.points : tide.points <= ember.points)) {
        throw reportFailure('civilization_score_outcome_mismatch', record);
      }
    }
    return;
  }
  if (outcome.kind === 'faction_winner' || (outcome.kind === 'draw' && 'scores' in outcome)) {
    throw reportFailure('civilization_outcome_in_hunger_games', record);
  }
  if (outcome.kind === 'winner') {
    if (survivors.length !== 1 || survivors[0] !== outcome.winner_seat) {
      throw reportFailure('winner_does_not_match_eliminations', record);
    }
    const soleInitialCompetitor = initialSeats.length === 1 && eliminationCountIsZero(alive, initialSeats);
    const eliminationResolvedWinner = lastEliminationTick !== undefined && sameTick(lastEliminationTick, outcome.at);
    const oneSeatReleasedAtMatchZero = soleInitialCompetitor && outcome.at.domain === 'match' && outcome.at.value === 0n;
    if (!eliminationResolvedWinner && !oneSeatReleasedAtMatchZero) {
      throw reportFailure('winner_tick_mismatch', record);
    }
    if (terminalClock?.phase !== 'finished' || terminalClock.tick === null || !sameTick(terminalClock.tick, outcome.at)) {
      throw reportFailure('terminal_clock_mismatch', record);
    }
    if (lastPublicState === undefined || !sameSeats(lastPublicState.seats, survivors)
        || (lastEliminationTick !== undefined && !sameTick(lastPublicState.at, outcome.at))) {
      throw reportFailure('terminal_public_state_mismatch', record);
    }
    return;
  }

  if (outcome.reason === 'no_survivors') {
    if (survivors.length !== 0 || lastEliminationTick === undefined || !sameTick(lastEliminationTick, outcome.at)) {
      throw reportFailure('no_survivors_draw_mismatch', record);
    }
  } else if (outcome.at.domain !== 'match'
      || outcome.at.value !== prepare.settings.match.authoritative_max_ticks
      || survivors.length < 2) {
    throw reportFailure('tick_limit_draw_mismatch', record);
  }
  if (terminalClock?.phase !== 'finished' || terminalClock.tick === null || !sameTick(terminalClock.tick, outcome.at)) {
    throw reportFailure('terminal_clock_mismatch', record);
  }
  if (lastPublicState === undefined || !sameSeats(lastPublicState.seats, survivors)
      || (outcome.reason === 'no_survivors' && !sameTick(lastPublicState.at, outcome.at))) {
    throw reportFailure('terminal_public_state_mismatch', record);
  }
}

function outcomeJson(outcome: OutcomePayload): Readonly<Record<string, unknown>> {
  if (outcome.at === null) {
    return { ...outcome, at: null };
  }
  return {
    ...outcome,
    ...('scores' in outcome ? { scores: outcome.scores.map((score) => ({ faction_id: score.faction_id, points: score.points.toString() })) } : {}),
    at: { domain: outcome.at.domain, value: outcome.at.value.toString() },
  };
}

function requireMonotonicTick(
  previous: AuthoritativeTick | undefined,
  current: AuthoritativeTick,
  record: number,
): AuthoritativeTick {
  if (previous !== undefined) {
    const order = compareTick(current, previous);
    if (order < 0) throw reportFailure('event_tick_out_of_order', record);
  }
  return current;
}

function compareTick(
  left: AuthoritativeTick,
  right: AuthoritativeTick,
): number {
  if (left.domain !== right.domain) return left.domain === 'countdown' ? -1 : 1;
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

function sameTick(
  left: AuthoritativeTick,
  right: AuthoritativeTick,
): boolean {
  return left.domain === right.domain && left.value === right.value;
}

function sameNullableTick(left: AuthoritativeTick | null, right: AuthoritativeTick | null): boolean {
  return left === null || right === null ? left === right : sameTick(left, right);
}

function sameSeats(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((seat, index) => seat === right[index]);
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function eliminationCountIsZero(alive: ReadonlySet<number>, initialSeats: readonly number[]): boolean {
  return alive.size === initialSeats.length && initialSeats.every((seat) => alive.has(seat));
}

function reportFailure(kind: string, record?: number): TraceError {
  return new TraceError({ kind, ...(record === undefined ? {} : { record }) });
}
