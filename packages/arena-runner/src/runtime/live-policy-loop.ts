import { DeterministicRandom, RandomStream, emptyPolicyMemory, seatId, type PolicyMemory } from '@arena/core';
import type { compilePolicy } from '@arena/spec';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { RunnerError } from '../errors.js';
import { makePolicyEffectRecord, makePolicyReplayRecord, type PolicyPathUpdate } from '../policy-replay.js';
import type { RuntimeTraceBuilder } from './trace.js';
import { mapRuntimeFailure } from './failures.js';
import { decideRuntimePolicy, isStrategyDecisionTick } from './policy-decision.js';
import { PolicyCompetitorGate } from './policy-gate.js';
import type { RuntimeCompetitorClient } from './clients.js';

type PolicyCompetitor = Pick<RuntimeCompetitorClient, 'seat' | 'client' | 'bot'>;
type PolicyTrace = Pick<RuntimeTraceBuilder, 'recordPolicyDecision' | 'recordPolicyEffect' | 'checkpoint'>;

export class LivePolicyLoop {
  readonly #trace: PolicyTrace;
  readonly #params: ReturnType<typeof compilePolicy>['params'];
  readonly #seed: bigint;
  readonly #strategyIntervalTicks: bigint;
  readonly #recordPolicy: boolean;
  readonly #competitors: () => readonly PolicyCompetitor[];
  readonly #fail: (error: unknown) => void;
  readonly #memories = new Map<number, PolicyMemory>();
  readonly #randoms = new Map<number, DeterministicRandom>();
  readonly #tasks = new Map<number, Promise<void>>();
  readonly #activeClients = new Map<number, PolicyCompetitor['client']>();
  readonly #cancellations = new Map<number, Promise<void>>();
  readonly #watchedBots = new Map<number, Readonly<{
    bot: PolicyCompetitor['bot'];
    gate: PolicyCompetitorGate;
  }>>();
  readonly #disabledSeats = new Set<number>();
  #sequence = 0n;
  #observationCount = 0;
  #lastTick = -1;
  #stopped = false;
  #checkpointTail: Promise<void> = Promise.resolve();

  constructor(options: Readonly<{
    trace: PolicyTrace;
    params: ReturnType<typeof compilePolicy>['params'];
    seed: bigint;
    strategyIntervalTicks: bigint;
    recordPolicy: boolean;
    competitors(): readonly PolicyCompetitor[];
    fail(error: unknown): void;
  }>) {
    this.#trace = options.trace;
    this.#params = options.params;
    this.#seed = options.seed;
    this.#strategyIntervalTicks = options.strategyIntervalTicks;
    this.#recordPolicy = options.recordPolicy;
    this.#competitors = options.competitors;
    this.#fail = options.fail;
  }

  onTick(tick: number): void {
    if (this.#stopped) return;
    if (tick < this.#lastTick) {
      throw new RunnerError('corrupt_evidence', 'policy clock', { kind: 'non_monotonic_active_tick' });
    }
    if (tick === this.#lastTick) return;
    this.#lastTick = tick;
    if (!isStrategyDecisionTick(BigInt(tick), this.#strategyIntervalTicks)) return;
    for (const competitor of this.#competitors()) {
      if (this.#tasks.has(competitor.seat) || !this.#canIssuePolicy(competitor)) continue;
      const launched = deferred<void>();
      const task = launched.promise;
      this.#tasks.set(competitor.seat, task);
      void this.#runDecision(competitor, tick).then(
        () => launched.resolve(undefined),
        (error: unknown) => launched.reject(error),
      );
      void task.then(
        () => this.#removeTask(competitor.seat, task),
        (error: unknown) => {
          this.#removeTask(competitor.seat, task);
          this.#fail(error);
        },
      );
    }
  }

  stopLaunching(): void {
    this.#stopped = true;
  }

  async stopAndJoin(): Promise<void> {
    this.#stopped = true;
    const active = [...this.#tasks.entries()];
    try {
      const pending = new Set(this.#cancellations.values());
      for (const [seat] of active) {
        if (this.#cancellations.has(seat)) continue;
        const client = this.#activeClients.get(seat);
        if (client !== undefined) pending.add(Promise.resolve().then(() => client.cancel('shutdown')));
      }
      if (active.length !== 0 || pending.size !== 0) {
        const results = await Promise.allSettled([...pending, ...active.map(([, task]) => task)]);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed !== undefined) throw mapRuntimeFailure(failed.reason);
      }
      await this.#checkpointTail;
    } finally {
      for (const { gate } of this.#watchedBots.values()) gate.close();
      this.#watchedBots.clear();
    }
  }

  async #runDecision(competitor: PolicyCompetitor, tick: number): Promise<void> {
    if (!this.#canIssuePolicy(competitor)) return;
    const seat = competitor.seat;
    const client = competitor.client;
    const bot = competitor.bot;
    const observation = client.observe(tick);
    const memory = this.#memories.get(seat) ?? emptyPolicyMemory();
    const random = this.#randoms.get(seat)
      ?? DeterministicRandom.forStream(this.#seed, RandomStream.policy(seatId(seat)));
    const step = decideRuntimePolicy(observation, memory, this.#params, random);
    const { decision } = step;
    this.#memories.set(seat, decision.memory);
    this.#randoms.set(seat, random);

    let sequence: bigint | undefined;
    let decisionRecorded: Promise<void> | undefined;
    if (this.#recordPolicy) {
      this.#sequence += 1n;
      sequence = this.#sequence;
      this.#observationCount += 1;
      const recorded = this.#trace.recordPolicyDecision(
        makePolicyReplayRecord(sequence, seat, step.input, decision, step.rngStateAfter),
      );
      // Enqueue the decision watermark before another seat can record a later decision.
      // Pending skills remain pending in the checkpoint; their effects are recorded only on settlement.
      decisionRecorded = Promise.all([recorded, this.#markCheckpoint(this.#observationCount)]).then(() => undefined);
    }

    if (decision.intent.kind === 'hold') {
      if (decisionRecorded !== undefined) await decisionRecorded;
      return;
    }

    const capture = this.#recordPolicy ? capturePathUpdates(bot) : undefined;
    this.#activeClients.set(seat, client);
    const skillPromise = client.run(decision.intent);
    try {
      if (decisionRecorded !== undefined) await decisionRecorded;
      const skill = await skillPromise;
      if (sequence !== undefined) {
        await this.#trace.recordPolicyEffect(makePolicyEffectRecord(sequence, skill, capture!.values()));
      }
    } catch (error) {
      void client.cancel('shutdown').catch(() => {});
      await skillPromise.catch(() => {});
      throw error;
    } finally {
      capture?.close();
      if (this.#activeClients.get(seat) === client) this.#activeClients.delete(seat);
    }
  }

  #canIssuePolicy(competitor: PolicyCompetitor): boolean {
    if (this.#stopped || this.#disabledSeats.has(competitor.seat)) return false;
    const bot = competitor.bot;
    const watched = this.#watchedBots.get(competitor.seat);
    if (watched?.bot !== bot) {
      watched?.gate.close();
      const gate = new PolicyCompetitorGate(bot, () => this.#disableSeat(competitor.seat));
      this.#watchedBots.set(competitor.seat, Object.freeze({ bot, gate }));
    }
    return this.#watchedBots.get(competitor.seat)?.gate.active === true
      && !this.#disabledSeats.has(competitor.seat);
  }

  #disableSeat(seat: number): void {
    if (this.#disabledSeats.has(seat)) return;
    this.#disabledSeats.add(seat);
    const client = this.#activeClients.get(seat);
    if (client === undefined) return;
    const task = this.#tasks.get(seat);
    const cancel = (async () => { await client.cancel('agentEliminated'); })();
    const join = task ?? Promise.resolve();
    const cancellation = Promise.allSettled([cancel, join]).then((results) => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    });
    this.#cancellations.set(seat, cancellation);
    void cancellation.then(
      () => this.#clearCancellation(seat, cancellation),
      (error: unknown) => {
        this.#clearCancellation(seat, cancellation);
        this.#fail(error);
      },
    );
  }

  #clearCancellation(seat: number, cancellation: Promise<void>): void {
    if (this.#cancellations.get(seat) === cancellation) this.#cancellations.delete(seat);
  }

  #markCheckpoint(observationCount: number): Promise<void> {
    if (observationCount % 200 !== 0) return Promise.resolve();
    this.#checkpointTail = this.#trace.checkpoint(observationCount);
    return this.#checkpointTail;
  }

  #removeTask(seat: number, task: Promise<void>): void {
    if (this.#tasks.get(seat) === task) this.#tasks.delete(seat);
  }
}


function capturePathUpdates(bot: RuntimeCompetitorClient['bot']): Readonly<{
  close(): void;
  values(): readonly PolicyPathUpdate[];
}> {
  let latest: PolicyPathUpdate | undefined;
  let failure: RunnerError | undefined;
  const onPathUpdate = (update: PartiallyComputedPath): void => {
    try {
      const path = update.path.map((point) => {
        if (![point.x, point.y, point.z].every(Number.isFinite)) {
          throw new RunnerError('runtime_failure', 'path update', { kind: 'invalid_path_coordinate' });
        }
        return Object.freeze({ x: point.x, y: point.y, z: point.z });
      });
      latest = Object.freeze({ status: update.status, path: Object.freeze(path) });
    } catch (error) {
      failure ??= mapRuntimeFailure(error);
    }
  };
  bot.on('path_update', onPathUpdate);
  return Object.freeze({
    close: () => bot.removeListener('path_update', onPathUpdate),
    values: () => {
      if (failure !== undefined) throw failure;
      return latest === undefined ? Object.freeze([]) : Object.freeze([latest]);
    },
  });
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
