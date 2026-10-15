import {
  ACTION_FUNNEL_STAGES,
  duelPoolRequiredReceipts,
  type DuelPoolId,
  type DuelPoolReceipt,
  type DuelPoolReceiptAction,
  type DuelPoolReceiptStatus,
  type ActionFunnelStage,
} from '@arena/core';
import { canonicalJson } from '../canonical.js';
import { decodeControlEnvelope, ControlCodecError } from '../control/index.js';
import type { ControlMessage, MechanicsReceipt } from '../control/types.js';
import type { Evidence } from '../evidence.js';
import { damageHits } from '../funnel-report.js';
import { readActionFunnelTraceRecord } from '../funnel-record.js';
import { replayPolicyJson } from '../policy-replay.js';
import { TraceError, type TraceRecord } from '../trace.js';

const ACTION_PAIRING_WINDOW_TICKS = 100;
const SHIELD_PAIRING_WINDOW_TICKS = 20;
const MOVEMENT_PAIRING_WINDOW_TICKS = 8;
const MAX_OBSERVATION_GAP_TICKS = 8;
const MINIMUM_MAINTAINED_DISTANCE_TICKS = 10;

interface ReplayFrame {
  readonly tick: number;
  readonly entity: number;
  readonly x: number;
  readonly z: number;
  readonly opponentX: number;
  readonly opponentZ: number;
  readonly distance: number;
}

interface ClientActionEvidence {
  readonly attacks: readonly Readonly<{ tick: number | null; targetSeat: number }>[];
  readonly shots: readonly number[];
  readonly eats: readonly number[];
  readonly shieldTransitions: readonly Readonly<{ tick: number | null; blocking: boolean }>[];
  readonly frames: readonly ReplayFrame[];
}

interface ServerActionEvidence {
  readonly mechanics: readonly Readonly<{ tick: number; receipt: MechanicsReceipt }>[];
  readonly meleeHits: ReturnType<typeof damageHits>;
}

export function duelPoolReceiptsFromEvidence(
  evidence: Evidence,
  member: DuelPoolId,
  seat: number,
  matchId: string,
): readonly DuelPoolReceipt[] {
  const required = duelPoolRequiredReceipts(member);
  if (required.length === 0) return Object.freeze([]);
  const hasPolicyDecisions = evidence.records.some((record) => isPolicyReplay(record) && record.seat === seat);
  if (hasPolicyDecisions) replayPolicyJson(evidence);
  const client = readClientActionEvidence(evidence.records, seat);
  const server = readServerActionEvidence(evidence.records);
  return Object.freeze(required.map((action) => {
    const clientReceipt = hasClientReceipt(action, client);
    const serverReceipt = hasServerReceipt(action, server, seat);
    const paired = hasPairedReceipt(action, client, server, seat);
    const status = receiptStatus(clientReceipt, serverReceipt, paired);
    return Object.freeze({ member, action, matchId, status });
  }));
}

function readClientActionEvidence(records: readonly TraceRecord[], seat: number): ClientActionEvidence {
  const attacks: { tick: number | null; targetSeat: number }[] = [];
  const shots: number[] = [];
  const eats: number[] = [];
  const shieldTransitions: { tick: number | null; blocking: boolean }[] = [];
  const frames: ReplayFrame[] = [];
  const foodBySequence = new Map<string, boolean>();

  for (const [index, record] of records.entries()) {
    if (record.schema === 'policy-replay-v6' && record.seat === seat) {
      const decision = record.decision as { intent?: { kind?: unknown; inventorySlot?: unknown } };
      const observation = (record.input as { observation?: ReplayObservation }).observation;
      if (decision.intent?.kind === 'eat' && typeof decision.intent.inventorySlot === 'number') {
        const inventorySlot = decision.intent.inventorySlot;
        foodBySequence.set(record.sequence as string, observation?.agent.kind === 'current'
          && observation.agent.value.foodStacks.some((stack) => stack.inventorySlot === inventorySlot
            && stack.itemKind === 'goldenApple'));
      }
      const frame = observationFrame(observation);
      if (frame !== null) frames.push(frame);
      continue;
    }
    if (record.schema === 'action-funnel-v1' && record.seat === seat) {
      const funnel = readActionFunnelTraceRecord(record, index + 1);
      if (funnel.funnel === null) continue;
      const lastReached = funnel.funnel.kind === 'reached' ? funnel.funnel.stage : funnel.funnel.last_passed;
      if (!hasReached(lastReached, 'issued')) continue;
      if (funnel.funnel.action === 'attack' && funnel.target_seat !== null) {
        attacks.push({ tick: funnel.tick, targetSeat: funnel.target_seat });
      } else if (funnel.funnel.action === 'shoot' && funnel.tick !== null) {
        shots.push(funnel.tick);
      } else if (funnel.funnel.action === 'eat' && funnel.tick !== null
          && hasReached(lastReached, 'clientResponse') && foodBySequence.get(funnel.action_sequence) === true) {
        eats.push(funnel.tick);
      }
      continue;
    }
    if (record.schema === 'client-mechanics-v1') {
      const note = readClientMechanicsNote(record, index + 1);
      if (note.seat === seat) shieldTransitions.push({ tick: note.tick, blocking: note.blocking });
    }
  }

  return Object.freeze({
    attacks: Object.freeze(attacks),
    shots: Object.freeze(shots),
    eats: Object.freeze(eats),
    shieldTransitions: Object.freeze(shieldTransitions),
    frames: Object.freeze(frames.sort((left, right) => left.tick - right.tick)),
  });
}

function readServerActionEvidence(records: readonly TraceRecord[]): ServerActionEvidence {
  const mechanics: { tick: number; receipt: MechanicsReceipt }[] = [];
  for (const [index, record] of records.entries()) {
    if (record.direction !== 'plugin' || record.type !== 'mechanics_receipt') continue;
    const envelope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (key !== 'direction') envelope[key] = value;
    let message: ControlMessage;
    try {
      message = decodeControlEnvelope(canonicalJson(envelope));
    } catch (error) {
      if (!(error instanceof ControlCodecError)) throw error;
      throw new TraceError({ kind: 'invalid_mechanics_receipt_record', record: index + 1,
        ...(typeof error.path === 'string' ? { field: error.path } : {}) });
    }
    if (message.type !== 'mechanics_receipt') throw new TraceError({ kind: 'invalid_mechanics_receipt_record', record: index + 1 });
    const tick = Number(message.payload.at.value);
    if (!Number.isSafeInteger(tick)) throw new TraceError({ kind: 'invalid_mechanics_receipt_record', record: index + 1, field: 'payload.at.value' });
    for (const receipt of message.payload.receipts) mechanics.push({ tick, receipt });
  }
  return Object.freeze({
    mechanics: Object.freeze(mechanics),
    meleeHits: Object.freeze(damageHits(records).filter((hit) => hit.cause === 'melee')),
  });
}

function hasClientReceipt(
  action: DuelPoolReceiptAction,
  client: ClientActionEvidence,
): boolean {
  switch (action) {
    case 'lateralMovement': return lateralIntervals(client.frames).length > 0;
    case 'contactStarted': return client.attacks.length > 0;
    case 'distanceMaintained': return maintainedDistanceIntervals(client.frames).length > 0;
    case 'arrowReleased': return client.shots.length > 0;
    case 'shieldRaised': return client.shieldTransitions.some((entry) => entry.blocking);
    case 'shieldLowered': return client.shieldTransitions.some((entry) => !entry.blocking);
    case 'healedWithPermittedItem': return client.eats.length > 0;
  }
}

function hasServerReceipt(action: DuelPoolReceiptAction, server: ServerActionEvidence, seat: number): boolean {
  switch (action) {
    case 'lateralMovement': return server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'lateral_movement');
    case 'contactStarted': return server.meleeHits.some((entry) => entry.attacker === seat);
    case 'distanceMaintained': return server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'distance_maintained');
    case 'arrowReleased': return server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'ranged_projectile_release');
    case 'shieldRaised': return server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'shield_blocking_transition' && entry.receipt.blocking);
    case 'shieldLowered': return server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'shield_blocking_transition' && !entry.receipt.blocking);
    case 'healedWithPermittedItem': return server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'golden_apple_consume');
  }
}

function hasPairedReceipt(
  action: DuelPoolReceiptAction,
  client: ClientActionEvidence,
  server: ServerActionEvidence,
  seat: number,
): boolean {
  switch (action) {
    case 'lateralMovement': return lateralIntervals(client.frames).some((interval) => server.mechanics.some((entry) =>
      entry.receipt.seat === seat && entry.receipt.kind === 'lateral_movement'
      && tickWithin(entry.tick, interval.start - MOVEMENT_PAIRING_WINDOW_TICKS, interval.end + MOVEMENT_PAIRING_WINDOW_TICKS)));
    case 'contactStarted': return client.attacks.some((attack) => server.meleeHits.some((hit) =>
      hit.attacker === seat && hit.victim === attack.targetSeat && ticksClose(attack.tick, hit.tick, ACTION_PAIRING_WINDOW_TICKS)));
    case 'distanceMaintained': return maintainedDistanceIntervals(client.frames).some((interval) => server.mechanics.some((entry) =>
      entry.receipt.seat === seat && entry.receipt.kind === 'distance_maintained'
      && tickWithin(entry.tick, interval.start - MOVEMENT_PAIRING_WINDOW_TICKS, interval.end + MOVEMENT_PAIRING_WINDOW_TICKS)));
    case 'arrowReleased': return client.shots.some((tick) => server.mechanics.some((entry) =>
      entry.receipt.seat === seat && entry.receipt.kind === 'ranged_projectile_release'
      && ticksClose(tick, entry.tick, ACTION_PAIRING_WINDOW_TICKS)));
    case 'shieldRaised': return shieldTransitionPairs(client, server, seat, true);
    case 'shieldLowered': return shieldTransitionPairs(client, server, seat, false);
    case 'healedWithPermittedItem': return client.eats.some((tick) => server.mechanics.some((entry) =>
      entry.receipt.seat === seat && entry.receipt.kind === 'golden_apple_consume'
      && ticksClose(tick, entry.tick, ACTION_PAIRING_WINDOW_TICKS)));
  }
}

function shieldTransitionPairs(client: ClientActionEvidence, server: ServerActionEvidence, seat: number, blocking: boolean): boolean {
  return client.shieldTransitions.some((action) => action.blocking === blocking && action.tick !== null
    && server.mechanics.some((entry) => entry.receipt.seat === seat && entry.receipt.kind === 'shield_blocking_transition'
      && entry.receipt.blocking === blocking && ticksClose(action.tick, entry.tick, SHIELD_PAIRING_WINDOW_TICKS)));
}

function receiptStatus(client: boolean, server: boolean, paired: boolean): DuelPoolReceiptStatus {
  if (paired) return 'paired';
  if (client && server) return 'unpaired';
  if (client) return 'client_only';
  if (server) return 'server_only';
  return 'neither';
}

function lateralIntervals(frames: readonly ReplayFrame[]): readonly Readonly<{ start: number; end: number }>[] {
  const intervals: { start: number; end: number }[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const from = frames[index - 1]!;
    const to = frames[index]!;
    const span = to.tick - from.tick;
    if (from.entity !== to.entity || span <= 0 || span > MAX_OBSERVATION_GAP_TICKS) continue;
    const towardX = from.opponentX - from.x;
    const towardZ = from.opponentZ - from.z;
    const magnitude = Math.hypot(towardX, towardZ);
    if (magnitude === 0) continue;
    const deltaX = to.x - from.x;
    const deltaZ = to.z - from.z;
    const lateralBlocks = Math.abs(deltaX * towardZ - deltaZ * towardX) / magnitude;
    if (lateralBlocks >= 1) intervals.push({ start: from.tick, end: to.tick });
  }
  return intervals;
}

function maintainedDistanceIntervals(frames: readonly ReplayFrame[]): readonly Readonly<{ start: number; end: number }>[] {
  const intervals: { start: number; end: number }[] = [];
  for (let start = 0; start < frames.length; start += 1) {
    if (frames[start]!.distance <= 4 || frames[start]!.distance > 40) continue;
    let previous = frames[start]!;
    for (let end = start + 1; end < frames.length; end += 1) {
      const current = frames[end]!;
      if (current.entity !== previous.entity || current.tick - previous.tick > MAX_OBSERVATION_GAP_TICKS
          || current.distance <= 4 || current.distance > 40) break;
      previous = current;
      if (current.tick - frames[start]!.tick >= MINIMUM_MAINTAINED_DISTANCE_TICKS) {
        intervals.push({ start: frames[start]!.tick, end: current.tick });
        break;
      }
    }
  }
  return intervals;
}

function observationFrame(observation: ReplayObservation | undefined): ReplayFrame | null {
  if (observation === undefined || observation.agent.kind !== 'current' || observation.opponents.kind !== 'current'
      || observation.opponents.value.length === 0) return null;
  const self = observation.agent.value.position;
  let nearest: ReplayObservation['opponents']['value'][number] | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const opponent of observation.opponents.value) {
    const distance = Math.hypot(opponent.position.x - self.x, opponent.position.y - self.y, opponent.position.z - self.z);
    if (distance < nearestDistance) {
      nearest = opponent;
      nearestDistance = distance;
    }
  }
  if (nearest === undefined) return null;
  return {
    tick: observation.tick,
    entity: nearest.id,
    x: self.x,
    z: self.z,
    opponentX: nearest.position.x,
    opponentZ: nearest.position.z,
    distance: nearestDistance,
  };
}

function readClientMechanicsNote(record: TraceRecord, recordNumber: number): Readonly<{ seat: number; tick: number | null; blocking: boolean }> {
  const fields = ['schema', 'seat', 'tick', 'kind', 'blocking'];
  if (Object.keys(record).length !== fields.length || Object.keys(record).some((field) => !fields.includes(field))
      || typeof record.seat !== 'number' || !Number.isSafeInteger(record.seat) || record.seat < 0 || record.seat > 255
      || (record.tick !== null && (typeof record.tick !== 'number' || !Number.isSafeInteger(record.tick) || record.tick < 0))
      || record.kind !== 'shield_blocking_transition' || typeof record.blocking !== 'boolean') {
    throw new TraceError({ kind: 'invalid_client_mechanics_record', record: recordNumber });
  }
  return { seat: record.seat, tick: record.tick as number | null, blocking: record.blocking };
}

function isPolicyReplay(record: TraceRecord): boolean {
  return record.schema === 'policy-replay-v2' || record.schema === 'policy-replay-v3'
    || record.schema === 'policy-replay-v4' || record.schema === 'policy-replay-v6';
}

function hasReached(lastReached: string, requested: 'issued' | 'clientResponse'): boolean {
  return ACTION_FUNNEL_STAGES.indexOf(lastReached as ActionFunnelStage)
    >= ACTION_FUNNEL_STAGES.indexOf(requested);
}

function tickWithin(tick: number, start: number, end: number): boolean {
  return tick >= start && tick <= end;
}

function ticksClose(left: number | null, right: number, window: number): boolean {
  return left !== null && Math.abs(left - right) <= window;
}

interface ReplayObservation {
  readonly tick: number;
  readonly agent: { readonly kind: string; readonly value: { readonly position: Readonly<{ x: number; y: number; z: number }>; readonly foodStacks: readonly Readonly<{ inventorySlot: number; itemKind?: string }>[] } };
  readonly opponents: { readonly kind: string; readonly value: readonly Readonly<{ id: number; position: Readonly<{ x: number; y: number; z: number }> }>[] };
}
