import { spawn } from 'node:child_process';
import { consumeRawArgv, RawArgvError } from './raw-argv.js';

export const MAX_WORLD_PLAN_BYTES = 128 * 1024 * 1024;
export const MAX_OWNED_READ_BYTES = 16 * 1024 * 1024;

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

type NativeOperation =
  | 'create-run'
  | 'stage-world-plan'
  | 'read-owned-file'
  | 'unlink-created-file'
  | 'unlink-created-directory';

type NativeEvent = Readonly<{
  event: 'created-directory' | 'staged-file';
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

export class OwnedFilesError extends Error {
  readonly category: NativeErrorCategory;
  readonly operation: NativeOperation;
  readonly errno?: number;
  readonly cleanupErrno?: number;
  readonly published: boolean;
  readonly identity?: FileIdentity;
  readonly relativePath?: Buffer;
  readonly nativeEvents: readonly NativeEvent[];
  readonly diagnostic?: string;
  readonly causeValue?: unknown;

  constructor(details: {
    message: string;
    category: NativeErrorCategory;
    operation: NativeOperation;
    errno?: number;
    cleanupErrno?: number;
    published?: boolean;
    identity?: FileIdentity;
    relativePath?: Buffer;
    nativeEvents?: readonly NativeEvent[];
    diagnostic?: string;
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
    this.nativeEvents = details.nativeEvents ?? [];
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
      nativeEvents: error.nativeEvents,
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
  if (operation !== 'stage-world-plan') return;
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
  if (record.event === 'created-directory' || record.event === 'staged-file') {
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
        reject(new OwnedFilesError({
          message: `${operation} was cancelled`,
          category: 'cancelled',
          operation,
          nativeEvents: events,
          diagnostic: diagnostic || undefined,
        }));
        return;
      }
      if (spawnError !== undefined) {
        reject(new OwnedFilesError({
          message: `could not start native helper for ${operation}`,
          category: 'helper_start',
          operation,
          diagnostic: diagnostic || undefined,
          cause: spawnError,
        }));
        return;
      }
      if (outputOverflow || diagnosticOverflow) {
        let events: NativeEvent[] = [];
        try {
          const parsed = parseOutput(Buffer.concat(stdout), operation);
          events = parsed.events;
          includePublishedStage(events, operation, arguments_, parsed.result);
        } catch (error) {
          if (error instanceof OwnedFilesError) events = [...error.nativeEvents];
        }
        includePublishedStage(events, operation, arguments_, undefined);
        reject(new OwnedFilesError({
          message: 'native helper exceeded its output limit',
          category: 'protocol_error',
          operation,
          nativeEvents: events,
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
          reject(new OwnedFilesError({
            message: error.message,
            category: error.category,
            operation: error.operation,
            errno: error.errno,
            cleanupErrno: error.cleanupErrno,
            published: error.published,
            identity: error.identity,
            nativeEvents: events,
            diagnostic: error.diagnostic,
            cause: error.causeValue,
          }));
        } else {
          reject(error);
        }
        return;
      }
      includePublishedStage(parsed.events, operation, arguments_, parsed.result);
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

function validateByteLimit(limit: number, maximum: number, operation: NativeOperation): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new OwnedFilesError({
      message: `${operation} byte limit must be between zero and ${maximum}`,
      category: 'invalid_argument',
      operation,
    });
  }
}

function resultIdentity(result: NativeSuccess, operation: NativeOperation): FileIdentity {
  return identityFrom(result.device, result.inode, operation);
}

function nativeIdentityArguments(identity: FileIdentity): string[] {
  return [identity.device, identity.inode];
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

async function cleanupAfterFailure(helperPath: string, root: Buffer, error: unknown): Promise<never> {
  if (!(error instanceof OwnedFilesError) || error.nativeEvents.length === 0) throw error;
  const cleanupErrno = await cleanupEvents(helperPath, root, error.nativeEvents);
  if (cleanupErrno === undefined) {
    if (error.cleanupErrno === undefined && !error.published) throw error;
    throw new OwnedFilesError({
      message: error.message,
      category: error.category,
      operation: error.operation,
      errno: error.errno,
      published: false,
      identity: error.identity,
      nativeEvents: error.nativeEvents,
      diagnostic: error.diagnostic,
      cause: error.causeValue,
    });
  }
  throw new OwnedFilesError({
    message: error.message,
    category: error.category,
    operation: error.operation,
    errno: error.errno,
    cleanupErrno: error.cleanupErrno ?? cleanupErrno,
    published: error.published,
    identity: error.identity,
    nativeEvents: error.nativeEvents,
    diagnostic: error.diagnostic,
    cause: error.causeValue,
  });
}

export async function createRunDirectory(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  signal?: AbortSignal;
}>): Promise<FileIdentity> {
  const { helperPath, ownedRoot, relativePath, signal } = options;
  return await withRelativePath(relativePath, async () => {
    try {
      const { result } = await spawnHelper(helperPath, 'create-run', [
        encodePath(ownedRoot, 'owned root', 'create-run'),
        encodePath(relativePath, 'run directory', 'create-run'),
      ], undefined, signal);
      return resultIdentity(result, 'create-run');
    } catch (error) {
      return await cleanupAfterFailure(helperPath, ownedRoot, error);
    }
  });
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
  return await withRelativePath(destinationRelativePath, async () => {
    validateByteLimit(maxBytes, MAX_WORLD_PLAN_BYTES, 'stage-world-plan');
    if (contents.length > maxBytes) {
      throw new OwnedFilesError({
        message: 'world plan exceeds its byte limit',
        category: 'too_large',
        operation: 'stage-world-plan',
      });
    }
    try {
      const { result } = await spawnHelper(helperPath, 'stage-world-plan', [
        encodePath(ownedRoot, 'owned root', 'stage-world-plan'),
        encodePath(destinationRelativePath, 'world plan destination', 'stage-world-plan'),
        String(maxBytes),
      ], contents, signal);
      return resultIdentity(result, 'stage-world-plan');
    } catch (error) {
      return await cleanupAfterFailure(helperPath, ownedRoot, error);
    }
  });
}

export async function readOwnedFile(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  relativePath: Buffer;
  maxBytes: number;
  signal?: AbortSignal;
}>): Promise<Buffer> {
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
    return contents;
  });
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
