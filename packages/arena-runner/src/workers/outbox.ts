import { RunnerError } from '../errors.js';

export const MAX_CRITICAL_BACKLOG = 4096;
export const CRITICAL_STALL_TIMEOUT_MS = 30_000;
export const MAX_DIAGNOSTIC_KEYS = 64;

export class BoundedCriticalIngest<T> {
  readonly #handler: (item: T) => Promise<void>;
  readonly #maxBacklog: number;
  readonly #stallTimeoutMs: number;
  readonly #fail: (error: RunnerError) => void;
  readonly #queue: T[] = [];
  #running = false;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;
  #idle: Array<() => void> = [];
  #failed = false;

  constructor(options: Readonly<{
    handler(item: T): Promise<void>;
    fail(error: RunnerError): void;
    maxBacklog?: number;
    stallTimeoutMs?: number;
  }>) {
    this.#handler = options.handler;
    this.#fail = options.fail;
    this.#maxBacklog = options.maxBacklog ?? MAX_CRITICAL_BACKLOG;
    this.#stallTimeoutMs = options.stallTimeoutMs ?? CRITICAL_STALL_TIMEOUT_MS;
  }

  get pending(): number {
    return this.#queue.length + (this.#running ? 1 : 0);
  }

  push(item: T): void {
    if (this.#failed) return;
    if (this.#queue.length >= this.#maxBacklog) {
      this.#declare(new RunnerError('runtime_failure', 'worker evidence', { kind: 'critical_backlog_exceeded' }));
      return;
    }
    this.#queue.push(item);
    if (!this.#running) void this.#drain();
  }

  idle(): Promise<void> {
    if (this.#failed || this.pending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#idle.push(resolve); });
  }

  close(): void {
    this.#clearStall();
    this.#failed = true;
    this.#queue.length = 0;
    this.#release();
  }

  async #drain(): Promise<void> {
    this.#running = true;
    try {
      while (this.#queue.length > 0 && !this.#failed) {
        const item = this.#queue.shift()!;
        this.#armStall();
        try {
          await this.#handler(item);
        } catch (error) {
          this.#declare(error instanceof RunnerError ? error
            : new RunnerError('runtime_failure', 'worker evidence', { kind: 'critical_record_rejected' }, { cause: error }));
          return;
        } finally {
          this.#clearStall();
        }
      }
    } finally {
      this.#running = false;
      if (this.pending === 0) this.#release();
    }
  }

  #armStall(): void {
    this.#clearStall();
    this.#stallTimer = setTimeout(() => {
      this.#declare(new RunnerError('runtime_failure', 'worker evidence', { kind: 'critical_writer_stalled' }));
    }, this.#stallTimeoutMs);
  }

  #clearStall(): void {
    if (this.#stallTimer !== undefined) {
      clearTimeout(this.#stallTimer);
      this.#stallTimer = undefined;
    }
  }

  #declare(error: RunnerError): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#clearStall();
    this.#queue.length = 0;
    this.#fail(error);
    this.#release();
  }

  #release(): void {
    const waiters = this.#idle;
    this.#idle = [];
    for (const resolve of waiters) resolve();
  }
}

export class DiagnosticCoalescer {
  readonly #counters = new Map<string, number>();
  #dropped = 0;

  note(key: string): void {
    const existing = this.#counters.get(key);
    if (existing === undefined && this.#counters.size >= MAX_DIAGNOSTIC_KEYS) {
      this.#dropped += 1;
      return;
    }
    this.#counters.set(key, (existing ?? 0) + 1);
  }

  drain(): Readonly<{ counters: Readonly<Record<string, number>>; dropped: number }> | undefined {
    if (this.#counters.size === 0 && this.#dropped === 0) return undefined;
    const counters = Object.freeze(Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => a < b ? -1 : 1)));
    const dropped = this.#dropped;
    this.#counters.clear();
    this.#dropped = 0;
    return Object.freeze({ counters, dropped });
  }
}
