import {
  ACTION_FUNNEL_MISS_REASONS,
  ACTION_FUNNEL_STAGES,
  type ActionFunnelAction,
  type ActionFunnelMissReason,
  type ActionFunnelRecord,
  type ActionFunnelStage,
} from '@arena/core';
import { TraceError, type TraceRecord } from './trace.js';

export const ACTION_FUNNEL_RECORD_SCHEMA = 'action-funnel-v1';
export const BORDER_KNOWLEDGE_KINDS = ['current', 'stale', 'unknown'] as const;
export type BorderKnowledgeKind = typeof BORDER_KNOWLEDGE_KINDS[number];

export type ActionFunnelTraceOutcome =
  | { readonly kind: 'reached'; readonly action: ActionFunnelAction; readonly stage: ActionFunnelStage }
  | {
    readonly kind: 'stopped';
    readonly action: ActionFunnelAction;
    readonly last_passed: ActionFunnelStage;
    readonly reason: ActionFunnelMissReason;
    readonly eye_to_body_units: number | null;
  };

export interface ActionFunnelTraceRecordV1 {
  readonly schema: typeof ACTION_FUNNEL_RECORD_SCHEMA;
  readonly seat: number;
  readonly action_sequence: string;
  readonly tick: number | null;
  readonly intent: string;
  readonly target_entity: number | null;
  readonly target_seat: number | null;
  readonly border: BorderKnowledgeKind;
  readonly skill: 'succeeded' | 'failed' | 'cancelled' | 'progress' | 'pending';
  readonly funnel: ActionFunnelTraceOutcome | null;
}

export function makeActionFunnelTraceRecord(input: Readonly<{
  seat: number;
  actionSequence: string;
  tick: number | null;
  intent: string;
  targetEntity: number | null;
  targetSeat: number | null;
  border: BorderKnowledgeKind;
  skill: ActionFunnelTraceRecordV1['skill'];
  funnel: ActionFunnelRecord | null;
}>): ActionFunnelTraceRecordV1 {
  return Object.freeze({
    schema: ACTION_FUNNEL_RECORD_SCHEMA,
    seat: input.seat,
    action_sequence: input.actionSequence,
    tick: input.tick,
    intent: input.intent,
    target_entity: input.targetEntity,
    target_seat: input.targetSeat,
    border: input.border,
    skill: input.skill,
    funnel: input.funnel === null ? null : input.funnel.kind === 'reached'
      ? Object.freeze({ kind: 'reached', action: input.funnel.action, stage: input.funnel.stage })
      : Object.freeze({
        kind: 'stopped',
        action: input.funnel.action,
        last_passed: input.funnel.lastPassed,
        reason: input.funnel.reason,
        eye_to_body_units: input.funnel.eyeToBodyUnits,
      }),
  });
}

const FIELDS = ['schema', 'seat', 'action_sequence', 'tick', 'intent', 'target_entity', 'target_seat', 'border', 'skill', 'funnel'];
const SKILLS = new Set(['succeeded', 'failed', 'cancelled', 'progress', 'pending']);
export const FUNNEL_ACTIONS = ['approach', 'attack', 'shoot', 'eat'] as const satisfies readonly ActionFunnelAction[];
const ACTIONS = new Set<string>(FUNNEL_ACTIONS);

export function readActionFunnelTraceRecord(record: TraceRecord, recordNumber: number): ActionFunnelTraceRecordV1 {
  const fail = (field: string): TraceError => new TraceError({ kind: 'invalid_action_funnel_record', record: recordNumber, field });
  const keys = Object.keys(record);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) throw fail('fields');
  const integer = (value: unknown, field: string, nullable: boolean): number | null => {
    if (value === null && nullable) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw fail(field);
    return value;
  };
  const seat = integer(record.seat, 'seat', false)!;
  if (seat > 255) throw fail('seat');
  if (typeof record.action_sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(record.action_sequence)) throw fail('action_sequence');
  if (typeof record.intent !== 'string' || record.intent.length === 0 || record.intent.length > 64) throw fail('intent');
  if (!BORDER_KNOWLEDGE_KINDS.includes(record.border as BorderKnowledgeKind)) throw fail('border');
  if (typeof record.skill !== 'string' || !SKILLS.has(record.skill)) throw fail('skill');
  const targetSeat = integer(record.target_seat, 'target_seat', true);
  if (targetSeat !== null && targetSeat > 255) throw fail('target_seat');
  let funnel: ActionFunnelTraceOutcome | null = null;
  if (record.funnel !== null) {
    const value = record.funnel;
    if (typeof value !== 'object' || Array.isArray(value)) throw fail('funnel');
    const entry = value as TraceRecord;
    if (typeof entry.action !== 'string' || !ACTIONS.has(entry.action)) throw fail('funnel.action');
    if (entry.kind === 'reached') {
      if (Object.keys(entry).length !== 3 || !ACTION_FUNNEL_STAGES.includes(entry.stage as ActionFunnelStage)) throw fail('funnel.stage');
      funnel = Object.freeze({ kind: 'reached', action: entry.action as ActionFunnelAction, stage: entry.stage as ActionFunnelStage });
    } else if (entry.kind === 'stopped') {
      if (Object.keys(entry).length !== 5
          || !ACTION_FUNNEL_STAGES.includes(entry.last_passed as ActionFunnelStage)
          || !ACTION_FUNNEL_MISS_REASONS.includes(entry.reason as ActionFunnelMissReason)) throw fail('funnel.reason');
      funnel = Object.freeze({
        kind: 'stopped',
        action: entry.action as ActionFunnelAction,
        last_passed: entry.last_passed as ActionFunnelStage,
        reason: entry.reason as ActionFunnelMissReason,
        eye_to_body_units: integer(entry.eye_to_body_units, 'funnel.eye_to_body_units', true),
      });
    } else {
      throw fail('funnel.kind');
    }
  }
  return Object.freeze({
    schema: ACTION_FUNNEL_RECORD_SCHEMA,
    seat,
    action_sequence: record.action_sequence,
    tick: integer(record.tick, 'tick', true),
    intent: record.intent,
    target_entity: integer(record.target_entity, 'target_entity', true),
    target_seat: targetSeat,
    border: record.border as BorderKnowledgeKind,
    skill: record.skill as ActionFunnelTraceRecordV1['skill'],
    funnel,
  });
}
