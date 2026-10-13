import { canonicalJson, sha256Json } from '../canonical.js';
import type { ControlMessage } from '../control/index.js';
import type { StrictJsonValue } from '../control/strict-json.js';
import { MAX_OWNED_FILE_BYTES, stageOwnedFile, type FileIdentity } from '../owned-files/index.js';
import { RunnerError } from '../errors.js';
import type { PreparedRun } from '../prepare.js';
import type { TraceRecord } from '../trace.js';

const TRACE_SCHEMA_VERSION = 1;
const MAX_RUNTIME_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_TRACE_RECORDS = 100_000;
const MAX_U64 = (1n << 64n) - 1n;
const TRACE_FILE_NAME = Buffer.from('/trace-v1.json', 'ascii');

/** Collects bounded lifecycle evidence while excluding credentials and optional telemetry. */
export class RuntimeTraceBuilder {
  readonly #runId: string;
  readonly #baseByteLength: number;
  readonly #records: TraceRecord[] = [];
  #recordBytes = 0;
  #hasReady = false;
  #hasOutcome = false;
  #lastControlSequence = 0n;
  #finalized: Buffer | undefined;

  constructor(runId: string) {
    if (runId.length === 0) throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_run_id' });
    this.#runId = runId;
    this.#baseByteLength = Buffer.byteLength(canonicalJson({
      schema: TRACE_SCHEMA_VERSION,
      run_id: runId,
      first_sequence: '1',
      last_sequence: MAX_U64.toString(),
      records: [],
      sha256: '0'.repeat(64),
      trailer: { complete: true },
    }), 'utf8');
  }

  /** Records readiness without accepting the hello payload that carries the control token. */
  recordReady(ready: Extract<ControlMessage, { readonly type: 'ready' }>): void {
    if (this.#hasReady || this.#records.length !== 0) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_out_of_order' });
    }
    if (ready.protocol !== 1 || ready.run_id !== this.#runId || ready.sequence <= 0n
        || ready.correlation === undefined || ready.correlation <= 0n) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_readiness_envelope' });
    }
    this.#append(toTraceRecord(ready));
    this.#hasReady = true;
    this.#lastControlSequence = ready.sequence;
  }

  /** Records each semantic event; a size limit failure invalidates the run instead of dropping it. */
  record(message: ControlMessage): void {
    this.#assertMutable();
    if (message.type === 'hello' || message.type === 'ready') {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'unexpected_handshake' });
    }
    if (!this.#hasReady) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_missing' });
    }
    if (message.run_id !== this.#runId) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'run_id_mismatch' });
    }
    if (message.sequence <= this.#lastControlSequence) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'non_monotonic_control_sequence' });
    }
    if (this.#hasOutcome) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'event_after_outcome' });
    }

    switch (message.type) {
      case 'heartbeat':
      case 'metrics':
        this.#lastControlSequence = message.sequence;
        return;
      case 'prepare':
      case 'start':
      case 'abort':
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'unexpected_runner_command' });
      default:
        break;
    }

    this.#append(toTraceRecord(message));
    this.#lastControlSequence = message.sequence;
    if (message.type === 'outcome') this.#hasOutcome = true;
  }

  /** Produces one complete trace segment only after the authoritative outcome was recorded. */
  finalize(): Buffer {
    if (this.#finalized !== undefined) return Buffer.from(this.#finalized);
    if (!this.#hasReady) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_missing' });
    }
    if (!this.#hasOutcome) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'outcome_missing' });
    }
    const lastSequence = BigInt(this.#records.length);
    if (lastSequence === 0n || lastSequence > MAX_U64) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'sequence_exhausted' });
    }
    const segment = {
      schema: TRACE_SCHEMA_VERSION,
      run_id: this.#runId,
      first_sequence: '1',
      last_sequence: lastSequence.toString(),
      records: this.#records,
      sha256: sha256Json(this.#records),
      trailer: { complete: true },
    };
    const bytes = Buffer.from(canonicalJson(segment), 'utf8');
    if (bytes.byteLength > MAX_RUNTIME_TRACE_BYTES) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_limit_exceeded' });
    }
    this.#finalized = bytes;
    return Buffer.from(bytes);
  }

  #append(record: TraceRecord): void {
    this.#assertMutable();
    if (this.#records.length >= MAX_RUNTIME_TRACE_RECORDS) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_record_limit_exceeded' });
    }
    const recordBytes = Buffer.byteLength(canonicalJson(record), 'utf8');
    const separatorBytes = this.#records.length === 0 ? 0 : 1;
    if (this.#baseByteLength + this.#recordBytes + separatorBytes + recordBytes > MAX_RUNTIME_TRACE_BYTES) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_limit_exceeded' });
    }
    this.#records.push(record);
    this.#recordBytes += separatorBytes + recordBytes;
  }

  #assertMutable(): void {
    if (this.#finalized !== undefined) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_finalized' });
    }
  }
}

/** Stages finalized evidence inside the prepared run after the server has stopped. */
export async function stageRuntimeTrace(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  preparedRun: PreparedRun;
  trace: RuntimeTraceBuilder;
}>): Promise<Readonly<{ relativePath: Buffer; identity: FileIdentity; byteLength: number }>> {
  const contents = options.trace.finalize();
  const relativePath = Buffer.concat([options.preparedRun.runDirectoryPath, TRACE_FILE_NAME]);
  const identity = await stageOwnedFile({
    helperPath: options.helperPath,
    ownedRoot: options.ownedRoot,
    relativePath,
    contents,
    maxBytes: Math.min(MAX_RUNTIME_TRACE_BYTES, MAX_OWNED_FILE_BYTES),
  });
  return Object.freeze({ relativePath, identity, byteLength: contents.byteLength });
}

function toTraceRecord(value: unknown): TraceRecord {
  const converted = toTraceValue(value);
  if (converted === null || typeof converted !== 'object' || Array.isArray(converted)) {
    throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_record' });
  }
  return converted as TraceRecord;
}

function toTraceValue(value: unknown): StrictJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => toTraceValue(item));
  if (typeof value === 'object') {
    const result: Record<string, StrictJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      result[key] = toTraceValue(item);
    }
    return result;
  }
  throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_record_value' });
}
