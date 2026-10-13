import { spawn, type ChildProcess } from 'node:child_process';
import { RunnerError } from '../errors.js';

const GRACEFUL_STOP_MS = 15_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_REAP_MS = 4_000;

export interface ServerProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface OwnedServerProcess {
  readonly pid: number;
  readonly exited: Promise<ServerProcessExit>;
  shutdown(): Promise<ServerProcessExit>;
}

export interface StartServerProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
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
      stdio: ['pipe', 'inherit', 'inherit'],
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
  return new SpawnedServerProcess(child);
}

class SpawnedServerProcess implements OwnedServerProcess {
  readonly pid: number;
  readonly exited: Promise<ServerProcessExit>;
  readonly #child: ChildProcess;
  #shutdownPromise: Promise<ServerProcessExit> | undefined;
  #processFailure: Error | undefined;
  #stdinFailure: Error | undefined;

  constructor(child: ChildProcess) {
    if (child.pid === undefined) throw new RunnerError('runtime_failure', 'server process', { kind: 'missing_pid' });
    this.pid = child.pid;
    this.#child = child;
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
      this.#stdinFailure ??= error;
    });
  }

  shutdown(): Promise<ServerProcessExit> {
    this.#shutdownPromise ??= this.#shutdown();
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<ServerProcessExit> {
    if (!isExited(this.#child)) {
      const input = this.#child.stdin;
      if (input !== null && !input.destroyed && input.writable) input.end('stop\n');
      else this.#child.kill('SIGTERM');

      if (await waitForExit(this.exited, GRACEFUL_STOP_MS) === undefined) {
        this.#child.kill('SIGTERM');
        if (await waitForExit(this.exited, TERMINATION_GRACE_MS) === undefined) {
          this.#child.kill('SIGKILL');
          if (await waitForExit(this.exited, FORCE_REAP_MS) === undefined) {
            throw new RunnerError('runtime_failure', 'server process', { kind: 'child_reap_timeout' });
          }
        }
      }
    }

    const exit = await this.exited;
    if (this.#processFailure !== undefined) {
      throw new RunnerError('runtime_failure', 'server process', { kind: 'process_error' });
    }
    if (this.#stdinFailure !== undefined) {
      throw new RunnerError('runtime_failure', 'server process', { kind: 'console_write_failed' });
    }
    return exit;
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
