import type { ActionFunnelRecord, ActionFunnelSink, ClientDiagnosticRecord, ClientDiagnosticSink } from '@arena/core';
import { canonicalJson } from '../canonical.js';
import { stageOwnedFile, type FileIdentity } from '../owned-files/index.js';
import type { BorderKnowledgeKind } from '../funnel-record.js';

export const DIAGNOSTIC_RING_CAPACITY = 128;
export const DIAGNOSTIC_RINGS_FILE = 'diagnostic-rings.json';
const MAX_DIAGNOSTIC_RINGS_BYTES = 4 * 1024 * 1024;

export type DiagnosticEntry =
  | Readonly<{
    kind: 'decision';
    tick: number;
    sequence: string;
    disposition: string;
    goal: string;
    intent: string;
    border: BorderKnowledgeKind;
  }>
  | Readonly<{
    kind: 'action';
    tick: number | null;
    action_sequence: string;
    intent: string;
    skill: string;
    funnel: ActionFunnelRecord | null;
  }>;

export class ActionFunnelCollector {
  readonly #usernameSeats: ReadonlyMap<string, number>;
  readonly #pending = new Map<number, ActionFunnelRecord>();
  readonly #rings = new Map<number, DiagnosticEntry[]>();
  #dropped = 0;
  onDiagnostic: ((seat: number, record: ClientDiagnosticRecord) => void) | undefined;

  constructor(usernameSeats: ReadonlyMap<string, number>) {
    this.#usernameSeats = usernameSeats;
  }

  sink(seat: number): ActionFunnelSink {
    return (record) => { this.#pending.set(seat, record); };
  }

  diagnosticSink(seat: number): ClientDiagnosticSink {
    return (record) => { this.onDiagnostic?.(seat, record); };
  }

  take(seat: number): ActionFunnelRecord | null {
    const record = this.#pending.get(seat) ?? null;
    this.#pending.delete(seat);
    return record;
  }

  discard(seat: number): void {
    this.#pending.delete(seat);
  }

  seatForUsername(username: string | undefined): number | null {
    return username === undefined ? null : this.#usernameSeats.get(username) ?? null;
  }

  note(seat: number, entry: DiagnosticEntry): void {
    let ring = this.#rings.get(seat);
    if (ring === undefined) {
      ring = [];
      this.#rings.set(seat, ring);
    }
    if (ring.length >= DIAGNOSTIC_RING_CAPACITY) {
      ring.shift();
      this.#dropped += 1;
    }
    ring.push(entry);
  }

  snapshot(): object {
    return {
      schema: 1,
      ring_capacity: DIAGNOSTIC_RING_CAPACITY,
      entries_dropped_by_overflow: this.#dropped,
      seats: [...this.#rings.entries()].sort(([left], [right]) => left - right)
        .map(([seat, entries]) => ({ seat, entries })),
    };
  }
}

export async function flushDiagnosticRings(options: Readonly<{
  collector: ActionFunnelCollector;
  helperPath: string;
  ownedRoot: Buffer;
  runDirectoryPath: Buffer;
}>): Promise<FileIdentity> {
  return await stageOwnedFile({
    helperPath: options.helperPath,
    ownedRoot: options.ownedRoot,
    relativePath: Buffer.concat([options.runDirectoryPath, Buffer.from(`/${DIAGNOSTIC_RINGS_FILE}`, 'ascii')]),
    contents: Buffer.from(canonicalJson(options.collector.snapshot()), 'utf8'),
    maxBytes: MAX_DIAGNOSTIC_RINGS_BYTES,
  });
}
