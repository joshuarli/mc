import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunnerError } from '../errors.js';
import type { ActionFunnelTraceRecordV1 } from '../funnel-record.js';
import type { RunNoteRecord } from '../run-note.js';
import type { PolicyEffectRecord, PolicyReplayRecord } from '../policy-replay.js';
import type { ActionFunnelCollector } from '../runtime/funnel.js';
import { BoundedCriticalIngest } from './outbox.js';
import { partitionSeats, workerForSeat } from './assignment.js';
import {
  assertWorkerMessageBound,
  decodeWorkerMessage,
  type SupervisorToWorker,
  type WorkerInit,
  type WorkerSeat,
  type WorkerToSupervisor,
} from './protocol.js';
import { PolicySequenceMap } from './sequence-map.js';

export const WORKER_READY_TIMEOUT_MS = 90_000;
export const WORKER_STOP_TIMEOUT_MS = 10_000;
const CHECKPOINT_INTERVAL = 200;

export interface WorkerChannel {
  send(message: SupervisorToWorker): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: () => void): void;
  terminate(): Promise<void>;
}

export type WorkerLauncher = (worker: number) => WorkerChannel;

export interface CohortTrace {
  recordPolicyDecision(record: PolicyReplayRecord): Promise<void>;
  recordPolicyEffect(record: PolicyEffectRecord): Promise<void>;
  recordActionFunnel(record: ActionFunnelTraceRecordV1): Promise<void>;
  recordRunNote(record: RunNoteRecord): Promise<void>;
  checkpoint(globalObservationCount: number): Promise<void>;
}

export interface WorkerLoss {
  readonly worker: number;
  readonly epoch: number;
  readonly seats: readonly number[];
  readonly reason: string;
}

export type CohortBaseInit = Omit<WorkerInit, 'type' | 'worker' | 'epoch' | 'seats'>;

interface WorkerState {
  readonly worker: number;
  readonly epoch: number;
  readonly seats: readonly WorkerSeat[];
  readonly channel: WorkerChannel;
  ready: boolean;
  stopped: boolean;
  lost: boolean;
  stopRequested: boolean;
  readonly readyWaiters: Array<{ resolve(): void; reject(error: unknown): void }>;
  readonly stoppedWaiters: Array<() => void>;
}

export class WorkerCohort {
  readonly #workerCount: number;
  readonly #seats: readonly WorkerSeat[];
  readonly #launcher: WorkerLauncher;
  readonly #trace: CohortTrace;
  readonly #base: CohortBaseInit;
  readonly #collector: ActionFunnelCollector | undefined;
  readonly #currentTick: () => number | null;
  readonly #states = new Map<number, WorkerState>();
  readonly #losses: WorkerLoss[] = [];
  readonly #sequences = new PolicySequenceMap();
  readonly #diagnostics = new Map<string, number>();
  readonly #ingest: BoundedCriticalIngest<() => Promise<void>>;
  readonly #failureState: Promise<never>;
  #rejectFailure!: (error: unknown) => void;
  #decisionCount = 0;
  #droppedDiagnostics = 0;

  constructor(options: Readonly<{
    workerCount: number;
    seats: readonly WorkerSeat[];
    launcher: WorkerLauncher;
    trace: CohortTrace;
    base: CohortBaseInit;
    collector?: ActionFunnelCollector;
    currentTick(): number | null;
    maxBacklog?: number;
    stallTimeoutMs?: number;
  }>) {
    this.#workerCount = options.workerCount;
    this.#seats = options.seats;
    this.#launcher = options.launcher;
    this.#trace = options.trace;
    this.#base = options.base;
    this.#collector = options.collector;
    this.#currentTick = options.currentTick;
    this.#failureState = new Promise<never>((_resolve, reject) => { this.#rejectFailure = reject; });
    void this.#failureState.catch(() => {});
    this.#ingest = new BoundedCriticalIngest<() => Promise<void>>({
      handler: (task) => task(),
      fail: (error) => this.#rejectFailure(error),
      ...(options.maxBacklog === undefined ? {} : { maxBacklog: options.maxBacklog }),
      ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    });
  }

  get failure(): Promise<never> {
    return this.#failureState;
  }

  get losses(): readonly WorkerLoss[] {
    return Object.freeze([...this.#losses]);
  }

  get diagnostics(): Readonly<Record<string, number>> {
    return Object.freeze({ ...Object.fromEntries(this.#diagnostics), dropped: this.#droppedDiagnostics });
  }

  async start(): Promise<void> {
    const cohorts = partitionSeats(this.#seats.map(({ seat }) => seat), this.#workerCount);
    const assignments: { worker: number; epoch: number; seats: readonly number[] }[] = [];
    const starting: Promise<void>[] = [];
    for (const [worker, seatNumbers] of cohorts.entries()) {
      if (seatNumbers.length === 0) continue;
      const seats = this.#seats.filter(({ seat }) => workerForSeat(seat, this.#workerCount) === worker);
      const channel = this.#launcher(worker);
      const state: WorkerState = {
        worker, epoch: 1, seats, channel, ready: false, stopped: false, lost: false, stopRequested: false,
        readyWaiters: [], stoppedWaiters: [],
      };
      this.#states.set(worker, state);
      assignments.push({ worker, epoch: 1, seats: seatNumbers });
      channel.onMessage((message) => this.#onMessage(state, message));
      channel.onExit(() => this.#onExit(state));
    }
    await this.#trace.recordRunNote({
      schema: 'worker-topology-v1',
      worker_count: this.#workerCount,
      assignments: assignments.map((entry) => ({ worker: entry.worker, epoch: entry.epoch, seats: [...entry.seats] })),
    });
    for (const state of this.#states.values()) {
      const init: WorkerInit = { type: 'init', worker: state.worker, epoch: state.epoch, seats: state.seats, ...this.#base };
      assertWorkerMessageBound(init);
      starting.push(new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RunnerError('runtime_failure', 'worker cohort', {
          kind: 'worker_not_ready', field: String(state.worker),
        })), WORKER_READY_TIMEOUT_MS);
        state.readyWaiters.push({
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        state.channel.send(init);
      }));
    }
    await Promise.all(starting);
  }

  onTick(tick: number): void {
    for (const state of this.#states.values()) {
      if (state.ready && !state.lost && !state.stopRequested) state.channel.send({ type: 'tick', tick });
    }
  }

  async stopAndDrain(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const state of this.#states.values()) {
      if (state.lost || state.stopped) continue;
      state.stopRequested = true;
      waits.push(new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#lose(state, 'worker_stop_timeout');
          resolve();
        }, WORKER_STOP_TIMEOUT_MS);
        state.stoppedWaiters.push(() => { clearTimeout(timer); resolve(); });
        state.channel.send({ type: 'stop' });
      }));
    }
    await Promise.all(waits);
    await this.#ingest.idle();
  }

  async terminate(): Promise<void> {
    await Promise.allSettled([...this.#states.values()].map((state) => state.channel.terminate()));
    this.#ingest.close();
  }

  #onMessage(state: WorkerState, raw: unknown): void {
    let message: WorkerToSupervisor;
    try {
      message = decodeWorkerMessage(raw);
    } catch (error) {
      this.#lose(state, 'invalid_worker_message');
      return;
    }
    if (message.worker !== state.worker || message.epoch !== state.epoch) {
      this.#lose(state, 'worker_identity_mismatch');
      return;
    }
    switch (message.type) {
      case 'ready':
        state.ready = true;
        for (const waiter of state.readyWaiters.splice(0)) waiter.resolve();
        return;
      case 'stopped':
        state.stopped = true;
        for (const waiter of state.stoppedWaiters.splice(0)) waiter();
        return;
      case 'failure':
        this.#lose(state, message.kind);
        return;
      case 'diagnostic':
        for (const [key, count] of Object.entries(message.counters)) {
          this.#diagnostics.set(key, (this.#diagnostics.get(key) ?? 0) + count);
        }
        this.#droppedDiagnostics += message.dropped;
        return;
      case 'critical':
        this.#ingest.push(() => this.#record(state, message));
        return;
    }
  }

  #onExit(state: WorkerState): void {
    if (state.stopped || state.lost) return;
    this.#lose(state, state.stopRequested ? 'worker_exit_before_stop' : 'worker_exit');
  }

  #lose(state: WorkerState, reason: string): void {
    if (state.lost) return;
    state.lost = true;
    for (const waiter of state.readyWaiters.splice(0)) {
      waiter.reject(new RunnerError('runtime_failure', 'worker cohort', { kind: reason, field: String(state.worker) }));
    }
    for (const waiter of state.stoppedWaiters.splice(0)) waiter();
    void state.channel.terminate();
    const loss: WorkerLoss = Object.freeze({
      worker: state.worker, epoch: state.epoch, seats: Object.freeze(state.seats.map(({ seat }) => seat)), reason,
    });
    this.#losses.push(loss);
    this.#ingest.push(() => this.#trace.recordRunNote({
      schema: 'worker-loss-v1',
      worker: loss.worker,
      epoch: loss.epoch,
      seats: [...loss.seats],
      reason,
      tick: this.#currentTick(),
    }));
  }

  async #record(state: WorkerState, message: Extract<WorkerToSupervisor, { type: 'critical' }>): Promise<void> {
    const record = structuredClone(message.record) as Record<string, any>;
    const missing = (): RunnerError => new RunnerError('runtime_failure', 'worker evidence', { kind: 'unmatched_source_sequence' });
    const resolve = (local: unknown): string => {
      const value = typeof local === 'string' ? this.#sequences.resolve(state.worker, state.epoch, local) : undefined;
      if (value === undefined) throw missing();
      return value;
    };
    if (message.kind === 'decision') {
      const global = this.#sequences.assign(state.worker, state.epoch, String(record.sequence));
      record.sequence = global.toString();
      const disposition = record.disposition as Record<string, string> | undefined;
      if (disposition !== undefined) {
        if (disposition.kind === 'start' || disposition.kind === 'replace') {
          disposition.action_sequence = global.toString();
          if (disposition.replaces_action_sequence !== undefined) {
            disposition.replaces_action_sequence = resolve(disposition.replaces_action_sequence);
          }
        } else if (disposition.action_sequence !== undefined) {
          disposition.action_sequence = resolve(disposition.action_sequence);
        }
      }
      await this.#trace.recordPolicyDecision(record as unknown as PolicyReplayRecord);
      this.#collector?.note(record.seat, {
        kind: 'decision', tick: message.source_tick ?? 0, sequence: record.sequence,
        disposition: String(disposition?.kind ?? 'hold'), goal: String(record.decision?.goal?.kind),
        intent: String(record.decision?.intent?.kind), border: 'unknown',
      });
      this.#decisionCount += 1;
      if (this.#decisionCount % CHECKPOINT_INTERVAL === 0) await this.#trace.checkpoint(this.#decisionCount);
    } else if (message.kind === 'diagnostic') {
      await this.#trace.recordRunNote({
        schema: 'client-diagnostic-v1',
        seat: record.seat,
        tick: message.source_tick,
        diagnostic: 'borderUnknown',
        reason: record.reason,
        consecutive_observations: record.consecutive_observations,
      });
    } else if (message.kind === 'effect') {
      record.decision_sequence = resolve(record.decision_sequence);
      await this.#trace.recordPolicyEffect(record as unknown as PolicyEffectRecord);
    } else {
      record.action_sequence = resolve(record.action_sequence);
      record.source = {
        worker: message.worker, epoch: message.epoch, sequence: message.source_sequence, tick: message.source_tick,
      };
      await this.#trace.recordActionFunnel(record as unknown as ActionFunnelTraceRecordV1);
    }
  }
}

export function launchWorkerProcess(): WorkerLauncher {
  const entry = fileURLToPath(new URL('./worker-main.js', import.meta.url));
  return () => {
    const child: ChildProcess = fork(entry, [], {
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      execArgv: process.execArgv,
    });
    return {
      send: (message) => {
        if (!child.connected) return;
        child.send(message);
      },
      onMessage: (listener) => { child.on('message', listener); },
      onExit: (listener) => {
        child.once('exit', listener);
        child.once('disconnect', listener);
      },
      terminate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          child.kill('SIGTERM');
        });
      },
    };
  };
}
