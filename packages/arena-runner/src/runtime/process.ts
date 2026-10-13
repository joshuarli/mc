import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { RunnerError } from '../errors.js';

const GRACEFUL_STOP_MS = 15_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_REAP_MS = 4_000;
const PAPER_BIND_ERROR_MARKER = 'failed to bind to port';
const MAX_PARTIAL_OUTPUT_LINE_BYTES = 4_096;

export interface ServerProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface OwnedServerProcess {
  readonly pid: number;
  readonly exited: Promise<ServerProcessExit>;
  readonly fatalOutputError: Promise<RunnerError>;
  shutdown(): Promise<ServerProcessExit>;
}

export interface StartServerProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly output?: Readonly<{
    stdout?: Writable;
    stderr?: Writable;
  }>;
}

/** Starts one child without a shell and keeps ownership until its exit is observed. */
export async function startOwnedServerProcess(
  options: StartServerProcessOptions,
): Promise<OwnedServerProcess> {
  if (options.signal?.aborted) {
    throw new RunnerError('runtime_failure', 'server process', { kind: 'cancelled' });
  }

  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw mapSpawnError(error);
  }

  let startFailure: unknown;
  const started = new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      startFailure = error;
      child.removeListener('spawn', onSpawn);
      reject(mapSpawnError(error));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });

  const onAbort = (): void => {
    child.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await started;
  } catch (error) {
    if (options.signal?.aborted) {
      child.kill('SIGKILL');
      if (!await waitForChildClose(child, FORCE_REAP_MS)) {
        throw new RunnerError('runtime_failure', 'server process', { kind: 'child_reap_timeout' });
      }
      throw new RunnerError('runtime_failure', 'server process', { kind: 'cancelled' });
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (startFailure !== undefined) throw mapSpawnError(startFailure);
  if (child.stdout === null || child.stderr === null) {
    child.kill('SIGKILL');
    if (!await waitForChildClose(child, FORCE_REAP_MS)) {
      throw new RunnerError('runtime_failure', 'server process', { kind: 'child_reap_timeout' });
    }
    throw new RunnerError('runtime_failure', 'server process', { kind: 'missing_child_output_stream' });
  }
  return new SpawnedServerProcess(
    child,
    options.output?.stdout ?? process.stdout,
    options.output?.stderr ?? process.stderr,
  );
}

class SpawnedServerProcess implements OwnedServerProcess {
  readonly pid: number;
  readonly exited: Promise<ServerProcessExit>;
  readonly fatalOutputError: Promise<RunnerError>;
  readonly #child: ChildProcess;
  readonly #outputBindings: readonly OutputBinding[];
  readonly #resolveFatalOutputError: (error: RunnerError) => void;
  #shutdownPromise: Promise<ServerProcessExit> | undefined;
  #processFailure: Error | undefined;
  #stdinFailure: Error | undefined;
  #stdinFailureDuringStopWrite = false;
  #shutdownStopWriteAttempted = false;
  #ownerRequestedTermination = false;
  #fatalOutputFailure: RunnerError | undefined;

  constructor(child: ChildProcess, stdout: Writable, stderr: Writable) {
    if (child.pid === undefined) throw new RunnerError('runtime_failure', 'server process', { kind: 'missing_pid' });
    this.pid = child.pid;
    this.#child = child;
    let resolveFatalOutputError!: (error: RunnerError) => void;
    this.fatalOutputError = new Promise<RunnerError>((resolve) => {
      resolveFatalOutputError = resolve;
    });
    this.#resolveFatalOutputError = resolveFatalOutputError;
    this.exited = new Promise<ServerProcessExit>((resolve) => {
      child.once('close', (code, signal) => {
        resolve(Object.freeze({
          code,
          signal: signal === null ? null : signal as NodeJS.Signals,
        }));
      });
    });
    child.on('error', (error) => {
      this.#processFailure ??= error;
    });
    child.stdin?.on('error', (error) => {
      if (this.#stdinFailure !== undefined) return;
      this.#stdinFailure = error;
      this.#stdinFailureDuringStopWrite = this.#shutdownStopWriteAttempted;
    });
    const bindFailure = (): void => {
      this.#recordOutputFailure(new RunnerError('owner_conflict', 'Paper server port', {
        kind: 'paper_port_bind_failed',
        field: '25565',
      }));
    };
    this.#outputBindings = Object.freeze([
      bindOutput(child.stdout!, stdout, bindFailure, (error) => this.#recordRelayFailure(error)),
      bindOutput(child.stderr!, stderr, bindFailure, (error) => this.#recordRelayFailure(error)),
    ]);
    child.once('close', () => this.#detachOutput());
  }

  shutdown(): Promise<ServerProcessExit> {
    this.#shutdownPromise ??= this.#shutdown();
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<ServerProcessExit> {
    if (!isExited(this.#child)) {
      const input = this.#child.stdin;
      if (input !== null && !input.destroyed && input.writable) {
        this.#shutdownStopWriteAttempted = true;
        input.end('stop\n');
      } else {
        this.#requestTermination('SIGTERM');
      }

      if (await waitForExit(this.exited, GRACEFUL_STOP_MS) === undefined) {
        this.#requestTermination('SIGTERM');
        if (await waitForExit(this.exited, TERMINATION_GRACE_MS) === undefined) {
          this.#requestTermination('SIGKILL');
          if (await waitForExit(this.exited, FORCE_REAP_MS) === undefined) {
            throw new RunnerError('runtime_failure', 'server process', { kind: 'child_reap_timeout' });
          }
        }
      }
    }

    const exit = await this.exited;
    if (this.#fatalOutputFailure !== undefined) throw this.#fatalOutputFailure;
    if (this.#processFailure !== undefined) {
      throw new RunnerError('runtime_failure', 'server process', { kind: 'process_error' });
    }
    if (this.#stdinFailure !== undefined && !this.#isExpectedStopWriteEpipe(this.#stdinFailure, exit)) {
      throw new RunnerError('runtime_failure', 'server process', { kind: 'console_write_failed' });
    }
    return exit;
  }

  #isExpectedStopWriteEpipe(error: Error, exit: ServerProcessExit): boolean {
    // A signal-exited child can close its input before Node delivers the exit event.
    return this.#stdinFailureDuringStopWrite
      && isBrokenPipe(error)
      && exit.signal !== null
      && !this.#ownerRequestedTermination;
  }

  #requestTermination(signal: NodeJS.Signals): void {
    this.#ownerRequestedTermination = true;
    this.#child.kill(signal);
  }

  #recordRelayFailure(error: Error): void {
    this.#recordOutputFailure(new RunnerError('runtime_failure', 'server output', {
      kind: 'output_relay_failed',
      reason: error.name,
    }));
  }

  #recordOutputFailure(error: RunnerError): void {
    if (this.#fatalOutputFailure !== undefined) return;
    this.#fatalOutputFailure = error;
    this.#resolveFatalOutputError(error);
    this.#requestTermination('SIGTERM');
  }

  #detachOutput(): void {
    for (const binding of this.#outputBindings) binding.close();
  }
}

function isBrokenPipe(error: Error): boolean {
  return 'code' in error && error.code === 'EPIPE';
}

interface OutputBinding {
  close(): void;
}

function bindOutput(
  source: Readable,
  destination: Writable,
  onPaperBindFailure: () => void,
  onRelayFailure: (error: Error) => void,
): OutputBinding {
  const observer = new PaperBindLineObserver(onPaperBindFailure);
  const onData = (chunk: Buffer): void => observer.observe(chunk);
  const onSourceError = (error: Error): void => onRelayFailure(error);
  const onDestinationError = (error: Error): void => {
    source.unpipe(destination);
    source.resume();
    onRelayFailure(error);
  };
  source.on('data', onData);
  source.on('error', onSourceError);
  destination.on('error', onDestinationError);
  source.pipe(destination, { end: false });
  return Object.freeze({
    close: () => {
      source.removeListener('data', onData);
      source.removeListener('error', onSourceError);
      destination.removeListener('error', onDestinationError);
      source.unpipe(destination);
    },
  });
}

class PaperBindLineObserver {
  readonly #onFailure: () => void;
  #partialLine = '';
  #found = false;

  constructor(onFailure: () => void) {
    this.#onFailure = onFailure;
  }

  observe(chunk: Buffer): void {
    if (this.#found) return;
    const lines = `${this.#partialLine}${chunk.toString('latin1')}`.split('\n');
    for (const line of lines) {
      if (line.replace(/\r$/, '').toLowerCase().includes(PAPER_BIND_ERROR_MARKER)) {
        this.#found = true;
        this.#onFailure();
        return;
      }
    }
    this.#partialLine = (lines.at(-1) ?? '').slice(-MAX_PARTIAL_OUTPUT_LINE_BYTES);
  }
}

function waitForExit(exit: Promise<ServerProcessExit>, timeoutMs: number): Promise<ServerProcessExit | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void exit.then((status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    child.once('close', onClose);
  });
}

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function mapSpawnError(error: unknown): RunnerError {
  const failure = error instanceof Error && 'code' in error ? error as NodeJS.ErrnoException : undefined;
  const category = failure?.code === 'ENOENT' || failure?.code === 'EACCES'
    ? 'missing_prerequisite'
    : 'runtime_failure';
  return new RunnerError(category, 'server process', {
    kind: 'spawn_failed',
    ...(typeof failure?.errno === 'number' ? { os_code: failure.errno } : {}),
  });
}
