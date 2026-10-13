import {
  decide,
  rehydratePolicyReplayInput,
  type Decision,
  type SkillCancellation,
  type SkillFailure,
  type PolicyReplayInputV1,
  type SkillOutcome,
} from '@arena/core';
import type { Evidence } from './evidence.js';
import { canonicalJson } from './canonical.js';
import { ControlCodecError, decodeControlEnvelope } from './control/index.js';
import type { ControlMessage } from './control/types.js';
import { TraceError, type TraceRecord } from './trace.js';

const MAX_U64 = (1n << 64n) - 1n;
const POLICY_DECISION_FIELDS = ['schema', 'sequence', 'seat', 'input', 'decision', 'rng_state_after'];
const POLICY_EFFECT_FIELDS = ['schema', 'decision_sequence', 'skill', 'path_updates'];
const PATH_UPDATE_STATUSES = new Set(['success', 'partial', 'noPath', 'timeout']);
const SKILL_FAILURES = new Set(['preconditionsNotMet', 'noProgress', 'serverRejected', 'timedOut']);
const SKILL_CANCELLATIONS = new Set(['replaced', 'agentEliminated', 'shutdown']);

export interface PolicyReplayRecordV1 {
  readonly schema: 'policy-replay-v1';
  readonly sequence: string;
  readonly seat: number;
  readonly input: PolicyReplayInputV1;
  readonly decision: Decision;
  readonly rng_state_after: string;
}

export interface PolicyPathPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PolicyPathUpdate {
  readonly status: 'success' | 'partial' | 'noPath' | 'timeout';
  readonly path: readonly PolicyPathPoint[];
}

export interface PolicyEffectRecordV1 {
  readonly schema: 'policy-effect-v1';
  readonly decision_sequence: string;
  readonly skill: SkillOutcome;
  readonly path_updates: readonly PolicyPathUpdate[];
}

export interface PolicyReplaySummary {
  readonly schema: 1;
  readonly run_id: string;
  readonly verified: true;
  readonly decision_count: number;
  readonly policy_sequence_range: Readonly<{ first: string; last: string }>;
  readonly effect_count: number;
  readonly path_update_count: number;
}

/** Builds a recorder frame with the sequence and RNG state captured around one policy call. */
export function makePolicyReplayRecord(
  sequence: bigint,
  seat: number,
  input: PolicyReplayInputV1,
  decision: Decision,
  rngStateAfter: bigint,
): PolicyReplayRecordV1 {
  assertSequence(sequence, 'sequence');
  assertSeat(seat);
  assertU64(rngStateAfter, 'rng_state_after');
  return Object.freeze({
    schema: 'policy-replay-v1',
    sequence: sequence.toString(10),
    seat,
    input,
    decision,
    rng_state_after: rngStateAfter.toString(10),
  });
}

/** Builds a bounded effect record without inventing path results the client did not emit. */
export function makePolicyEffectRecord(
  decisionSequence: bigint,
  skill: SkillOutcome,
  pathUpdates: readonly PolicyPathUpdate[],
): PolicyEffectRecordV1 {
  assertSequence(decisionSequence, 'decision_sequence');
  const copiedSkill = copySkillOutcome(skill);
  if (pathUpdates.length > 1) throw new TypeError('a policy effect can retain at most one path update');
  const copiedPathUpdates = Object.freeze(pathUpdates.map(copyPathUpdate));
  return Object.freeze({
    schema: 'policy-effect-v1',
    decision_sequence: decisionSequence.toString(10),
    skill: copiedSkill,
    path_updates: copiedPathUpdates,
  });
}

export function replayPolicyJson(evidence: Evidence): PolicyReplaySummary {
  const decisions = new Map<string, PolicyReplayRecordV1>();
  const preparedSeats = readPreparedSeats(evidence);
  let previousSequence = 0n;
  let firstSequence: string | undefined;
  let lastSequence: string | undefined;
  let effectCount = 0;
  let pathUpdateCount = 0;
  const effects = new Set<string>();

  for (const [index, record] of evidence.records.entries()) {
    if (record.schema === 'policy-replay-v1') {
      const decision = readPolicyDecision(record, index + 1);
      if (preparedSeats !== undefined && !preparedSeats.has(decision.seat)) {
        throw replayFailure('policy_seat_not_in_roster', index + 1, 'seat');
      }
      const sequence = BigInt(decision.sequence);
      if (sequence <= previousSequence) throw replayFailure('policy_sequence_not_increasing', index + 1, 'sequence');
      previousSequence = sequence;
      firstSequence ??= decision.sequence;
      lastSequence = decision.sequence;
      decisions.set(decision.sequence, decision);
      replayDecision(decision, index + 1);
    } else if (record.schema === 'policy-effect-v1') {
      const effect = readPolicyEffect(record, index + 1);
      if (!decisions.has(effect.decision_sequence)) {
        throw replayFailure('unmatched_policy_effect', index + 1, 'decision_sequence');
      }
      if (effects.has(effect.decision_sequence)) {
        throw replayFailure('duplicate_policy_effect', index + 1, 'decision_sequence');
      }
      effects.add(effect.decision_sequence);
      effectCount += 1;
      pathUpdateCount += effect.path_updates.length;
    }
  }

  if (firstSequence === undefined || lastSequence === undefined) throw replayFailure('policy_records_missing');
  return {
    schema: 1,
    run_id: evidence.run_id,
    verified: true,
    decision_count: decisions.size,
    policy_sequence_range: { first: firstSequence, last: lastSequence },
    effect_count: effectCount,
    path_update_count: pathUpdateCount,
  };
}

function readPreparedSeats(evidence: Evidence): ReadonlySet<number> | undefined {
  let seats: ReadonlySet<number> | undefined;
  for (const [index, record] of evidence.records.entries()) {
    if (record.direction !== 'runner' || record.type !== 'prepare') continue;
    const envelope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'direction') envelope[key] = value;
    }
    let message: ControlMessage;
    try {
      message = decodeControlEnvelope(canonicalJson(envelope));
    } catch (error) {
      throw replayFailure('invalid_policy_prepare', index + 1,
        error instanceof ControlCodecError ? error.path ?? undefined : undefined);
    }
    if (message.type !== 'prepare' || message.run_id !== evidence.run_id) {
      throw replayFailure('invalid_policy_prepare', index + 1);
    }
    if (seats !== undefined) throw replayFailure('duplicate_policy_prepare', index + 1);
    seats = new Set(message.payload.roster.map((competitor) => competitor.seat));
  }
  return seats;
}

function replayDecision(record: PolicyReplayRecordV1, recordNumber: number): void {
  let restored: ReturnType<typeof rehydratePolicyReplayInput>;
  try {
    restored = rehydratePolicyReplayInput(record.input);
  } catch (error) {
    if (error instanceof TypeError && 'field' in error && typeof error.field === 'string') {
      throw replayFailure('invalid_policy_input', recordNumber, error.field);
    }
    throw error;
  }

  const actualDecision = decide(restored.observation, restored.memory, restored.params, restored.random);
  if (canonicalJson(actualDecision) !== canonicalJson(record.decision)) {
    throw replayFailure('policy_decision_mismatch', recordNumber, 'decision');
  }
  const expectedRngState = parseU64Decimal(record.rng_state_after, recordNumber);
  if (restored.random.snapshotState() !== expectedRngState) {
    throw replayFailure('policy_rng_state_mismatch', recordNumber, 'rng_state_after');
  }
}

function readPolicyDecision(record: TraceRecord, recordNumber: number): PolicyReplayRecordV1 {
  assertExactFields(record, POLICY_DECISION_FIELDS, recordNumber);
  const sequence = parseSequence(record.sequence, 'sequence', recordNumber).toString(10);
  if (typeof record.seat !== 'number' || !Number.isSafeInteger(record.seat) || record.seat < 0 || record.seat > 255) {
    throw replayFailure('invalid_policy_seat', recordNumber, 'seat');
  }
  if (typeof record.rng_state_after !== 'string') {
    throw replayFailure('invalid_policy_rng_state', recordNumber, 'rng_state_after');
  }
  parseU64Decimal(record.rng_state_after, recordNumber);
  return {
    schema: 'policy-replay-v1',
    sequence,
    seat: record.seat,
    input: record.input as unknown as PolicyReplayInputV1,
    decision: record.decision as unknown as Decision,
    rng_state_after: record.rng_state_after,
  };
}

function readPolicyEffect(record: TraceRecord, recordNumber: number): PolicyEffectRecordV1 {
  assertExactFields(record, POLICY_EFFECT_FIELDS, recordNumber);
  const decisionSequence = parseSequence(record.decision_sequence, 'decision_sequence', recordNumber).toString(10);
  const skill = readSkillOutcome(record.skill, recordNumber);
  if (!Array.isArray(record.path_updates) || record.path_updates.length > 1) {
    throw replayFailure('invalid_policy_path_updates', recordNumber, 'path_updates');
  }
  const pathUpdates = record.path_updates.map((update, index) => readPathUpdate(update, recordNumber, index));
  return {
    schema: 'policy-effect-v1',
    decision_sequence: decisionSequence,
    skill,
    path_updates: pathUpdates,
  };
}

function readSkillOutcome(value: unknown, recordNumber: number): SkillOutcome {
  const object = strictObject(value);
  if (object === undefined || typeof object.kind !== 'string') {
    throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill');
  }
  switch (object.kind) {
    case 'pending':
    case 'succeeded':
      assertExactFields(object, ['kind'], recordNumber, 'skill');
      return { kind: object.kind };
    case 'progress': {
      assertExactFields(object, ['kind', 'progress'], recordNumber, 'skill');
      const progress = strictObject(object.progress);
      if (progress === undefined) throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.progress');
      assertExactFields(progress, ['completedSteps', 'totalSteps'], recordNumber, 'skill.progress');
      const { completedSteps, totalSteps } = progress;
      if (!Number.isSafeInteger(completedSteps) || !Number.isSafeInteger(totalSteps)
          || (completedSteps as number) <= 0 || (totalSteps as number) <= (completedSteps as number)
          || (totalSteps as number) > 65_535) {
        throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.progress');
      }
      return { kind: 'progress', progress: { completedSteps: completedSteps as number, totalSteps: totalSteps as number } };
    }
    case 'failed':
      assertExactFields(object, ['kind', 'cause'], recordNumber, 'skill');
      if (typeof object.cause !== 'string' || !SKILL_FAILURES.has(object.cause)) {
        throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.cause');
      }
      return { kind: 'failed', cause: object.cause as SkillFailure };
    case 'cancelled':
      assertExactFields(object, ['kind', 'reason'], recordNumber, 'skill');
      if (typeof object.reason !== 'string' || !SKILL_CANCELLATIONS.has(object.reason)) {
        throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.reason');
      }
      return { kind: 'cancelled', reason: object.reason as SkillCancellation };
    default:
      throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.kind');
  }
}

function readPathUpdate(value: unknown, recordNumber: number, index: number): PolicyPathUpdate {
  const object = strictObject(value);
  if (object === undefined) throw replayFailure('invalid_policy_path_update', recordNumber, `path_updates[${index}]`);
  assertExactFields(object, ['status', 'path'], recordNumber, `path_updates[${index}]`);
  if (typeof object.status !== 'string' || !PATH_UPDATE_STATUSES.has(object.status)) {
    throw replayFailure('invalid_policy_path_status', recordNumber, `path_updates[${index}].status`);
  }
  if (!Array.isArray(object.path)) throw replayFailure('invalid_policy_path', recordNumber, `path_updates[${index}].path`);
  const path = object.path.map((point, pointIndex) => {
    const position = strictObject(point);
    const field = `path_updates[${index}].path[${pointIndex}]`;
    if (position === undefined) throw replayFailure('invalid_policy_path_position', recordNumber, field);
    assertExactFields(position, ['x', 'y', 'z'], recordNumber, field);
    for (const coordinate of ['x', 'y', 'z'] as const) {
      if (typeof position[coordinate] !== 'number' || !Number.isSafeInteger(position[coordinate])) {
        throw replayFailure('invalid_policy_path_position', recordNumber, `${field}.${coordinate}`);
      }
    }
    return { x: position.x as number, y: position.y as number, z: position.z as number };
  });
  return { status: object.status as PolicyPathUpdate['status'], path };
}

function copySkillOutcome(skill: SkillOutcome): SkillOutcome {
  switch (skill.kind) {
    case 'pending':
    case 'succeeded':
      assertProducerFields(skill, ['kind']);
      return Object.freeze({ kind: skill.kind });
    case 'progress':
      assertProducerFields(skill, ['kind', 'progress']);
      assertProducerFields(skill.progress, ['completedSteps', 'totalSteps']);
      if (!Number.isSafeInteger(skill.progress.completedSteps) || !Number.isSafeInteger(skill.progress.totalSteps)
          || skill.progress.completedSteps <= 0 || skill.progress.completedSteps >= skill.progress.totalSteps
          || skill.progress.totalSteps > 65_535) throw new TypeError('invalid skill progress outcome');
      return Object.freeze({ kind: 'progress', progress: Object.freeze({ ...skill.progress }) });
    case 'failed':
      assertProducerFields(skill, ['kind', 'cause']);
      if (!SKILL_FAILURES.has(skill.cause)) throw new TypeError('invalid skill failure outcome');
      return Object.freeze({ kind: 'failed', cause: skill.cause });
    case 'cancelled':
      assertProducerFields(skill, ['kind', 'reason']);
      if (!SKILL_CANCELLATIONS.has(skill.reason)) throw new TypeError('invalid skill cancellation outcome');
      return Object.freeze({ kind: 'cancelled', reason: skill.reason });
    default:
      throw new TypeError('unknown skill outcome kind');
  }
}

function copyPathUpdate(update: PolicyPathUpdate): PolicyPathUpdate {
  if (!PATH_UPDATE_STATUSES.has(update.status)) throw new TypeError('invalid path update status');
  return Object.freeze({
    status: update.status,
    path: Object.freeze(update.path.map((position) => {
      for (const coordinate of [position.x, position.y, position.z]) {
        if (!Number.isSafeInteger(coordinate)) throw new TypeError('path position coordinates must be safe integers');
      }
      return Object.freeze({ x: position.x, y: position.y, z: position.z });
    })),
  });
}

function assertSeat(seat: number): void {
  if (!Number.isSafeInteger(seat) || seat < 0 || seat > 255) throw new RangeError('policy seat must be a u8');
}

function assertProducerFields(value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('skill outcome has an invalid shape');
  }
}

function assertU64(value: bigint, field: string): void {
  if (value < 0n || value > MAX_U64) throw new RangeError(`${field} must be a u64`);
}

function assertSequence(value: bigint, field: string): void {
  assertU64(value, field);
  if (value === 0n) throw new RangeError(`${field} must be positive`);
}

function parseSequence(value: unknown, field: string, record?: number): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw replayFailure(`invalid_policy_${field}`, record, field);
  }
  const sequence = BigInt(value);
  if (sequence === 0n || sequence > MAX_U64) throw replayFailure(`invalid_policy_${field}`, record, field);
  return sequence;
}

function parseU64Decimal(value: unknown, recordNumber: number): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw replayFailure('invalid_policy_rng_state', recordNumber, 'rng_state_after');
  }
  const state = BigInt(value);
  if (state > MAX_U64) throw replayFailure('invalid_policy_rng_state', recordNumber, 'rng_state_after');
  return state;
}

function assertExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  record: number,
  prefix?: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw replayFailure('invalid_policy_record_shape', record, prefix);
  }
}

function strictObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function replayFailure(kind: string, record?: number, field?: string): TraceError {
  return new TraceError({ kind, ...(record === undefined ? {} : { record }), ...(field === undefined ? {} : { field }) });
}

