import {
  civilizationPolicyMemory,
  civilizationPolicyFeedbackBatch,
  type CivilizationPolicyMemory,
  type CivilizationPolicyFeedbackBatch,
  type PolicyParamValues,
  type AgentObservationInput,
  civilizationObservation,
  civilizationPolicyContext,
  decideCivilization,
  decideOpening,
  compileCandidate,
  type CandidateId,
  type CompiledCandidate,
  openingPolicyState,
  openingStyleForSeat,
  normalizePolicyReplayInput,
  type CivilizationDecision,
  type CivilizationGoal,
  type CivilizationActionIntent,
  type CivilizationObservation,
  type CivilizationObservationInput,
  type CivilizationPolicyContext,
  type CivilizationPolicyContextInput,
  type PolicyReplayInputSource,
  type PolicyReplayInputV3,
  type PolicyReplayInputV4,
  type OpeningPolicyState,
  decide,
  decideDuelPool,
  decideDuelPoolOpening,
  decidePolicyReplayV1,
  DUEL_POOL_VERSION,
  duelPoolMember,
  isDuelPoolId,
  type DuelPoolId,
  rehydratePolicyReplayInput,
  type Decision,
  type DecisionV1,
  type PolicyReplayInputV2,
  type OpeningStyle,
  type SkillCancellation,
  type SkillFailure,
  type PolicyReplayInputV1,
  type SkillOutcome,
} from '@arena/core';
import type { Evidence } from './evidence.js';
import { canonicalJson } from './canonical.js';
import { ControlCodecError, decodeControlEnvelope } from './control/index.js';
import type { ControlMessage } from './control/types.js';
import { TraceError, type TraceRecord } from './trace.js';

const MAX_U64 = (1n << 64n) - 1n;
const POLICY_DECISION_FIELDS = ['schema', 'sequence', 'seat', 'input', 'decision', 'rng_state_after'];
const POLICY_EFFECT_FIELDS = ['schema', 'decision_sequence', 'skill', 'path_updates'];
const PATH_UPDATE_STATUSES = new Set(['success', 'partial', 'noPath', 'timeout']);
const SKILL_FAILURES = new Set(['preconditionsNotMet', 'noProgress', 'serverRejected', 'timedOut']);
const SKILL_CANCELLATIONS = new Set(['replaced', 'agentEliminated', 'shutdown']);

export interface PolicyReplayRecordV1 {
  readonly schema: 'policy-replay-v1';
  readonly sequence: string;
  readonly seat: number;
  readonly input: PolicyReplayInputV1;
  readonly decision: DecisionV1;
  readonly rng_state_after: string;
}

export type PolicyDisposition =
  | { readonly kind: 'hold' }
  | { readonly kind: 'start'; readonly action_sequence: string }
  | { readonly kind: 'continue'; readonly action_sequence: string }
  | { readonly kind: 'defer'; readonly action_sequence: string; readonly reason: 'lowerPriority' | 'hysteresis' | 'cleanupPending' | 'goalPersistence' }
  | { readonly kind: 'replace'; readonly action_sequence: string; readonly replaces_action_sequence: string; readonly reason: 'higherPriority' | 'targetChanged' };

export interface PolicyReplayRecordV2 extends Omit<PolicyReplayRecordV1, 'schema' | 'input' | 'decision'> {
  readonly schema: 'policy-replay-v2';
  readonly input: PolicyReplayInputV2;
  readonly decision: Decision;
  readonly disposition: PolicyDisposition;
}

export interface PolicyReplayRecordV3 extends Omit<PolicyReplayRecordV2, 'schema' | 'input'> {
  readonly schema: 'policy-replay-v3';
  readonly input: PolicyReplayInputV3;
  readonly opening_state_after: OpeningPolicyState;
}

export interface PolicyReplayRecordV4 extends Omit<PolicyReplayRecordV2, 'schema' | 'input'> {
  readonly schema: 'policy-replay-v4';
  readonly input: PolicyReplayInputV4;
  readonly opening_state_after: OpeningPolicyState | null;
}

export interface CivilizationPolicyReplayInputV1 {
  readonly schema: 'civilization-policy-input-v1';
  readonly context: CivilizationPolicyContextInput;
  readonly observation: Omit<CivilizationObservationInput, 'base'> & { readonly base: AgentObservationInput };
  readonly memory: CivilizationPolicyMemory;
  readonly feedback: CivilizationPolicyFeedbackBatch;
  readonly params: PolicyParamValues;
  readonly rng_state: string;
}

export interface CivilizationPolicyReplayRecordV1 extends Omit<PolicyReplayRecordV2, 'schema' | 'input' | 'decision'> {
  readonly schema: 'civilization-policy-replay-v1';
  readonly input: CivilizationPolicyReplayInputV1;
  readonly decision: CivilizationDecision;
}

export type PolicyReplayRecord = PolicyReplayRecordV1 | PolicyReplayRecordV2 | PolicyReplayRecordV3 | PolicyReplayRecordV4
  | CivilizationPolicyReplayRecordV1;

interface OpeningPolicyReplayTransition {
  readonly stateBefore: OpeningPolicyState;
  readonly stateAfter: OpeningPolicyState;
}

export interface PolicyPathPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PolicyPathUpdate {
  readonly status: 'success' | 'partial' | 'noPath' | 'timeout';
  readonly path: readonly PolicyPathPoint[];
}

export interface PolicyEffectRecordV1 {
  readonly schema: 'policy-effect-v1';
  readonly decision_sequence: string;
  readonly skill: SkillOutcome;
  readonly path_updates: readonly PolicyPathUpdate[];
}

export interface CivilizationPolicyEffectRecordV1 extends Omit<PolicyEffectRecordV1, 'schema'> {
  readonly schema: 'civilization-policy-effect-v1';
}

export type PolicyEffectRecord = PolicyEffectRecordV1 | CivilizationPolicyEffectRecordV1;

export function normalizeCivilizationPolicyReplayInput(source: Readonly<
  Omit<PolicyReplayInputSource, 'observation' | 'memory' | 'feedback'> & {
    memory: CivilizationPolicyMemory;
    feedback: CivilizationPolicyFeedbackBatch;
    context: CivilizationPolicyContext;
    observation: CivilizationObservation;
  }
>): CivilizationPolicyReplayInputV1 {
  const context = civilizationPolicyContext({ seat: source.context.seat, faction: source.context.faction,
    role: source.context.role, objective: source.context.objective });
  const observation = civilizationObservation({ base: source.observation.base,
    ownMaterials: source.observation.ownMaterials, observedResources: source.observation.observedResources,
    teamMessages: source.observation.teamMessages }, context);
  const memory = civilizationPolicyMemory(source.memory);
  const feedback = civilizationPolicyFeedbackBatch(source.feedback);
  const base = normalizePolicyReplayInput({ observation: observation.base, memory: memory.policy,
    feedback: feedback.shared, params: source.params, random: source.random });
  return Object.freeze({
    schema: 'civilization-policy-input-v1',
    context: Object.freeze({ seat: context.seat, faction: context.faction, role: context.role, objective: context.objective }),
    observation: Object.freeze({ base: base.observation, ownMaterials: observation.ownMaterials,
      observedResources: observation.observedResources, teamMessages: observation.teamMessages }),
    memory, feedback, params: base.params, rng_state: base.rng_state,
  });
}

export function makeCivilizationPolicyReplayRecord(options: Readonly<{
  sequence: bigint;
  seat: number;
  input: CivilizationPolicyReplayInputV1;
  decision: CivilizationDecision;
  rngStateAfter: bigint;
  disposition: PolicyDisposition;
}>): CivilizationPolicyReplayRecordV1 {
  assertSequence(options.sequence, 'sequence');
  assertSeat(options.seat);
  assertU64(options.rngStateAfter, 'rng_state_after');
  const disposition = readDisposition(options.disposition, undefined);
  const record: CivilizationPolicyReplayRecordV1 = Object.freeze({
    schema: 'civilization-policy-replay-v1', sequence: options.sequence.toString(), seat: options.seat,
    input: options.input, decision: options.decision, rng_state_after: options.rngStateAfter.toString(), disposition,
  });
  if (options.input.schema !== 'civilization-policy-input-v1' || options.input.context.seat !== options.seat) {
    throw new TypeError('civilization replay input must match its decision seat and namespace');
  }
  if ((disposition.kind === 'hold') !== (record.decision.intent.kind === 'hold') && disposition.kind !== 'defer') {
    throw new TypeError('civilization hold disposition must describe a hold intent');
  }
  if ((disposition.kind === 'start' || disposition.kind === 'replace') && disposition.action_sequence !== record.sequence) {
    throw new TypeError('action identity must match its initiating decision');
  }
  return record;
}

export function makeCivilizationPolicyEffectRecord(
  decisionSequence: bigint,
  skill: SkillOutcome,
  pathUpdates: readonly PolicyPathUpdate[],
): CivilizationPolicyEffectRecordV1 {
  return Object.freeze({ ...makePolicyEffectRecord(decisionSequence, skill, pathUpdates), schema: 'civilization-policy-effect-v1' });
}

export function isCivilizationMaterialAction(decision: CivilizationDecision): decision is CivilizationDecision & {
  readonly goal: Extract<CivilizationGoal, { readonly kind: 'gatherMaterial' | 'craftMaterial' | 'transferMaterial' | 'buildOutpost' }>;
  readonly intent: CivilizationActionIntent;
} {
  const { goal, intent } = decision;
  if (goal.kind !== 'gatherMaterial' && goal.kind !== 'craftMaterial'
      && goal.kind !== 'transferMaterial' && goal.kind !== 'buildOutpost') return false;
  return intent.kind === 'mineBlock' || intent.kind === 'craft' || intent.kind === 'containerTransfer'
    || intent.kind === 'placeBlock' || intent.kind === 'navigate' || intent.kind === 'dropCollect'
    || intent.kind === 'containerOpen';
}

export interface PolicyReplaySummaryV1 {
  readonly schema: 1;
  readonly run_id: string;
  readonly verified: true;
  readonly decision_count: number;
  readonly policy_sequence_range: Readonly<{ first: string; last: string }>;
  readonly effect_count: number;
  readonly path_update_count: number;
}

export interface OpeningStyleSeatEvidence {
  readonly assigned_style: OpeningStyle;
  readonly first_decision: Readonly<{ goal: Decision['goal']; intent: Decision['intent'] }> | null;
  readonly local_opportunities: Readonly<{
    readonly chest_sightings: number;
    readonly chest_positions: readonly Readonly<{ x: number; y: number; z: number }>[];
    readonly visible_opponent_observations: number;
    readonly isolated_opponent_observations: number;
    readonly visible_opponents: readonly Readonly<{
      id: number;
      position: Readonly<{ x: number; y: number; z: number }>;
      attacking_agent: boolean;
    }>[];
  }>;
  readonly confirmed_outcomes: Readonly<Record<OpeningActionKind, Readonly<{
    succeeded: number;
    failed: number;
    cancelled: number;
  }>>>;
}

export interface PolicyReplaySummaryV2 extends Omit<PolicyReplaySummaryV1, 'schema'> {
  readonly schema: 2;
  readonly opening_evidence: Readonly<Record<string, OpeningStyleSeatEvidence>>;
}

export type PolicyReplaySummary = PolicyReplaySummaryV1 | PolicyReplaySummaryV2;

type OpeningActionKind = 'navigation' | 'loot' | 'eat' | 'equip' | 'attack';

interface MutableOpeningEvidence {
  readonly assignedStyle: OpeningStyle;
  firstDecision: Readonly<{ goal: Decision['goal']; intent: Decision['intent'] }> | null;
  chestSightings: number;
  readonly chestPositions: Map<string, Readonly<{ x: number; y: number; z: number }>>;
  visibleOpponentObservations: number;
  isolatedOpponentObservations: number;
  readonly visibleOpponents: Map<string, Readonly<{ id: number; position: Readonly<{ x: number; y: number; z: number }>; attacking_agent: boolean }>>;
  readonly confirmedOutcomes: Record<OpeningActionKind, { succeeded: number; failed: number; cancelled: number }>;
}

const MAX_OPENING_EVIDENCE_OPPORTUNITIES = 64;

export function makePolicyReplayRecord(options: Readonly<{
  sequence: bigint;
  seat: number;
  input: PolicyReplayInputV2;
  decision: Decision;
  rngStateAfter: bigint;
  disposition: PolicyDisposition;
}>): PolicyReplayRecordV2 {
  const { sequence, seat, input, decision, rngStateAfter, disposition } = options;
  assertSequence(sequence, 'sequence');
  assertSeat(seat);
  assertU64(rngStateAfter, 'rng_state_after');
  let validated: PolicyDisposition;
  try { validated = readDisposition(disposition, undefined); }
  catch (error) { throw new TypeError('invalid policy action disposition', { cause: error }); }
  if ((validated.kind === 'hold') !== (decision.intent.kind === 'hold') && validated.kind !== 'defer') {
    throw new TypeError('policy hold disposition must describe a hold intent');
  }
  if ((validated.kind === 'start' || validated.kind === 'replace') && validated.action_sequence !== sequence.toString()) {
    throw new TypeError('action identity must match its initiating decision');
  }
  return Object.freeze({ schema: 'policy-replay-v2', sequence: sequence.toString(), seat, input, decision, rng_state_after: rngStateAfter.toString(), disposition: Object.freeze(validated) });
}

export function makeOpeningPolicyReplayRecord(options: Readonly<{
  sequence: bigint;
  seat: number;
  input: PolicyReplayInputV3;
  decision: Decision;
  openingStateAfter: OpeningPolicyState;
  rngStateAfter: bigint;
  disposition: PolicyDisposition;
}>): PolicyReplayRecordV3 {
  const { sequence, seat, input, decision, rngStateAfter, disposition } = options;
  assertSequence(sequence, 'sequence');
  assertSeat(seat);
  assertU64(rngStateAfter, 'rng_state_after');
  if (input.schema !== 'policy-input-v3'
      || openingStyleForSeat(BigInt(input.opening.seed), seat, input.opening.cycle) !== input.opening.style) {
    throw new TypeError('opening style assignment must match the replay seed, seat, and cycle');
  }
  let validated: PolicyDisposition;
  try { validated = readDisposition(disposition, undefined); }
  catch (error) { throw new TypeError('invalid policy action disposition', { cause: error }); }
  if ((validated.kind === 'hold') !== (decision.intent.kind === 'hold') && validated.kind !== 'defer') {
    throw new TypeError('policy hold disposition must describe a hold intent');
  }
  if ((validated.kind === 'start' || validated.kind === 'replace') && validated.action_sequence !== sequence.toString()) {
    throw new TypeError('action identity must match its initiating decision');
  }
  const openingStateAfter = openingPolicyState(options.openingStateAfter);
  return Object.freeze({ schema: 'policy-replay-v3', sequence: sequence.toString(), seat, input, decision,
    rng_state_after: rngStateAfter.toString(), disposition: Object.freeze(validated), opening_state_after: openingStateAfter });
}

export function makePolicyReplayRecordV4(options: Readonly<{
  sequence: bigint;
  seat: number;
  input: PolicyReplayInputV4;
  decision: Decision;
  openingStateAfter: OpeningPolicyState | null;
  rngStateAfter: bigint;
  disposition: PolicyDisposition;
}>): PolicyReplayRecordV4 {
  const { sequence, seat, input, decision, rngStateAfter, disposition } = options;
  assertSequence(sequence, 'sequence');
  assertSeat(seat);
  assertU64(rngStateAfter, 'rng_state_after');
  if (input.schema !== 'policy-input-v4') throw new TypeError('policy replay v4 requires a policy-input-v4 input');
  if (input.opening === null) {
    if (options.openingStateAfter !== null) throw new TypeError('a non-opening decision has no opening state');
  } else if (options.openingStateAfter === null
      || openingStyleForSeat(BigInt(input.opening.seed), seat, input.opening.cycle) !== input.opening.style) {
    throw new TypeError('opening style assignment must match the replay seed, seat, and cycle');
  }
  let validated: PolicyDisposition;
  try { validated = readDisposition(disposition, undefined); }
  catch (error) { throw new TypeError('invalid policy action disposition', { cause: error }); }
  if ((validated.kind === 'hold') !== (decision.intent.kind === 'hold') && validated.kind !== 'defer') {
    throw new TypeError('policy hold disposition must describe a hold intent');
  }
  if ((validated.kind === 'start' || validated.kind === 'replace') && validated.action_sequence !== sequence.toString()) {
    throw new TypeError('action identity must match its initiating decision');
  }
  return Object.freeze({ schema: 'policy-replay-v4', sequence: sequence.toString(), seat, input, decision,
    rng_state_after: rngStateAfter.toString(), disposition: Object.freeze(validated),
    opening_state_after: options.openingStateAfter === null ? null : openingPolicyState(options.openingStateAfter) });
}

export function makePolicyEffectRecord(
  decisionSequence: bigint,
  skill: SkillOutcome,
  pathUpdates: readonly PolicyPathUpdate[],
): PolicyEffectRecordV1 {
  assertSequence(decisionSequence, 'decision_sequence');
  const copiedSkill = copySkillOutcome(skill);
  if (pathUpdates.length > 1) throw new TypeError('a policy effect can retain at most one path update');
  const copiedPathUpdates = Object.freeze(pathUpdates.map(copyPathUpdate));
  return Object.freeze({
    schema: 'policy-effect-v1',
    decision_sequence: decisionSequence.toString(10),
    skill: copiedSkill,
    path_updates: copiedPathUpdates,
  });
}

export function replayPolicyJson(evidence: Evidence): PolicyReplaySummary {
  const decisions = new Map<string, PolicyReplayRecord>();
  const activeActions = new Map<number, string>();
  const actionOwners = new Map<string, number>();
  const prepared = readPreparedContext(evidence);
  const seatCandidates = readSeatCandidates(evidence);
  let previousSequence = 0n;
  let firstSequence: string | undefined;
  let lastSequence: string | undefined;
  let effectCount = 0;
  let pathUpdateCount = 0;
  const effects = new Set<string>();
  const openingEvidence = new Map<number, MutableOpeningEvidence>();
  const openingStates = new Map<number, OpeningPolicyState>();
  let terminalOutcomeSeen = false;

  for (const [index, record] of evidence.records.entries()) {
    if (record.direction === 'plugin' && record.type === 'outcome') terminalOutcomeSeen = true;
    if (record.schema === 'policy-replay-v1' || record.schema === 'policy-replay-v2'
        || record.schema === 'policy-replay-v3' || record.schema === 'policy-replay-v4'
        || record.schema === 'civilization-policy-replay-v1') {
      const decision = readPolicyDecision(record, index + 1);
      if (decision.schema === 'civilization-policy-replay-v1' && terminalOutcomeSeen) {
        throw replayFailure('policy_decision_after_outcome', index + 1);
      }
      if (prepared !== undefined && !prepared.seats.has(decision.seat)) {
        throw replayFailure('policy_seat_not_in_roster', index + 1, 'seat');
      }
      if (prepared !== undefined && (decision.schema === 'civilization-policy-replay-v1') !== (prepared.mode === 'civilization')) {
        throw replayFailure('policy_namespace_mode_mismatch', index + 1, 'schema');
      }
      const sequence = BigInt(decision.sequence);
      if (sequence <= previousSequence) throw replayFailure('policy_sequence_not_increasing', index + 1, 'sequence');
      previousSequence = sequence;
      firstSequence ??= decision.sequence;
      lastSequence = decision.sequence;
      const openingTransition = replayDecision(decision, index + 1, prepared?.seed, seatCandidates.get(decision.seat));
      if (hasOpeningInput(decision)) {
        if (openingTransition === undefined) throw replayFailure('policy_opening_state_chain_mismatch', index + 1);
        const expectedState = openingStates.get(decision.seat) ?? openingPolicyState({ cacheTakenAt: null });
        if (canonicalJson(openingTransition.stateBefore) !== canonicalJson(expectedState)) {
          throw replayFailure('policy_opening_state_chain_mismatch', index + 1, 'input.opening.state');
        }
        openingStates.set(decision.seat, openingTransition.stateAfter);
        retainOpeningDecision(openingEvidence, decision as unknown as PolicyReplayRecordV3, index + 1);
      }
      if (decision.schema !== 'policy-replay-v1') {
        validateActionDecision(decision, activeActions, actionOwners, effects, index + 1);
      } else if (decision.decision.intent.kind !== 'hold') {
        actionOwners.set(decision.sequence, decision.seat);
      }
      decisions.set(decision.sequence, decision);
    } else if (record.schema === 'policy-effect-v1' || record.schema === 'civilization-policy-effect-v1') {
      const effect = readPolicyEffect(record, index + 1);
      if (!decisions.has(effect.decision_sequence)) {
        throw replayFailure('unmatched_policy_effect', index + 1, 'decision_sequence');
      }
      if (effects.has(effect.decision_sequence)) {
        throw replayFailure('duplicate_policy_effect', index + 1, 'decision_sequence');
      }
      const initiator = decisions.get(effect.decision_sequence)!;
      if ((initiator.schema === 'civilization-policy-replay-v1') !== (effect.schema === 'civilization-policy-effect-v1')) {
        throw replayFailure('policy_effect_namespace_mismatch', index + 1, 'schema');
      }
      if (initiator.schema !== 'policy-replay-v1' && (effect.skill.kind === 'pending'
          || (effect.skill.kind === 'progress' && (initiator.schema !== 'civilization-policy-replay-v1'
            || !isCivilizationMaterialAction(initiator.decision))))) {
        throw replayFailure('nonterminal_policy_effect', index + 1, 'skill');
      }
      if (initiator.schema !== 'policy-replay-v1' && !actionOwners.has(effect.decision_sequence)) {
        throw replayFailure('policy_effect_without_action', index + 1, 'decision_sequence');
      }
      effects.add(effect.decision_sequence);
      if (hasOpeningInput(initiator)) {
        retainOpeningEffect(openingEvidence.get(initiator.seat), initiator.decision.intent, effect.skill.kind);
      }
      if (activeActions.get(initiator.seat) === effect.decision_sequence) activeActions.delete(initiator.seat);
      effectCount += 1;
      pathUpdateCount += effect.path_updates.length;
    } else if (typeof record.schema === 'string' && (record.schema.startsWith('policy-') || record.schema.startsWith('civilization-policy-'))) {
      throw replayFailure('unsupported_policy_schema', index + 1, 'schema');
    }
  }

  const hasTerminalOutcome = evidence.records.some((record) => record.direction === 'plugin' && record.type === 'outcome');
  if (hasTerminalOutcome && [...actionOwners.keys()].some((sequence) =>
      decisions.get(sequence)?.schema === 'civilization-policy-replay-v1' && !effects.has(sequence))) {
    throw replayFailure('policy_skill_result_pending');
  }
  if (firstSequence === undefined || lastSequence === undefined) throw replayFailure('policy_records_missing');
  const summary = {
    run_id: evidence.run_id,
    verified: true as const,
    decision_count: decisions.size,
    policy_sequence_range: { first: firstSequence, last: lastSequence },
    effect_count: effectCount,
    path_update_count: pathUpdateCount,
  };
  if (openingEvidence.size === 0) return { schema: 1, ...summary };
  return {
    schema: 2,
    ...summary,
    opening_evidence: Object.freeze(Object.fromEntries([...openingEvidence.entries()]
      .sort(([first], [second]) => first - second)
      .map(([seat, value]) => [String(seat), freezeOpeningEvidence(value)]))),
  };
}

function readSeatCandidates(evidence: Evidence): ReadonlyMap<number, ReplaySeatPolicy> {
  const candidates = new Map<number, ReplaySeatPolicy>();
  for (const [index, record] of evidence.records.entries()) {
    if (record.schema !== 'seat-policy-v1') continue;
    const params = record.params;
    if (typeof record.seat !== 'number' || typeof record.candidate !== 'string' || typeof record.semantic_id !== 'string'
        || params === null || typeof params !== 'object' || Array.isArray(params) || candidates.has(record.seat)) {
      throw replayFailure('invalid_seat_policy', index + 1);
    }
    if (isDuelPoolId(record.candidate) && record.candidate !== 'baseline') {
      if (record.version !== DUEL_POOL_VERSION) throw replayFailure('invalid_seat_policy', index + 1, 'version');
      const member = duelPoolMember(record.candidate);
      if (member.semanticId !== record.semantic_id) throw replayFailure('seat_policy_identity_mismatch', index + 1, 'semantic_id');
      candidates.set(record.seat, { duelPoolId: record.candidate });
      continue;
    }
    let compiled: CompiledCandidate;
    try {
      compiled = compileCandidate(record.candidate as CandidateId, params as Record<string, number>);
    } catch {
      throw replayFailure('invalid_seat_policy', index + 1, 'candidate');
    }
    if (compiled.semanticId !== record.semantic_id) throw replayFailure('seat_policy_identity_mismatch', index + 1, 'semantic_id');
    candidates.set(record.seat, compiled);
  }
  return candidates;
}

function readPreparedContext(evidence: Evidence): { readonly seats: ReadonlySet<number>; readonly mode: 'hunger_games' | 'civilization'; readonly seed: bigint } | undefined {
  let prepared: { readonly seats: ReadonlySet<number>; readonly mode: 'hunger_games' | 'civilization'; readonly seed: bigint } | undefined;
  for (const [index, record] of evidence.records.entries()) {
    if (record.direction !== 'runner' || record.type !== 'prepare') continue;
    const envelope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'direction') envelope[key] = value;
    }
    let message: ControlMessage;
    try {
      message = decodeControlEnvelope(canonicalJson(envelope));
    } catch (error) {
      throw replayFailure('invalid_policy_prepare', index + 1,
        error instanceof ControlCodecError ? error.path ?? undefined : undefined);
    }
    if (message.type !== 'prepare' || message.run_id !== evidence.run_id) {
      throw replayFailure('invalid_policy_prepare', index + 1);
    }
    if (prepared !== undefined) throw replayFailure('duplicate_policy_prepare', index + 1);
    prepared = { seats: new Set(message.payload.roster.map((competitor) => competitor.seat)), mode: message.payload.mode,
      seed: message.payload.seed };
  }
  return prepared;
}

function retainOpeningDecision(
  evidence: Map<number, MutableOpeningEvidence>,
  record: PolicyReplayRecordV3,
  recordNumber: number,
): void {
  let seat = evidence.get(record.seat);
  if (seat === undefined) {
    seat = {
      assignedStyle: record.input.opening.style,
      firstDecision: null,
      chestSightings: 0,
      chestPositions: new Map(),
      visibleOpponentObservations: 0,
      isolatedOpponentObservations: 0,
      visibleOpponents: new Map(),
      confirmedOutcomes: {
        navigation: { succeeded: 0, failed: 0, cancelled: 0 },
        loot: { succeeded: 0, failed: 0, cancelled: 0 },
        eat: { succeeded: 0, failed: 0, cancelled: 0 },
        equip: { succeeded: 0, failed: 0, cancelled: 0 },
        attack: { succeeded: 0, failed: 0, cancelled: 0 },
      },
    };
    evidence.set(record.seat, seat);
  } else if (seat.assignedStyle !== record.input.opening.style) {
    throw replayFailure('policy_opening_style_changed', recordNumber, 'input.opening.style');
  }
  seat.firstDecision ??= Object.freeze({ goal: record.decision.goal, intent: record.decision.intent });
  const observation = record.input.observation;
  if (observation.loot.kind === 'current') {
    for (const opportunity of observation.loot.value) {
      if (opportunity.kind !== 'unopenedContainer') continue;
      seat.chestSightings += 1;
      const position = freezePosition(opportunity.position);
      const key = `${position.x},${position.y},${position.z}`;
      if (seat.chestPositions.size < MAX_OPENING_EVIDENCE_OPPORTUNITIES) seat.chestPositions.set(key, position);
    }
  }
  if (observation.opponents.kind === 'current' && observation.opponents.value.length > 0) {
    seat.visibleOpponentObservations += 1;
    if (observation.opponents.value.length === 1) seat.isolatedOpponentObservations += 1;
    for (const opponent of observation.opponents.value) {
      const position = freezePosition(opponent.position);
      const key = `${opponent.id}:${position.x},${position.y},${position.z}`;
      if (seat.visibleOpponents.size < MAX_OPENING_EVIDENCE_OPPORTUNITIES) {
        seat.visibleOpponents.set(key, Object.freeze({ id: opponent.id, position, attacking_agent: opponent.attackingAgent }));
      }
    }
  }
}

function retainOpeningEffect(
  evidence: MutableOpeningEvidence | undefined,
  intent: Decision['intent'],
  outcome: SkillOutcome['kind'],
): void {
  if (evidence === undefined || outcome === 'pending' || outcome === 'progress') return;
  const action = openingActionKind(intent);
  if (action === null) return;
  evidence.confirmedOutcomes[action][outcome] += 1;
}

function openingActionKind(intent: Decision['intent']): OpeningActionKind | null {
  switch (intent.kind) {
    case 'navigate':
    case 'approach': return 'navigation';
    case 'containerOpen':
    case 'dropCollect': return 'loot';
    case 'eat': return 'eat';
    case 'equip': return 'equip';
    case 'attack': return 'attack';
    case 'hold': return null;
  }
}

function freezeOpeningEvidence(value: MutableOpeningEvidence): OpeningStyleSeatEvidence {
  const freezeCounts = (counts: { succeeded: number; failed: number; cancelled: number }) => Object.freeze({ ...counts });
  return Object.freeze({
    assigned_style: value.assignedStyle,
    first_decision: value.firstDecision,
    local_opportunities: Object.freeze({
      chest_sightings: value.chestSightings,
      chest_positions: Object.freeze([...value.chestPositions.values()]),
      visible_opponent_observations: value.visibleOpponentObservations,
      isolated_opponent_observations: value.isolatedOpponentObservations,
      visible_opponents: Object.freeze([...value.visibleOpponents.values()]),
    }),
    confirmed_outcomes: Object.freeze({
      navigation: freezeCounts(value.confirmedOutcomes.navigation),
      loot: freezeCounts(value.confirmedOutcomes.loot),
      eat: freezeCounts(value.confirmedOutcomes.eat),
      equip: freezeCounts(value.confirmedOutcomes.equip),
      attack: freezeCounts(value.confirmedOutcomes.attack),
    }),
  });
}

function freezePosition(position: Readonly<{ x: number; y: number; z: number }>): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({ x: position.x, y: position.y, z: position.z });
}

type ReplaySeatPolicy = CompiledCandidate | { readonly duelPoolId: DuelPoolId };

function isDuelPoolReplay(candidate: ReplaySeatPolicy | undefined): candidate is { readonly duelPoolId: DuelPoolId } {
  return candidate !== undefined && 'duelPoolId' in candidate;
}

function replayDecision(
  record: PolicyReplayRecord,
  recordNumber: number,
  preparedSeed?: bigint,
  candidate?: ReplaySeatPolicy,
): OpeningPolicyReplayTransition | undefined {
  if (record.schema === 'civilization-policy-replay-v1') {
    const input = strictObject(record.input);
    if (input === undefined || input.schema !== 'civilization-policy-input-v1') {
      throw replayFailure('invalid_policy_input_schema', recordNumber, 'input.schema');
    }
    assertExactFields(input, ['schema', 'context', 'observation', 'memory', 'feedback', 'params', 'rng_state'], recordNumber, 'input');
    let actual: CivilizationDecision;
    let state: bigint;
    try {
      const memory = civilizationPolicyMemory(input.memory as CivilizationPolicyMemory);
      const feedback = civilizationPolicyFeedbackBatch(input.feedback as CivilizationPolicyFeedbackBatch);
      const extension = strictObject(input.observation);
      if (extension === undefined) throw replayFailure('invalid_policy_input', recordNumber, 'input.observation');
      assertExactFields(extension, ['base', 'ownMaterials', 'observedResources', 'teamMessages'], recordNumber, 'input.observation');
      const carriesKnowledge = Object.hasOwn(strictObject(input.memory)?.policy as object ?? {}, 'knowledge');
      const base = rehydratePolicyReplayInput(carriesKnowledge
        ? { schema: 'policy-input-v4', observation: extension.base, memory: memory.policy, feedback: feedback.shared,
          params: input.params, opening: null, rng_state: input.rng_state }
        : { schema: 'policy-input-v2', observation: extension.base, memory: memory.policy, feedback: feedback.shared,
          params: input.params, rng_state: input.rng_state });
      if (base.schema !== (carriesKnowledge ? 'policy-input-v4' : 'policy-input-v2')) {
        throw replayFailure('invalid_policy_input_schema', recordNumber, 'input.schema');
      }
      const context = civilizationPolicyContext(input.context as CivilizationPolicyContextInput);
      if (context.seat !== record.seat) throw replayFailure('policy_context_seat_mismatch', recordNumber, 'input.context.seat');
      const observation = civilizationObservation({
        base: base.observation,
        ownMaterials: extension.ownMaterials as CivilizationObservationInput['ownMaterials'],
        observedResources: extension.observedResources as CivilizationObservationInput['observedResources'],
        teamMessages: extension.teamMessages as CivilizationObservationInput['teamMessages'],
      }, context);
      actual = decideCivilization(context, observation, memory, base.params, base.random, feedback);
      state = base.random.snapshotState();
    } catch (error) {
      if (error instanceof TraceError) throw error;
      throw replayFailure('invalid_policy_input', recordNumber, 'input');
    }
    if (canonicalJson(actual) !== canonicalJson(record.decision)) throw replayFailure('policy_decision_mismatch', recordNumber, 'decision');
    if (state !== parseU64Decimal(record.rng_state_after, recordNumber)) throw replayFailure('policy_rng_state_mismatch', recordNumber, 'rng_state_after');
    return;
  }
  if (record.schema === 'policy-replay-v4') {
    let restored: ReturnType<typeof rehydratePolicyReplayInput>;
    try {
      restored = rehydratePolicyReplayInput(record.input);
    } catch (error) {
      if (error instanceof TypeError && 'field' in error && typeof error.field === 'string') {
        throw replayFailure('invalid_policy_input', recordNumber, error.field);
      }
      throw error;
    }
    if (restored.schema !== 'policy-input-v4') throw replayFailure('invalid_policy_input_schema', recordNumber, 'input.schema');
    if (restored.opening === null) {
      if (record.opening_state_after !== null) {
        throw replayFailure('policy_opening_state_mismatch', recordNumber, 'opening_state_after');
      }
      const actualDecision = isDuelPoolReplay(candidate)
        ? decideDuelPool(candidate.duelPoolId, restored.observation, restored.memory, restored.random, restored.feedback)
        : candidate === undefined
        ? decide(restored.observation, restored.memory, restored.params, restored.random, restored.feedback)
        : candidate.decide(restored.observation, restored.memory, restored.random, restored.feedback);
      if (canonicalJson(actualDecision) !== canonicalJson(record.decision)) {
        throw replayFailure('policy_decision_mismatch', recordNumber, 'decision');
      }
      if (restored.random.snapshotState() !== parseU64Decimal(record.rng_state_after, recordNumber)) {
        throw replayFailure('policy_rng_state_mismatch', recordNumber, 'rng_state_after');
      }
      return undefined;
    }
    if (record.opening_state_after === null) {
      throw replayFailure('policy_opening_state_mismatch', recordNumber, 'opening_state_after');
    }
    if (preparedSeed !== undefined && restored.opening.seed !== preparedSeed) {
      throw replayFailure('policy_opening_seed_mismatch', recordNumber, 'input.opening.seed');
    }
    if (openingStyleForSeat(restored.opening.seed, record.seat, restored.opening.cycle) !== restored.opening.style) {
      throw replayFailure('policy_opening_style_mismatch', recordNumber, 'input.opening.style');
    }
    let actual: ReturnType<typeof decideOpening>;
    try {
      actual = isDuelPoolReplay(candidate)
        ? decideDuelPoolOpening(candidate.duelPoolId, restored.observation, restored.memory, restored.random, restored.feedback,
          { style: restored.opening.style, state: restored.opening.state })
        : candidate === undefined
        ? decideOpening(restored.observation, restored.memory, restored.params, restored.random, restored.feedback,
          { style: restored.opening.style, state: restored.opening.state })
        : candidate.decideOpening(restored.observation, restored.memory, restored.random, restored.feedback,
          { style: restored.opening.style, state: restored.opening.state });
    } catch {
      throw replayFailure('invalid_policy_input', recordNumber, 'input.opening');
    }
    const { openingState, ...decision } = actual;
    if (canonicalJson(decision) !== canonicalJson(record.decision)) {
      throw replayFailure('policy_decision_mismatch', recordNumber, 'decision');
    }
    let expectedOpeningState: OpeningPolicyState;
    try { expectedOpeningState = openingPolicyState(record.opening_state_after); }
    catch { throw replayFailure('invalid_policy_input', recordNumber, 'opening_state_after'); }
    if (canonicalJson(openingState) !== canonicalJson(expectedOpeningState)) {
      throw replayFailure('policy_opening_state_mismatch', recordNumber, 'opening_state_after');
    }
    if (restored.random.snapshotState() !== parseU64Decimal(record.rng_state_after, recordNumber)) {
      throw replayFailure('policy_rng_state_mismatch', recordNumber, 'rng_state_after');
    }
    return Object.freeze({ stateBefore: restored.opening.state, stateAfter: expectedOpeningState });
  }
  if (record.schema === 'policy-replay-v3') {
    let restored: ReturnType<typeof rehydratePolicyReplayInput>;
    try {
      restored = rehydratePolicyReplayInput(record.input);
    } catch (error) {
      if (error instanceof TypeError && 'field' in error && typeof error.field === 'string') {
        throw replayFailure('invalid_policy_input', recordNumber, error.field);
      }
      throw error;
    }
    if (restored.schema !== 'policy-input-v3') throw replayFailure('invalid_policy_input_schema', recordNumber, 'input.schema');
    if (preparedSeed !== undefined && restored.opening.seed !== preparedSeed) {
      throw replayFailure('policy_opening_seed_mismatch', recordNumber, 'input.opening.seed');
    }
    if (openingStyleForSeat(restored.opening.seed, record.seat, restored.opening.cycle) !== restored.opening.style) {
      throw replayFailure('policy_opening_style_mismatch', recordNumber, 'input.opening.style');
    }
    let actual: ReturnType<typeof decideOpening>;
    try {
      actual = decideOpening(restored.observation, restored.memory, restored.params, restored.random, restored.feedback,
        { style: restored.opening.style, state: restored.opening.state });
    } catch {
      throw replayFailure('invalid_policy_input', recordNumber, 'input.opening');
    }
    const { openingState, ...decision } = actual;
    if (canonicalJson(decision) !== canonicalJson(record.decision)) {
      throw replayFailure('policy_decision_mismatch', recordNumber, 'decision');
    }
    let expectedOpeningState: OpeningPolicyState;
    try { expectedOpeningState = openingPolicyState(record.opening_state_after); }
    catch { throw replayFailure('invalid_policy_input', recordNumber, 'opening_state_after'); }
    if (canonicalJson(openingState) !== canonicalJson(expectedOpeningState)) {
      throw replayFailure('policy_opening_state_mismatch', recordNumber, 'opening_state_after');
    }
    if (restored.random.snapshotState() !== parseU64Decimal(record.rng_state_after, recordNumber)) {
      throw replayFailure('policy_rng_state_mismatch', recordNumber, 'rng_state_after');
    }
    return Object.freeze({ stateBefore: restored.opening.state, stateAfter: expectedOpeningState });
  }
  let restored: ReturnType<typeof rehydratePolicyReplayInput>;
  try {
    restored = rehydratePolicyReplayInput(record.input);
  } catch (error) {
    if (error instanceof TypeError && 'field' in error && typeof error.field === 'string') {
      throw replayFailure('invalid_policy_input', recordNumber, error.field);
    }
    throw error;
  }

  if ((record.schema === 'policy-replay-v1') !== (restored.schema === 'policy-input-v1')) {
    throw replayFailure('invalid_policy_input_schema', recordNumber, 'input.schema');
  }
  const actualDecision = restored.schema === 'policy-input-v1'
    ? decidePolicyReplayV1(restored.observation, restored.memory, restored.params, restored.random)
    : decide(restored.observation, restored.memory, restored.params, restored.random, restored.feedback);
  if (canonicalJson(actualDecision) !== canonicalJson(record.decision)) {
    throw replayFailure('policy_decision_mismatch', recordNumber, 'decision');
  }
  const expectedRngState = parseU64Decimal(record.rng_state_after, recordNumber);
  if (restored.random.snapshotState() !== expectedRngState) {
    throw replayFailure('policy_rng_state_mismatch', recordNumber, 'rng_state_after');
  }
  return undefined;
}

function hasOpeningInput(record: PolicyReplayRecord): record is PolicyReplayRecordV3 | PolicyReplayRecordV4 {
  return record.schema === 'policy-replay-v3'
    || (record.schema === 'policy-replay-v4' && record.input.opening !== null);
}

function readPolicyDecision(record: TraceRecord, recordNumber: number): PolicyReplayRecord {
  const isV2 = record.schema === 'policy-replay-v2' || record.schema === 'civilization-policy-replay-v1';
  const isV3 = record.schema === 'policy-replay-v3';
  const isV4 = record.schema === 'policy-replay-v4';
  const expected = isV3 || isV4 ? [...POLICY_DECISION_FIELDS, 'disposition', 'opening_state_after']
    : isV2 ? [...POLICY_DECISION_FIELDS, 'disposition'] : POLICY_DECISION_FIELDS;
  assertExactFields(record, expected, recordNumber);
  const sequence = parseSequence(record.sequence, 'sequence', recordNumber).toString(10);
  if (typeof record.seat !== 'number' || !Number.isSafeInteger(record.seat) || record.seat < 0 || record.seat > 255) {
    throw replayFailure('invalid_policy_seat', recordNumber, 'seat');
  }
  if (typeof record.rng_state_after !== 'string') {
    throw replayFailure('invalid_policy_rng_state', recordNumber, 'rng_state_after');
  }
  parseU64Decimal(record.rng_state_after, recordNumber);
  const base: PolicyReplayRecordV1 = {
    schema: 'policy-replay-v1',
    sequence,
    seat: record.seat,
    input: record.input as unknown as PolicyReplayInputV1,
    decision: record.decision as unknown as DecisionV1,
    rng_state_after: record.rng_state_after,
  };
  if (record.schema === 'civilization-policy-replay-v1') {
    return { ...base, schema: 'civilization-policy-replay-v1', input: record.input as unknown as CivilizationPolicyReplayInputV1,
      decision: record.decision as unknown as CivilizationDecision, disposition: readDisposition(record.disposition, recordNumber) };
  }
  if (isV4) {
    return { ...base, schema: 'policy-replay-v4', input: record.input as unknown as PolicyReplayInputV4,
      decision: record.decision as unknown as Decision, disposition: readDisposition(record.disposition, recordNumber),
      opening_state_after: record.opening_state_after as unknown as OpeningPolicyState | null };
  }
  if (isV3) {
    return { ...base, schema: 'policy-replay-v3', input: record.input as unknown as PolicyReplayInputV3,
      decision: record.decision as unknown as Decision, disposition: readDisposition(record.disposition, recordNumber),
      opening_state_after: record.opening_state_after as unknown as OpeningPolicyState };
  }
  return isV2 ? { ...base, input: record.input as unknown as PolicyReplayInputV2, decision: record.decision as unknown as Decision, schema: 'policy-replay-v2', disposition: readDisposition(record.disposition, recordNumber) } : base;
}

function validateActionDecision(
  record: PolicyReplayRecordV2 | PolicyReplayRecordV3 | PolicyReplayRecordV4 | CivilizationPolicyReplayRecordV1,
  active: Map<number, string>,
  owners: Map<string, number>,
  effects: ReadonlySet<string>,
  recordNumber: number,
): void {
  const disposition = record.disposition;
  const previous = active.get(record.seat);
  if (disposition.kind === 'hold') {
    if (record.decision.intent.kind !== 'hold' || previous !== undefined) {
      throw replayFailure('invalid_policy_hold_disposition', recordNumber, 'disposition');
    }
    return;
  }
  if (disposition.kind === 'start' || disposition.kind === 'replace') {
    if (record.decision.intent.kind === 'hold' || disposition.action_sequence !== record.sequence) {
      throw replayFailure('invalid_policy_action_identity', recordNumber, 'disposition.action_sequence');
    }
    if (disposition.kind === 'start' ? previous !== undefined : previous !== disposition.replaces_action_sequence) {
      throw replayFailure('unmatched_policy_action', recordNumber, 'disposition');
    }
    active.set(record.seat, record.sequence);
    owners.set(record.sequence, record.seat);
    return;
  }
  if (previous !== disposition.action_sequence || owners.get(disposition.action_sequence) !== record.seat
      || effects.has(disposition.action_sequence)) {
    throw replayFailure('unmatched_policy_action', recordNumber, 'disposition.action_sequence');
  }
}

function readDisposition(value: unknown, recordNumber: number | undefined): PolicyDisposition {
  const object = strictObject(value);
  const fail = (): never => { throw replayFailure('invalid_policy_disposition', recordNumber, 'disposition'); };
  if (object === undefined) return fail();
  const exact = (fields: string[]): void => {
    if (Object.keys(object).length !== fields.length || fields.some((field) => !Object.hasOwn(object, field))) fail();
  };
  if (object.kind === 'hold') { exact(['kind']); return { kind: 'hold' }; }
  const action_sequence = parseSequence(object.action_sequence, 'action_sequence', recordNumber).toString();
  switch (object.kind) {
    case 'start':
    case 'continue':
      exact(['kind', 'action_sequence']);
      return { kind: object.kind, action_sequence };
    case 'defer':
      exact(['kind', 'action_sequence', 'reason']);
      if (object.reason !== 'lowerPriority' && object.reason !== 'hysteresis' && object.reason !== 'cleanupPending' && object.reason !== 'goalPersistence') return fail();
      return { kind: 'defer', action_sequence, reason: object.reason };
    case 'replace': {
      exact(['kind', 'action_sequence', 'replaces_action_sequence', 'reason']);
      if (object.reason !== 'higherPriority' && object.reason !== 'targetChanged') return fail();
      const replaces_action_sequence = parseSequence(object.replaces_action_sequence, 'replaces_action_sequence', recordNumber).toString();
      return { kind: 'replace', action_sequence, replaces_action_sequence, reason: object.reason };
    }
    default: return fail();
  }
}

function readPolicyEffect(record: TraceRecord, recordNumber: number): PolicyEffectRecord {
  assertExactFields(record, POLICY_EFFECT_FIELDS, recordNumber);
  const decisionSequence = parseSequence(record.decision_sequence, 'decision_sequence', recordNumber).toString(10);
  const skill = readSkillOutcome(record.skill, recordNumber);
  if (!Array.isArray(record.path_updates) || record.path_updates.length > 1) {
    throw replayFailure('invalid_policy_path_updates', recordNumber, 'path_updates');
  }
  const pathUpdates = record.path_updates.map((update, index) => readPathUpdate(update, recordNumber, index));
  return {
    schema: record.schema === 'civilization-policy-effect-v1' ? 'civilization-policy-effect-v1' : 'policy-effect-v1',
    decision_sequence: decisionSequence,
    skill,
    path_updates: pathUpdates,
  };
}

function readSkillOutcome(value: unknown, recordNumber: number): SkillOutcome {
  const object = strictObject(value);
  if (object === undefined || typeof object.kind !== 'string') {
    throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill');
  }
  switch (object.kind) {
    case 'pending':
    case 'succeeded':
      assertExactFields(object, ['kind'], recordNumber, 'skill');
      return { kind: object.kind };
    case 'progress': {
      assertExactFields(object, ['kind', 'progress'], recordNumber, 'skill');
      const progress = strictObject(object.progress);
      if (progress === undefined) throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.progress');
      assertExactFields(progress, ['completedSteps', 'totalSteps'], recordNumber, 'skill.progress');
      const { completedSteps, totalSteps } = progress;
      if (!Number.isSafeInteger(completedSteps) || !Number.isSafeInteger(totalSteps)
          || (completedSteps as number) <= 0 || (totalSteps as number) <= (completedSteps as number)
          || (totalSteps as number) > 65_535) {
        throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.progress');
      }
      return { kind: 'progress', progress: { completedSteps: completedSteps as number, totalSteps: totalSteps as number } };
    }
    case 'failed':
      assertExactFields(object, ['kind', 'cause'], recordNumber, 'skill');
      if (typeof object.cause !== 'string' || !SKILL_FAILURES.has(object.cause)) {
        throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.cause');
      }
      return { kind: 'failed', cause: object.cause as SkillFailure };
    case 'cancelled':
      assertExactFields(object, ['kind', 'reason'], recordNumber, 'skill');
      if (typeof object.reason !== 'string' || !SKILL_CANCELLATIONS.has(object.reason)) {
        throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.reason');
      }
      return { kind: 'cancelled', reason: object.reason as SkillCancellation };
    default:
      throw replayFailure('invalid_policy_skill_outcome', recordNumber, 'skill.kind');
  }
}

function readPathUpdate(value: unknown, recordNumber: number, index: number): PolicyPathUpdate {
  const object = strictObject(value);
  if (object === undefined) throw replayFailure('invalid_policy_path_update', recordNumber, `path_updates[${index}]`);
  assertExactFields(object, ['status', 'path'], recordNumber, `path_updates[${index}]`);
  if (typeof object.status !== 'string' || !PATH_UPDATE_STATUSES.has(object.status)) {
    throw replayFailure('invalid_policy_path_status', recordNumber, `path_updates[${index}].status`);
  }
  if (!Array.isArray(object.path)) throw replayFailure('invalid_policy_path', recordNumber, `path_updates[${index}].path`);
  const path = object.path.map((point, pointIndex) => {
    const position = strictObject(point);
    const field = `path_updates[${index}].path[${pointIndex}]`;
    if (position === undefined) throw replayFailure('invalid_policy_path_position', recordNumber, field);
    assertExactFields(position, ['x', 'y', 'z'], recordNumber, field);
    for (const coordinate of ['x', 'y', 'z'] as const) {
      if (!isTracePathCoordinate(position[coordinate])) {
        throw replayFailure('invalid_policy_path_position', recordNumber, `${field}.${coordinate}`);
      }
    }
    return { x: position.x as number, y: position.y as number, z: position.z as number };
  });
  return { status: object.status as PolicyPathUpdate['status'], path };
}

function copySkillOutcome(skill: SkillOutcome): SkillOutcome {
  switch (skill.kind) {
    case 'pending':
    case 'succeeded':
      assertProducerFields(skill, ['kind']);
      return Object.freeze({ kind: skill.kind });
    case 'progress':
      assertProducerFields(skill, ['kind', 'progress']);
      assertProducerFields(skill.progress, ['completedSteps', 'totalSteps']);
      if (!Number.isSafeInteger(skill.progress.completedSteps) || !Number.isSafeInteger(skill.progress.totalSteps)
          || skill.progress.completedSteps <= 0 || skill.progress.completedSteps >= skill.progress.totalSteps
          || skill.progress.totalSteps > 65_535) throw new TypeError('invalid skill progress outcome');
      return Object.freeze({ kind: 'progress', progress: Object.freeze({ ...skill.progress }) });
    case 'failed':
      assertProducerFields(skill, ['kind', 'cause']);
      if (!SKILL_FAILURES.has(skill.cause)) throw new TypeError('invalid skill failure outcome');
      return Object.freeze({ kind: 'failed', cause: skill.cause });
    case 'cancelled':
      assertProducerFields(skill, ['kind', 'reason']);
      if (!SKILL_CANCELLATIONS.has(skill.reason)) throw new TypeError('invalid skill cancellation outcome');
      return Object.freeze({ kind: 'cancelled', reason: skill.reason });
    default:
      throw new TypeError('unknown skill outcome kind');
  }
}

function copyPathUpdate(update: PolicyPathUpdate): PolicyPathUpdate {
  if (!PATH_UPDATE_STATUSES.has(update.status)) throw new TypeError('invalid path update status');
  return Object.freeze({
    status: update.status,
    path: Object.freeze(update.path.map((position) => {
      for (const coordinate of [position.x, position.y, position.z]) {
        if (!isTracePathCoordinate(coordinate)) {
          throw new TypeError('path position coordinates must be finite and JSON-safe numbers');
        }
      }
      return Object.freeze({ x: position.x, y: position.y, z: position.z });
    })),
  });
}

function isTracePathCoordinate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function assertSeat(seat: number): void {
  if (!Number.isSafeInteger(seat) || seat < 0 || seat > 255) throw new RangeError('policy seat must be a u8');
}

function assertProducerFields(value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('skill outcome has an invalid shape');
  }
}

function assertU64(value: bigint, field: string): void {
  if (value < 0n || value > MAX_U64) throw new RangeError(`${field} must be a u64`);
}

function assertSequence(value: bigint, field: string): void {
  assertU64(value, field);
  if (value === 0n) throw new RangeError(`${field} must be positive`);
}

function parseSequence(value: unknown, field: string, record?: number): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw replayFailure(`invalid_policy_${field}`, record, field);
  }
  const sequence = BigInt(value);
  if (sequence === 0n || sequence > MAX_U64) throw replayFailure(`invalid_policy_${field}`, record, field);
  return sequence;
}

function parseU64Decimal(value: unknown, recordNumber: number): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw replayFailure('invalid_policy_rng_state', recordNumber, 'rng_state_after');
  }
  const state = BigInt(value);
  if (state > MAX_U64) throw replayFailure('invalid_policy_rng_state', recordNumber, 'rng_state_after');
  return state;
}

function assertExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  record: number,
  prefix?: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw replayFailure('invalid_policy_record_shape', record, prefix);
  }
}

function strictObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function replayFailure(kind: string, record?: number, field?: string): TraceError {
  return new TraceError({ kind, ...(record === undefined ? {} : { record }), ...(field === undefined ? {} : { field }) });
}

