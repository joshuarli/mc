import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { RunnerError } from '../errors.js';

const MAX_OWNED_RSS_BYTES = 8n * 1024n * 1024n * 1024n;
const MIN_AVAILABLE_MEMORY_BYTES = 4n * 1024n * 1024n * 1024n;
const DEFAULT_INTERVAL_MS = 1_000;
const COMMAND_TIMEOUT_MS = 2_000;
const COMMAND_KILL_GRACE_MS = 1_000;
const COMMAND_REAP_TIMEOUT_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 4_096;
const RESOURCE_FIELDS = Object.freeze({
  ownedRssBytes: 'owned_rss_bytes',
  availableMemoryBytes: 'available_memory_bytes',
  swapIns: 'swap_ins',
  swapOuts: 'swap_outs',
} as const);

export interface RuntimeResourceSample {
  readonly ownedRssBytes: bigint;
  readonly availableMemoryBytes: bigint;
  readonly swapIns: bigint;
  readonly swapOuts: bigint;
}

export interface ResourceMonitorEffects {
  readJavaRssBytes(javaPid: number, signal: AbortSignal): Promise<bigint>;
  readSwapCounters(signal: AbortSignal): Promise<Readonly<{ swapIns: bigint; swapOuts: bigint }>>;
  nodeRssBytes(): number;
  availableMemoryBytes(): number;
  wait(intervalMs: number, signal: AbortSignal): Promise<void>;
}

export interface OwnedResourceMonitor {
  /** Resolves once with the first resource limit or monitoring failure. */
  readonly failure: Promise<RunnerError>;
  /** Stops polling and waits for its current sample to finish. */
  stop(): Promise<void>;
}

/** Monitors the runner and its owned JVM without buffering an unbounded process log. */
export async function startOwnedResourceMonitor(options: Readonly<{
  javaPid: number;
  effects?: ResourceMonitorEffects;
}>): Promise<OwnedResourceMonitor> {
  if (!Number.isSafeInteger(options.javaPid) || options.javaPid <= 0) {
    throw new RunnerError('invalid_input', 'runtime resource monitor', { kind: 'invalid_process_id' });
  }

  const effects = options.effects ?? hostEffects;
  const controller = new AbortController();
  const sampleCurrent = (signal: AbortSignal): Promise<RuntimeResourceSample> =>
    sampleOwnedResources(options.javaPid, signal, effects);
  let previous: RuntimeResourceSample;
  try {
    previous = await sampleCurrent(controller.signal);
  } catch (error) {
    throw mapMonitorError(error);
  }
  const initialFailure = resourceLimit(previous);
  if (initialFailure !== undefined) throw initialFailure;

  let resolveFailure!: (error: RunnerError) => void;
  const failure = new Promise<RunnerError>((resolve) => { resolveFailure = resolve; });
  let completed = false;
  const publishFailure = (error: RunnerError): void => {
    if (completed) return;
    completed = true;
    resolveFailure(error);
    controller.abort();
  };

  const loop = (async (): Promise<void> => {
    while (!controller.signal.aborted) {
      await effects.wait(DEFAULT_INTERVAL_MS, controller.signal);
      if (controller.signal.aborted) return;
      let current: RuntimeResourceSample;
      try {
        current = await sampleCurrent(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) publishFailure(mapMonitorError(error));
        return;
      }
      const violation = resourceLimit(current, previous);
      if (violation !== undefined) {
        publishFailure(violation);
        return;
      }
      previous = current;
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) publishFailure(mapMonitorError(error));
  });

  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    failure,
    stop: () => {
      stopPromise ??= (async () => {
        controller.abort();
        await loop;
      })();
      return stopPromise;
    },
  });
}

function resourceLimit(
  current: RuntimeResourceSample,
  previous?: RuntimeResourceSample,
): RunnerError | undefined {
  if (current.ownedRssBytes < 0n || current.availableMemoryBytes < 0n
      || current.swapIns < 0n || current.swapOuts < 0n) {
    return new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_resource_sample' });
  }
  if (current.ownedRssBytes > MAX_OWNED_RSS_BYTES) {
    return new RunnerError('runtime_failure', 'runtime memory', {
      kind: 'owned_rss_limit_exceeded',
      field: RESOURCE_FIELDS.ownedRssBytes,
    });
  }
  if (current.availableMemoryBytes < MIN_AVAILABLE_MEMORY_BYTES) {
    return new RunnerError('runtime_failure', 'process memory availability', {
      kind: 'available_memory_limit_exceeded',
      field: RESOURCE_FIELDS.availableMemoryBytes,
    });
  }
  if (previous !== undefined
      && (current.swapIns > previous.swapIns || current.swapOuts > previous.swapOuts)) {
    return new RunnerError('runtime_failure', 'system memory', {
      kind: 'system_swapping_detected',
      field: current.swapIns > previous.swapIns ? RESOURCE_FIELDS.swapIns : RESOURCE_FIELDS.swapOuts,
    });
  }
  return undefined;
}

const hostEffects: ResourceMonitorEffects = Object.freeze({
  readJavaRssBytes: readProcessRss,
  readSwapCounters,
  nodeRssBytes: () => process.memoryUsage().rss,
  availableMemoryBytes: () => process.availableMemory(),
  wait: waitForInterval,
});

async function sampleOwnedResources(
  javaPid: number,
  signal: AbortSignal,
  effects: ResourceMonitorEffects,
): Promise<RuntimeResourceSample> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new RunnerError('missing_prerequisite', 'runtime resource monitor', { kind: 'unsupported_platform' });
  }
  const sampleController = new AbortController();
  const abortSample = (): void => sampleController.abort();
  signal.addEventListener('abort', abortSample, { once: true });
  let javaRssBytes: bigint;
  let swap: Readonly<{ swapIns: bigint; swapOuts: bigint }>;
  const javaRss = effects.readJavaRssBytes(javaPid, sampleController.signal);
  const swapCounters = effects.readSwapCounters(sampleController.signal);
  try {
    [javaRssBytes, swap] = await Promise.all([javaRss, swapCounters]);
  } catch (error) {
    sampleController.abort();
    await Promise.allSettled([javaRss, swapCounters]);
    throw error;
  } finally {
    signal.removeEventListener('abort', abortSample);
  }
  const nodeRssBytes = effects.nodeRssBytes();
  const availableMemoryBytes = effects.availableMemoryBytes();
  if (!Number.isSafeInteger(nodeRssBytes) || !Number.isSafeInteger(availableMemoryBytes)) {
    throw new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_host_memory_value' });
  }
  return Object.freeze({
    ownedRssBytes: BigInt(nodeRssBytes) + javaRssBytes,
    availableMemoryBytes: BigInt(availableMemoryBytes),
    swapIns: swap.swapIns,
    swapOuts: swap.swapOuts,
  });
}

async function readProcessRss(javaPid: number, signal: AbortSignal): Promise<bigint> {
  const output = await runBoundedCommand('ps', ['-o', 'rss=', '-p', String(javaPid)], signal);
  const value = output.toString('ascii').trim();
  if (!/^\d+$/.test(value)) {
    throw new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_process_rss' });
  }
  return BigInt(value) * 1_024n;
}

async function readSwapCounters(signal: AbortSignal): Promise<Readonly<{ swapIns: bigint; swapOuts: bigint }>> {
  if (process.platform === 'linux') {
    let contents: string;
    try {
      contents = await readFile('/proc/vmstat', { encoding: 'utf8', signal });
    } catch (error) {
      throw new RunnerError('missing_prerequisite', 'runtime resource monitor', {
        kind: 'swap_counters_unavailable',
        field: '/proc/vmstat',
        ...(signal.aborted ? {} : errorCode(error)),
      });
    }
    const values = new Map<string, bigint>();
    for (const line of contents.split('\n')) {
      const match = /^(pswpin|pswpout)\s+(\d+)$/.exec(line);
      if (match !== null) values.set(match[1]!, BigInt(match[2]!));
    }
    const swapIns = values.get('pswpin');
    const swapOuts = values.get('pswpout');
    if (swapIns === undefined || swapOuts === undefined) {
      throw new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_swap_counters' });
    }
    return Object.freeze({ swapIns, swapOuts });
  }

  if (process.platform === 'darwin') {
    const output = await runBoundedCommand('vm_stat', [], signal);
    const swapIns = parseMacSwapCounter(output, 'Swapins');
    const swapOuts = parseMacSwapCounter(output, 'Swapouts');
    return Object.freeze({ swapIns, swapOuts });
  }
  throw new RunnerError('missing_prerequisite', 'runtime resource monitor', { kind: 'unsupported_platform' });
}

function parseMacSwapCounter(output: Buffer, name: 'Swapins' | 'Swapouts'): bigint {
  const match = new RegExp(`^${name}:\\s*(\\d+)\\.?$`, 'm').exec(output.toString('ascii'));
  if (match === null) {
    throw new RunnerError('runtime_failure', 'runtime resource monitor', {
      kind: 'invalid_swap_counters',
      field: name,
    });
  }
  return BigInt(match[1]!);
}

function runBoundedCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) {
    return Promise.reject(new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'cancelled' }));
  }
  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      reject(commandError(command, error));
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: RunnerError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminating = false;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      signal.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('data', onData);
      child.stdout?.removeListener('error', onOutputError);
    };
    const fail = (error: RunnerError): void => {
      cleanup();
      reject(error);
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reapTimer = setTimeout(() => {
          fail(failure ?? new RunnerError('runtime_failure', 'runtime resource monitor', {
            kind: 'resource_command_reap_timeout',
            field: command,
          }));
        }, COMMAND_REAP_TIMEOUT_MS);
      }, COMMAND_KILL_GRACE_MS);
    };
    const onAbort = (): void => {
      failure ??= new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'cancelled' });
      terminate();
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        failure ??= new RunnerError('runtime_failure', 'runtime resource monitor', {
          kind: 'resource_command_output_limit',
          field: command,
        });
        terminate();
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onError = (error: Error): void => {
      failure ??= commandError(command, error);
      terminate();
    };
    const onOutputError = (error: Error): void => {
      failure ??= new RunnerError('runtime_failure', 'runtime resource monitor', {
        kind: 'resource_command_output_failed',
        field: command,
        reason: error.name,
      });
      terminate();
    };
    const onClose = (code: number | null): void => {
      if (failure !== undefined) {
        fail(failure);
      } else if (code !== 0) {
        fail(new RunnerError('runtime_failure', 'runtime resource monitor', {
          kind: 'resource_command_failed',
          field: command,
          ...(code === null ? {} : { os_code: code }),
        }));
      } else {
        cleanup();
        resolve(Buffer.concat(chunks, bytes));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', onData);
    child.stdout?.on('error', onOutputError);
    child.once('error', onError);
    child.once('close', onClose);
    timeout = setTimeout(() => {
      failure ??= new RunnerError('runtime_failure', 'runtime resource monitor', {
        kind: 'resource_command_timeout',
        field: command,
      });
      terminate();
    }, COMMAND_TIMEOUT_MS);
  });
}

function commandError(command: string, error: unknown): RunnerError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  return new RunnerError('missing_prerequisite', 'runtime resource monitor', {
    kind: 'resource_command_unavailable',
    field: command,
    ...(code === undefined ? {} : { reason: code }),
  });
}

function errorCode(error: unknown): Readonly<{ reason: string }> {
  return Object.freeze({ reason: error instanceof Error ? error.name : 'unknown' });
}

function mapMonitorError(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  return new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'resource_sample_failed' });
}

function waitForInterval(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
