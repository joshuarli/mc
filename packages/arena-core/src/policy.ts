import {
  blockPosition,
  borderCenter,
  compareBlockPositions,
  isNearOrOutsideBorder,
  manhattanDistance,
  offsetBlockPosition,
  squaredDistance,
  type BlockPosition,
} from './geometry.js';
import {
  assertValidatedAgentObservation,
  entityId,
  inventorySlot,
  knownArmor,
  knownFood,
  knownWeapon,
  lootTarget,
  tick,
  type AgentObservation,
  type AgentState,
  type EntityId,
  type EquipmentSlot,
  type EquipmentUpgrade,
  type InventorySlot,
  type KnownItem,
  type Knowledge,
  type LootOpportunity,
  type LootTarget,
  type Tick,
  type VisibleOpponent,
  unopenedContainer,
  visibleDrop,
} from './observation.js';
import type { SkillFailure, SkillOutcome } from './outcome.js';
import { DeterministicRandom } from './random.js';

const MAX_HEALTH_HALF_HEARTS = 40;
const MAX_HUNGER_POINTS = 20;
const MAX_BORDER_MARGIN_BLOCKS = 8;
const MAX_FIGHT_RANGE_BLOCKS = 8;
const MAX_OPPONENT_MEMORY_TICKS = 100;
const MAX_LOOT_HYSTERESIS_BLOCKS = 16;
const MAX_SEARCH_RADIUS_BLOCKS = 16;
const MELEE_REACH_BLOCKS = 3;
const LOOT_INTERACTION_DISTANCE_BLOCKS = 3n;
const MAX_REMEMBERED_FAILED_TARGETS = 16;
const MAX_POLICY_FEEDBACKS = 2;
const FAILED_EXPLORATION_APPROACH_BLOCKS = 8n;

export type PolicyParameterVersion = 1;

export interface PolicyParamValues {
  readonly version: PolicyParameterVersion;
  readonly eatAtHungerOrBelow: number;
  readonly retreatAtHealthHalfHeartsOrBelow: number;
  readonly borderMarginBlocks: number;
  readonly fightRangeBlocks: number;
  readonly opponentMemoryTicks: number;
  readonly lootHysteresisBlocks: number;
  readonly searchRadiusBlocks: number;
}

export type InvalidPolicyParamsCode =
  | 'unsupported-version'
  | 'hunger-threshold-out-of-range'
  | 'retreat-threshold-out-of-range'
  | 'border-margin-out-of-range'
  | 'fight-range-out-of-range'
  | 'opponent-memory-out-of-range'
  | 'loot-hysteresis-out-of-range'
  | 'search-radius-out-of-range';

export class InvalidPolicyParamsError extends RangeError {
  constructor(readonly code: InvalidPolicyParamsCode) {
    super(`invalid policy parameters: ${code}`);
    this.name = 'InvalidPolicyParamsError';
  }
}

export class PolicyParams {
  readonly values: PolicyParamValues;

  private constructor(values: PolicyParamValues) {
    this.values = Object.freeze({ ...values });
  }

  static create(values: PolicyParamValues): PolicyParams {
    assertExactKeys(values, [
      'version',
      'eatAtHungerOrBelow',
      'retreatAtHealthHalfHeartsOrBelow',
      'borderMarginBlocks',
      'fightRangeBlocks',
      'opponentMemoryTicks',
      'lootHysteresisBlocks',
      'searchRadiusBlocks',
    ]);
    if (values.version !== 1) {
      throw new InvalidPolicyParamsError('unsupported-version');
    }
    if (!isIntegerInRange(values.eatAtHungerOrBelow, 1, MAX_HUNGER_POINTS)) {
      throw new InvalidPolicyParamsError('hunger-threshold-out-of-range');
    }
    if (!isIntegerInRange(values.retreatAtHealthHalfHeartsOrBelow, 1, MAX_HEALTH_HALF_HEARTS - 1)) {
      throw new InvalidPolicyParamsError('retreat-threshold-out-of-range');
    }
    if (!isIntegerInRange(values.borderMarginBlocks, 0, MAX_BORDER_MARGIN_BLOCKS)) {
      throw new InvalidPolicyParamsError('border-margin-out-of-range');
    }
    if (!isIntegerInRange(values.fightRangeBlocks, 1, MAX_FIGHT_RANGE_BLOCKS)) {
      throw new InvalidPolicyParamsError('fight-range-out-of-range');
    }
    if (!isIntegerInRange(values.opponentMemoryTicks, 1, MAX_OPPONENT_MEMORY_TICKS)) {
      throw new InvalidPolicyParamsError('opponent-memory-out-of-range');
    }
    if (!isIntegerInRange(values.lootHysteresisBlocks, 0, MAX_LOOT_HYSTERESIS_BLOCKS)) {
      throw new InvalidPolicyParamsError('loot-hysteresis-out-of-range');
    }
    if (!isIntegerInRange(values.searchRadiusBlocks, 1, MAX_SEARCH_RADIUS_BLOCKS)) {
      throw new InvalidPolicyParamsError('search-radius-out-of-range');
    }
    return new PolicyParams(values);
  }

  static baseline(): PolicyParams {
    return PolicyParams.create({
      version: 1,
      eatAtHungerOrBelow: 8,
      retreatAtHealthHalfHeartsOrBelow: 8,
      borderMarginBlocks: 2,
      fightRangeBlocks: 4,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 2,
      searchRadiusBlocks: 8,
    });
  }
}

export type WaitReason =
  | 'agentStateUnknown'
  | 'agentStateStale'
  | 'agentEliminated'
  | 'borderUnknown'
  | 'borderStale'
  | 'unrepresentableTarget'
  | 'failedTargetsExhausted';

export type Goal =
  | { readonly kind: 'escapeBorder' }
  | { readonly kind: 'recoverHunger' }
  | {
    readonly kind: 'improveEquipment';
    readonly inventorySlot: InventorySlot;
    readonly equipmentSlot: EquipmentSlot;
    readonly rating: number;
  }
  | { readonly kind: 'engageVisibleOpponent'; readonly target: EntityId }
  | { readonly kind: 'retreatFromOpponent'; readonly target: EntityId }
  | { readonly kind: 'loot'; readonly target: LootTarget }
  | { readonly kind: 'searchLastKnown'; readonly target: EntityId }
  | { readonly kind: 'explore' }
  | { readonly kind: 'wait'; readonly reason: WaitReason };

export type Intent =
  | { readonly kind: 'navigate'; readonly target: BlockPosition }
  | { readonly kind: 'eat'; readonly inventorySlot: InventorySlot }
  | {
    readonly kind: 'equip';
    readonly inventorySlot: InventorySlot;
    readonly equipmentSlot: EquipmentSlot;
    readonly rating: number;
  }
  | { readonly kind: 'approach'; readonly target: EntityId }
  | { readonly kind: 'attack'; readonly target: EntityId }
  | { readonly kind: 'dropCollect'; readonly entityId: EntityId }
  | { readonly kind: 'containerOpen'; readonly position: BlockPosition }
  | { readonly kind: 'hold'; readonly reason: WaitReason };

export interface RememberedOpponent {
  readonly id: EntityId;
  readonly position: BlockPosition;
  readonly observedAt: Tick;
}

export type FailedTargetEvidence =
  | {
    readonly kind: 'loot';
    readonly target: LootTarget;
    readonly opportunity: LootOpportunity;
  }
  | {
    readonly kind: 'searchLastKnown';
    readonly target: EntityId;
    readonly position: BlockPosition;
    readonly opponent: SearchOpponentEvidence;
  }
  | {
    readonly kind: 'explore';
    readonly target: BlockPosition;
    readonly origin: BlockPosition;
  };

export type PolicyFeedback =
  | { readonly kind: 'succeeded'; readonly target: FailedTargetEvidence }
  | { readonly kind: 'failed'; readonly target: FailedTargetEvidence; readonly cause: SkillFailure };

export type PolicyFeedbackBatch = readonly PolicyFeedback[];

export interface PolicyFeedbackSource {
  readonly initiatingObservation: AgentObservation;
  readonly goal: Goal;
  readonly intent: Intent;
  readonly outcome: SkillOutcome;
}

export type SearchOpponentEvidence =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'absent' }
  | {
    readonly kind: 'observed';
    readonly position: BlockPosition;
  };

export interface PolicyMemory {
  readonly lastGoal: Goal | null;
  readonly lastOpponent: RememberedOpponent | null;
  readonly failedTargets: readonly FailedTargetEvidence[];
}

export interface PolicyMemoryInput {
  readonly lastGoal: Goal | null;
  readonly lastOpponent: RememberedOpponent | null;
  readonly failedTargets: readonly FailedTargetEvidence[];
}

export interface PolicyMemoryInputV1 {
  readonly lastGoal: Goal | null;
  readonly lastOpponent: RememberedOpponent | null;
}

export interface DecisionV1 {
  readonly goal: Goal;
  readonly intent: Intent;
  readonly memory: PolicyMemoryInputV1;
}

type DecisionSemantics = 'policy-input-v1' | 'policy-input-v2';

export function emptyPolicyMemory(): PolicyMemory {
  return Object.freeze({ lastGoal: null, lastOpponent: null, failedTargets: Object.freeze([]) });
}

export function policyMemory(input: PolicyMemoryInput): PolicyMemory {
  assertExactKeys(input, ['lastGoal', 'lastOpponent', 'failedTargets']);
  const lastGoal = input.lastGoal === null ? null : cloneGoal(input.lastGoal);
  let lastOpponent: RememberedOpponent | null = null;
  if (input.lastOpponent !== null) {
    assertExactKeys(input.lastOpponent, ['id', 'position', 'observedAt']);
    lastOpponent = Object.freeze({
      id: entityId(input.lastOpponent.id),
      position: freezePosition(input.lastOpponent.position),
      observedAt: tick(input.lastOpponent.observedAt),
    });
  }
  if (!Array.isArray(input.failedTargets) || input.failedTargets.length > MAX_REMEMBERED_FAILED_TARGETS) {
    throw new RangeError(`policy memory can hold at most ${MAX_REMEMBERED_FAILED_TARGETS} failed targets`);
  }
  assertDenseArray(input.failedTargets, 'policy memory failedTargets');
  const failedTargets = input.failedTargets.map(cloneFailedTargetEvidence);
  for (let index = 0; index < failedTargets.length; index += 1) {
    const candidate = failedTargets[index]!;
    if (failedTargets.slice(0, index).some((existing) => sameFailedTarget(existing, candidate))) {
      throw new TypeError('policy memory cannot contain duplicate failed targets');
    }
  }
  return Object.freeze({ lastGoal, lastOpponent, failedTargets: Object.freeze(failedTargets) });
}

/** Rehydrates the old memory shape only for historical policy-input-v1 replay. */
export function policyMemoryV1(input: PolicyMemoryInputV1): PolicyMemoryInputV1 {
  assertExactKeys(input, ['lastGoal', 'lastOpponent']);
  const memory = policyMemory({ ...input, failedTargets: [] });
  if (memory.lastGoal?.kind === 'wait' && memory.lastGoal.reason === 'failedTargetsExhausted') {
    throw new TypeError('policy-input-v1 does not support failedTargetsExhausted');
  }
  return Object.freeze({ lastGoal: memory.lastGoal, lastOpponent: memory.lastOpponent });
}

/**
 * Copies a settlement-ordered batch of completed skill feedback. The runtime may
 * include at most two completions between strategy decisions; overflow is invalid.
 */
export function policyFeedbackBatch(input: readonly PolicyFeedback[]): PolicyFeedbackBatch {
  if (!Array.isArray(input) || input.length > MAX_POLICY_FEEDBACKS) {
    throw new RangeError(`policy feedback can contain at most ${MAX_POLICY_FEEDBACKS} outcomes`);
  }
  assertDenseArray(input, 'policy feedback');
  return Object.freeze(input.map(clonePolicyFeedback));
}

/**
 * Converts one completed local skill result into target feedback using only the
 * observation that initiated it and the originating policy goal and intent.
 * Cancellation and goals without a suppressible navigation target have no effect.
 */
export function createPolicyFeedback(source: PolicyFeedbackSource): PolicyFeedback | null {
  assertExactKeys(source, ['initiatingObservation', 'goal', 'intent', 'outcome']);
  assertValidatedAgentObservation(source.initiatingObservation);
  const goal = cloneGoal(source.goal);
  const intent = cloneIntent(source.intent);
  if (source.outcome.kind === 'cancelled') {
    assertExactKeys(source.outcome, ['kind', 'reason']);
    validateSkillCancellation(source.outcome.reason);
    return null;
  }
  if (source.outcome.kind !== 'failed' && source.outcome.kind !== 'succeeded') {
    throw new TypeError('policy feedback requires a completed skill outcome');
  }
  if (source.outcome.kind === 'succeeded') {
    assertExactKeys(source.outcome, ['kind']);
  } else {
    assertExactKeys(source.outcome, ['kind', 'cause']);
  }

  const target = feedbackTarget(source.initiatingObservation, goal, intent);
  if (target === null) return null;
  return source.outcome.kind === 'succeeded'
    ? Object.freeze({ kind: 'succeeded', target })
    : Object.freeze({ kind: 'failed', target, cause: validateSkillFailure(source.outcome.cause) });
}

export interface Decision {
  readonly goal: Goal;
  readonly intent: Intent;
  readonly memory: PolicyMemory;
}

interface LootChoice {
  readonly opportunity: LootOpportunity;
  readonly target: LootTarget;
  readonly utility: number;
  readonly distance: bigint;
}

export function decide(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): Decision {
  return decideWithSemantics(observation, memory, params, random, feedback, 'policy-input-v2');
}

function decideWithSemantics(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
  semantics: DecisionSemantics,
): Decision {
  assertValidatedAgentObservation(observation);
  let nextMemory = applyPolicyFeedback(policyMemory(memory), policyFeedbackBatch(feedback));
  nextMemory = pruneChangedFailedTargets(observation, nextMemory);
  const agent = currentValue(observation.agent);
  if (agent === null) {
    const reason = observation.agent.kind === 'unknown' ? 'agentStateUnknown' : 'agentStateStale';
    return waitDecision(reason, nextMemory);
  }
  if (agent.healthHalfHearts === 0) {
    return waitDecision('agentEliminated', nextMemory);
  }

  const border = currentValue(observation.border);
  if (border === null) {
    const reason = observation.border.kind === 'unknown' ? 'borderUnknown' : 'borderStale';
    return waitDecision(reason, nextMemory);
  }

  let currentMemory = nextMemory;
  const currentOpponents = currentValue(observation.opponents);
  if (currentOpponents !== null && currentOpponents.length > 0) {
    const nearest = nearestOpponent(agent.position, currentOpponents);
    currentMemory = policyMemory({
      ...currentMemory,
      lastOpponent: Object.freeze({ id: nearest.id, position: nearest.position, observedAt: observation.tick }),
    });
  }

  if (isNearOrOutsideBorder(border, agent.position, params.values.borderMarginBlocks)) {
    const goal: Goal = Object.freeze({ kind: 'escapeBorder' });
    return finish(goal, { kind: 'navigate', target: borderCenter(border, agent.position.y) }, {
      ...currentMemory,
      lastGoal: goal,
    });
  }

  const nearestThreat = nearestKnownThreat(observation, currentMemory, params.values, agent);
  if (agent.healthHalfHearts <= params.values.retreatAtHealthHalfHeartsOrBelow && nearestThreat !== null) {
    const tieBit = nearestThreat.id % 2 === 1;
    const retreat = retreatTarget(agent.position, nearestThreat.position, tieBit);
    if (retreat.ok === false) {
      return waitDecision('unrepresentableTarget', currentMemory);
    }
    const goal: Goal = Object.freeze({ kind: 'retreatFromOpponent', target: nearestThreat.id });
    return finish(goal, { kind: 'navigate', target: retreat.value }, {
      ...currentMemory,
      lastGoal: goal,
    });
  }

  const food = lowestInventorySlot(agent.foodStacks);
  if (isSafeToEat(observation, currentMemory, params.values, agent)
      && agent.hungerPoints <= params.values.eatAtHungerOrBelow
      && food !== null) {
    const goal: Goal = Object.freeze({ kind: 'recoverHunger' });
    return finish(goal, { kind: 'eat', inventorySlot: food.inventorySlot }, {
      ...currentMemory,
      lastGoal: goal,
    });
  }

  const upgrade = bestUpgrade(agent);
  if (upgrade !== null) {
    const goal: Goal = Object.freeze({
      kind: 'improveEquipment',
      inventorySlot: upgrade.inventorySlot,
      equipmentSlot: upgrade.equipmentSlot,
      rating: upgrade.rating,
    });
    return finish(goal, {
      kind: 'equip',
      inventorySlot: upgrade.inventorySlot,
      equipmentSlot: upgrade.equipmentSlot,
      rating: upgrade.rating,
    }, { ...currentMemory, lastGoal: goal });
  }

  const opponent = currentOpponents === null || currentOpponents.length === 0
    ? null
    : nearestOpponent(agent.position, currentOpponents);
  if (opponent !== null
      && agent.healthHalfHearts > params.values.retreatAtHealthHalfHeartsOrBelow
      && squaredDistance(agent.position, opponent.position) <= BigInt(params.values.fightRangeBlocks) ** 2n) {
    const goal: Goal = Object.freeze({ kind: 'engageVisibleOpponent', target: opponent.id });
    const intent: Intent = squaredDistance(agent.position, opponent.position) <= BigInt(MELEE_REACH_BLOCKS) ** 2n
      ? { kind: 'attack', target: opponent.id }
      : { kind: 'approach', target: opponent.id };
    return finish(goal, intent, { ...currentMemory, lastGoal: goal });
  }

  const loot = selectLoot(observation, currentMemory, agent, params.values);
  if (loot !== null) {
    const goal: Goal = Object.freeze({ kind: 'loot', target: loot.target });
    let intent: Intent;
    if (loot.distance > LOOT_INTERACTION_DISTANCE_BLOCKS) {
      intent = { kind: 'navigate', target: loot.opportunity.position };
    } else if (loot.opportunity.kind === 'visibleDrop') {
      intent = { kind: 'dropCollect', entityId: loot.opportunity.entityId };
    } else {
      intent = { kind: 'containerOpen', position: loot.opportunity.position };
    }
    return finish(goal, intent, { ...currentMemory, lastGoal: goal });
  }

  const remembered = rememberedOpponent(observation, currentMemory, params.values.opponentMemoryTicks);
  if (remembered !== null && !isFailedSearchTarget(currentMemory, remembered)) {
    const goal: Goal = Object.freeze({ kind: 'searchLastKnown', target: remembered.id });
    return finish(goal, { kind: 'navigate', target: remembered.position }, {
      ...currentMemory,
      lastGoal: goal,
    });
  }

  const exploration = explorationTarget(
    agent.position,
    params.values.searchRadiusBlocks,
    currentMemory,
    random,
    semantics,
  );
  if (exploration.ok === false) {
    return waitDecision(exploration.reason, currentMemory);
  }
  const goal: Goal = Object.freeze({ kind: 'explore' });
  return finish(goal, { kind: 'navigate', target: exploration.value }, {
    ...currentMemory,
    lastGoal: goal,
  });
}

/** Replays the former decision contract without feeding skill results into policy. */
export function decidePolicyReplayV1(
  observation: AgentObservation,
  memory: PolicyMemoryInputV1,
  params: PolicyParams,
  random: DeterministicRandom,
): DecisionV1 {
  const decision = decideWithSemantics(
    observation,
    policyMemory({ ...policyMemoryV1(memory), failedTargets: [] }),
    params,
    random,
    [],
    'policy-input-v1',
  );
  return Object.freeze({
    goal: decision.goal,
    intent: decision.intent,
    memory: Object.freeze({ lastGoal: decision.memory.lastGoal, lastOpponent: decision.memory.lastOpponent }),
  });
}

function finish(goal: Goal, intent: Intent, memory: PolicyMemoryInput): Decision {
  return Object.freeze({ goal, intent: freezeIntent(intent), memory: policyMemory(memory) });
}

function waitDecision(reason: WaitReason, memory: PolicyMemory): Decision {
  const goal: Goal = Object.freeze({ kind: 'wait', reason });
  return finish(goal, { kind: 'hold', reason }, memory);
}

function feedbackTarget(
  observation: AgentObservation,
  goal: Goal,
  intent: Intent,
): FailedTargetEvidence | null {
  if (goal.kind === 'loot') {
    if (intent.kind !== 'navigate' && intent.kind !== 'dropCollect' && intent.kind !== 'containerOpen') {
      throw new TypeError('loot feedback requires a loot intent');
    }
    const opportunities = currentValue(observation.loot);
    const opportunity = opportunities?.find((candidate) => sameLootTarget(lootTarget(candidate), goal.target));
    if (opportunity === undefined) {
      throw new TypeError('loot feedback target is absent from its initiating observation');
    }
    if (!lootIntentMatches(opportunity, intent)) {
      throw new TypeError('loot feedback intent does not match its target');
    }
    return cloneFailedTargetEvidence({
      kind: 'loot',
      target: goal.target,
      opportunity,
    });
  }
  if (goal.kind === 'searchLastKnown') {
    if (intent.kind !== 'navigate') {
      throw new TypeError('last-known target feedback requires navigation');
    }
    return cloneFailedTargetEvidence({
      kind: 'searchLastKnown',
      target: goal.target,
      position: intent.target,
      opponent: searchOpponentEvidence(observation, goal.target),
    });
  }
  if (goal.kind === 'explore') {
    if (intent.kind !== 'navigate') {
      throw new TypeError('exploration feedback requires navigation');
    }
    const agent = currentValue(observation.agent);
    if (agent === null) {
      throw new TypeError('exploration feedback requires current self position');
    }
    return cloneFailedTargetEvidence({
      kind: 'explore',
      target: intent.target,
      origin: agent.position,
    });
  }
  return null;
}

function lootIntentMatches(opportunity: LootOpportunity, intent: Intent): boolean {
  if (opportunity.kind === 'visibleDrop') {
    return intent.kind === 'navigate'
      ? samePosition(intent.target, opportunity.position)
      : intent.kind === 'dropCollect' && intent.entityId === opportunity.entityId;
  }
  return intent.kind === 'navigate'
    ? samePosition(intent.target, opportunity.position)
    : intent.kind === 'containerOpen' && samePosition(intent.position, opportunity.position);
}

function clonePolicyFeedback(feedback: PolicyFeedback): PolicyFeedback {
  if (feedback.kind === 'succeeded') {
    assertExactKeys(feedback, ['kind', 'target']);
    return Object.freeze({ kind: 'succeeded', target: cloneFailedTargetEvidence(feedback.target) });
  }
  if (feedback.kind === 'failed') {
    assertExactKeys(feedback, ['kind', 'target', 'cause']);
    return Object.freeze({
      kind: 'failed',
      target: cloneFailedTargetEvidence(feedback.target),
      cause: validateSkillFailure(feedback.cause),
    });
  }
  throw new TypeError(`unknown policy feedback kind: ${String((feedback as { kind?: unknown }).kind)}`);
}

function cloneFailedTargetEvidence(evidence: FailedTargetEvidence): FailedTargetEvidence {
  switch (evidence.kind) {
    case 'loot': {
      assertExactKeys(evidence, ['kind', 'target', 'opportunity']);
      const target = cloneLootTarget(evidence.target);
      const opportunity = cloneLootOpportunity(evidence.opportunity);
      if (!sameLootTarget(target, lootTarget(opportunity))) {
        throw new TypeError('loot evidence does not match its target');
      }
      return Object.freeze({ kind: 'loot', target, opportunity });
    }
    case 'searchLastKnown':
      assertExactKeys(evidence, ['kind', 'target', 'position', 'opponent']);
      return Object.freeze({
        kind: 'searchLastKnown',
        target: entityId(evidence.target),
        position: freezePosition(evidence.position),
        opponent: cloneSearchOpponentEvidence(evidence.opponent),
      });
    case 'explore':
      assertExactKeys(evidence, ['kind', 'target', 'origin']);
      return Object.freeze({
        kind: 'explore',
        target: freezePosition(evidence.target),
        origin: freezePosition(evidence.origin),
      });
  }
  throw new TypeError(`unknown failed target evidence kind: ${String((evidence as { kind?: unknown }).kind)}`);
}

function cloneLootOpportunity(opportunity: LootOpportunity): LootOpportunity {
  if (opportunity.kind === 'visibleDrop') {
    assertExactKeys(opportunity, ['kind', 'entityId', 'position', 'item']);
    return visibleDrop(
      entityId(opportunity.entityId),
      freezePosition(opportunity.position),
      cloneKnownItem(opportunity.item),
    );
  }
  if (opportunity.kind === 'unopenedContainer') {
    assertExactKeys(opportunity, ['kind', 'position']);
    return unopenedContainer(freezePosition(opportunity.position));
  }
  throw new TypeError(`unknown loot opportunity kind: ${String((opportunity as { kind?: unknown }).kind)}`);
}

function cloneKnownItem(item: KnownItem): KnownItem {
  if (item.kind === 'food') {
    assertExactKeys(item, ['kind']);
    return knownFood();
  }
  if (item.kind === 'weapon') {
    assertExactKeys(item, ['kind', 'rating']);
    return knownWeapon(item.rating);
  }
  if (item.kind === 'armor') {
    assertExactKeys(item, ['kind', 'equipmentSlot', 'rating']);
    return knownArmor(item.equipmentSlot, item.rating);
  }
  throw new TypeError(`unknown item kind: ${String((item as { kind?: unknown }).kind)}`);
}

function cloneSearchOpponentEvidence(evidence: SearchOpponentEvidence): SearchOpponentEvidence {
  if (evidence.kind === 'unknown' || evidence.kind === 'absent') {
    assertExactKeys(evidence, ['kind']);
    return Object.freeze({ kind: evidence.kind });
  }
  if (evidence.kind === 'observed') {
    assertExactKeys(evidence, ['kind', 'position']);
    return Object.freeze({
      kind: 'observed',
      position: freezePosition(evidence.position),
    });
  }
  throw new TypeError(`unknown opponent evidence kind: ${String((evidence as { kind?: unknown }).kind)}`);
}

function applyPolicyFeedback(memory: PolicyMemory, feedback: PolicyFeedbackBatch): PolicyMemory {
  let failedTargets = [...memory.failedTargets];
  for (const event of feedback) {
    const target = cloneFailedTargetEvidence(event.target);
    failedTargets = failedTargets.filter((existing) => !sameFailedTarget(existing, target));
    if (event.kind === 'failed') {
      failedTargets.push(target);
      if (failedTargets.length > MAX_REMEMBERED_FAILED_TARGETS) failedTargets.shift();
    }
  }
  return policyMemory({ ...memory, failedTargets });
}

function pruneChangedFailedTargets(observation: AgentObservation, memory: PolicyMemory): PolicyMemory {
  const failedTargets = memory.failedTargets.filter((entry) => !failedTargetEvidenceChanged(observation, entry));
  return failedTargets.length === memory.failedTargets.length
    ? memory
    : policyMemory({ ...memory, failedTargets });
}

function failedTargetEvidenceChanged(observation: AgentObservation, failed: FailedTargetEvidence): boolean {
  switch (failed.kind) {
    case 'loot': {
      if (observation.loot.kind === 'unknown') return false;
      const currentOpportunity = observation.loot.value.find((opportunity) => (
        sameLootTarget(lootTarget(opportunity), failed.target)
      ));
      if (currentOpportunity === undefined) return observation.loot.kind === 'current';
      return !sameLootOpportunity(failed.opportunity, currentOpportunity);
    }
    case 'searchLastKnown':
      return !sameSearchOpponentEvidence(failed.opponent, searchOpponentEvidence(observation, failed.target));
    case 'explore': {
      const agent = currentValue(observation.agent);
      return agent !== null
        && manhattanDistance(agent.position, failed.origin) >= FAILED_EXPLORATION_APPROACH_BLOCKS;
    }
  }
}

function searchOpponentEvidence(observation: AgentObservation, target: EntityId): SearchOpponentEvidence {
  if (observation.opponents.kind === 'unknown') return Object.freeze({ kind: 'unknown' });
  const opponent = observation.opponents.value.find((candidate) => candidate.id === target);
  if (opponent === undefined) return Object.freeze({ kind: 'absent' });
  return Object.freeze({
    kind: 'observed',
    position: opponent.position,
  });
}

function sameFailedTarget(first: FailedTargetEvidence, second: FailedTargetEvidence): boolean {
  if (first.kind !== second.kind) return false;
  switch (first.kind) {
    case 'loot':
      return second.kind === 'loot' && sameLootTarget(first.target, second.target);
    case 'searchLastKnown':
      return second.kind === 'searchLastKnown' && first.target === second.target;
    case 'explore':
      return second.kind === 'explore' && samePosition(first.target, second.target);
  }
}

function isFailedSearchTarget(memory: PolicyMemory, remembered: RememberedOpponent): boolean {
  return memory.failedTargets.some((failed) => (
    failed.kind === 'searchLastKnown' && failed.target === remembered.id
  ));
}

function sameSearchOpponentEvidence(first: SearchOpponentEvidence, second: SearchOpponentEvidence): boolean {
  if (second.kind === 'unknown') return true;
  if (first.kind === 'unknown' || first.kind !== second.kind) return false;
  return first.kind !== 'observed'
    || (second.kind === 'observed' && samePosition(first.position, second.position));
}

function sameLootOpportunity(first: LootOpportunity, second: LootOpportunity): boolean {
  if (first.kind !== second.kind || !samePosition(first.position, second.position)) return false;
  if (first.kind === 'unopenedContainer' && second.kind === 'unopenedContainer') return true;
  if (first.kind !== 'visibleDrop' || second.kind !== 'visibleDrop' || first.entityId !== second.entityId) return false;
  return sameKnownItem(first.item, second.item);
}

function sameKnownItem(first: KnownItem, second: KnownItem): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'food') return true;
  if (first.kind === 'weapon' && second.kind === 'weapon') return first.rating === second.rating;
  return first.kind === 'armor'
    && second.kind === 'armor'
    && first.equipmentSlot === second.equipmentSlot
    && first.rating === second.rating;
}

function samePosition(first: BlockPosition, second: BlockPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function validateSkillFailure(value: SkillFailure): SkillFailure {
  if (value !== 'preconditionsNotMet'
      && value !== 'noProgress'
      && value !== 'serverRejected'
      && value !== 'timedOut') {
    throw new TypeError(`unknown skill failure cause: ${String(value)}`);
  }
  return value;
}

function validateSkillCancellation(value: string): void {
  if (value !== 'replaced' && value !== 'agentEliminated' && value !== 'shutdown') {
    throw new TypeError(`unknown skill cancellation reason: ${value}`);
  }
}


function currentValue<T>(knowledge: Knowledge<T>): T | null {
  return knowledge.kind === 'current' ? knowledge.value : null;
}

function nearestOpponent(position: BlockPosition, opponents: readonly VisibleOpponent[]): VisibleOpponent {
  const ordered = [...opponents].sort((first, second) => {
    const firstDistance = squaredDistance(position, first.position);
    const secondDistance = squaredDistance(position, second.position);
    if (firstDistance !== secondDistance) {
      return firstDistance < secondDistance ? -1 : 1;
    }
    return compareNumbers(first.id, second.id);
  });
  const nearest = ordered[0];
  if (nearest === undefined) {
    throw new RangeError('nearest opponent requires a nonempty opponent list');
  }
  return nearest;
}

function nearestKnownThreat(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParamValues,
  agent: AgentState,
): VisibleOpponent | null {
  const candidates: VisibleOpponent[] = [];
  const current = currentValue(observation.opponents);
  if (current !== null && current.length > 0) {
    candidates.push(...current);
  }
  const remembered = rememberedOpponent(observation, memory, params.opponentMemoryTicks);
  if (remembered !== null) {
    candidates.push({
      id: remembered.id,
      position: remembered.position,
      attackingAgent: false,
    });
  }

  const maxDistance = BigInt(params.fightRangeBlocks) * 2n;
  const eligible = candidates.filter((opponent) => manhattanDistance(agent.position, opponent.position) <= maxDistance);
  eligible.sort((first, second) => {
    if (first.attackingAgent !== second.attackingAgent) {
      return first.attackingAgent ? -1 : 1;
    }
    const firstDistance = squaredDistance(agent.position, first.position);
    const secondDistance = squaredDistance(agent.position, second.position);
    if (firstDistance !== secondDistance) {
      return firstDistance < secondDistance ? -1 : 1;
    }
    return compareNumbers(first.id, second.id);
  });
  return eligible[0] ?? null;
}

function isSafeToEat(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParamValues,
  agent: AgentState,
): boolean {
  const opponents = currentValue(observation.opponents);
  return opponents !== null
    && opponents.length === 0
    && nearestKnownThreat(observation, memory, params, agent) === null;
}

function bestUpgrade(agent: AgentState): EquipmentUpgrade | null {
  const candidates = agent.upgrades.filter((upgrade) => {
    const currentRating = agent.equipped[upgrade.equipmentSlot];
    return upgrade.rating > (currentRating ?? 0);
  });
  candidates.sort((first, second) => {
    if (first.rating !== second.rating) {
      return second.rating - first.rating;
    }
    const firstSlotOrder = equipmentSlotOrder(first.equipmentSlot);
    const secondSlotOrder = equipmentSlotOrder(second.equipmentSlot);
    if (firstSlotOrder !== secondSlotOrder) {
      return firstSlotOrder - secondSlotOrder;
    }
    return compareNumbers(first.inventorySlot, second.inventorySlot);
  });
  return candidates[0] ?? null;
}

function lowestInventorySlot(stacks: readonly { readonly inventorySlot: InventorySlot }[]): { readonly inventorySlot: InventorySlot } | null {
  let selected: { readonly inventorySlot: InventorySlot } | null = null;
  for (const stack of stacks) {
    if (selected === null || stack.inventorySlot < selected.inventorySlot) {
      selected = stack;
    }
  }
  return selected;
}

function selectLoot(
  observation: AgentObservation,
  memory: PolicyMemory,
  agent: AgentState,
  params: PolicyParamValues,
): LootChoice | null {
  const opportunities = currentValue(observation.loot);
  if (opportunities === null) {
    return null;
  }
  const candidates = opportunities
    .map((opportunity): LootChoice | null => {
      const target = lootTarget(opportunity);
      if (memory.failedTargets.some((failed) => (
        failed.kind === 'loot' && sameLootTarget(failed.target, target)
      ))) {
        return null;
      }
      const utility = lootUtility(opportunity, agent);
      return utility === 0
        ? null
        : {
          opportunity,
          target,
          utility,
          distance: manhattanDistance(agent.position, opportunity.position),
        };
    })
    .filter((choice): choice is LootChoice => choice !== null);
  candidates.sort(compareLootChoices);
  const best = candidates[0];
  if (best === undefined) {
    return null;
  }

  const lastGoal = memory.lastGoal;
  if (lastGoal?.kind === 'loot') {
    const previous = candidates.find((candidate) => sameLootTarget(candidate.target, lastGoal.target));
    if (previous !== undefined
        && previous.utility === best.utility
        && previous.distance <= best.distance + BigInt(params.lootHysteresisBlocks)) {
      return previous;
    }
  }
  return best;
}

function compareLootChoices(first: LootChoice, second: LootChoice): number {
  if (first.utility !== second.utility) {
    return second.utility - first.utility;
  }
  if (first.distance !== second.distance) {
    return first.distance < second.distance ? -1 : 1;
  }
  return compareLootTargets(first.target, second.target);
}

function compareLootTargets(first: LootTarget, second: LootTarget): number {
  if (first.kind !== second.kind) {
    return first.kind === 'drop' ? -1 : 1;
  }
  if (first.kind === 'drop' && second.kind === 'drop') {
    return compareNumbers(first.entityId, second.entityId);
  }
  if (first.kind === 'container' && second.kind === 'container') {
    return compareBlockPositions(first.position, second.position);
  }
  throw new TypeError('loot target kinds are inconsistent');
}

function sameLootTarget(first: LootTarget, second: LootTarget): boolean {
  return compareLootTargets(first, second) === 0;
}

function lootUtility(opportunity: LootOpportunity, agent: AgentState): number {
  if (opportunity.kind === 'unopenedContainer') {
    return 1;
  }
  switch (opportunity.item.kind) {
    case 'food':
      return agent.foodStacks.length === 0 ? 2 : 0;
    case 'weapon':
      return opportunity.item.rating > (agent.equipped.weapon ?? 0) ? 3 : 0;
    case 'armor':
      return opportunity.item.rating > (agent.equipped[opportunity.item.equipmentSlot] ?? 0) ? 3 : 0;
  }
}

function rememberedOpponent(
  observation: AgentObservation,
  memory: PolicyMemory,
  maxAgeTicks: number,
): RememberedOpponent | null {
  const fromMemory = memory.lastOpponent !== null
    && observation.tick >= memory.lastOpponent.observedAt
    && observation.tick - memory.lastOpponent.observedAt <= maxAgeTicks
    ? memory.lastOpponent
    : null;

  let fromStaleObservation: RememberedOpponent | null = null;
  if (observation.opponents.kind === 'stale'
      && observation.tick - observation.opponents.observedAt <= maxAgeTicks
      && observation.opponents.value.length > 0) {
    const agent = currentValue(observation.agent);
    const position = agent?.position ?? null;
    const sorted = [...observation.opponents.value].sort((first, second) => {
      if (position !== null) {
        const firstDistance = squaredDistance(position, first.position);
        const secondDistance = squaredDistance(position, second.position);
        if (firstDistance !== secondDistance) {
          return firstDistance < secondDistance ? -1 : 1;
        }
      }
      return compareNumbers(first.id, second.id);
    });
    const nearest = sorted[0];
    if (nearest !== undefined) {
      fromStaleObservation = Object.freeze({
        id: nearest.id,
        position: nearest.position,
        observedAt: observation.opponents.observedAt,
      });
    }
  }

  if (fromMemory !== null && fromStaleObservation !== null) {
    return fromStaleObservation.observedAt > fromMemory.observedAt ? fromStaleObservation : fromMemory;
  }
  return fromMemory ?? fromStaleObservation;
}

function retreatTarget(position: BlockPosition, threat: BlockPosition, tieBit: boolean) {
  let dx = compareNumbers(position.x, threat.x);
  let dz = compareNumbers(position.z, threat.z);
  if (dx === 0 && dz === 0) {
    dx = tieBit ? 1 : -1;
    return offsetBlockPosition(position, dx * 4, 0, 0);
  }
  return offsetBlockPosition(position, Math.sign(dx) * 4, 0, Math.sign(dz) * 4);
}

function explorationTarget(
  position: BlockPosition,
  radius: number,
  memory: PolicyMemory,
  random: DeterministicRandom,
  semantics: DecisionSemantics,
): { readonly ok: true; readonly value: BlockPosition }
  | { readonly ok: false; readonly reason: 'unrepresentableTarget' | 'failedTargetsExhausted' } {
  const half = Math.max(1, Math.floor(radius / 2));
  const offsets = [
    [radius, 0],
    [radius, half],
    [0, radius],
    [-half, radius],
    [-radius, 0],
    [-radius, -half],
    [0, -radius],
    [half, -radius],
  ] as const;
  const start = random.nextEightWay();
  if (semantics === 'policy-input-v1') {
    const [dx, dz] = offsets[start]!;
    const target = offsetBlockPosition(position, dx, 0, dz);
    return target.ok ? target : { ok: false, reason: 'unrepresentableTarget' };
  }

  let representableTargets = 0;
  for (let offset = 0; offset < offsets.length; offset += 1) {
    const [dx, dz] = offsets[(start + offset) % offsets.length]!;
    const candidate = offsetBlockPosition(position, dx, 0, dz);
    if (!candidate.ok) {
      continue;
    }
    representableTargets += 1;
    if (!memory.failedTargets.some((failed) => (
      failed.kind === 'explore' && samePosition(failed.target, candidate.value)
    ))) {
      return candidate;
    }
  }
  return {
    ok: false,
    reason: representableTargets === 0 ? 'unrepresentableTarget' : 'failedTargetsExhausted',
  };
}

function equipmentSlotOrder(slot: EquipmentSlot): number {
  switch (slot) {
    case 'weapon': return 0;
    case 'helmet': return 1;
    case 'chestplate': return 2;
    case 'leggings': return 3;
    case 'boots': return 4;
  }
}

function compareNumbers(first: number, second: number): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function isIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('expected an object');
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new TypeError(`object keys must be exactly: ${expected.join(', ')}`);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`object field ${key} must be an own data property`);
    }
  }
}

function assertDenseArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1
      || !Reflect.ownKeys(value).includes('length')) {
    throw new TypeError(`${field} must be a plain dense array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${field}[${index}] must be an own data element`);
    }
  }
}

function cloneGoal(goal: Goal): Goal {
  switch (goal.kind) {
    case 'escapeBorder':
    case 'recoverHunger':
    case 'explore':
      assertExactKeys(goal, ['kind']);
      return Object.freeze({ ...goal });
    case 'improveEquipment':
      assertExactKeys(goal, ['kind', 'inventorySlot', 'equipmentSlot', 'rating']);
      return Object.freeze({
        kind: goal.kind,
        inventorySlot: inventorySlot(goal.inventorySlot),
        equipmentSlot: validateEquipmentSlot(goal.equipmentSlot),
        rating: validateRating(goal.rating),
      });
    case 'engageVisibleOpponent':
    case 'searchLastKnown':
    case 'retreatFromOpponent':
      assertExactKeys(goal, ['kind', 'target']);
      return Object.freeze({ ...goal, target: entityId(goal.target) });
    case 'loot':
      assertExactKeys(goal, ['kind', 'target']);
      return Object.freeze({ kind: 'loot', target: cloneLootTarget(goal.target) });
    case 'wait':
      assertExactKeys(goal, ['kind', 'reason']);
      return Object.freeze({ ...goal, reason: validateWaitReason(goal.reason) });
  }
}

function cloneLootTarget(target: LootTarget): LootTarget {
  if (target.kind === 'drop') {
    assertExactKeys(target, ['kind', 'entityId']);
    return Object.freeze({ kind: 'drop', entityId: entityId(target.entityId) });
  }
  if (target.kind === 'container') {
    assertExactKeys(target, ['kind', 'position']);
    return Object.freeze({ kind: 'container', position: freezePosition(target.position) });
  }
  throw new TypeError(`unknown loot target kind: ${String((target as { kind?: unknown }).kind)}`);
}

function cloneIntent(intent: Intent): Intent {
  switch (intent.kind) {
    case 'navigate':
      assertExactKeys(intent, ['kind', 'target']);
      return Object.freeze({ kind: 'navigate', target: freezePosition(intent.target) });
    case 'eat':
      assertExactKeys(intent, ['kind', 'inventorySlot']);
      return Object.freeze({ kind: 'eat', inventorySlot: inventorySlot(intent.inventorySlot) });
    case 'equip':
      assertExactKeys(intent, ['kind', 'inventorySlot', 'equipmentSlot', 'rating']);
      return Object.freeze({
        kind: 'equip',
        inventorySlot: inventorySlot(intent.inventorySlot),
        equipmentSlot: validateEquipmentSlot(intent.equipmentSlot),
        rating: validateRating(intent.rating),
      });
    case 'approach':
    case 'attack':
      assertExactKeys(intent, ['kind', 'target']);
      return Object.freeze({ ...intent, target: entityId(intent.target) });
    case 'dropCollect':
      assertExactKeys(intent, ['kind', 'entityId']);
      return Object.freeze({ kind: 'dropCollect', entityId: entityId(intent.entityId) });
    case 'containerOpen':
      assertExactKeys(intent, ['kind', 'position']);
      return Object.freeze({ kind: 'containerOpen', position: freezePosition(intent.position) });
    case 'hold':
      assertExactKeys(intent, ['kind', 'reason']);
      return Object.freeze({ kind: 'hold', reason: validateWaitReason(intent.reason) });
  }
}

function freezeIntent(intent: Intent): Intent {
  return cloneIntent(intent);
}

function freezePosition(position: BlockPosition): BlockPosition {
  return blockPosition(position.x, position.y, position.z);
}

function validateEquipmentSlot(value: EquipmentSlot): EquipmentSlot {
  if (value !== 'weapon' && value !== 'helmet' && value !== 'chestplate' && value !== 'leggings' && value !== 'boots') {
    throw new TypeError(`unknown equipment slot: ${String(value)}`);
  }
  return value;
}

function validateRating(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`equipment rating must be between 0 and 255, received ${value}`);
  }
  return value;
}

function validateWaitReason(value: WaitReason): WaitReason {
  if (value !== 'agentStateUnknown'
      && value !== 'agentStateStale'
      && value !== 'agentEliminated'
      && value !== 'borderUnknown'
      && value !== 'borderStale'
      && value !== 'unrepresentableTarget'
      && value !== 'failedTargetsExhausted') {
    throw new TypeError(`unknown wait reason: ${String(value)}`);
  }
  return value;
}
