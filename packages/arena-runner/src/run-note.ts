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
  | Readonly<{
    schema: 'client-diagnostic-v1';
    seat: number;
    tick: number | null;
    diagnostic: 'borderUnknown';
    reason: BorderUnknownReason;
    consecutive_observations: number;
  }>;

export const RUN_NOTE_SCHEMAS: readonly string[] = ['worker-topology-v1', 'worker-loss-v1', 'client-diagnostic-v1'];
