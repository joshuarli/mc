import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { TextDecoder } from 'node:util';
import { sha256Json } from './canonical.js';
import { parseStrictJson, StrictJsonError, type StrictJsonValue } from './control/strict-json.js';
import { RunnerError } from './errors.js';

export const TRACE_SCHEMA_VERSION = 3;
export const FUNNEL_TRACE_SCHEMA_VERSION = 4;
export const MAX_TRACE_SEGMENT_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
export const MAX_TRACE_SEGMENTS = 100_000;
const MAX_SEQUENCE = (1n << 64n) - 1n;
const TRACE_FIELDS = new Set([
  'schema',
  'run_id',
  'first_sequence',
  'last_sequence',
  'records',
  'sha256',
  'trailer',
]);

export interface TraceSegment {
  readonly schema: 2 | 3 | 4;
  readonly runId: string;
  readonly firstSequence: bigint;
  readonly lastSequence: bigint;
  readonly records: readonly TraceRecord[];
  readonly sha256: string;
  readonly byteLength: number;
}

export interface TraceFailureSource {
  readonly kind: string;
  readonly record?: number;
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
}

export class TraceError extends Error {
  constructor(readonly source: TraceFailureSource) {
    super(source.kind);
  }
}

export async function readSegment(path: PathLike, argument: number): Promise<TraceSegment> {
  const resource = `trace segment argument ${argument}`;
  let file: FileHandle | undefined;
  let operationFailed = false;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw corrupt(resource, 'not_a_regular_file', argument);
    }
    if (metadata.size > MAX_TRACE_SEGMENT_BYTES) {
      throw corrupt(resource, 'segment_too_large', argument);
    }

    const bytes = Buffer.allocUnsafe(MAX_TRACE_SEGMENT_BYTES + 1);
    let length = 0;
    while (length <= MAX_TRACE_SEGMENT_BYTES) {
      const requested = Math.min(64 * 1024, bytes.length - length);
      const { bytesRead } = await file.read(bytes, length, requested, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_TRACE_SEGMENT_BYTES) {
      throw corrupt(resource, 'segment_too_large', argument);
    }

    try {
      return parseSegment(bytes.subarray(0, length));
    } catch (error) {
      if (!(error instanceof TraceError)) throw error;
      throw new RunnerError('corrupt_evidence', resource, {
        ...error.source,
        argument,
      });
    }
  } catch (error) {
    operationFailed = true;
    if (error instanceof RunnerError) throw error;
    throw mapIoError(resource, argument, error);
  } finally {
    if (file !== undefined) {
      try {
        await file.close();
      } catch (error) {
        if (!operationFailed) throw mapIoError(resource, argument, error);
      }
    }
  }
}

export function parseSegment(input: string | Uint8Array): TraceSegment {
  let parsed: StrictJsonValue;
  try {
    parsed = parseStrictJson(input);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    if (error.code === 'maximum_depth') throw traceFailure('nesting_limit_exceeded', positionFor(input, error.offset));
    const kind = error.code === 'duplicate_key' ? 'invalid_json' : error.code;
    throw traceFailure(kind, positionFor(input, error.offset));
  }

  const root = strictJsonObject(parsed);
  if (root === undefined) throw traceFailure('trace_root_not_object');
  for (const field of Object.keys(root)) {
    if (!TRACE_FIELDS.has(field)) throw traceFailure('unknown_field');
  }
  for (const field of TRACE_FIELDS) {
    if (!Object.hasOwn(root, field)) throw traceFailure(missingFieldKind(field));
  }

  if (root.schema !== 2 && root.schema !== TRACE_SCHEMA_VERSION && root.schema !== FUNNEL_TRACE_SCHEMA_VERSION) {
    throw traceFailure('unsupported_schema');
  }
  const runId = typeof root.run_id === 'string' && root.run_id.length > 0 ? root.run_id : undefined;
  if (runId === undefined) throw traceFailure('invalid_run_id');

  const firstSequence = parseSequence(root.first_sequence, 'first_sequence');
  const lastSequence = parseSequence(root.last_sequence, 'last_sequence');
  if (!Array.isArray(root.records) || root.records.some((record) => strictJsonObject(record) === undefined)) {
    throw traceFailure('invalid_records');
  }
  const records = root.records as readonly TraceRecord[];
  if (root.schema === 2 && records.some((record) => record.schema === 'policy-replay-v3')) {
    throw traceFailure('unsupported_policy_schema');
  }
  if (root.schema !== FUNNEL_TRACE_SCHEMA_VERSION && records.some((record) => record.schema === 'action-funnel-v1'
    || record.schema === 'worker-topology-v1' || record.schema === 'worker-loss-v1'
    || record.schema === 'client-diagnostic-v1')) {
    throw traceFailure('unsupported_funnel_schema');
  }
  if (root.schema !== FUNNEL_TRACE_SCHEMA_VERSION && records.some((record) => record.schema === 'policy-replay-v4')) {
    throw traceFailure('unsupported_policy_schema');
  }
  if (typeof root.sha256 !== 'string') throw traceFailure('invalid_sha256');
  if (!/^[0-9a-f]{64}$/.test(root.sha256)) throw traceFailure('invalid_checksum_format');

  const trailer = strictJsonObject(root.trailer);
  if (trailer === undefined || Object.keys(trailer).length !== 1 || trailer.complete !== true) {
    throw traceFailure('invalid_completion_trailer');
  }

  const expectedCount = lastSequence - firstSequence + 1n;
  if (expectedCount <= 0n || expectedCount > MAX_SEQUENCE) throw traceFailure('invalid_sequence_range');
  if (expectedCount !== BigInt(records.length)) throw traceFailure('record_sequence_count_mismatch');
  if (sha256Json(records) !== root.sha256) throw traceFailure('checksum_mismatch');

  const byteLength = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  return { schema: root.schema, runId, firstSequence, lastSequence, records, sha256: root.sha256, byteLength };
}

function parseSequence(value: StrictJsonValue | undefined, field: 'first_sequence' | 'last_sequence'): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw traceFailure(`invalid_${field}`);
  }
  const sequence = BigInt(value);
  if (sequence === 0n || sequence > MAX_SEQUENCE) throw traceFailure(`invalid_${field}`);
  return sequence;
}

export type TraceRecord = { readonly [key: string]: StrictJsonValue };

function strictJsonObject(value: StrictJsonValue | undefined): TraceRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as TraceRecord
    : undefined;
}

function positionFor(input: string | Uint8Array, offset: number | null): { line: number; column: number } | undefined {
  if (offset === null) return undefined;
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  let line = 1;
  let column = 1;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function missingFieldKind(field: string): string {
  switch (field) {
    case 'schema': return 'missing_schema';
    case 'run_id': return 'missing_run_id';
    case 'first_sequence': return 'missing_first_sequence';
    case 'last_sequence': return 'missing_last_sequence';
    case 'records': return 'missing_records';
    case 'sha256': return 'missing_sha256';
    case 'trailer': return 'missing_trailer';
    default: return 'missing_field';
  }
}

function traceFailure(kind: string, position?: { line?: number; column?: number }): TraceError {
  return new TraceError({ kind, ...position });
}

function corrupt(
  resource: string,
  kind: string,
  argument: number,
  position?: { line?: number; column?: number },
): RunnerError {
  return new RunnerError('corrupt_evidence', resource, { kind, argument, ...position });
}

function mapIoError(resource: string, argument: number, error: unknown): RunnerError {
  const failure = error as NodeJS.ErrnoException;
  const category = failure.code === 'ENOENT' ? 'missing_prerequisite' : 'runtime_failure';
  const source: { kind: string; argument: number; os_code?: number } = { kind: 'io', argument };
  if (typeof failure.errno === 'number') source.os_code = failure.errno;
  return new RunnerError(category, resource, source);
}

