import { DeterministicRandom, RandomStream, emptyPolicyMemory, openingStyleForSeat, seatId, type PolicyMemory, type Decision, type OpeningPolicyState, type SkillCancellation, type SkillOutcome, createPolicyFeedback, policyFeedbackBatch, type PolicyFeedbackBatch, type AgentObservation, decideCivilization, type CivilizationDecision, type PolicyFeedbackSource, CIVILIZATION_TEAM_MESSAGE_MAX_BYTES, CIVILIZATION_TEAM_MESSAGE_MIN_INTERVAL_TICKS, type CivilizationObservation, type CivilizationPolicyMemory, type CivilizationPolicyFeedbackBatch, type CivilizationGoal, type CivilizationActionIntent, emptyCivilizationPolicyMemory, civilizationPolicyFeedbackBatch, tick } from '@arena/core';
import type { OpeningStyleCycle, compilePolicy } from '@arena/spec';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { RunnerError } from '../errors.js';
import { makeCivilizationPolicyEffectRecord, makeCivilizationPolicyReplayRecord, normalizeCivilizationPolicyReplayInput, makePolicyEffectRecord, makePolicyReplayRecordV4, type PolicyPathUpdate, type PolicyDisposition } from '../policy-replay.js';
import { canonicalJson } from '../canonical.js';
import type { RuntimeTraceBuilder } from './trace.js';
import { mapRuntimeFailure } from './failures.js';
import {
  decideRuntimeCandidateOpening, decideRuntimeCandidatePolicy, decideRuntimeDuelPool, decideRuntimeDuelPoolOpening,
  decideRuntimeOpeningPolicy, decideRuntimePolicy,
  isStrategyDecisionTick,
} from './policy-decision.js';
import { PolicyCompetitorGate } from './policy-gate.js';
import type { RuntimeCompetitorClient } from './clients.js';
import type { ActionFunnelCollector } from './funnel.js';
import { openingPolicyState, policyMemory, type CompiledCandidate, type DuelPoolId, type PolicyMemoryInput } from '@arena/core';
import { makeActionFunnelTraceRecord } from '../funnel-record.js';
import { isClientQuarantine, type ClientQuarantine } from './client-quarantine.js';

type PolicyCompetitor = Pick<RuntimeCompetitorClient, 'seat' | 'gameplay' | 'bot'> & Partial<Pick<RuntimeCompetitorClient, 'close'>>;
type GameplayDecision = Decision | CivilizationDecision;
type PolicyTrace = Pick<RuntimeTraceBuilder, 'recordPolicyDecision' | 'recordPolicyEffect' | 'checkpoint'>
  & Partial<Pick<RuntimeTraceBuilder, 'recordActionFunnel' | 'recordRunNote'>>;
const ACTION_CLEANUP_TIMEOUT_MS = 5_000;

export type PolicyActivityEvent =
  | { readonly kind: 'decision'; readonly seat: number; readonly tick: number; readonly sequence: string;
      readonly disposition: PolicyDisposition; readonly goal: GameplayDecision['goal']; readonly intent: GameplayDecision['intent'];
      readonly tickReceivedAtNs: bigint; readonly decisionStartedAtNs: bigint; readonly acceptedAtNs: bigint }
  | { readonly kind: 'action'; readonly seat: number; readonly actionSequence: string; readonly intent: GameplayDecision['intent'];
      readonly startedAtNs: bigint | null; readonly settledAtNs: bigint; readonly outcome: SkillOutcome; readonly cleanupIncluded: true }
  | { readonly kind: 'actionFailed'; readonly seat: number; readonly actionSequence: string; readonly intent: GameplayDecision['intent'];
      readonly startedAtNs: bigint | null; readonly settledAtNs: bigint; readonly error: unknown };

interface OwnedAction {
  readonly sequence: bigint;
  readonly decision: GameplayDecision;
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
  startedAtTick: number | null;
}

export interface SeatPolicyState {
  readonly memory: unknown;
  readonly rng_state: string;
  readonly opening_state: OpeningPolicyState | null;
}

export class LivePolicyLoop {
  readonly #trace: PolicyTrace;
  readonly #params: ReturnType<typeof compilePolicy>['params'];
  readonly #seed: bigint;
  readonly #openingStyleCycle: OpeningStyleCycle | undefined;
  readonly #strategyIntervalTicks: bigint;
  readonly #recordPolicy: boolean;
  readonly #competitors: () => readonly PolicyCompetitor[];
  readonly #fail: (error: unknown) => void;
  readonly #onActivity: ((event: PolicyActivityEvent) => void) | undefined;
  readonly #funnel: ActionFunnelCollector | undefined;
  readonly #candidates: ReadonlyMap<number, CompiledCandidate> | undefined;
  readonly #poolPartners: ReadonlyMap<number, DuelPoolId> | undefined;
  readonly #memories = new Map<number, PolicyMemory>();
  readonly #openingStates = new Map<number, OpeningPolicyState>();
  readonly #feedback = new Map<number, PolicyFeedbackBatch>();
  readonly #civilizationMemories = new Map<number, CivilizationPolicyMemory>();
  readonly #civilizationFeedback = new Map<number, CivilizationPolicyFeedbackBatch>();
  readonly #lastReportTicks = new Map<number, number>();
  readonly #randoms = new Map<number, DeterministicRandom>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #actions = new Map<number, OwnedAction>();
  readonly #watchedBots = new Map<number, Readonly<{ bot: PolicyCompetitor['bot']; gate: PolicyCompetitorGate }>>();
  readonly #disabledSeats = new Set<number>();
  readonly #quarantines: ClientQuarantine[] = [];
  readonly #quarantineClosed = new Set<number>();
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
    openingStyleCycle?: OpeningStyleCycle;
    strategyIntervalTicks: bigint;
    recordPolicy: boolean;
    competitors(): readonly PolicyCompetitor[];
    fail(error: unknown): void;
    onActivity?: (event: PolicyActivityEvent) => void;
    funnel?: ActionFunnelCollector;
    candidates?: ReadonlyMap<number, CompiledCandidate>;
    poolPartners?: ReadonlyMap<number, DuelPoolId>;
    restore?: ReadonlyMap<number, SeatPolicyState>;
  }>) {
    this.#trace = options.trace;
    this.#params = options.params;
    this.#seed = options.seed;
    this.#openingStyleCycle = options.openingStyleCycle;
    this.#strategyIntervalTicks = options.strategyIntervalTicks;
    this.#recordPolicy = options.recordPolicy;
    this.#competitors = options.competitors;
    this.#fail = options.fail;
    this.#onActivity = options.onActivity;
    this.#funnel = options.funnel;
    this.#candidates = options.candidates;
    this.#poolPartners = options.poolPartners;
    for (const [seat, state] of options.restore ?? []) {
      this.#memories.set(seat, policyMemory(state.memory as PolicyMemoryInput));
      this.#randoms.set(seat, DeterministicRandom.fromState(BigInt(state.rng_state)));
      if (state.opening_state !== null) this.#openingStates.set(seat, openingPolicyState(state.opening_state));
    }
  }

  get degraded(): readonly ClientQuarantine[] {
    return Object.freeze([...this.#quarantines]);
  }

  exportState(): ReadonlyMap<number, SeatPolicyState> {
    const states = new Map<number, SeatPolicyState>();
    for (const [seat, memory] of this.#memories) {
      const random = this.#randoms.get(seat);
      if (random === undefined) continue;
      states.set(seat, Object.freeze({
        memory: JSON.parse(JSON.stringify(memory, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)),
        rng_state: random.snapshotState().toString(),
        opening_state: this.#openingStates.get(seat) ?? null,
      }));
    }
    return states;
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
      catch (error) {
        if (isClientQuarantine(error)) this.#retireQuarantinedClient(competitor, error);
        else this.#reportFailure(error);
      }
    }
  }

  stopLaunching(): void { this.#stopped = true; }

  async stopAndJoin(): Promise<void> {
    this.#stopped = true;
    try {
      const cancel = [...this.#actions.values()].map((action) => this.#cancel(action, 'shutdown'));
      const joined = new Set<Promise<void>>([...cancel, ...this.#tasks]);
      let results = await Promise.allSettled([...joined]);
      let failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed === undefined) {
        const extra = [...this.#tasks].filter((task) => !joined.has(task));
        if (extra.length > 0) {
          results = await Promise.allSettled(extra);
          failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        }
      }
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
    const gameplay = competitor.gameplay;
    const random = this.#randoms.get(seat) ?? DeterministicRandom.forStream(this.#seed, RandomStream.policy(seatId(seat)));
    const step = gameplay.mode === 'hunger_games'
      ? (() => {
        const memory = this.#memories.get(seat) ?? emptyPolicyMemory();
        const feedback = this.#feedback.get(seat) ?? [];
        this.#feedback.delete(seat);
        const inputObservation = gameplay.client.observe(tick);
        const poolId = this.#poolPartners?.get(seat);
        if (poolId !== undefined) {
          if (this.#openingStyleCycle === undefined) {
            const result = decideRuntimeDuelPool(poolId, inputObservation, memory, this.#params, random, feedback);
            return { mode: 'hunger_games' as const, observation: inputObservation, ...result };
          }
          const poolStyle = openingStyleForSeat(this.#seed, seat, this.#openingStyleCycle);
          const poolOpening = this.#openingStates.get(seat) ?? Object.freeze({ cacheTakenAt: null });
          const poolAssignment = { seed: this.#seed, seat, style: poolStyle, cycle: this.#openingStyleCycle, state: poolOpening };
          const result = decideRuntimeDuelPoolOpening(poolId, inputObservation, memory, this.#params, random, feedback, poolAssignment);
          this.#openingStates.set(seat, result.openingState);
          return { mode: 'hunger_games' as const, observation: inputObservation, ...result };
        }
        const candidate = this.#candidates?.get(seat);
        if (this.#openingStyleCycle === undefined) {
          const result = candidate === undefined
            ? decideRuntimePolicy(inputObservation, memory, this.#params, random, feedback)
            : decideRuntimeCandidatePolicy(candidate, inputObservation, memory, random, feedback);
          return { mode: 'hunger_games' as const, observation: inputObservation, ...result };
        }
        const style = openingStyleForSeat(this.#seed, seat, this.#openingStyleCycle);
        const openingState = this.#openingStates.get(seat) ?? Object.freeze({ cacheTakenAt: null });
        const assignment = { seed: this.#seed, seat, style, cycle: this.#openingStyleCycle, state: openingState };
        const result = candidate === undefined
          ? decideRuntimeOpeningPolicy(inputObservation, memory, this.#params, random, feedback, assignment)
          : decideRuntimeCandidateOpening(candidate, inputObservation, memory, random, feedback, assignment);
        this.#openingStates.set(seat, result.openingState);
        return { mode: 'hunger_games' as const, observation: inputObservation, ...result };
      })()
      : (() => {
        const memory = this.#civilizationMemories.get(seat) ?? emptyCivilizationPolicyMemory();
        const feedback = this.#civilizationFeedback.get(seat) ?? civilizationPolicyFeedbackBatch({ shared: [], actions: [] });
        this.#civilizationFeedback.delete(seat);
        const inputObservation = gameplay.client.observe(tick);
        this.#relayTeamReport(competitor, inputObservation, tick);
        const input = normalizeCivilizationPolicyReplayInput({ context: gameplay.context, observation: inputObservation,
          memory, feedback, params: this.#params, random });
        const decision = decideCivilization(gameplay.context, inputObservation, memory, this.#params, random, feedback);
        return { mode: 'civilization' as const, observation: inputObservation.base, input, decision, rngStateAfter: random.snapshotState() };
      })();
    const { decision } = step;
    if (step.mode === 'hunger_games') this.#memories.set(seat, step.decision.memory);
    else this.#civilizationMemories.set(seat, step.decision.memory);
    this.#randoms.set(seat, random);
    const sequence = ++this.#sequence;
    const previous = this.#actions.get(seat);
    const disposition = Object.freeze(this.#disposition(previous, decision, tick, sequence));
    this.#funnel?.note(seat, {
      kind: 'decision',
      tick,
      sequence: sequence.toString(),
      disposition: disposition.kind === 'defer' ? `defer:${disposition.reason}` : disposition.kind,
      goal: decision.goal.kind,
      intent: decision.intent.kind,
      border: step.observation.border.kind,
    });
    let recorded = Promise.resolve();
    if (this.#recordPolicy) {
      let record: ReturnType<typeof makePolicyReplayRecordV4> | ReturnType<typeof makeCivilizationPolicyReplayRecord>;
      if (step.mode === 'hunger_games') {
        record = makePolicyReplayRecordV4({ sequence, seat, input: step.input, decision: step.decision,
          openingStateAfter: step.input.opening === null ? null : this.#openingStates.get(seat) ?? null,
          rngStateAfter: step.rngStateAfter, disposition });
      } else {
        record = makeCivilizationPolicyReplayRecord({ sequence, seat, input: step.input, decision: step.decision,
          rngStateAfter: step.rngStateAfter, disposition });
      }
      const frame = this.#trace.recordPolicyDecision(record);
      if (step.mode === 'hunger_games' && this.#funnel !== undefined && this.#trace.recordRunNote !== undefined) {
        const explanation = step.explanation();
        this.#ownTask(this.#trace.recordRunNote({
          schema: 'decision-explain-v1', version: explanation.version, seat, sequence: sequence.toString(), tick,
          reason: explanation.reason, delegated_goal: explanation.delegatedGoal,
          alternatives: explanation.alternatives.map((entry) => ({ goal: entry.goal, score: entry.score, condition: entry.condition })),
          nearest_cache_blocks: explanation.nearestCacheBlocks, nearest_opponent_blocks: explanation.nearestOpponentBlocks,
          border_center_blocks: explanation.borderCenterBlocks, armed: explanation.armed,
        }));
      }
      this.#observationCount += 1;
      if (this.#observationCount % 200 === 0) this.#checkpointTail = this.#trace.checkpoint(this.#observationCount);
      recorded = Promise.all([frame, this.#checkpointTail]).then(() => undefined);
    }
    this.#ownTask(recorded);

    if (disposition.kind === 'start' || disposition.kind === 'replace') {
      const barrier = previous === undefined ? Promise.resolve() : this.#cancel(previous, 'replaced');
      const action: OwnedAction = {
        sequence, decision, initiatingObservation: step.observation, acceptedTick: tick, competitor, barrier,
        cancellation: deferred<SkillCancellation>(), task: Promise.resolve(), state: 'reserved', priority: goalPriority(decision), startedAtNs: null, startedAtTick: null,
      };
      this.#actions.set(seat, action);
      action.task = this.#execute(action, recorded);
      this.#ownTask(action.task);
    }
    if (this.#onActivity !== undefined) this.#onActivity({ kind: 'decision', seat, tick, sequence: sequence.toString(),
      disposition, goal: decision.goal, intent: decision.intent,
      tickReceivedAtNs: tickReceivedAtNs ?? decisionStartedAtNs!, decisionStartedAtNs: decisionStartedAtNs!, acceptedAtNs: process.hrtime.bigint() });
  }

  #relayTeamReport(sender: PolicyCompetitor, observation: CivilizationObservation, tick: number): void {
    if (sender.gameplay.mode !== 'civilization' || sender.gameplay.context.seat !== sender.seat) {
      throw new RunnerError('runtime_failure', 'civilization team channel', { kind: 'sender_identity_mismatch' });
    }
    const previous = this.#lastReportTicks.get(sender.seat);
    if (previous !== undefined && tick - previous < CIVILIZATION_TEAM_MESSAGE_MIN_INTERVAL_TICKS) return;
    if (observation.observedResources.kind !== 'current') return;
    const resource = observation.observedResources.value.find((value) => value.kind !== 'outpostCell');
    if (resource === undefined) return;
    const report = { sourceTick: tick, declaredStale: false, kind: 'resourceSighting',
      resource: resource.kind === 'logBlock' ? 'oakLogBlock' : resource.kind === 'container' ? 'container'
        : resource.item === 'oak_log' ? 'oakLogDrop' : 'oakPlankDrop', position: resource.position };
    const frame = Buffer.from(canonicalJson(report), 'utf8');
    if (frame.byteLength > CIVILIZATION_TEAM_MESSAGE_MAX_BYTES) {
      throw new RunnerError('runtime_failure', 'civilization team channel', { kind: 'team_frame_too_large' });
    }
    const decodedReport: unknown = JSON.parse(frame.toString('utf8'));
    for (const recipient of this.#competitors()) {
      if (recipient.seat === sender.seat || this.#disabledSeats.has(recipient.seat)
          || recipient.gameplay.mode !== 'civilization'
          || recipient.gameplay.context.faction !== sender.gameplay.context.faction) continue;
      recipient.gameplay.client.receiveTeamReport({ authenticatedSenderSeat: sender.seat, decodedReport, currentTick: tick });
    }
    this.#lastReportTicks.set(sender.seat, tick);
  }

  #disposition(previous: OwnedAction | undefined, decision: GameplayDecision, tick: number, sequence: bigint): PolicyDisposition {
    const action_sequence = sequence.toString();
    if (previous === undefined) return decision.intent.kind === 'hold' ? { kind: 'hold' } : { kind: 'start', action_sequence };
    const activeSequence = previous.sequence.toString();
    const same = canonicalJson(previous.decision.intent) === canonicalJson(decision.intent);
    const priority = goalPriority(decision);
    const previousPriority = previous.priority;
    if (same) {
      previous.priority = Math.max(previousPriority, priority);
      return previous.state === 'running'
        ? { kind: 'continue', action_sequence: activeSequence }
        : { kind: 'defer', action_sequence: activeSequence, reason: 'cleanupPending' };
    }
    if (decision.intent.kind === 'hold' || priority < previousPriority) return { kind: 'defer', action_sequence: activeSequence, reason: 'lowerPriority' };
    if (priority === previousPriority) {
      if (previous.state === 'reserved') return { kind: 'defer', action_sequence: activeSequence, reason: 'cleanupPending' };
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
    let targetSeat: number | null = null;
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
        action.startedAtTick = this.#lastTick;
        if (this.#onActivity !== undefined) action.startedAtNs = process.hrtime.bigint();
        capture = this.#recordPolicy ? capturePathUpdates(action.competitor.bot) : undefined;
        this.#funnel?.discard(action.competitor.seat);
        targetSeat = this.#targetSeat(action);
        const gameplay = action.competitor.gameplay;
        outcome = gameplay.mode === 'civilization' && isCivilizationIntent(action.decision.intent)
          ? await gameplay.client.runCivilization(action.decision.intent)
          : await gameplay.client.run(sharedIntent(action.decision.intent));
      }
      const settledAtNs = this.#onActivity === undefined ? undefined : process.hrtime.bigint();
      capture?.close();
      const pathUpdates = capture?.values() ?? [];
      capture = undefined;
      if (outcome.kind === 'pending' || (outcome.kind === 'progress'
          && (action.competitor.gameplay.mode !== 'civilization' || !isMaterialAction(action.decision)))) throw new RunnerError('runtime_failure', 'policy skill', { kind: 'nonterminal_skill_outcome' });
      action.state = 'settled';
      if (this.#actions.get(action.competitor.seat) === action) this.#actions.delete(action.competitor.seat);
      const source = outcome.kind === 'progress' ? null : sharedFeedbackSource(action, outcome);
      const feedback = source === null ? null : createPolicyFeedback(source);
      const seat = action.competitor.seat;
      if (action.competitor.gameplay.mode === 'civilization') {
        const pending = this.#civilizationFeedback.get(seat) ?? civilizationPolicyFeedbackBatch({ shared: [], actions: [] });
        const materialAction = isMaterialAction(action.decision);
        const actions = materialAction && outcome.kind !== 'cancelled' && action.startedAtTick !== null
          ? [...pending.actions, { goal: action.decision.goal, intent: action.decision.intent, outcome,
            startedAt: tick(action.startedAtTick), completedAt: tick(this.#lastTick) }]
          : pending.actions;
        if (feedback !== null || actions !== pending.actions) this.#civilizationFeedback.set(seat,
          civilizationPolicyFeedbackBatch({ shared: feedback === null ? pending.shared : [...pending.shared, feedback], actions }));
      } else if (feedback !== null) {
        const pending = this.#feedback.get(seat) ?? [];
        this.#feedback.set(seat, policyFeedbackBatch([...pending, feedback]));
      }
      const funnelRecord = this.#funnel?.take(seat) ?? null;
      if (this.#funnel !== undefined && this.#recordPolicy && this.#trace.recordActionFunnel !== undefined) {
        const target = actionTarget(action.decision.intent);
        const tickAtStart = action.startedAtTick;
        this.#funnel.note(seat, { kind: 'action', tick: tickAtStart, action_sequence: action.sequence.toString(),
          intent: action.decision.intent.kind, skill: outcome.kind, funnel: funnelRecord });
        await this.#trace.recordActionFunnel(makeActionFunnelTraceRecord({
          seat,
          actionSequence: action.sequence.toString(),
          tick: tickAtStart,
          intent: action.decision.intent.kind,
          targetEntity: target,
          targetSeat,
          border: action.initiatingObservation.border.kind,
          skill: outcome.kind,
          funnel: funnelRecord,
        }));
      }
      if (this.#recordPolicy) await this.#trace.recordPolicyEffect(action.competitor.gameplay.mode === 'civilization'
        ? makeCivilizationPolicyEffectRecord(action.sequence, outcome, pathUpdates) : makePolicyEffectRecord(action.sequence, outcome, pathUpdates));
      effectRecorded = true;
      deliveringActivity = true;
      this.#onActivity?.({ kind: 'action', seat: action.competitor.seat, actionSequence: action.sequence.toString(),
        intent: action.decision.intent, startedAtNs: action.startedAtNs, settledAtNs: settledAtNs!, outcome, cleanupIncluded: true });
    } catch (error) {
      if (isClientQuarantine(error)) {
        this.#retireQuarantinedClient(action.competitor, error);
        if (decisionRecorded && !effectRecorded && this.#recordPolicy) {
          await this.#trace.recordPolicyEffect(action.competitor.gameplay.mode === 'civilization'
            ? makeCivilizationPolicyEffectRecord(action.sequence, { kind: 'cancelled', reason: 'agentEliminated' }, [])
            : makePolicyEffectRecord(action.sequence, { kind: 'cancelled', reason: 'agentEliminated' }, []));
          effectRecorded = true;
        }
        deliveringActivity = true;
        this.#onActivity?.({ kind: 'action', seat: action.competitor.seat, actionSequence: action.sequence.toString(),
          intent: action.decision.intent, startedAtNs: action.startedAtNs, settledAtNs: process.hrtime.bigint(),
          outcome: { kind: 'cancelled', reason: 'agentEliminated' }, cleanupIncluded: true });
        return;
      }
      this.#disabledSeats.add(action.competitor.seat);
      if (action.state === 'reserved' && decisionRecorded && !effectRecorded && this.#recordPolicy) {
        await this.#trace.recordPolicyEffect(action.competitor.gameplay.mode === 'civilization'
          ? makeCivilizationPolicyEffectRecord(action.sequence, { kind: 'cancelled', reason: 'shutdown' }, [])
          : makePolicyEffectRecord(action.sequence, { kind: 'cancelled', reason: 'shutdown' }, []));
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

  #targetSeat(action: OwnedAction): number | null {
    const target = actionTarget(action.decision.intent);
    if (target === null || this.#funnel === undefined) return null;
    return this.#funnel.seatForUsername(action.competitor.bot.entities[target]?.username);
  }

  #cancel(action: OwnedAction, reason: SkillCancellation): Promise<void> {
    if (action.cancelTask !== undefined) return action.cancelTask;
    const wasRunning = action.state === 'running';
    action.cancellation.resolve(reason);
    action.cancelTask = boundedCleanup((async () => {
      let quarantine: unknown;
      if (wasRunning) {
        try {
          await action.competitor.gameplay.client.cancel(reason);
        } catch (error) {
          if (!isClientQuarantine(error)) throw error;
          quarantine = error;
        }
      }
      try {
        await action.task;
        await action.barrier;
      } catch (error) {
        if (!isClientQuarantine(error)) throw error;
        quarantine ??= error;
      }
      if (isClientQuarantine(quarantine)) this.#retireQuarantinedClient(action.competitor, quarantine);
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

  #retireQuarantinedClient(competitor: PolicyCompetitor, error: Error): void {
    const seat = competitor.seat;
    if (!this.#quarantines.some((entry) => entry.seat === seat)) {
      this.#quarantines.push(Object.freeze({ seat, tick: this.#lastTick, reason: error.message }));
    }
    this.#disabledSeats.add(seat);
    if (this.#quarantineClosed.has(seat)) return;
    this.#quarantineClosed.add(seat);
    this.#ownTask(this.#disconnectQuarantinedClient(competitor));
  }

  async #disconnectQuarantinedClient(competitor: PolicyCompetitor): Promise<void> {
    try {
      if (competitor.close !== undefined) await competitor.close();
      else await competitor.gameplay.client.close();
    } catch (error) {
      if (!isClientQuarantine(error)) throw error;
    }
  }
}

function actionTarget(intent: GameplayDecision['intent']): number | null {
  return intent.kind === 'approach' || intent.kind === 'attack' ? Number(intent.target) : null;
}

function goalPriority(decision: GameplayDecision): number {
  switch (decision.goal.kind) {
    case 'escapeBorder': return 7;
    case 'retreatFromOpponent': return 6;
    case 'recoverHunger': return 5;
    case 'improveEquipment': return 4;
    case 'engageVisibleOpponent': return 3;
    case 'loot': return 2;
    case 'searchLastKnown': return 1;
    case 'explore': return 0;
    case 'gatherMaterial': case 'craftMaterial': case 'transferMaterial': case 'buildOutpost': return 2;
    case 'captureZone': return 1;
    case 'holdCaptureZone': case 'outpostComplete': case 'wait': return -1;
  }
}

function isCivilizationIntent(intent: GameplayDecision['intent']): intent is import('@arena/core').CivIntent {
  return intent.kind === 'mineBlock' || intent.kind === 'craft' || intent.kind === 'containerTransfer'
    || intent.kind === 'placeBlock' || (intent.kind === 'hold' && (intent.reason === 'materialsUnknown' || intent.reason === 'resourcesUnknown'
      || intent.reason === 'blueprintObstructed' || intent.reason === 'blueprintComplete'
      || intent.reason === 'materialsUnavailable' || intent.reason === 'captureZoneOccupied'
      || intent.reason === 'materialTargetCoolingDown'));
}

function isMaterialAction(decision: GameplayDecision): decision is CivilizationDecision & {
  readonly goal: CivilizationGoal; readonly intent: CivilizationActionIntent;
} {
  switch (decision.goal.kind) {
    case 'gatherMaterial': case 'craftMaterial': case 'transferMaterial': case 'buildOutpost':
      return decision.intent.kind === 'navigate' || decision.intent.kind === 'dropCollect'
        || decision.intent.kind === 'containerOpen' || (isCivilizationIntent(decision.intent) && decision.intent.kind !== 'hold');
    default: return false;
  }
}

function sharedIntent(intent: GameplayDecision['intent']): Decision['intent'] {
  if (isCivilizationIntent(intent)) throw new RunnerError('runtime_failure', 'policy intent', { kind: 'civilization_intent_in_hunger_games' });
  return intent;
}

function sharedFeedbackSource(action: OwnedAction, outcome: SkillOutcome): PolicyFeedbackSource | null {
  if (isCivilizationIntent(action.decision.intent)) return null;
  const goal = action.decision.goal;
  switch (goal.kind) {
    case 'escapeBorder': case 'retreatFromOpponent': case 'recoverHunger': case 'improveEquipment':
    case 'engageVisibleOpponent': case 'loot': case 'searchLastKnown': case 'explore':
      return { initiatingObservation: action.initiatingObservation, goal, intent: action.decision.intent, outcome };
    default: return null;
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
