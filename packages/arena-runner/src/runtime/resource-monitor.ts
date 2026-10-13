import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { boundedErrorReason, RunnerError } from '../errors.js';

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

export type ResourceMonitorCommandObservation =
  | Readonly<{
    status: 'closed';
    command: 'ps' | 'vm_stat';
    requestedAtNs: bigint;
    spawnedAtNs?: bigint;
    exitedAtNs?: bigint;
    closedAtNs: bigint;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }>
  | Readonly<{
    status: 'timed_out';
    command: 'ps' | 'vm_stat';
    requestedAtNs: bigint;
    spawnedAtNs?: bigint;
    deadlineAtNs: bigint;
    timeoutFiredAtNs: bigint;
    exit?: Readonly<{ atNs: bigint; code: number | null; signal: NodeJS.Signals | null }>;
    close?: Readonly<{ atNs: bigint; code: number | null; signal: NodeJS.Signals | null }>;
  }>
  | Readonly<{
    status: 'spawn_failed';
    command: 'ps' | 'vm_stat';
    requestedAtNs: bigint;
    failedAtNs: bigint;
    reason: string;
  }>
  | Readonly<{
    status: 'reap_timed_out';
    command: 'ps' | 'vm_stat';
    requestedAtNs: bigint;
    spawnedAtNs?: bigint;
    reapDeadlineAtNs: bigint;
    reapTimeoutFiredAtNs: bigint;
    exit?: Readonly<{ atNs: bigint; code: number | null; signal: NodeJS.Signals | null }>;
    timeout?: Readonly<{ deadlineAtNs: bigint; firedAtNs: bigint }>;
  }>;

export interface ResourceMonitorSampleObservation {
  readonly source: 'host' | 'injected_effects';
  readonly sample: RuntimeResourceSample;
  readonly node: Readonly<{
    readonly pid: number;
    rssBytes: number;
    cpuUserMicroseconds: number;
    cpuSystemMicroseconds: number;
  }>;
  readonly java: Readonly<{
    readonly pid: number;
    rssBytes: bigint;
    cpuTime: Readonly<{ status: 'available'; microseconds: bigint }>
      | Readonly<{ status: 'unavailable'; reason: 'injected_effects' | 'unsupported_platform' }>;
  }>;
  readonly timing: Readonly<{
    sampleStartedAtNs: bigint;
    sampleCompletedAtNs: bigint;
    pollTimerDelayNs: bigint | null;
    commands: readonly ResourceMonitorCommandObservation[];
  }>;
}

export type ResourceMonitorSampleEvent =
  | Readonly<{ status: 'sampled'; observation: ResourceMonitorSampleObservation }>
  | Readonly<{
    status: 'failed';
    source: RunnerError;
    timing: Readonly<{
      sampleStartedAtNs: bigint;
      sampleCompletedAtNs: bigint;
      pollTimerDelayNs: bigint | null;
      commands: readonly ResourceMonitorCommandObservation[];
    }>;
  }>;

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
  onSample?: (event: ResourceMonitorSampleEvent) => void;
}>): Promise<OwnedResourceMonitor> {
  if (!Number.isSafeInteger(options.javaPid) || options.javaPid <= 0) {
    throw new RunnerError('invalid_input', 'runtime resource monitor', { kind: 'invalid_process_id' });
  }

  const effects = options.effects ?? hostEffects;
  const source = options.effects === undefined ? 'host' : 'injected_effects';
  const controller = new AbortController();
  const sampleCurrent = (signal: AbortSignal, pollTimerDelayNs: bigint | null): Promise<RuntimeResourceSample> =>
    sampleCurrentWithObservation(options.javaPid, signal, effects, source, options.onSample, pollTimerDelayNs);
  let previous: RuntimeResourceSample;
  try {
    previous = await sampleCurrent(controller.signal, null);
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
      const waitStartedAtNs = process.hrtime.bigint();
      await effects.wait(DEFAULT_INTERVAL_MS, controller.signal);
      if (controller.signal.aborted) return;
      const pollTimerDelayNs = source === 'host'
        ? maxBigInt(0n, process.hrtime.bigint() - waitStartedAtNs - BigInt(DEFAULT_INTERVAL_MS) * 1_000_000n)
        : null;
      let current: RuntimeResourceSample;
      try {
        current = await sampleCurrent(controller.signal, pollTimerDelayNs);
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
  readJavaRssBytes,
  readSwapCounters,
  nodeRssBytes: () => process.memoryUsage().rss,
  availableMemoryBytes: () => process.availableMemory(),
  wait: waitForInterval,
});

async function sampleOwnedResources(
  javaPid: number,
  signal: AbortSignal,
  effects: ResourceMonitorEffects,
  commandObservations?: ResourceMonitorCommandObservation[],
): Promise<CollectedResourceSample> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new RunnerError('missing_prerequisite', 'runtime resource monitor', { kind: 'unsupported_platform' });
  }
  const sampleController = new AbortController();
  const abortSample = (): void => sampleController.abort();
  signal.addEventListener('abort', abortSample, { once: true });
  let javaRssBytes: bigint;
  let javaCpuTime: ResourceMonitorSampleObservation['java']['cpuTime'];
  let swap: Readonly<{ swapIns: bigint; swapOuts: bigint }>;
  const collectHostDiagnostics = commandObservations !== undefined && effects === hostEffects;
  const javaProcess = collectHostDiagnostics
    ? readJavaProcessMetrics(javaPid, sampleController.signal, commandObservations)
    : effects.readJavaRssBytes(javaPid, sampleController.signal).then((rssBytes) => ({
      rssBytes,
      cpuTime: Object.freeze({
        status: 'unavailable',
        reason: commandObservations === undefined ? 'unsupported_platform' : 'injected_effects',
      }) as ResourceMonitorSampleObservation['java']['cpuTime'],
    }));
  const swapCounters = effects === hostEffects
    ? readSwapCounters(sampleController.signal, commandObservations)
    : effects.readSwapCounters(sampleController.signal);
  try {
    const [java, swapSample] = await Promise.all([javaProcess, swapCounters]);
    javaRssBytes = java.rssBytes;
    javaCpuTime = java.cpuTime;
    swap = swapSample;
  } catch (error) {
    sampleController.abort();
    await Promise.allSettled([javaProcess, swapCounters]);
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
    sample: Object.freeze({
      ownedRssBytes: BigInt(nodeRssBytes) + javaRssBytes,
      availableMemoryBytes: BigInt(availableMemoryBytes),
      swapIns: swap.swapIns,
      swapOuts: swap.swapOuts,
    }),
    nodeRssBytes,
    javaRssBytes,
    javaCpuTime,
  });
}

interface CollectedResourceSample {
  readonly sample: RuntimeResourceSample;
  readonly nodeRssBytes: number;
  readonly javaRssBytes: bigint;
  readonly javaCpuTime: ResourceMonitorSampleObservation['java']['cpuTime'];
}

async function sampleCurrentWithObservation(
  javaPid: number,
  signal: AbortSignal,
  effects: ResourceMonitorEffects,
  source: ResourceMonitorSampleObservation['source'],
  onSample: ((event: ResourceMonitorSampleEvent) => void) | undefined,
  pollTimerDelayNs: bigint | null,
): Promise<RuntimeResourceSample> {
  if (onSample === undefined) {
    return (await sampleOwnedResources(javaPid, signal, effects)).sample;
  }

  const sampleStartedAtNs = process.hrtime.bigint();
  const commands: ResourceMonitorCommandObservation[] = [];
  let collected: CollectedResourceSample;
  try {
    collected = await sampleOwnedResources(javaPid, signal, effects, commands);
  } catch (error) {
    const event: ResourceMonitorSampleEvent = Object.freeze({
      status: 'failed',
      source: mapMonitorError(error),
      timing: Object.freeze({
        sampleStartedAtNs,
        sampleCompletedAtNs: process.hrtime.bigint(),
        pollTimerDelayNs,
        commands: Object.freeze([...commands]),
      }),
    });
    notifySample(onSample, event);
    throw error;
  }

  const sampleCompletedAtNs = process.hrtime.bigint();
  const nodeCpu = process.cpuUsage();
  if (!Number.isSafeInteger(nodeCpu.user) || !Number.isSafeInteger(nodeCpu.system)) {
    throw new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_node_cpu_value' });
  }
  const observation: ResourceMonitorSampleObservation = Object.freeze({
    source,
    sample: collected.sample,
    node: Object.freeze({
      pid: process.pid,
      rssBytes: collected.nodeRssBytes,
      cpuUserMicroseconds: nodeCpu.user,
      cpuSystemMicroseconds: nodeCpu.system,
    }),
    java: Object.freeze({
      pid: javaPid,
      rssBytes: collected.javaRssBytes,
      cpuTime: collected.javaCpuTime,
    }),
    timing: Object.freeze({
      sampleStartedAtNs,
      sampleCompletedAtNs,
      pollTimerDelayNs,
      commands: Object.freeze([...commands]),
    }),
  });
  notifySample(onSample, Object.freeze({ status: 'sampled', observation }));
  return collected.sample;
}

function notifySample(onSample: (event: ResourceMonitorSampleEvent) => void, event: ResourceMonitorSampleEvent): void {
  try {
    onSample(event);
  } catch (error) {
    const reason = boundedErrorReason(error);
    throw new RunnerError('runtime_failure', 'runtime resource monitor', {
      kind: 'resource_sample_callback_failed',
      ...(reason === undefined ? {} : { reason }),
    }, { cause: error });
  }
}

async function readJavaRssBytes(javaPid: number, signal: AbortSignal): Promise<bigint> {
  return (await readJavaProcessMetrics(javaPid, signal)).rssBytes;
}

async function readJavaProcessMetrics(
  javaPid: number,
  signal: AbortSignal,
  commandObservations?: ResourceMonitorCommandObservation[],
): Promise<Readonly<{
  rssBytes: bigint;
  cpuTime: ResourceMonitorSampleObservation['java']['cpuTime'];
}>> {
  const includeCpuTime = commandObservations !== undefined && process.platform === 'darwin';
  const output = await runBoundedCommand(
    'ps',
    ['-o', includeCpuTime ? 'rss=,time=' : 'rss=', '-p', String(javaPid)],
    signal,
    commandObservations,
  );
  const value = output.toString('ascii').trim();
  if (includeCpuTime) {
    const match = /^(\d+)\s+(\d+):([0-5]\d)\.(\d{2})$/.exec(value);
    if (match === null) {
      throw new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_process_metrics' });
    }
    const rssBytes = BigInt(match[1]!) * 1_024n;
    const elapsedCentiseconds = (BigInt(match[2]!) * 60n + BigInt(match[3]!)) * 100n + BigInt(match[4]!);
    return Object.freeze({
      rssBytes,
      cpuTime: Object.freeze({ status: 'available', microseconds: elapsedCentiseconds * 10_000n }),
    });
  }
  if (!/^\d+$/.test(value)) {
    throw new RunnerError('runtime_failure', 'runtime resource monitor', { kind: 'invalid_process_rss' });
  }
  return Object.freeze({
    rssBytes: BigInt(value) * 1_024n,
    cpuTime: Object.freeze({
      status: 'unavailable',
      reason: 'unsupported_platform',
    }),
  });
}

async function readSwapCounters(
  signal: AbortSignal,
  commandObservations?: ResourceMonitorCommandObservation[],
): Promise<Readonly<{ swapIns: bigint; swapOuts: bigint }>> {
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
    const output = await runBoundedCommand('vm_stat', [], signal, commandObservations);
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

function runBoundedCommand(
  command: 'ps' | 'vm_stat',
  args: readonly string[],
  signal: AbortSignal,
  observations?: ResourceMonitorCommandObservation[],
): Promise<Buffer> {
  const requestedAtNs = process.hrtime.bigint();
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
      recordCommandObservation(observations, Object.freeze({
        status: 'spawn_failed',
        command,
        requestedAtNs,
        failedAtNs: process.hrtime.bigint(),
        reason: commandError(command, error).source.reason ?? 'spawn_failed',
      }));
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
    let observationRecorded = false;
    let spawnedAtNs: bigint | undefined;
    let spawnFailure: Readonly<{ failedAtNs: bigint; reason: string }> | undefined;
    let exit: Readonly<{ atNs: bigint; code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let timeoutFiredAtNs: bigint | undefined;
    let deadlineAtNs: bigint | undefined;
    let reapDeadlineAtNs: bigint | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      signal.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('spawn', onSpawn);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('data', onData);
      child.stdout?.removeListener('error', onOutputError);
    };
    const fail = (error: RunnerError): void => {
      cleanup();
      reject(error);
    };
    const recordClosed = (code: number | null, closeSignal: NodeJS.Signals | null, closedAtNs: bigint): void => {
      if (observationRecorded) return;
      observationRecorded = true;
      if (timeoutFiredAtNs !== undefined) {
        recordCommandObservation(observations, Object.freeze({
          status: 'timed_out',
          command,
          requestedAtNs,
          ...(spawnedAtNs === undefined ? {} : { spawnedAtNs }),
          deadlineAtNs: deadlineAtNs!,
          timeoutFiredAtNs,
          ...(exit === undefined ? {} : { exit }),
          close: Object.freeze({ atNs: closedAtNs, code, signal: closeSignal }),
        }));
      } else if (spawnFailure !== undefined) {
        recordCommandObservation(observations, Object.freeze({
          status: 'spawn_failed',
          command,
          requestedAtNs,
          failedAtNs: spawnFailure.failedAtNs,
          reason: spawnFailure.reason,
        }));
      } else {
        recordCommandObservation(observations, Object.freeze({
          status: 'closed',
          command,
          requestedAtNs,
          ...(spawnedAtNs === undefined ? {} : { spawnedAtNs }),
          ...(exit === undefined ? {} : { exitedAtNs: exit.atNs }),
          closedAtNs,
          exitCode: code,
          exitSignal: closeSignal,
        }));
      }
    };
    const recordReapTimeout = (firedAtNs: bigint): void => {
      if (observationRecorded) return;
      observationRecorded = true;
      if (spawnFailure !== undefined) {
        recordCommandObservation(observations, Object.freeze({
          status: 'spawn_failed',
          command,
          requestedAtNs,
          failedAtNs: spawnFailure.failedAtNs,
          reason: spawnFailure.reason,
        }));
        return;
      }
      recordCommandObservation(observations, Object.freeze({
        status: 'reap_timed_out',
        command,
        requestedAtNs,
        ...(spawnedAtNs === undefined ? {} : { spawnedAtNs }),
        reapDeadlineAtNs: reapDeadlineAtNs!,
        reapTimeoutFiredAtNs: firedAtNs,
        ...(exit === undefined ? {} : { exit }),
        ...(timeoutFiredAtNs === undefined ? {} : {
          timeout: Object.freeze({ deadlineAtNs: deadlineAtNs!, firedAtNs: timeoutFiredAtNs }),
        }),
      }));
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reapDeadlineAtNs = process.hrtime.bigint() + BigInt(COMMAND_REAP_TIMEOUT_MS) * 1_000_000n;
        reapTimer = setTimeout(() => {
          const firedAtNs = process.hrtime.bigint();
          recordReapTimeout(firedAtNs);
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
      if (spawnedAtNs === undefined) {
        spawnFailure ??= Object.freeze({
          failedAtNs: process.hrtime.bigint(),
          reason: failure.source.reason ?? error.name,
        });
      }
      terminate();
    };
    const onSpawn = (): void => {
      spawnedAtNs = process.hrtime.bigint();
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      exit = Object.freeze({ atNs: process.hrtime.bigint(), code, signal: exitSignal });
    };
    const onOutputError = (error: Error): void => {
      failure ??= new RunnerError('runtime_failure', 'runtime resource monitor', {
        kind: 'resource_command_output_failed',
        field: command,
        reason: error.name,
      });
      terminate();
    };
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      recordClosed(code, closeSignal, process.hrtime.bigint());
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
    child.once('spawn', onSpawn);
    child.once('exit', onExit);
    child.once('error', onError);
    child.once('close', onClose);
    deadlineAtNs = process.hrtime.bigint() + BigInt(COMMAND_TIMEOUT_MS) * 1_000_000n;
    timeout = setTimeout(() => {
      if (failure === undefined) {
        failure = new RunnerError('runtime_failure', 'runtime resource monitor', {
          kind: 'resource_command_timeout',
          field: command,
        });
        timeoutFiredAtNs = process.hrtime.bigint();
      }
      terminate();
    }, COMMAND_TIMEOUT_MS);
  });
}

function recordCommandObservation(
  observations: ResourceMonitorCommandObservation[] | undefined,
  observation: ResourceMonitorCommandObservation,
): void {
  observations?.push(observation);
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

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
