export type WorkerEventRecord =
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
  }>;

export const WORKER_RECORD_SCHEMAS: readonly string[] = ['worker-topology-v1', 'worker-loss-v1'];
