import { canonicalJson } from '../canonical.js';
import { RunnerError, type ErrorCategory, type ErrorSource } from '../errors.js';
import {
  MAX_OWNED_READ_BYTES,
  OwnedFilesError,
  readOwnedFile,
  stageOwnedFile,
  type FileIdentity,
} from '../owned-files/index.js';
import { isValidRunId } from '../run-id.js';
import { parseStrictJson, StrictJsonError, type StrictJsonValue } from '../control/strict-json.js';
import { MAX_TRACE_SEGMENT_BYTES } from '../trace.js';

export const OPERATIONAL_FAILURE_SCHEMA_VERSION = 1;
export const MAX_OPERATIONAL_FAILURE_BYTES = MAX_OWNED_READ_BYTES;
const RUN_DIRECTORY_PREFIX = '.work/arena/runs/';
const FAILURE_ARTIFACT_NAME = 'operational-failure-v1.json';
const TRACE_SEGMENT_LIMIT = 100_000;
const MAX_U64 = 18_446_744_073_709_551_615n;

const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'invalid_input',
  'missing_prerequisite',
  'owner_conflict',
  'corrupt_evidence',
  'runtime_failure',
  'cancelled',
]);
const ERROR_SOURCE_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'argument',
  'field',
  'record',
  'line',
  'column',
  'os_code',
  'cleanup_os_code',
  'cleanup_kind',
  'published',
  'reason',
  'run_id',
  'relative_artifact',
]);

export interface OperationalFailurePrimaryV1 {
  readonly category: ErrorCategory;
  readonly resource: string;
  readonly source: ErrorSource;
}

export type OperationalFailureCleanupV1 =
  | Readonly<{ status: 'succeeded'; source: null }>
  | Readonly<{ status: 'failed'; source: ErrorSource }>;

export interface OperationalFailureTraceSegmentV1 {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly byte_length: number;
}

export interface OperationalFailureArtifactV1 {
  readonly schema: 1;
  readonly run_id: string;
  readonly primary: OperationalFailurePrimaryV1;
  readonly cleanup: OperationalFailureCleanupV1;
  readonly trace_checkpoint_segments: readonly OperationalFailureTraceSegmentV1[];
}

export async function writeOperationalFailureArtifact(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  artifact: OperationalFailureArtifactV1;
  signal?: AbortSignal;
}>): Promise<Readonly<{ path: Buffer; identity: FileIdentity; byteLength: number }>> {
  validateArtifact(options.artifact, options.artifact.run_id);
  const contents = Buffer.from(canonicalJson(options.artifact), 'utf8');
  if (contents.length > MAX_OPERATIONAL_FAILURE_BYTES) {
    throw new RunnerError('runtime_failure', 'operational failure artifact', {
      kind: 'operational_failure_artifact_too_large',
    });
  }
  const path = failureArtifactPath(options.artifact.run_id);
  const identity = await stageOwnedFile({
    helperPath: options.helperPath,
    ownedRoot: options.ownedRoot,
    relativePath: path,
    contents,
    maxBytes: MAX_OPERATIONAL_FAILURE_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return Object.freeze({ path, identity, byteLength: contents.length });
}

export async function readOperationalFailureArtifact(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  runId: string;
}>): Promise<OperationalFailureArtifactV1> {
  if (!isValidRunId(options.runId)) throw invalidArtifact('invalid_run_id');
  let bytes: Buffer;
  try {
    bytes = await readOwnedFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath: failureArtifactPath(options.runId),
      maxBytes: MAX_OPERATIONAL_FAILURE_BYTES,
    });
  } catch (error) {
    if (!(error instanceof OwnedFilesError)) throw error;
    if (error.category === 'not_found') {
      throw new RunnerError('missing_prerequisite', 'operational failure artifact', {
        kind: 'operational_failure_artifact_missing',
      });
    }
    throw new RunnerError(
      error.category === 'too_large' || error.category === 'unsupported_file_type' || error.category === 'symlink_rejected'
        ? 'corrupt_evidence'
        : error.category === 'helper_start' ? 'missing_prerequisite' : 'runtime_failure',
      'operational failure artifact',
      { kind: 'operational_failure_artifact_read_failed' },
    );
  }
  return parseOperationalFailureArtifact(bytes, options.runId);
}

export function parseOperationalFailureArtifact(
  input: string | Uint8Array,
  expectedRunId: string,
): OperationalFailureArtifactV1 {
  let parsed: StrictJsonValue;
  try {
    parsed = parseStrictJson(input);
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw invalidArtifact(error.code === 'duplicate_key' ? 'invalid_json' : error.code);
  }
  const root = objectValue(parsed);
  if (root === undefined || !hasExactKeys(root, ['schema', 'run_id', 'primary', 'cleanup', 'trace_checkpoint_segments'])) {
    throw invalidArtifact('invalid_shape');
  }
  if (!isSafeIntegerNumber(root, 'schema', root.schema)) throw invalidArtifact('invalid_schema');
  if (root.schema !== OPERATIONAL_FAILURE_SCHEMA_VERSION) throw invalidArtifact('unsupported_schema');
  if (typeof root.run_id !== 'string' || !isValidRunId(root.run_id) || root.run_id !== expectedRunId) {
    throw invalidArtifact('invalid_run_id');
  }

  const primary = parsePrimary(root.primary);
  const cleanup = parseCleanup(root.cleanup);
  const traceCheckpointSegments = parseSegments(root.trace_checkpoint_segments, root.run_id);
  return Object.freeze({
    schema: OPERATIONAL_FAILURE_SCHEMA_VERSION,
    run_id: root.run_id,
    primary,
    cleanup,
    trace_checkpoint_segments: Object.freeze(traceCheckpointSegments),
  });
}

export function failureArtifactPath(runId: string): Buffer {
  if (!isValidRunId(runId)) throw invalidArtifact('invalid_run_id');
  return Buffer.from(`${RUN_DIRECTORY_PREFIX}${runId}/${FAILURE_ARTIFACT_NAME}`, 'ascii');
}

function validateArtifact(artifact: OperationalFailureArtifactV1, expectedRunId: string): void {
  const root = objectValue(artifact as unknown as StrictJsonValue);
  if (root === undefined || !hasExactKeys(root, [
    'schema', 'run_id', 'primary', 'cleanup', 'trace_checkpoint_segments',
  ]) || root.schema !== OPERATIONAL_FAILURE_SCHEMA_VERSION || root.run_id !== expectedRunId
      || typeof root.run_id !== 'string' || !isValidRunId(root.run_id)) {
    throw invalidArtifact('invalid_shape');
  }
  parsePrimary(root.primary);
  parseCleanup(root.cleanup);
  parseSegments(root.trace_checkpoint_segments, root.run_id);
}

function parsePrimary(value: StrictJsonValue | undefined): OperationalFailurePrimaryV1 {
  const primary = objectValue(value);
  if (primary === undefined || !hasExactKeys(primary, ['category', 'resource', 'source'])) {
    throw invalidArtifact('invalid_primary');
  }
  if (typeof primary.category !== 'string' || !ERROR_CATEGORIES.has(primary.category)
      || typeof primary.resource !== 'string' || primary.resource.length === 0) {
    throw invalidArtifact('invalid_primary');
  }
  const source = parseErrorSource(primary.source);
  return Object.freeze({
    category: primary.category as ErrorCategory,
    resource: primary.resource,
    source,
  });
}

function parseCleanup(value: StrictJsonValue | undefined): OperationalFailureCleanupV1 {
  const cleanup = objectValue(value);
  if (cleanup === undefined || !hasExactKeys(cleanup, ['status', 'source'])) {
    throw invalidArtifact('invalid_cleanup');
  }
  if (cleanup.status === 'succeeded' && cleanup.source === null) {
    return Object.freeze({ status: 'succeeded', source: null });
  }
  if (cleanup.status === 'failed') {
    return Object.freeze({ status: 'failed', source: parseErrorSource(cleanup.source) });
  }
  throw invalidArtifact('invalid_cleanup');
}

function parseErrorSource(value: StrictJsonValue | undefined): ErrorSource {
  const source = objectValue(value);
  if (source === undefined || typeof source.kind !== 'string' || source.kind.length === 0
      || Object.keys(source).some((field) => !ERROR_SOURCE_FIELDS.has(field))
      || Object.values(source).some((fieldValue) => fieldValue === undefined)) {
    throw invalidArtifact('invalid_source');
  }
  for (const field of ['argument', 'record', 'line', 'column', 'os_code', 'cleanup_os_code'] as const) {
    const fieldValue = source[field];
    if (fieldValue !== undefined && !isSafeIntegerNumber(source, field, fieldValue)) {
      throw invalidArtifact('invalid_source');
    }
  }
  for (const field of ['field', 'cleanup_kind', 'reason', 'run_id', 'relative_artifact'] as const) {
    const fieldValue = source[field];
    if (fieldValue !== undefined && typeof fieldValue !== 'string') throw invalidArtifact('invalid_source');
  }
  if (source.published !== undefined && typeof source.published !== 'boolean') {
    throw invalidArtifact('invalid_source');
  }
  return Object.freeze(source as unknown as ErrorSource);
}

function parseSegments(value: StrictJsonValue | undefined, runId: string): OperationalFailureTraceSegmentV1[] {
  if (!Array.isArray(value) || value.length > TRACE_SEGMENT_LIMIT) {
    throw invalidArtifact('invalid_trace_checkpoint_segments');
  }
  const segments: OperationalFailureTraceSegmentV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const segment = objectValue(value[index]);
    if (segment === undefined || !hasExactKeys(segment, ['path', 'identity', 'byte_length'])) {
      throw invalidArtifact('invalid_trace_checkpoint_segment');
    }
    const expectedPath = traceSegmentPath(runId, index + 1);
    if (segment.path !== expectedPath || !isSafeIntegerNumber(segment, 'byte_length', segment.byte_length)
        || segment.byte_length <= 0
        || segment.byte_length > MAX_TRACE_SEGMENT_BYTES) {
      throw invalidArtifact('invalid_trace_checkpoint_segment');
    }
    const identity = objectValue(segment.identity);
    if (identity === undefined || !hasExactKeys(identity, ['device', 'inode'])
        || !isFileIdentity(identity.device, identity.inode)) {
      throw invalidArtifact('invalid_trace_checkpoint_segment');
    }
    segments.push(Object.freeze({
      path: expectedPath,
      identity: Object.freeze({ device: identity.device as string, inode: identity.inode as string }),
      byte_length: segment.byte_length,
    }));
  }
  return segments;
}

function traceSegmentPath(runId: string, sequence: number): string {
  return `${RUN_DIRECTORY_PREFIX}${runId}/trace-v2-${String(sequence).padStart(6, '0')}.json`;
}

function isFileIdentity(device: StrictJsonValue | undefined, inode: StrictJsonValue | undefined): boolean {
  return isU64Decimal(device) && isU64Decimal(inode);
}

function isU64Decimal(value: StrictJsonValue | undefined): value is string {
  return typeof value === 'string' && value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value)
    && BigInt(value) <= MAX_U64;
}

function isSafeIntegerNumber(
  owner: object,
  key: string,
  value: StrictJsonValue | undefined,
): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  const token = strictJsonNumberToken(owner, key);
  return token === undefined || isIntegerNumberToken(token);
}

function isIntegerNumberToken(token: string): boolean {
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (match === null) return false;
  const fraction = match[2] ?? '';
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  const decimalPlaces = fraction.length - exponent;
  if (decimalPlaces <= 0) return true;
  const digits = `${match[1]}${fraction}`;
  if (decimalPlaces >= digits.length) return /^0+$/.test(digits);
  return new RegExp(`0{${decimalPlaces}}$`).test(digits);
}

function objectValue(value: StrictJsonValue | undefined): Record<string, StrictJsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, StrictJsonValue>
    : undefined;
}

function hasExactKeys(value: Record<string, StrictJsonValue>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function invalidArtifact(field: string): RunnerError {
  return new RunnerError('corrupt_evidence', 'operational failure artifact', {
    kind: 'invalid_operational_failure_artifact',
    field,
  });
}
