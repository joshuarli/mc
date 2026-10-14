import type { BorderUnknownReason } from '@arena/core';

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

export interface ResumeNote {
  readonly schema: 'resume-v1';
  readonly checkpoint_id: string;
  readonly digest: string;
  readonly epoch: number;
  readonly match_tick: string;
  readonly eliminated_seats: readonly number[];
}

export const RUN_NOTE_SCHEMAS: readonly string[] = [
  'worker-topology-v1', 'worker-loss-v1', 'client-diagnostic-v1', 'seat-policy-v1', 'resume-v1',
];
