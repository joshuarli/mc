import { compilePolicy } from '@arena/spec';
import type { OpeningStyleCycle } from '@arena/spec';
import { RunnerError } from '../errors.js';
import { LivePolicyLoop, type PolicyActivityEvent } from '../runtime/live-policy-loop.js';
import { ActionFunnelCollector } from '../runtime/funnel.js';
import { RuntimeCompetitorClient, type RuntimeClientOptions } from '../runtime/clients.js';
import type { PlayerIdentity } from '../runtime/observations.js';
import { DiagnosticCoalescer } from './outbox.js';
import {
  assertWorkerMessageBound,
  type CriticalKind,
  type SupervisorToWorker,
  type WorkerInit,
  type WorkerToSupervisor,
} from './protocol.js';

const DIAGNOSTIC_FLUSH_TICKS = 200;

export type WorkerCompetitor = Pick<RuntimeCompetitorClient, 'seat' | 'gameplay' | 'bot' | 'connect' | 'close' | 'failure'>;

export type WorkerCompetitorFactory = (
  seat: number,
  identity: PlayerIdentity,
  options: RuntimeClientOptions,
) => WorkerCompetitor;

export class WorkerRuntime {
  readonly #send: (message: WorkerToSupervisor) => Promise<void>;
  readonly #createCompetitor: WorkerCompetitorFactory;
  readonly #diagnostics = new DiagnosticCoalescer();
  readonly #abort = new AbortController();
  #init: WorkerInit | undefined;
  #loop: LivePolicyLoop | undefined;
  #competitors: readonly WorkerCompetitor[] = [];
  #sourceSequence = 0;
  #sourceTick: number | null = null;
  #lastDiagnosticTick = 0;
  #stopped = false;

  constructor(options: Readonly<{
    send(message: WorkerToSupervisor): Promise<void>;
    createCompetitor?: WorkerCompetitorFactory;
  }>) {
    this.#send = options.send;
    this.#createCompetitor = options.createCompetitor
      ?? ((seat, identity, clientOptions) => new RuntimeCompetitorClient(seat, identity, clientOptions));
  }

  async handle(message: SupervisorToWorker): Promise<void> {
    switch (message.type) {
      case 'init': return await this.#start(message);
      case 'tick': return this.#tick(message.tick);
      case 'stop': return await this.#stop();
    }
  }

  async #start(init: WorkerInit): Promise<void> {
    if (this.#init !== undefined) throw new RunnerError('runtime_failure', 'worker', { kind: 'worker_already_initialized' });
    this.#init = init;
    const policy = compilePolicy(init.policy_source);
    const collector = new ActionFunnelCollector(new Map(init.roster.map((entry) => [entry.username, entry.seat])));
    collector.onDiagnostic = (seat, record) => {
      void this.#critical('diagnostic', { seat, kind: record.kind, reason: record.reason,
        consecutive_observations: record.consecutiveObservations }).catch((error: unknown) => this.#fail(error));
    };
    const clientOptionsFor = (seat: number): RuntimeClientOptions => ({
      host: init.host,
      port: init.port,
      scenario: { mode: 'hunger_games', server: {
        minecraft: init.minecraft,
        viewDistanceChunks: init.view_distance_chunks,
        simulationDistanceChunks: init.view_distance_chunks,
        maxTickRate: 20,
      } },
      signal: this.#abort.signal,
      publicRoster: [],
      funnel: collector.sink(seat),
      diagnostic: collector.diagnosticSink(seat),
    });
    this.#competitors = init.seats.map((entry) => this.#createCompetitor(
      entry.seat,
      { username: entry.username, offlineUuid: entry.offline_uuid },
      clientOptionsFor(entry.seat),
    ));
    await Promise.all(this.#competitors.map((competitor) => competitor.connect()));
    const connectionFailure = this.#competitors.map((competitor) => competitor.failure()).find((value) => value !== undefined);
    if (connectionFailure !== undefined) throw connectionFailure;

    const trace = {
      recordPolicyDecision: (record: unknown) => this.#critical('decision', record),
      recordPolicyEffect: (record: unknown) => this.#critical('effect', record),
      recordActionFunnel: (record: unknown) => this.#critical('funnel', record),
      checkpoint: async () => undefined,
    };
    const cycle: OpeningStyleCycle | undefined = init.opening_style_cycle === null
      ? undefined
      : init.opening_style_cycle as unknown as OpeningStyleCycle;
    this.#loop = new LivePolicyLoop({
      trace: trace as never,
      params: policy.params,
      seed: BigInt(init.seed),
      ...(cycle === undefined ? {} : { openingStyleCycle: cycle }),
      strategyIntervalTicks: BigInt(init.strategy_interval_ticks),
      recordPolicy: init.record_policy,
      funnel: collector,
      competitors: () => this.#competitors,
      fail: (error) => { void this.#fail(error); },
      onActivity: (event) => this.#activity(event),
    });
    await this.#send({ type: 'ready', worker: init.worker, epoch: init.epoch });
  }

  #tick(tick: number): void {
    if (this.#loop === undefined || this.#stopped) return;
    this.#sourceTick = tick;
    this.#loop.onTick(tick);
    if (tick - this.#lastDiagnosticTick >= DIAGNOSTIC_FLUSH_TICKS) {
      this.#lastDiagnosticTick = tick;
      void this.#flushDiagnostics();
    }
  }

  async #stop(): Promise<void> {
    if (this.#stopped || this.#init === undefined) return;
    this.#stopped = true;
    this.#abort.abort();
    this.#loop?.stopLaunching();
    await this.#loop?.stopAndJoin();
    await Promise.allSettled(this.#competitors.map((competitor) => competitor.close()));
    await this.#flushDiagnostics();
    await this.#send({ type: 'stopped', worker: this.#init.worker, epoch: this.#init.epoch });
  }

  async #fail(error: unknown): Promise<void> {
    if (this.#init === undefined || this.#stopped) return;
    this.#stopped = true;
    const kind = error instanceof RunnerError ? error.source.kind : 'worker_runtime_failure';
    await this.#send({ type: 'failure', worker: this.#init.worker, epoch: this.#init.epoch, kind: kind.slice(0, 64) });
  }

  #activity(event: PolicyActivityEvent): void {
    this.#diagnostics.note(event.kind === 'decision' ? `decision.${event.disposition.kind}` : event.kind);
  }

  async #flushDiagnostics(): Promise<void> {
    const drained = this.#diagnostics.drain();
    if (drained === undefined || this.#init === undefined) return;
    await this.#send({
      type: 'diagnostic', worker: this.#init.worker, epoch: this.#init.epoch,
      source_sequence: this.#sourceSequence++, source_tick: this.#sourceTick,
      counters: drained.counters, dropped: drained.dropped,
    });
  }

  async #critical(kind: CriticalKind, record: unknown): Promise<void> {
    if (this.#init === undefined) throw new RunnerError('runtime_failure', 'worker', { kind: 'worker_not_initialized' });
    const message: WorkerToSupervisor = {
      type: 'critical', kind, worker: this.#init.worker, epoch: this.#init.epoch,
      source_sequence: this.#sourceSequence++, source_tick: this.#sourceTick,
      record: JSON.parse(JSON.stringify(record, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)),
    };
    assertWorkerMessageBound(message);
    await this.#send(message);
  }
}
