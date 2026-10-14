import type { AlternativeCondition, AlternativeKind, BorderUnknownReason, DecisionReason } from '@arena/core';

export type RunNoteRecord =
  | Readonly<{
    schema: 'worker-topology-v1';
    worker_count: number;
    assignments: readonly Readonly<{ worker: number; epoch: number; seats: readonly number[] }>[];
  }>
  | Readonly<{
    schema: 'worker-loss-v1';
    worker: number;
    epoch: number;
    seats: readonly number[];
    reason: string;
    tick: number | null;
  }>
  | SeatPolicyNote
  | DecisionExplainNote
  | ResumeNote
  | Readonly<{
    schema: 'client-diagnostic-v1';
    seat: number;
    tick: number | null;
    diagnostic: 'borderUnknown';
    reason: BorderUnknownReason;
    consecutive_observations: number;
  }>;

export interface SeatPolicyNote {
  readonly schema: 'seat-policy-v1';
  readonly seat: number;
  readonly candidate: string;
  readonly version: number;
  readonly implementation: string;
  readonly semantic_id: string;
  readonly params: Readonly<Record<string, number>>;
}

export interface DecisionExplainNote {
  readonly schema: 'decision-explain-v1';
  readonly version: number;
  readonly seat: number;
  readonly sequence: string;
  readonly tick: number;
  readonly reason: DecisionReason;
  readonly delegated_goal: string;
  readonly alternatives: readonly Readonly<{ goal: AlternativeKind; score: number; condition: AlternativeCondition }>[];
  readonly nearest_cache_blocks: number | null;
  readonly nearest_opponent_blocks: number | null;
  readonly border_center_blocks: number | null;
  readonly armed: boolean | null;
}

export interface ResumeNote {
  readonly schema: 'resume-v1';
  readonly checkpoint_id: string;
  readonly digest: string;
  readonly epoch: number;
  readonly match_tick: string;
  readonly eliminated_seats: readonly number[];
}

export const RUN_NOTE_SCHEMAS: readonly string[] = [
  'worker-topology-v1', 'worker-loss-v1', 'client-diagnostic-v1', 'seat-policy-v1', 'resume-v1', 'decision-explain-v1',
];
