import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { consumeRawArgv, RawArgvError } from './raw-argv.js';
import { isValidRunId } from '../run-id.js';

export const MAX_WORLD_PLAN_BYTES = 128 * 1024 * 1024;
export const MAX_OWNED_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_OWNED_READ_BYTES = 16 * 1024 * 1024;
export const MAX_OWNED_TREE_FILES = 100_000;
export const MAX_OWNED_TREE_BYTES = 16 * 1024 * 1024 * 1024;

export type NativeErrorCategory =
  | 'invalid_path'
  | 'conflict'
  | 'permission'
  | 'symlink_rejected'
  | 'not_found'
  | 'too_large'
  | 'cancelled'
  | 'unsupported_file_type'
  | 'io'
  | 'invalid_argument'
  | 'helper_start'
  | 'protocol_error';

export type FileIdentity = Readonly<{
  device: string;
  inode: string;
}>;

export type ClonePublication = 'absent' | 'present' | 'unknown';

export type OwnedRunLeaseClose =
  | Readonly<{ kind: 'released' }>
  | Readonly<{ kind: 'lost'; error: OwnedFilesError }>;

export interface OwnedRunLease {
  readonly identity: FileIdentity;
  readonly closed: Promise<OwnedRunLeaseClose>;
  release(): Promise<void>;
}

type OwnedRunLeaseProvenance = {
  readonly ownedRoot: Buffer;
  readonly relativePath: Buffer;
  readonly lockIdentity: FileIdentity;
  readonly runDirectoryIdentity: FileIdentity;
  state: 'held' | 'releasing' | 'closed';
  activeOperations: number;
  readonly releaseWaiters: Set<() => void>;
};

const ownedRunLeaseProvenance = new WeakMap<OwnedRunLease, OwnedRunLeaseProvenance>();

function markOwnedRunLeaseClosed(lease: OwnedRunLease): void {
  const provenance = ownedRunLeaseProvenance.get(lease);
  if (provenance !== undefined) provenance.state = 'closed';
}

function waitForOwnedRunLeaseOperations(provenance: OwnedRunLeaseProvenance): Promise<void> {
  if (provenance.activeOperations === 0) return Promise.resolve();
  return new Promise((resolve) => provenance.releaseWaiters.add(resolve));
}

function finishOwnedRunLeaseOperation(provenance: OwnedRunLeaseProvenance): void {
  provenance.activeOperations--;
  if (provenance.activeOperations !== 0) return;
  for (const resolve of provenance.releaseWaiters) resolve();
  provenance.releaseWaiters.clear();
}

type NativeOperation =
  | 'create-run'
  | 'create-owned-directory'
  | 'stage-world-plan'
  | 'stage-owned-file'
  | 'clone-owned-tree'
  | 'inspect-owned-resources'
  | 'list-owned-runs'
  | 'remove-owned-run-tree'
  | 'hold-run-lease'
  | 'read-owned-file'
  | 'unlink-created-file'
  | 'unlink-created-directory';

type NativeEvent = Readonly<{
  event: 'created-directory' | 'staged-file' | 'clone-published';
  path: Buffer;
  device: string;
  inode: string;
}>;

type NativeSuccess = Readonly<{
  v: 1;
  ok: true;
  operation: NativeOperation;
  device?: string;
  inode?: string;
  data?: string;
  free_bytes?: string;
  work_bytes?: string;
  dependency_bytes?: string;
  run_count?: number;
  runs?: unknown;
  run_device?: string;
  run_inode?: string;
}>;

export type OwnedResourceSnapshot = Readonly<{
  freeBytes: bigint;
  workBytes: bigint;
  dependencyBytes: bigint;
  runCount: number;
}>;

export type OwnedRunSnapshot = Readonly<{
  runId: string;
  identity: FileIdentity;
  modifiedTimeNs: bigint;
  failureArtifactModifiedTimeNs?: bigint;
  terminalTraceSequence?: number;
  terminalTraceModifiedTimeNs?: bigint;
}>;

type NativeFailure = Readonly<{
  v: 1;
  ok: false;
  operation: NativeOperation | 'startup';
  category: NativeErrorCategory;
  errno: number;
  cleanup_errno: number;
  published: boolean;
  device: string;
  inode: string;
}>;

type NativeRecord = NativeEvent | NativeSuccess | NativeFailure;

const nativeErrorCategories: ReadonlySet<string> = new Set([
  'invalid_path',
  'conflict',
  'permission',
  'symlink_rejected',
  'not_found',
  'too_large',
  'cancelled',
  'unsupported_file_type',
  'io',
]);
const maxStdoutBytes = 24 * 1024 * 1024;
const maxStderrBytes = 64 * 1024;
const childTerminationGraceMs = 5000;
const maxOwnedRunListEntries = 10_000;

export class OwnedFilesError extends Error {
  readonly category: NativeErrorCategory;
  readonly operation: NativeOperation;
  readonly errno: number | undefined;
  readonly cleanupErrno: number | undefined;
  readonly published: boolean;
  readonly identity: FileIdentity | undefined;
  readonly relativePath: Buffer | undefined;
  readonly sourceRelativePath: Buffer | undefined;
  readonly nativeEvents: readonly NativeEvent[];
  readonly clonePublication: ClonePublication | undefined;
  readonly diagnostic: string | undefined;
  readonly causeValue?: unknown;

  constructor(details: {
    message: string;
    category: NativeErrorCategory;
    operation: NativeOperation;
    errno?: number | undefined;
    cleanupErrno?: number | undefined;
    published?: boolean;
    identity?: FileIdentity | undefined;
    relativePath?: Buffer | undefined;
    sourceRelativePath?: Buffer | undefined;
    nativeEvents?: readonly NativeEvent[];
    clonePublication?: ClonePublication | undefined;
    diagnostic?: string | undefined;
    cause?: unknown;
  }) {
    super(details.message);
    this.name = 'OwnedFilesError';
    this.category = details.category;
    this.operation = details.operation;
    this.errno = details.errno;
    this.cleanupErrno = details.cleanupErrno;
    this.published = details.published ?? false;
    this.identity = details.identity;
    this.relativePath = details.relativePath;
    this.sourceRelativePath = details.sourceRelativePath;
    this.nativeEvents = details.nativeEvents ?? [];
    this.clonePublication = details.clonePublication;
    this.diagnostic = details.diagnostic;
    this.causeValue = details.cause;
  }
}

async function withRelativePath<T>(relativePath: Buffer, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof OwnedFilesError)) throw error;
    throw new OwnedFilesError({
      message: error.message,
      category: error.category,
      operation: error.operation,
      errno: error.errno,
      cleanupErrno: error.cleanupErrno,
      published: error.published,
      identity: error.identity,
      relativePath: Buffer.from(relativePath),
      sourceRelativePath: error.sourceRelativePath,
      nativeEvents: error.nativeEvents,
      clonePublication: error.clonePublication,
      diagnostic: error.diagnostic,
      cause: error.causeValue,
    });
  }
}

async function withSourceRelativePath<T>(sourceRelativePath: Buffer, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof OwnedFilesError)) throw error;
    throw new OwnedFilesError({
      message: error.message,
      category: error.category,
      operation: error.operation,
      errno: error.errno,
      cleanupErrno: error.cleanupErrno,
      published: error.published,
      identity: error.identity,
      relativePath: error.relativePath,
      sourceRelativePath: Buffer.from(sourceRelativePath),
      nativeEvents: error.nativeEvents,
      clonePublication: error.clonePublication,
      diagnostic: error.diagnostic,
      cause: error.causeValue,
    });
  }
}

function encodePath(path: Buffer, name: string, operation: NativeOperation): string {
  if (path.length === 0 || path.includes(0)) {
    throw new OwnedFilesError({
      message: `${name} must be a non-empty OS path without NUL bytes`,
      category: 'invalid_path',
      operation,
      clonePublication: operation === 'clone-owned-tree' ? 'absent' : undefined,
    });
  }
  return path.toString('base64');
}

function decodeBase64(value: string, name: string, operation: NativeOperation): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new OwnedFilesError({
      message: `${name} has invalid base64`,
      category: 'protocol_error',
      operation,
    });
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new OwnedFilesError({
      message: `${name} has non-canonical base64`,
      category: 'protocol_error',
      operation,
    });
  }
  return bytes;
}

function identityFrom(device: unknown, inode: unknown, operation: NativeOperation): FileIdentity {
  if (typeof device !== 'string' || typeof inode !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/.test(device) || !/^(?:0|[1-9][0-9]*)$/.test(inode)) {
    throw new OwnedFilesError({
      message: 'native helper returned an invalid filesystem identity',
      category: 'protocol_error',
      operation,
    });
  }
  return Object.freeze({ device, inode });
}

function includePublishedStage(events: NativeEvent[], operation: NativeOperation,
                              arguments_: readonly string[], result: NativeSuccess | NativeFailure | undefined): void {
  if (operation !== 'stage-world-plan' && operation !== 'stage-owned-file') return;
  if (result !== undefined && !(result.ok || result.published)) return;
  let identity: FileIdentity | undefined;
  if (result?.device !== undefined && result.inode !== undefined &&
      !(result.device === '0' && result.inode === '0')) {
    try {
      identity = identityFrom(result.device, result.inode, operation);
    } catch (error) {
      if (!(error instanceof OwnedFilesError)) throw error;
    }
  }
  if (identity === undefined) {
    const temporary = events.find((event) => event.event === 'staged-file');
    if (temporary === undefined) return;
    identity = { device: temporary.device, inode: temporary.inode };
  }
  const path = decodeBase64(arguments_[1]!, 'world plan destination', operation);
  if (events.some((event) => event.event === 'staged-file' && event.path.equals(path) &&
      event.device === identity!.device && event.inode === identity!.inode)) return;
  events.push({
    event: 'staged-file',
    path,
    ...identity,
  });
}

function includePublishedClone(events: NativeEvent[], operation: NativeOperation,
                               arguments_: readonly string[], result: NativeSuccess | NativeFailure | undefined): void {
  if (operation !== 'clone-owned-tree' || (result !== undefined && !(result.ok || result.published))) return;
  let identity: FileIdentity | undefined;
  if (result?.device !== undefined && result.inode !== undefined &&
      !(result.device === '0' && result.inode === '0')) {
    try {
      identity = identityFrom(result.device, result.inode, operation);
    } catch (error) {
      if (!(error instanceof OwnedFilesError)) throw error;
    }
  }
  const destination = decodeBase64(arguments_[2]!, 'clone destination', operation);
  const existing = events.find((event) => event.event === 'clone-published' && event.path.equals(destination));
  if (identity === undefined && existing !== undefined) {
    identity = { device: existing.device, inode: existing.inode };
  }
  if (identity === undefined) return;
  if (existing !== undefined && existing.device === identity.device && existing.inode === identity.inode) return;
  events.push({ event: 'clone-published', path: destination, ...identity });
}

function clonePublication(events: readonly NativeEvent[]): Readonly<{
  published: boolean;
  identity: FileIdentity | undefined;
  status: ClonePublication;
}> {
  const event = [...events].reverse().find((candidate) => candidate.event === 'clone-published');
  return event === undefined
    ? { published: false, identity: undefined, status: 'unknown' }
    : { published: true, identity: { device: event.device, inode: event.inode }, status: 'present' };
}

function cloneFailureState(operation: NativeOperation, events: readonly NativeEvent[],
                           result: NativeSuccess | NativeFailure | undefined): Readonly<{
  published: boolean;
  identity: FileIdentity | undefined;
  status: ClonePublication | undefined;
}> {
  if (operation !== 'clone-owned-tree') return { published: false, identity: undefined, status: undefined };
  if (result !== undefined && !result.ok) {
    return {
      published: result.published,
      identity: result.published && !(result.device === '0' && result.inode === '0')
        ? identityFrom(result.device, result.inode, operation)
        : undefined,
      status: result.published ? 'present' : 'absent',
    };
  }
  return clonePublication(events);
}

function parseRecord(line: string, expectedOperation: NativeOperation): NativeRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new OwnedFilesError({
      message: 'native helper returned malformed JSON',
      category: 'protocol_error',
      operation: expectedOperation,
      cause,
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OwnedFilesError({
      message: 'native helper returned a non-object record',
      category: 'protocol_error',
      operation: expectedOperation,
    });
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1) {
    throw new OwnedFilesError({
      message: 'native helper returned an unsupported protocol version',
      category: 'protocol_error',
      operation: expectedOperation,
    });
  }
  if (record.event === 'created-directory' || record.event === 'staged-file' ||
      record.event === 'clone-published') {
    const identity = identityFrom(record.device, record.inode, expectedOperation);
    return {
      event: record.event,
      path: decodeBase64(String(record.path), 'native event path', expectedOperation),
      device: identity.device,
      inode: identity.inode,
    };
  }
  if (record.ok === true && typeof record.operation === 'string') {
    return record as NativeSuccess;
  }
  if (record.ok === false && typeof record.operation === 'string' &&
      typeof record.category === 'string' && nativeErrorCategories.has(record.category) &&
      Number.isInteger(record.errno) && (record.errno as number) >= 0 &&
      Number.isInteger(record.cleanup_errno) && (record.cleanup_errno as number) >= 0 &&
      typeof record.published === 'boolean' &&
      typeof record.device === 'string' && /^(?:0|[1-9][0-9]*)$/.test(record.device) &&
      typeof record.inode === 'string' && /^(?:0|[1-9][0-9]*)$/.test(record.inode)) {
    return record as NativeFailure;
  }
  throw new OwnedFilesError({
    message: 'native helper returned an unknown record shape',
    category: 'protocol_error',
    operation: expectedOperation,
  });
}

function parseOutput(output: Buffer, expectedOperation: NativeOperation): {
  events: NativeEvent[];
  result: NativeSuccess | NativeFailure;
} {
  if (output.length === 0 || output.includes(0)) {
    throw new OwnedFilesError({
      message: 'native helper returned empty or binary control output',
      category: 'protocol_error',
      operation: expectedOperation,
    });
  }
  if (output.some((byte) => byte > 0x7f)) {
    throw new OwnedFilesError({
      message: 'native helper control output is not ASCII',
      category: 'protocol_error',
      operation: expectedOperation,
    });
  }
  const text = output.toString('ascii');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length > 130 || lines.some((line) => line.length === 0)) {
    throw new OwnedFilesError({
      message: 'native helper returned an invalid record sequence',
      category: 'protocol_error',
      operation: expectedOperation,
    });
  }
  const events: NativeEvent[] = [];
  let result: NativeSuccess | NativeFailure | undefined;
  for (const line of lines) {
    let record: NativeRecord;
    try {
      record = parseRecord(line, expectedOperation);
    } catch (error) {
      if (error instanceof OwnedFilesError && events.length > 0) {
        throw new OwnedFilesError({
          message: error.message,
          category: error.category,
          operation: expectedOperation,
          errno: error.errno,
          cleanupErrno: error.cleanupErrno,
          nativeEvents: events,
          cause: error.causeValue,
        });
      }
      throw error;
    }
    if ('event' in record) {
      events.push(record);
    } else {
      if (result !== undefined) {
        throw new OwnedFilesError({
          message: 'native helper returned more than one final result',
          category: 'protocol_error',
          operation: expectedOperation,
          nativeEvents: events,
        });
      }
      result = record;
    }
  }
  if (result === undefined || result.operation !== expectedOperation) {
    throw new OwnedFilesError({
      message: 'native helper result does not match the requested operation',
      category: 'protocol_error',
      operation: expectedOperation,
      nativeEvents: events,
    });
  }
  return { events, result };
}

function makeNativeError(operation: NativeOperation, result: NativeFailure,
                         events: readonly NativeEvent[], diagnostic: string): OwnedFilesError {
  const identity = result.device === '0' && result.inode === '0'
    ? undefined
    : identityFrom(result.device, result.inode, operation);
  return new OwnedFilesError({
    message: `native ${operation} failed: ${result.category}`,
    category: result.category,
    operation,
    errno: result.errno,
    cleanupErrno: result.cleanup_errno === 0 ? undefined : result.cleanup_errno,
    published: result.published,
    identity,
    nativeEvents: events,
    clonePublication: operation === 'clone-owned-tree'
      ? (result.published ? 'present' : 'absent')
      : undefined,
    diagnostic: diagnostic || undefined,
  });
}

async function spawnHelper(helperPath: string, operation: NativeOperation, arguments_: string[],
                           input: Buffer | undefined, signal: AbortSignal | undefined): Promise<{
  events: NativeEvent[];
  result: NativeSuccess;
}> {
  if (signal?.aborted) {
    throw new OwnedFilesError({
      message: `${operation} was cancelled before the helper started`,
      category: 'cancelled',
      operation,
      clonePublication: operation === 'clone-owned-tree' ? 'absent' : undefined,
    });
  }
  try {
    consumeRawArgv();
  } catch (cause) {
    if (!(cause instanceof RawArgvError)) throw cause;
    throw new OwnedFilesError({
      message: 'raw argv channel could not be consumed before starting a helper',
      category: 'protocol_error',
      operation,
      clonePublication: operation === 'clone-owned-tree' ? 'absent' : undefined,
      cause,
    });
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [operation, ...arguments_], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let diagnosticOverflow = false;
    let spawnError: Error | undefined;
    let cancellationRequested = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const terminateChild = (): void => {
      if (child.pid === undefined) return;
      child.kill('SIGTERM');
      escalationTimer ??= setTimeout(() => child.kill('SIGKILL'), childTerminationGraceMs);
    };
    const onAbort = (): void => {
      cancellationRequested = true;
      child.stdin.destroy();
      terminateChild();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once('spawn', () => {
      if (cancellationRequested) terminateChild();
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        outputOverflow = true;
        terminateChild();
      } else {
        stdout.push(Buffer.from(chunk));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        diagnosticOverflow = true;
      } else {
        stderr.push(Buffer.from(chunk));
      }
    });
    child.on('error', (error: Error) => {
      spawnError = error;
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && !cancellationRequested) spawnError ??= error;
    });
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      if (cancellationRequested || signal?.aborted) {
        let events: NativeEvent[] = [];
        let result: NativeSuccess | NativeFailure | undefined;
        try {
          const parsed = stdout.length === 0
            ? undefined
            : parseOutput(Buffer.concat(stdout), operation);
          events = parsed?.events ?? [];
          result = parsed?.result;
        } catch (error) {
          if (error instanceof OwnedFilesError) events = [...error.nativeEvents];
        }
        includePublishedStage(events, operation, arguments_, result);
        includePublishedClone(events, operation, arguments_, result);
        const cloneState = cloneFailureState(operation, events, result);
        reject(new OwnedFilesError({
          message: `${operation} was cancelled`,
          category: 'cancelled',
          operation,
          published: cloneState.published,
          identity: cloneState.identity,
          nativeEvents: events,
          clonePublication: cloneState.status,
          diagnostic: diagnostic || undefined,
        }));
        return;
      }
      if (spawnError !== undefined) {
        reject(new OwnedFilesError({
          message: `could not start native helper for ${operation}`,
          category: 'helper_start',
          operation,
          clonePublication: operation === 'clone-owned-tree' ? 'absent' : undefined,
          diagnostic: diagnostic || undefined,
          cause: spawnError,
        }));
        return;
      }
      if (outputOverflow || diagnosticOverflow) {
        let events: NativeEvent[] = [];
        let result: NativeSuccess | NativeFailure | undefined;
        try {
          const parsed = parseOutput(Buffer.concat(stdout), operation);
          events = parsed.events;
          result = parsed.result;
          includePublishedStage(events, operation, arguments_, parsed.result);
        } catch (error) {
          if (error instanceof OwnedFilesError) events = [...error.nativeEvents];
        }
        includePublishedStage(events, operation, arguments_, result);
        includePublishedClone(events, operation, arguments_, result);
        const cloneState = cloneFailureState(operation, events, result);
        reject(new OwnedFilesError({
          message: 'native helper exceeded its output limit',
          category: 'protocol_error',
          operation,
          published: cloneState.published,
          identity: cloneState.identity,
          nativeEvents: events,
          clonePublication: cloneState.status,
          diagnostic: diagnostic || undefined,
        }));
        return;
      }
      let parsed: ReturnType<typeof parseOutput>;
      try {
        parsed = parseOutput(Buffer.concat(stdout), operation);
      } catch (error) {
        if (error instanceof OwnedFilesError) {
          const events = [...error.nativeEvents];
          includePublishedStage(events, operation, arguments_, undefined);
          includePublishedClone(events, operation, arguments_, undefined);
          const cloneState = cloneFailureState(operation, events, undefined);
          reject(new OwnedFilesError({
            message: error.message,
            category: error.category,
            operation: error.operation,
            errno: error.errno,
            cleanupErrno: error.cleanupErrno,
            published: error.published || cloneState.published,
            identity: error.identity ?? cloneState.identity,
            nativeEvents: events,
            clonePublication: cloneState.status,
            diagnostic: error.diagnostic,
            cause: error.causeValue,
          }));
        } else {
          reject(error);
        }
        return;
      }
      includePublishedStage(parsed.events, operation, arguments_, parsed.result);
      includePublishedClone(parsed.events, operation, arguments_, parsed.result);
      if (!parsed.result.ok) {
        reject(makeNativeError(operation, parsed.result, parsed.events, diagnostic));
        return;
      }
      if (exitCode !== 0 || exitSignal !== null) {
        reject(new OwnedFilesError({
          message: `native ${operation} returned success with exit ${String(exitCode ?? exitSignal)}`,
          category: 'protocol_error',
          operation,
          nativeEvents: parsed.events,
          clonePublication: operation === 'clone-owned-tree' ? 'present' : undefined,
          diagnostic: diagnostic || undefined,
        }));
        return;
      }
      resolve({ events: parsed.events, result: parsed.result });
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

class HelperRunLease implements OwnedRunLease {
  readonly identity: FileIdentity;
  readonly closed: Promise<OwnedRunLeaseClose>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #relativePath: Buffer;
  readonly #diagnostic: () => string;
  readonly #resolveClosed: (result: OwnedRunLeaseClose) => void;
  #releaseRequested = false;
  #releasePromise: Promise<void> | undefined;
  #failure: OwnedFilesError | undefined;
  #escalationTimer: NodeJS.Timeout | undefined;

  constructor(child: ChildProcessWithoutNullStreams, identity: FileIdentity,
              relativePath: Buffer, diagnostic: () => string) {
    this.#child = child;
    this.identity = identity;
    this.#relativePath = Buffer.from(relativePath);
    this.#diagnostic = diagnostic;
    let resolveClosed!: (result: OwnedRunLeaseClose) => void;
    this.closed = new Promise((resolve) => { resolveClosed = resolve; });
    this.#resolveClosed = resolveClosed;
    child.once('close', (exitCode, exitSignal) => {
      if (this.#escalationTimer !== undefined) clearTimeout(this.#escalationTimer);
      const failure = this.#failure ??
        (this.#releaseRequested && exitCode === 0 && exitSignal === null
          ? undefined
          : this.contextualize(new OwnedFilesError({
            message: `run lease helper exited with ${String(exitCode ?? exitSignal)}`,
            category: 'io',
            operation: 'hold-run-lease',
            diagnostic: this.#diagnostic() || undefined,
          })));
      markOwnedRunLeaseClosed(this);
      this.#resolveClosed(failure === undefined ? { kind: 'released' } : { kind: 'lost', error: failure });
    });
    child.on('error', (cause: Error) => {
      this.recordFailure(new OwnedFilesError({
        message: 'run lease helper stopped unexpectedly',
        category: 'helper_start',
        operation: 'hold-run-lease',
        cause,
      }));
    });
  }

  recordFailure(error: OwnedFilesError): void {
    this.#failure ??= this.contextualize(error);
    if (this.#child.pid !== undefined) {
      this.#child.kill('SIGTERM');
      this.#escalationTimer ??= setTimeout(() => this.#child.kill('SIGKILL'), childTerminationGraceMs);
    }
  }

  release(): Promise<void> {
    this.#releasePromise ??= this.releaseOnce();
    return this.#releasePromise;
  }

  private async releaseOnce(): Promise<void> {
    const provenance = ownedRunLeaseProvenance.get(this);
    if (provenance !== undefined && provenance.state === 'held') provenance.state = 'releasing';
    if (provenance !== undefined) await waitForOwnedRunLeaseOperations(provenance);
    this.#releaseRequested = true;
    this.#child.stdin.end();
    const result = await this.closed;
    if (result.kind === 'lost') throw result.error;
  }

  private contextualize(error: OwnedFilesError): OwnedFilesError {
    return new OwnedFilesError({
      message: error.message,
      category: error.category,
      operation: error.operation,
      errno: error.errno,
      cleanupErrno: error.cleanupErrno,
      published: error.published,
      identity: error.identity,
      relativePath: Buffer.from(error.relativePath ?? this.#relativePath),
      sourceRelativePath: error.sourceRelativePath,
      nativeEvents: error.nativeEvents,
      diagnostic: error.diagnostic,
      cause: error.causeValue,
    });
  }
}

function startOwnedRunLease(helperPath: string, ownedRoot: Buffer, relativePath: Buffer,
                            signal: AbortSignal | undefined): Promise<OwnedRunLease> {
  const operation: NativeOperation = 'hold-run-lease';
  if (signal?.aborted) {
    return Promise.reject(new OwnedFilesError({
      message: 'run lease acquisition was cancelled before the helper started',
      category: 'cancelled',
      operation,
    }));
  }
  try {
    consumeRawArgv();
  } catch (cause) {
    if (!(cause instanceof RawArgvError)) return Promise.reject(cause);
    return Promise.reject(new OwnedFilesError({
      message: 'raw argv channel could not be consumed before starting a helper',
      category: 'protocol_error',
      operation,
      cause,
    }));
  }

  const arguments_ = [
    encodePath(ownedRoot, 'owned root', operation),
    encodePath(relativePath, 'run directory', operation),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [operation, ...arguments_], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let pending = Buffer.alloc(0);
    let spawnError: Error | undefined;
    let startupError: OwnedFilesError | undefined;
    let cancellationRequested = false;
    let outputOverflow = false;
    let diagnosticOverflow = false;
    let lease: HelperRunLease | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;

    const diagnostic = (): string => Buffer.concat(stderr).toString('utf8');
    const terminateChild = (): void => {
      if (child.pid === undefined) return;
      child.kill('SIGTERM');
      escalationTimer ??= setTimeout(() => child.kill('SIGKILL'), childTerminationGraceMs);
    };
    const failBeforeAcquisition = (error: OwnedFilesError): void => {
      startupError ??= error;
      terminateChild();
    };
    const onAbort = (): void => {
      cancellationRequested = true;
      child.stdin.destroy();
      terminateChild();
    };
    const contextualError = (error: OwnedFilesError): OwnedFilesError => new OwnedFilesError({
      message: error.message,
      category: error.category,
      operation: error.operation,
      errno: error.errno,
      cleanupErrno: error.cleanupErrno,
      published: error.published,
      identity: error.identity,
      relativePath: Buffer.from(relativePath),
      sourceRelativePath: error.sourceRelativePath,
      nativeEvents: error.nativeEvents,
      diagnostic: (error.diagnostic ?? diagnostic()) || undefined,
      cause: error.causeValue,
    });

    const handleLine = (line: Buffer): void => {
      if (line.length === 0 || line.includes(0) || line.some((byte) => byte > 0x7f)) {
        const error = new OwnedFilesError({
          message: 'native run lease helper returned malformed control output',
          category: 'protocol_error',
          operation,
        });
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
        return;
      }
      let record: NativeRecord;
      try {
        record = parseRecord(line.toString('ascii'), operation);
      } catch (error) {
        const protocolError = error instanceof OwnedFilesError ? error : new OwnedFilesError({
          message: 'native run lease helper returned invalid control output',
          category: 'protocol_error',
          operation,
          cause: error,
        });
        if (lease === undefined) failBeforeAcquisition(protocolError);
        else lease.recordFailure(contextualError(protocolError));
        return;
      }
      if ('event' in record) {
        const error = new OwnedFilesError({
          message: 'native run lease helper returned an unexpected event',
          category: 'protocol_error',
          operation,
        });
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
        return;
      }
      if (record.ok === false) {
        const error = makeNativeError(operation, record, [], diagnostic());
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
        return;
      }
      if (record.operation !== operation) {
        const error = new OwnedFilesError({
          message: 'native run lease result does not match the requested operation',
          category: 'protocol_error',
          operation,
        });
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
        return;
      }
      if (lease !== undefined) {
        lease.recordFailure(contextualError(new OwnedFilesError({
          message: 'native run lease helper returned a second result',
          category: 'protocol_error',
          operation,
        })));
        return;
      }
      if (cancellationRequested || signal?.aborted) {
        cancellationRequested = true;
        terminateChild();
        return;
      }
      try {
        const lockIdentity = resultIdentity(record, operation);
        const runDirectoryIdentity = identityFrom(record.run_device, record.run_inode, operation);
        lease = new HelperRunLease(child, lockIdentity, relativePath, diagnostic);
        ownedRunLeaseProvenance.set(lease, {
          ownedRoot: Buffer.from(ownedRoot),
          relativePath: Buffer.from(relativePath),
          lockIdentity,
          runDirectoryIdentity,
          state: 'held',
          activeOperations: 0,
          releaseWaiters: new Set(),
        });
        signal?.removeEventListener('abort', onAbort);
        resolve(lease);
      } catch (error) {
        failBeforeAcquisition(error instanceof OwnedFilesError ? error : new OwnedFilesError({
          message: 'native run lease helper returned an invalid identity',
          category: 'protocol_error',
          operation,
          cause: error,
        }));
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once('spawn', () => {
      if (cancellationRequested || startupError !== undefined) terminateChild();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStderrBytes) {
        outputOverflow = true;
        const error = new OwnedFilesError({
          message: 'native run lease helper exceeded its output limit',
          category: 'protocol_error',
          operation,
        });
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        handleLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > maxStderrBytes) {
        outputOverflow = true;
        const error = new OwnedFilesError({
          message: 'native run lease helper exceeded its output limit',
          category: 'protocol_error',
          operation,
        });
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        diagnosticOverflow = true;
      } else {
        stderr.push(Buffer.from(chunk));
      }
      if (diagnosticOverflow) {
        const error = new OwnedFilesError({
          message: 'native run lease helper exceeded its diagnostic limit',
          category: 'protocol_error',
          operation,
        });
        if (lease === undefined) failBeforeAcquisition(error);
        else lease.recordFailure(contextualError(error));
      }
    });
    child.on('error', (error: Error) => {
      spawnError = error;
      if (lease !== undefined) lease.recordFailure(contextualError(new OwnedFilesError({
        message: 'native run lease helper stopped unexpectedly',
        category: 'helper_start',
        operation,
        cause: error,
      })));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && !cancellationRequested) spawnError ??= error;
    });
    child.on('close', (exitCode, exitSignal) => {
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      signal?.removeEventListener('abort', onAbort);
      if (lease !== undefined) return;
      if (cancellationRequested || signal?.aborted) {
        reject(new OwnedFilesError({
          message: 'run lease acquisition was cancelled',
          category: 'cancelled',
          operation,
          relativePath: Buffer.from(relativePath),
          diagnostic: diagnostic() || undefined,
        }));
      } else if (spawnError !== undefined) {
        reject(new OwnedFilesError({
          message: 'could not start native helper for hold-run-lease',
          category: 'helper_start',
          operation,
          relativePath: Buffer.from(relativePath),
          diagnostic: diagnostic() || undefined,
          cause: spawnError,
        }));
      } else if (startupError !== undefined) {
        reject(contextualError(startupError));
      } else {
        const trailingOutput = pending.length > 0;
        reject(new OwnedFilesError({
          message: trailingOutput
            ? 'native run lease helper closed with an incomplete result'
            : `native run lease helper exited before acquiring the lease (${String(exitCode ?? exitSignal)})`,
          category: outputOverflow || diagnosticOverflow ? 'protocol_error' : 'io',
          operation,
          relativePath: Buffer.from(relativePath),
          diagnostic: diagnostic() || undefined,
        }));
      }
    });
  });
}

function validateByteLimit(limit: number, maximum: number, operation: NativeOperation): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new OwnedFilesError({
      message: `${operation} byte limit must be between zero and ${maximum}`,
      category: 'invalid_argument',
      operation,
      clonePublication: operation === 'clone-owned-tree' ? 'absent' : undefined,
    });
  }
}

function resultIdentity(result: NativeSuccess, operation: NativeOperation): FileIdentity {
  return identityFrom(result.device, result.inode, operation);
}

function nativeIdentityArguments(identity: FileIdentity): string[] {
  return [identity.device, identity.inode];
}

export async function acquireOwnedRunLease(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  signal?: AbortSignal;
}>): Promise<OwnedRunLease> {
  const { helperPath, ownedRoot, relativePath, signal } = options;
  return await withRelativePath(relativePath, () =>
    startOwnedRunLease(helperPath, ownedRoot, relativePath, signal));
}

async function cleanupEvents(helperPath: string, root: Buffer, events: readonly NativeEvent[]): Promise<number | undefined> {
  let firstCleanupErrno: number | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const operation = event.event === 'staged-file' ? 'unlink-created-file' : 'unlink-created-directory';
    try {
      await spawnHelper(helperPath, operation, [
        encodePath(root, 'owned root', operation),
        encodePath(event.path, 'created path', operation),
        ...nativeIdentityArguments(event),
      ], undefined, undefined);
    } catch (error) {
      if (error instanceof OwnedFilesError && error.category === 'not_found') continue;
      firstCleanupErrno ??= error instanceof OwnedFilesError
        ? error.errno ?? error.cleanupErrno ?? -1
        : -1;
    }
  }
  return firstCleanupErrno;
}

async function cleanupClonePublication(helperPath: string, root: Buffer, destination: Buffer,
                                       error: OwnedFilesError): Promise<{
  status: ClonePublication;
  identity: FileIdentity | undefined;
  cleanupErrno: number | undefined;
}> {
  const status = error.clonePublication ?? 'unknown';
  const publicationEvent = [...error.nativeEvents].reverse().find((event) => event.event === 'clone-published');
  const stagingEvent = [...error.nativeEvents].reverse().find((event) => event.event === 'created-directory');
  const identity = error.identity ?? (publicationEvent === undefined
    ? stagingEvent === undefined ? undefined : { device: stagingEvent.device, inode: stagingEvent.inode }
    : { device: publicationEvent.device, inode: publicationEvent.inode });
  if (status === 'absent' || identity === undefined) {
    return { status, identity, cleanupErrno: undefined };
  }

  try {
    await spawnHelper(helperPath, 'unlink-created-directory', [
      encodePath(root, 'owned root', 'unlink-created-directory'),
      encodePath(destination, 'clone destination', 'unlink-created-directory'),
      ...nativeIdentityArguments(identity),
    ], undefined, undefined);
    return { status: 'absent', identity, cleanupErrno: undefined };
  } catch (cleanupError) {
    if (cleanupError instanceof OwnedFilesError &&
        (cleanupError.category === 'not_found' || cleanupError.category === 'invalid_path')) {
      return { status: 'absent', identity, cleanupErrno: undefined };
    }
    const status = cleanupError instanceof OwnedFilesError &&
      cleanupError.errno === osConstants.errno.ENOTEMPTY
      ? 'present'
      : error.clonePublication ?? 'unknown';
    return {
      status,
      identity,
      cleanupErrno: cleanupError instanceof OwnedFilesError
        ? cleanupError.errno ?? cleanupError.cleanupErrno ?? -1
        : -1,
    };
  }
}

async function cleanupAfterFailure(helperPath: string, root: Buffer, error: unknown,
                                   cloneDestination?: Buffer): Promise<never> {
  if (!(error instanceof OwnedFilesError) ||
      (error.nativeEvents.length === 0 && !(error.operation === 'clone-owned-tree' && error.published))) throw error;
  const eventCleanupErrno = await cleanupEvents(helperPath, root, error.nativeEvents);
  const cloneCleanup = error.operation === 'clone-owned-tree' && cloneDestination !== undefined
    ? await cleanupClonePublication(helperPath, root, cloneDestination, error)
    : undefined;
  const cleanupErrno = error.cleanupErrno ?? eventCleanupErrno ?? cloneCleanup?.cleanupErrno;
  const published = cloneCleanup === undefined
    ? cleanupErrno === undefined ? false : error.published
    : cloneCleanup.status === 'present' || (cloneCleanup.status === 'unknown' && error.published);
  if (cleanupErrno === undefined && !error.published &&
      (cloneCleanup === undefined || cloneCleanup.status === 'unknown')) throw error;
  throw new OwnedFilesError({
    message: error.message,
    category: error.category,
    operation: error.operation,
    errno: error.errno,
    cleanupErrno,
    published,
    identity: cloneCleanup?.identity ?? error.identity,
    relativePath: error.relativePath,
    sourceRelativePath: error.sourceRelativePath,
    nativeEvents: error.nativeEvents,
    clonePublication: cloneCleanup?.status ?? error.clonePublication,
    diagnostic: error.diagnostic,
    cause: error.causeValue,
  });
}

async function createDirectory(helperPath: string, ownedRoot: Buffer, relativePath: Buffer,
                               signal: AbortSignal | undefined,
                               operation: 'create-run' | 'create-owned-directory'): Promise<FileIdentity> {
  return await withRelativePath(relativePath, async () => {
    try {
      const { result } = await spawnHelper(helperPath, operation, [
        encodePath(ownedRoot, 'owned root', operation),
        encodePath(relativePath, 'owned directory', operation),
      ], undefined, signal);
      return resultIdentity(result, operation);
    } catch (error) {
      return await cleanupAfterFailure(helperPath, ownedRoot, error);
    }
  });
}

export async function createOwnedDirectory(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  signal?: AbortSignal;
}>): Promise<FileIdentity> {
  return await createDirectory(options.helperPath, options.ownedRoot, options.relativePath,
                               options.signal, 'create-owned-directory');
}

export async function createRunDirectory(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  signal?: AbortSignal;
}>): Promise<FileIdentity> {
  return await createDirectory(options.helperPath, options.ownedRoot, options.relativePath,
                               options.signal, 'create-run');
}

async function stageFile(helperPath: string, ownedRoot: Buffer, relativePath: Buffer,
                          contents: Buffer, maxBytes: number, maximumBytes: number,
                          signal: AbortSignal | undefined,
                          operation: 'stage-world-plan' | 'stage-owned-file'): Promise<FileIdentity> {
  return await withRelativePath(relativePath, async () => {
    validateByteLimit(maxBytes, maximumBytes, operation);
    if (contents.length > maxBytes) {
      throw new OwnedFilesError({
        message: 'owned file exceeds its byte limit',
        category: 'too_large',
        operation,
      });
    }
    try {
      const { result } = await spawnHelper(helperPath, operation, [
        encodePath(ownedRoot, 'owned root', operation),
        encodePath(relativePath, 'owned file destination', operation),
        String(maxBytes),
      ], contents, signal);
      return resultIdentity(result, operation);
    } catch (error) {
      return await cleanupAfterFailure(helperPath, ownedRoot, error);
    }
  });
}

export async function stageOwnedFile(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  contents: Buffer;
  maxBytes: number;
  signal?: AbortSignal;
}>): Promise<FileIdentity> {
  const { helperPath, ownedRoot, relativePath, contents, maxBytes, signal } = options;
  return await stageFile(helperPath, ownedRoot, relativePath, contents, maxBytes,
                         MAX_OWNED_FILE_BYTES, signal, 'stage-owned-file');
}

export async function stageWorldPlan(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  destinationRelativePath: Buffer;
  contents: Buffer;
  maxBytes: number;
  signal?: AbortSignal;
}>): Promise<FileIdentity> {
  const { helperPath, ownedRoot, destinationRelativePath, contents, maxBytes, signal } = options;
  return await stageFile(helperPath, ownedRoot, destinationRelativePath, contents, maxBytes,
                         MAX_WORLD_PLAN_BYTES, signal, 'stage-world-plan');
}

export async function cloneOwnedTree(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  sourceRelativePath: Buffer;
  destinationRelativePath: Buffer;
  maxFiles: number;
  maxBytes: number;
  signal?: AbortSignal;
}>): Promise<FileIdentity> {
  const { helperPath, ownedRoot, sourceRelativePath, destinationRelativePath, maxFiles, maxBytes, signal } = options;
  return await withSourceRelativePath(sourceRelativePath, async () =>
    await withRelativePath(destinationRelativePath, async () => {
      if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > MAX_OWNED_TREE_FILES) {
        throw new OwnedFilesError({
          message: `clone-owned-tree file limit must be between zero and ${MAX_OWNED_TREE_FILES}`,
          category: 'invalid_argument',
          operation: 'clone-owned-tree',
          clonePublication: 'absent',
        });
      }
      validateByteLimit(maxBytes, MAX_OWNED_TREE_BYTES, 'clone-owned-tree');
      try {
        const { result } = await spawnHelper(helperPath, 'clone-owned-tree', [
          encodePath(ownedRoot, 'owned root', 'clone-owned-tree'),
          encodePath(sourceRelativePath, 'clone source', 'clone-owned-tree'),
          encodePath(destinationRelativePath, 'clone destination', 'clone-owned-tree'),
          String(maxFiles),
          String(maxBytes),
        ], undefined, signal);
        return resultIdentity(result, 'clone-owned-tree');
      } catch (error) {
        return await cleanupAfterFailure(helperPath, ownedRoot, error, destinationRelativePath);
      }
    }));
}

export async function readOwnedFileWithIdentity(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  maxBytes: number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ contents: Buffer; identity: FileIdentity }>> {
  const { helperPath, ownedRoot, relativePath, maxBytes, signal } = options;
  return await withRelativePath(relativePath, async () => {
    validateByteLimit(maxBytes, MAX_OWNED_READ_BYTES, 'read-owned-file');
    const { result } = await spawnHelper(helperPath, 'read-owned-file', [
      encodePath(ownedRoot, 'owned root', 'read-owned-file'),
      encodePath(relativePath, 'source path', 'read-owned-file'),
      String(maxBytes),
    ], undefined, signal);
    if (typeof result.data !== 'string') {
      throw new OwnedFilesError({
        message: 'native read-owned-file result has no data',
        category: 'protocol_error',
        operation: 'read-owned-file',
      });
    }
    const contents = decodeBase64(result.data, 'native file contents', 'read-owned-file');
    if (contents.length > maxBytes) {
      throw new OwnedFilesError({
        message: 'native read-owned-file exceeded the requested byte limit',
        category: 'protocol_error',
        operation: 'read-owned-file',
      });
    }
    return Object.freeze({ contents, identity: resultIdentity(result, 'read-owned-file') });
  });
}

export async function readOwnedFile(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  maxBytes: number;
  signal?: AbortSignal;
}>): Promise<Buffer> {
  return (await readOwnedFileWithIdentity(options)).contents;
}

function resourceByteCount(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new OwnedFilesError({
      message: `native inspect-owned-resources result has invalid ${field}`,
      category: 'protocol_error',
      operation: 'inspect-owned-resources',
    });
  }
  const byteCount = BigInt(value);
  if (byteCount > (1n << 64n) - 1n) {
    throw new OwnedFilesError({
      message: `native inspect-owned-resources result has invalid ${field}`,
      category: 'protocol_error',
      operation: 'inspect-owned-resources',
    });
  }
  return byteCount;
}

function ownedRunTimestamp(value: unknown, field: string, optional: boolean): bigint | undefined {
  if (optional && value === null) return undefined;
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new OwnedFilesError({
      message: `native list-owned-runs result has invalid ${field}`,
      category: 'protocol_error',
      operation: 'list-owned-runs',
    });
  }
  const timestamp = BigInt(value);
  if (timestamp < -(1n << 63n) || timestamp > (1n << 63n) - 1n) {
    throw new OwnedFilesError({
      message: `native list-owned-runs result has invalid ${field}`,
      category: 'protocol_error',
      operation: 'list-owned-runs',
    });
  }
  return timestamp;
}

function ownedRunSequence(value: unknown): number | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new OwnedFilesError({
      message: 'native list-owned-runs result has invalid terminal_trace_sequence',
      category: 'protocol_error',
      operation: 'list-owned-runs',
    });
  }
  return value;
}

function validateOwnedRunSnapshots(value: unknown): readonly OwnedRunSnapshot[] {
  if (!Array.isArray(value) || value.length > maxOwnedRunListEntries) {
    throw new OwnedFilesError({
      message: 'native list-owned-runs result has an invalid runs array',
      category: 'protocol_error',
      operation: 'list-owned-runs',
    });
  }
  const snapshots: OwnedRunSnapshot[] = [];
  let previousRunId: string | undefined;
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new OwnedFilesError({
        message: 'native list-owned-runs result has an invalid run entry',
        category: 'protocol_error',
        operation: 'list-owned-runs',
      });
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.run_id !== 'string' || !isValidRunId(entry.run_id) ||
        (previousRunId !== undefined && entry.run_id <= previousRunId)) {
      throw new OwnedFilesError({
        message: 'native list-owned-runs result has invalid or unsorted run ids',
        category: 'protocol_error',
        operation: 'list-owned-runs',
      });
    }
    const failureArtifactModifiedTimeNs = ownedRunTimestamp(
      entry.failure_artifact_modified_time_ns, 'failure_artifact_modified_time_ns', true,
    );
    const terminalTraceModifiedTimeNs = ownedRunTimestamp(
      entry.terminal_trace_modified_time_ns, 'terminal_trace_modified_time_ns', true,
    );
    const terminalTraceSequence = ownedRunSequence(entry.terminal_trace_sequence);
    if ((terminalTraceSequence === undefined) !== (terminalTraceModifiedTimeNs === undefined)) {
      throw new OwnedFilesError({
        message: 'native list-owned-runs result has inconsistent terminal trace metadata',
        category: 'protocol_error',
        operation: 'list-owned-runs',
      });
    }
    snapshots.push(Object.freeze({
      runId: entry.run_id,
      identity: identityFrom(entry.device, entry.inode, 'list-owned-runs'),
      modifiedTimeNs: ownedRunTimestamp(entry.modified_time_ns, 'modified_time_ns', false)!,
      ...(failureArtifactModifiedTimeNs === undefined ? {} : { failureArtifactModifiedTimeNs }),
      ...(terminalTraceSequence === undefined ? {} : { terminalTraceSequence }),
      ...(terminalTraceModifiedTimeNs === undefined ? {} : { terminalTraceModifiedTimeNs }),
    }));
    previousRunId = entry.run_id;
  }
  return Object.freeze(snapshots);
}

export async function listOwnedRuns(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  signal?: AbortSignal;
}>): Promise<readonly OwnedRunSnapshot[]> {
  const { helperPath, ownedRoot, signal } = options;
  const { result } = await spawnHelper(helperPath, 'list-owned-runs', [
    encodePath(ownedRoot, 'owned root', 'list-owned-runs'),
  ], undefined, signal);
  return validateOwnedRunSnapshots(result.runs);
}

function invalidOwnedRunRemoval(message: string, runId: string): OwnedFilesError {
  return new OwnedFilesError({
    message,
    category: 'invalid_argument',
    operation: 'remove-owned-run-tree',
    relativePath: Buffer.from(`.work/arena/runs/${runId}`, 'ascii'),
  });
}

function validateRunIdentity(identity: FileIdentity): FileIdentity {
  if (identity === null || typeof identity !== 'object' ||
      typeof identity.device !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(identity.device) ||
      typeof identity.inode !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(identity.inode)) {
    throw invalidOwnedRunRemoval('run removal requires a valid directory identity', '');
  }
  return identityFrom(identity.device, identity.inode, 'remove-owned-run-tree');
}

type OwnedRunLeaseMatch = Readonly<{
  runPath: Buffer;
  identity: FileIdentity;
  provenance: OwnedRunLeaseProvenance;
}>;

function requireOwnedRunLeaseMatch(options: Readonly<{
  ownedRoot: Buffer;
  runId: string;
  identity: FileIdentity;
  lease: OwnedRunLease;
}>): OwnedRunLeaseMatch {
  const { ownedRoot, runId, identity, lease } = options;
  if (!isValidRunId(runId)) throw invalidOwnedRunRemoval('run removal requires a valid run id', runId);
  const expectedIdentity = validateRunIdentity(identity);
  const runPath = Buffer.from(`.work/arena/runs/${runId}`, 'ascii');
  const provenance = ownedRunLeaseProvenance.get(lease);
  if (provenance === undefined || provenance.state !== 'held' ||
      !provenance.ownedRoot.equals(ownedRoot) || !provenance.relativePath.equals(runPath) ||
      provenance.lockIdentity.device !== lease.identity.device ||
      provenance.lockIdentity.inode !== lease.identity.inode ||
      provenance.runDirectoryIdentity.device !== expectedIdentity.device ||
      provenance.runDirectoryIdentity.inode !== expectedIdentity.inode) {
    throw new OwnedFilesError({
      message: 'run operation requires an active lease for the matching owned run directory',
      category: 'conflict',
      operation: 'remove-owned-run-tree',
      relativePath: runPath,
      identity: expectedIdentity,
    });
  }
  return { runPath, identity: expectedIdentity, provenance };
}

export function assertOwnedRunLeaseMatches(options: Readonly<{
  lease: OwnedRunLease;
  ownedRoot: Buffer;
  runId: string;
  identity: FileIdentity;
}>): void {
  requireOwnedRunLeaseMatch(options);
}

export async function removeOwnedRun(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  runId: string;
  identity: FileIdentity;
  lease: OwnedRunLease;
  signal?: AbortSignal;
}>): Promise<void> {
  const { helperPath, ownedRoot, runId, identity, lease, signal } = options;
  const operation: NativeOperation = 'remove-owned-run-tree';
  const match = requireOwnedRunLeaseMatch({ ownedRoot, runId, identity, lease });
  const { identity: expectedIdentity, runPath, provenance } = match;

  const leaseAbort = new AbortController();
  void lease.closed.then(() => leaseAbort.abort());
  const helperSignal = signal === undefined
    ? leaseAbort.signal
    : AbortSignal.any([signal, leaseAbort.signal]);
  provenance.activeOperations++;
  try {
    await spawnHelper(helperPath, operation, [
      encodePath(ownedRoot, 'owned root', operation),
      runId,
      ...nativeIdentityArguments(expectedIdentity),
    ], undefined, helperSignal);
  } finally {
    finishOwnedRunLeaseOperation(provenance);
  }
}

export async function inspectOwnedResources(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  signal?: AbortSignal;
}>): Promise<OwnedResourceSnapshot> {
  const { helperPath, ownedRoot, signal } = options;
  const { result } = await spawnHelper(helperPath, 'inspect-owned-resources', [
    encodePath(ownedRoot, 'owned root', 'inspect-owned-resources'),
  ], undefined, signal);
  if (!Number.isSafeInteger(result.run_count) || (result.run_count as number) < 0) {
    throw new OwnedFilesError({
      message: 'native inspect-owned-resources result has invalid run_count',
      category: 'protocol_error',
      operation: 'inspect-owned-resources',
    });
  }
  return {
    freeBytes: resourceByteCount(result.free_bytes, 'free_bytes'),
    workBytes: resourceByteCount(result.work_bytes, 'work_bytes'),
    dependencyBytes: resourceByteCount(result.dependency_bytes, 'dependency_bytes'),
    runCount: result.run_count as number,
  };
}

export async function removeCreatedFile(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  identity: FileIdentity;
  signal?: AbortSignal;
}>): Promise<void> {
  const { helperPath, ownedRoot, relativePath, identity, signal } = options;
  await withRelativePath(relativePath, async () => {
    await spawnHelper(helperPath, 'unlink-created-file', [
      encodePath(ownedRoot, 'owned root', 'unlink-created-file'),
      encodePath(relativePath, 'created file', 'unlink-created-file'),
      ...nativeIdentityArguments(identity),
    ], undefined, signal);
  });
}

export async function removeCreatedDirectory(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  identity: FileIdentity;
  signal?: AbortSignal;
}>): Promise<void> {
  const { helperPath, ownedRoot, relativePath, identity, signal } = options;
  await withRelativePath(relativePath, async () => {
    await spawnHelper(helperPath, 'unlink-created-directory', [
      encodePath(ownedRoot, 'owned root', 'unlink-created-directory'),
      encodePath(relativePath, 'created directory', 'unlink-created-directory'),
      ...nativeIdentityArguments(identity),
    ], undefined, signal);
  });
}
