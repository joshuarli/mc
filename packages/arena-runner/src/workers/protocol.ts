import { RunnerError } from '../errors.js';

export const MAX_WORKER_MESSAGE_BYTES = 256 * 1024;

export interface WorkerSeat {
  readonly seat: number;
  readonly username: string;
  readonly offline_uuid: string;
}

export interface WorkerInit {
  readonly type: 'init';
  readonly worker: number;
  readonly epoch: number;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly minecraft: string;
  readonly view_distance_chunks: number;
  readonly seed: string;
  readonly strategy_interval_ticks: string;
  readonly opening_style_cycle: readonly [string, string, string] | null;
  readonly record_policy: boolean;
  readonly policy_source: string;
  readonly seats: readonly WorkerSeat[];
  readonly roster: readonly Readonly<{ seat: number; username: string }>[];
}

export type SupervisorToWorker =
  | WorkerInit
  | Readonly<{ type: 'tick'; tick: number }>
  | Readonly<{ type: 'stop' }>;

export type CriticalKind = 'decision' | 'effect' | 'funnel' | 'diagnostic';

export interface SourceStamp {
  readonly worker: number;
  readonly epoch: number;
  readonly source_sequence: number;
  readonly source_tick: number | null;
}

export type WorkerToSupervisor =
  | (Readonly<{ type: 'ready' }> & Pick<SourceStamp, 'worker' | 'epoch'>)
  | (Readonly<{ type: 'critical'; kind: CriticalKind; record: unknown }> & SourceStamp)
  | (Readonly<{ type: 'diagnostic'; counters: Readonly<Record<string, number>>; dropped: number }> & SourceStamp)
  | (Readonly<{ type: 'stopped' }> & Pick<SourceStamp, 'worker' | 'epoch'>)
  | (Readonly<{ type: 'failure'; kind: string }> & Pick<SourceStamp, 'worker' | 'epoch'>);

export function encodedWorkerMessageBytes(message: SupervisorToWorker | WorkerToSupervisor): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

export function assertWorkerMessageBound(message: SupervisorToWorker | WorkerToSupervisor): void {
  if (encodedWorkerMessageBytes(message) > MAX_WORKER_MESSAGE_BYTES) {
    throw new RunnerError('runtime_failure', 'worker message', { kind: 'worker_message_too_large' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function decodeWorkerMessage(value: unknown): WorkerToSupervisor {
  const invalid = (): RunnerError => new RunnerError('runtime_failure', 'worker message', { kind: 'invalid_worker_message' });
  if (!isRecord(value) || typeof value.type !== 'string') throw invalid();
  if (!nonNegativeInteger(value.worker) || !nonNegativeInteger(value.epoch)) throw invalid();
  const worker = value.worker;
  const epoch = value.epoch;
  switch (value.type) {
    case 'ready':
    case 'stopped':
      return Object.freeze({ type: value.type, worker, epoch });
    case 'failure':
      if (typeof value.kind !== 'string' || value.kind.length === 0 || value.kind.length > 64) throw invalid();
      return Object.freeze({ type: 'failure', worker, epoch, kind: value.kind });
    case 'critical': {
      if (value.kind !== 'decision' && value.kind !== 'effect' && value.kind !== 'funnel' && value.kind !== 'diagnostic') throw invalid();
      if (!nonNegativeInteger(value.source_sequence) || !isRecord(value.record)) throw invalid();
      if (value.source_tick !== null && !nonNegativeInteger(value.source_tick)) throw invalid();
      return Object.freeze({
        type: 'critical', worker, epoch, kind: value.kind, record: value.record,
        source_sequence: value.source_sequence, source_tick: value.source_tick as number | null,
      });
    }
    case 'diagnostic': {
      if (!nonNegativeInteger(value.source_sequence) || !isRecord(value.counters) || !nonNegativeInteger(value.dropped)) throw invalid();
      const counters: Record<string, number> = {};
      for (const [key, count] of Object.entries(value.counters)) {
        if (!nonNegativeInteger(count) || key.length > 64) throw invalid();
        counters[key] = count;
      }
      if (value.source_tick !== null && !nonNegativeInteger(value.source_tick)) throw invalid();
      return Object.freeze({
        type: 'diagnostic', worker, epoch, counters: Object.freeze(counters), dropped: value.dropped,
        source_sequence: value.source_sequence, source_tick: value.source_tick as number | null,
      });
    }
    default:
      throw invalid();
  }
}
