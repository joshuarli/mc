import { DeterministicRandom, RandomStream, emptyPolicyMemory, seatId, type PolicyMemory, type Decision, type SkillCancellation, type SkillOutcome, createPolicyFeedback, policyFeedbackBatch, type PolicyFeedbackBatch, type AgentObservation } from '@arena/core';
import type { compilePolicy } from '@arena/spec';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { RunnerError } from '../errors.js';
import { makePolicyEffectRecord, makePolicyReplayRecord, type PolicyPathUpdate, type PolicyDisposition } from '../policy-replay.js';
import { canonicalJson } from '../canonical.js';
import type { RuntimeTraceBuilder } from './trace.js';
import { mapRuntimeFailure } from './failures.js';
import { decideRuntimePolicy, isStrategyDecisionTick } from './policy-decision.js';
import { PolicyCompetitorGate } from './policy-gate.js';
import type { RuntimeCompetitorClient } from './clients.js';

type PolicyCompetitor = Pick<RuntimeCompetitorClient, 'seat' | 'client' | 'bot'>;
type PolicyTrace = Pick<RuntimeTraceBuilder, 'recordPolicyDecision' | 'recordPolicyEffect' | 'checkpoint'>;
const ACTION_CLEANUP_TIMEOUT_MS = 5_000;

export type PolicyActivityEvent =
  | { readonly kind: 'decision'; readonly seat: number; readonly tick: number; readonly sequence: string;
      readonly disposition: PolicyDisposition; readonly goal: Decision['goal']; readonly intent: Decision['intent'];
      readonly tickReceivedAtNs: bigint; readonly decisionStartedAtNs: bigint; readonly acceptedAtNs: bigint }
  | { readonly kind: 'action'; readonly seat: number; readonly actionSequence: string; readonly intent: Decision['intent'];
      readonly startedAtNs: bigint | null; readonly settledAtNs: bigint; readonly outcome: SkillOutcome; readonly cleanupIncluded: true }
  | { readonly kind: 'actionFailed'; readonly seat: number; readonly actionSequence: string; readonly intent: Decision['intent'];
      readonly startedAtNs: bigint | null; readonly settledAtNs: bigint; readonly error: unknown };

interface OwnedAction {
  readonly sequence: bigint;
  readonly decision: Decision;
  readonly initiatingObservation: AgentObservation;
  readonly acceptedTick: number;
  readonly competitor: PolicyCompetitor;
  readonly barrier: Promise<void>;
  readonly cancellation: ReturnType<typeof deferred<SkillCancellation>>;
  task: Promise<void>;
  state: 'reserved' | 'running' | 'settled';
  priority: number;
  cancelTask?: Promise<void>;
  startedAtNs: bigint | null;
}

/** Reobserves at the strategy cadence while one owner per seat executes or replaces its action. */
export class LivePolicyLoop {
  readonly #trace: PolicyTrace;
  readonly #params: ReturnType<typeof compilePolicy>['params'];
  readonly #seed: bigint;
  readonly #strategyIntervalTicks: bigint;
  readonly #recordPolicy: boolean;
  readonly #competitors: () => readonly PolicyCompetitor[];
  readonly #fail: (error: unknown) => void;
  readonly #onActivity: ((event: PolicyActivityEvent) => void) | undefined;
  readonly #memories = new Map<number, PolicyMemory>();
  readonly #feedback = new Map<number, PolicyFeedbackBatch>();
  readonly #randoms = new Map<number, DeterministicRandom>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #actions = new Map<number, OwnedAction>();
  readonly #watchedBots = new Map<number, Readonly<{ bot: PolicyCompetitor['bot']; gate: PolicyCompetitorGate }>>();
  readonly #disabledSeats = new Set<number>();
  #sequence = 0n;
  #observationCount = 0;
  #lastTick = -1;
  #stopped = false;
  #failure: unknown;
  #checkpointTail: Promise<void> = Promise.resolve();

  constructor(options: Readonly<{
    trace: PolicyTrace;
    params: ReturnType<typeof compilePolicy>['params'];
    seed: bigint;
    strategyIntervalTicks: bigint;
    recordPolicy: boolean;
    competitors(): readonly PolicyCompetitor[];
    fail(error: unknown): void;
    onActivity?: (event: PolicyActivityEvent) => void;
  }>) {
    this.#trace = options.trace;
    this.#params = options.params;
    this.#seed = options.seed;
    this.#strategyIntervalTicks = options.strategyIntervalTicks;
    this.#recordPolicy = options.recordPolicy;
    this.#competitors = options.competitors;
    this.#fail = options.fail;
    this.#onActivity = options.onActivity;
  }

  onTick(tick: number, tickReceivedAtNs?: bigint): void {
    if (this.#stopped) return;
    if (tick < this.#lastTick) throw new RunnerError('corrupt_evidence', 'policy clock', { kind: 'non_monotonic_active_tick' });
    if (tick === this.#lastTick) return;
    this.#lastTick = tick;
    if (!isStrategyDecisionTick(BigInt(tick), this.#strategyIntervalTicks)) return;
    for (const competitor of this.#competitors()) {
      if (!this.#canIssuePolicy(competitor)) continue;
      try { this.#decide(competitor, tick, tickReceivedAtNs); }
      catch (error) { this.#reportFailure(error); }
    }
  }

  stopLaunching(): void { this.#stopped = true; }

  async stopAndJoin(): Promise<void> {
    this.#stopped = true;
    try {
      const cancel = [...this.#actions.values()].map((action) => this.#cancel(action, 'shutdown'));
      const results = await Promise.allSettled([...cancel, ...this.#tasks]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed !== undefined) throw mapRuntimeFailure(failed.reason);
      await this.#checkpointTail;
      if (this.#failure !== undefined) throw mapRuntimeFailure(this.#failure);
    } finally {
      for (const { gate } of this.#watchedBots.values()) gate.close();
      this.#watchedBots.clear();
    }
  }

  #decide(competitor: PolicyCompetitor, tick: number, tickReceivedAtNs?: bigint): void {
    const decisionStartedAtNs = this.#onActivity === undefined ? undefined : process.hrtime.bigint();
    const seat = competitor.seat;
    const observation = competitor.client.observe(tick);
    const memory = this.#memories.get(seat) ?? emptyPolicyMemory();
    const random = this.#randoms.get(seat) ?? DeterministicRandom.forStream(this.#seed, RandomStream.policy(seatId(seat)));
    const feedback = this.#feedback.get(seat) ?? [];
    this.#feedback.delete(seat);
    const step = decideRuntimePolicy(observation, memory, this.#params, random, feedback);
    const { decision } = step;
    this.#memories.set(seat, decision.memory);
    this.#randoms.set(seat, random);
    const sequence = ++this.#sequence;
    const previous = this.#actions.get(seat);
    const disposition = Object.freeze(this.#disposition(previous, decision, tick, sequence));
    let recorded = Promise.resolve();
    if (this.#recordPolicy) {
      const frame = this.#trace.recordPolicyDecision(makePolicyReplayRecord({ sequence, seat, input: step.input, decision, rngStateAfter: step.rngStateAfter, disposition }));
      this.#observationCount += 1;
      // The decision watermark does not assert that its owned effect has completed.
      if (this.#observationCount % 200 === 0) this.#checkpointTail = this.#trace.checkpoint(this.#observationCount);
      recorded = Promise.all([frame, this.#checkpointTail]).then(() => undefined);
    }
    this.#ownTask(recorded);

    if (disposition.kind === 'start' || disposition.kind === 'replace') {
      const barrier = previous === undefined ? Promise.resolve() : this.#cancel(previous, 'replaced');
      const action: OwnedAction = {
        sequence, decision, initiatingObservation: observation, acceptedTick: tick, competitor, barrier,
        cancellation: deferred<SkillCancellation>(), task: Promise.resolve(), state: 'reserved', priority: goalPriority(decision), startedAtNs: null,
      };
      this.#actions.set(seat, action);
      action.task = this.#execute(action, recorded);
      this.#ownTask(action.task);
    }
    if (this.#onActivity !== undefined) this.#onActivity({ kind: 'decision', seat, tick, sequence: sequence.toString(),
      disposition, goal: decision.goal, intent: decision.intent,
      tickReceivedAtNs: tickReceivedAtNs ?? decisionStartedAtNs!, decisionStartedAtNs: decisionStartedAtNs!, acceptedAtNs: process.hrtime.bigint() });
  }

  #disposition(previous: OwnedAction | undefined, decision: Decision, tick: number, sequence: bigint): PolicyDisposition {
    const action_sequence = sequence.toString();
    if (previous === undefined) return decision.intent.kind === 'hold' ? { kind: 'hold' } : { kind: 'start', action_sequence };
    const activeSequence = previous.sequence.toString();
    const same = canonicalJson(previous.decision.intent) === canonicalJson(decision.intent);
    const priority = goalPriority(decision);
    const previousPriority = previous.priority;
    if (same) {
      // The same controls may now serve a more urgent goal; preserve that urgency while they run.
      previous.priority = Math.max(previousPriority, priority);
      return previous.state === 'running'
        ? { kind: 'continue', action_sequence: activeSequence }
        : { kind: 'defer', action_sequence: activeSequence, reason: 'cleanupPending' };
    }
    if (decision.intent.kind === 'hold' || priority < previousPriority) return { kind: 'defer', action_sequence: activeSequence, reason: 'lowerPriority' };
    if (priority === previousPriority) {
      if (previous.state === 'reserved') return { kind: 'defer', action_sequence: activeSequence, reason: 'cleanupPending' };
      // Exploration redraws a target on every observation; a fresh draw does not invalidate the owned route.
      if (previous.decision.goal.kind === 'explore' && decision.goal.kind === 'explore') {
        return { kind: 'defer', action_sequence: activeSequence, reason: 'goalPersistence' };
      }
      if (BigInt(tick - previous.acceptedTick) < this.#strategyIntervalTicks * 2n) return { kind: 'defer', action_sequence: activeSequence, reason: 'hysteresis' };
    }
    return { kind: 'replace', action_sequence, replaces_action_sequence: activeSequence,
      reason: priority > previousPriority ? 'higherPriority' : 'targetChanged' };
  }

  async #execute(action: OwnedAction, recorded: Promise<void>): Promise<void> {
    let capture: ReturnType<typeof capturePathUpdates> | undefined;
    let decisionRecorded = false;
    let effectRecorded = false;
    let deliveringActivity = false;
    try {
      await recorded;
      decisionRecorded = true;
      const ready = await Promise.race([
        action.barrier.then(() => ({ kind: 'ready' as const })),
        action.cancellation.promise.then((reason) => ({ kind: 'cancel' as const, reason })),
      ]);
      let outcome: SkillOutcome;
      if (ready.kind === 'cancel') outcome = { kind: 'cancelled', reason: ready.reason };
      else if (this.#stopped || this.#disabledSeats.has(action.competitor.seat)
          || this.#actions.get(action.competitor.seat) !== action) {
        outcome = { kind: 'cancelled', reason: this.#disabledSeats.has(action.competitor.seat) ? 'agentEliminated' : this.#stopped ? 'shutdown' : 'replaced' };
      } else {
        action.state = 'running';
        if (this.#onActivity !== undefined) action.startedAtNs = process.hrtime.bigint();
        capture = this.#recordPolicy ? capturePathUpdates(action.competitor.bot) : undefined;
        outcome = await action.competitor.client.run(action.decision.intent);
      }
      const settledAtNs = this.#onActivity === undefined ? undefined : process.hrtime.bigint();
      capture?.close();
      const pathUpdates = capture?.values() ?? [];
      capture = undefined;
      if (outcome.kind === 'pending' || outcome.kind === 'progress') throw new RunnerError('runtime_failure', 'policy skill', { kind: 'nonterminal_skill_outcome' });
      // The skill promise includes its resource cleanup. Release ownership before trace I/O so
      // a later observation cannot claim to continue an already settled action.
      action.state = 'settled';
      if (this.#actions.get(action.competitor.seat) === action) this.#actions.delete(action.competitor.seat);
      const feedback = createPolicyFeedback({ initiatingObservation: action.initiatingObservation,
        goal: action.decision.goal, intent: action.decision.intent, outcome });
      if (feedback !== null) {
        const pending = this.#feedback.get(action.competitor.seat) ?? [];
        this.#feedback.set(action.competitor.seat, policyFeedbackBatch([...pending, feedback]));
      }
      if (this.#recordPolicy) await this.#trace.recordPolicyEffect(makePolicyEffectRecord(action.sequence, outcome, pathUpdates));
      effectRecorded = true;
      deliveringActivity = true;
      this.#onActivity?.({ kind: 'action', seat: action.competitor.seat, actionSequence: action.sequence.toString(),
        intent: action.decision.intent, startedAtNs: action.startedAtNs, settledAtNs: settledAtNs!, outcome, cleanupIncluded: true });
    } catch (error) {
      // A failed cleanup never transfers control to a successor. The seat remains quarantined.
      this.#disabledSeats.add(action.competitor.seat);
      if (action.state === 'reserved' && decisionRecorded && !effectRecorded && this.#recordPolicy) {
        await this.#trace.recordPolicyEffect(makePolicyEffectRecord(action.sequence, { kind: 'cancelled', reason: 'shutdown' }, []));
      }
      if (!deliveringActivity) this.#onActivity?.({ kind: 'actionFailed', seat: action.competitor.seat, actionSequence: action.sequence.toString(),
        intent: action.decision.intent, startedAtNs: action.startedAtNs, settledAtNs: process.hrtime.bigint(), error });
      throw error;
    } finally {
      capture?.close();
      action.state = 'settled';
      if (this.#actions.get(action.competitor.seat) === action) this.#actions.delete(action.competitor.seat);
    }
  }

  #cancel(action: OwnedAction, reason: SkillCancellation): Promise<void> {
    if (action.cancelTask !== undefined) return action.cancelTask;
    const wasRunning = action.state === 'running';
    action.cancellation.resolve(reason);
    action.cancelTask = boundedCleanup((async () => {
      if (wasRunning) await action.competitor.client.cancel(reason);
      await action.task;
      // A superseded reservation still waits for the original control owner to release.
      await action.barrier;
    })());
    this.#ownTask(action.cancelTask);
    return action.cancelTask;
  }

  #ownTask(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.then(() => this.#tasks.delete(task), (error: unknown) => {
      this.#tasks.delete(task);
      this.#reportFailure(error);
    });
  }

  #reportFailure(error: unknown): void {
    this.#stopped = true;
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#fail(error);
  }

  #canIssuePolicy(competitor: PolicyCompetitor): boolean {
    if (this.#stopped || this.#disabledSeats.has(competitor.seat)) return false;
    const watched = this.#watchedBots.get(competitor.seat);
    if (watched?.bot !== competitor.bot) {
      watched?.gate.close();
      this.#watchedBots.set(competitor.seat, { bot: competitor.bot,
        gate: new PolicyCompetitorGate(competitor.bot, () => this.#disableSeat(competitor.seat)) });
    }
    return this.#watchedBots.get(competitor.seat)?.gate.active === true && !this.#disabledSeats.has(competitor.seat);
  }

  #disableSeat(seat: number): void {
    if (this.#disabledSeats.has(seat)) return;
    this.#disabledSeats.add(seat);
    const action = this.#actions.get(seat);
    if (action !== undefined) this.#ownTask(this.#cancel(action, 'agentEliminated'));
  }
}

function goalPriority(decision: Decision): number {
  switch (decision.goal.kind) {
    case 'escapeBorder': return 7;
    case 'retreatFromOpponent': return 6;
    case 'recoverHunger': return 5;
    case 'improveEquipment': return 4;
    case 'engageVisibleOpponent': return 3;
    case 'loot': return 2;
    case 'searchLastKnown': return 1;
    case 'explore': return 0;
    case 'wait': return -1;
  }
}

async function boundedCleanup(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RunnerError('runtime_failure', 'policy action cleanup', { kind: 'policy_action_cleanup_timeout' })), ACTION_CLEANUP_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
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


function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
