import type { RuntimeAuthorityEvent } from "../../packages/arena-runner/src/runtime/types.js";
import type { AuthoritativeTick } from "../../packages/arena-runner/src/control/types.js";

type FactionId = "ember" | "tide";

interface CivilizationStateEvidencePayload {
  readonly at: AuthoritativeTick;
  readonly occupants: readonly number[];
  readonly owner_faction: FactionId | null;
  readonly challenger_faction: FactionId | null;
  readonly capture_progress_ticks: bigint;
  readonly scores: readonly [
    Readonly<{ faction_id: "ember"; points: bigint }>,
    Readonly<{ faction_id: "tide"; points: bigint }>,
  ];
}

interface CivilizationStateEvidenceEvent {
  readonly protocol: 1;
  readonly run_id: string;
  readonly sequence: bigint;
  readonly type: "civilization_state";
  readonly payload: CivilizationStateEvidencePayload;
}

type CivilizationEvidenceEvent = RuntimeAuthorityEvent | CivilizationStateEvidenceEvent;

interface ExpectedCaptureState {
  readonly owner: FactionId | null;
  readonly challenger: FactionId | null;
  readonly progress: bigint;
}

/** Replays authoritative occupants and verifies every emitted capture owner, challenge, and score. */
export function assertCivilizationCaptureEvidence(
  events: readonly CivilizationEvidenceEvent[],
  settings: Readonly<{ graceTicks: bigint; uncontestedCaptureTicks: bigint }>,
): void {
  if (settings.graceTicks < 0n || settings.uncontestedCaptureTicks <= 0n) {
    throw new RangeError("civilization capture thresholds must be nonnegative and nonzero");
  }

  const eliminatedSeats = new Set<number>();
  const stateRecords: { event: CivilizationStateEvidenceEvent; eliminatedSeats: ReadonlySet<number> }[] = [];
  let previousSequence = 0n;
  for (const event of events) {
    if (event.sequence <= previousSequence) throw new Error("civilization event stream sequence is not increasing");
    previousSequence = event.sequence;
    if (event.type === "elimination") {
      for (const elimination of event.payload.eliminations) {
        if (!Number.isSafeInteger(elimination.seat) || elimination.seat < 0 || elimination.seat > 5
          || eliminatedSeats.has(elimination.seat)) {
          throw new Error("civilization elimination event repeats or references an invalid seat");
        }
        eliminatedSeats.add(elimination.seat);
      }
    }
    if (event.type === "civilization_state") {
      stateRecords.push({ event: event as CivilizationStateEvidenceEvent, eliminatedSeats: new Set(eliminatedSeats) });
    }
  }
  if (stateRecords.length === 0) throw new Error("civilization evidence requires authoritative capture-state events");

  let expectedTick = 0n;
  let expectedState: ExpectedCaptureState = { owner: null, challenger: null, progress: 0n };
  let emberScore = 0n;
  let tideScore = 0n;
  let firstOwner: FactionId | null = null;
  let changedOwnerToOpponent = false;

  for (const [index, stateRecord] of stateRecords.entries()) {
    const { event } = stateRecord;
    const state = event.payload;
    const at = state.at;
    if (at.domain !== "match" || at.value !== expectedTick) {
      throw new Error(`civilization state tick sequence is incomplete at index ${index}`);
    }
    if (state.occupants.some((seat, seatIndex) => !Number.isSafeInteger(seat) || seat < 0 || seat > 5
      || (seatIndex > 0 && state.occupants[seatIndex - 1]! >= seat)
      || stateRecord.eliminatedSeats.has(seat))) {
      throw new Error(`civilization state ${expectedTick} has invalid, repeated, unordered, or eliminated occupants`);
    }
    const occupantFactions = new Set(state.occupants.map(factionForSeat));
    if (expectedTick >= settings.graceTicks) {
      expectedState = advanceCapture(expectedState, occupantFactions, settings.uncontestedCaptureTicks);
    }
    if (state.owner_faction !== expectedState.owner
      || state.challenger_faction !== expectedState.challenger
      || state.capture_progress_ticks !== expectedState.progress) {
      throw new Error(`civilization state ${expectedTick} does not match occupants and capture rules`);
    }

    if (expectedTick >= settings.graceTicks && expectedState.owner !== null) {
      if (expectedState.owner === "ember") emberScore += 1n;
      else tideScore += 1n;
    }
    if (state.scores.length !== 2
      || state.scores[0]?.faction_id !== "ember" || state.scores[0].points !== emberScore
      || state.scores[1]?.faction_id !== "tide" || state.scores[1].points !== tideScore) {
      throw new Error(`civilization state ${expectedTick} has scores inconsistent with actual ownership`);
    }
    if (expectedState.owner !== null && firstOwner === null) firstOwner = expectedState.owner;
    else if (firstOwner !== null && expectedState.owner !== null && expectedState.owner !== firstOwner) {
      changedOwnerToOpponent = true;
    }
    expectedTick += 1n;
  }

  if (firstOwner === null || !changedOwnerToOpponent) {
    throw new Error("civilization capture evidence must show a faction claim and a later opponent capture");
  }
  if (emberScore === 0n || tideScore === 0n) {
    throw new Error("civilization capture evidence must award authoritative score to both factions");
  }
}

function advanceCapture(
  current: ExpectedCaptureState,
  presentFactions: ReadonlySet<FactionId>,
  captureTicks: bigint,
): ExpectedCaptureState {
  if (presentFactions.size === 2) return current;
  if (presentFactions.size === 0) {
    return { owner: current.owner, challenger: null, progress: 0n };
  }

  const claimant = presentFactions.values().next().value as FactionId | undefined;
  if (claimant === undefined) throw new Error("civilization capture occupant faction is missing");
  if (claimant === current.owner) return { owner: current.owner, challenger: null, progress: 0n };

  const progress = current.challenger === claimant ? current.progress + 1n : 1n;
  if (progress === captureTicks) return { owner: claimant, challenger: null, progress: 0n };
  return { owner: current.owner, challenger: claimant, progress };
}

function factionForSeat(seat: number): FactionId {
  return seat < 3 ? "ember" : "tide";
}
