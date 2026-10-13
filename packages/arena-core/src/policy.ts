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
  lootTarget,
  tick,
  type AgentObservation,
  type AgentState,
  type EntityId,
  type EquipmentSlot,
  type EquipmentUpgrade,
  type InventorySlot,
  type Knowledge,
  type LootOpportunity,
  type LootTarget,
  type Tick,
  type VisibleOpponent,
} from './observation.js';
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
  | 'unrepresentableTarget';

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

export interface PolicyMemory {
  readonly lastGoal: Goal | null;
  readonly lastOpponent: RememberedOpponent | null;
}

export interface PolicyMemoryInput {
  readonly lastGoal: Goal | null;
  readonly lastOpponent: RememberedOpponent | null;
}

export function emptyPolicyMemory(): PolicyMemory {
  return Object.freeze({ lastGoal: null, lastOpponent: null });
}

export function policyMemory(input: PolicyMemoryInput): PolicyMemory {
  assertExactKeys(input, ['lastGoal', 'lastOpponent']);
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
  return Object.freeze({ lastGoal, lastOpponent });
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
): Decision {
  assertValidatedAgentObservation(observation);
  const nextMemory = policyMemory(memory);
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

  const loot = selectLoot(observation, memory, agent, params.values);
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
  if (remembered !== null) {
    const goal: Goal = Object.freeze({ kind: 'searchLastKnown', target: remembered.id });
    return finish(goal, { kind: 'navigate', target: remembered.position }, {
      ...currentMemory,
      lastGoal: goal,
    });
  }

  const exploration = explorationTarget(agent.position, params.values.searchRadiusBlocks, random);
  if (exploration.ok === false) {
    return waitDecision('unrepresentableTarget', currentMemory);
  }
  const goal: Goal = Object.freeze({ kind: 'explore' });
  return finish(goal, { kind: 'navigate', target: exploration.value }, {
    ...currentMemory,
    lastGoal: goal,
  });
}

function finish(goal: Goal, intent: Intent, memory: PolicyMemoryInput): Decision {
  return Object.freeze({ goal, intent: freezeIntent(intent), memory: policyMemory(memory) });
}

function waitDecision(reason: WaitReason, memory: PolicyMemory): Decision {
  const goal: Goal = Object.freeze({ kind: 'wait', reason });
  return finish(goal, { kind: 'hold', reason }, memory);
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
      const utility = lootUtility(opportunity, agent);
      return utility === 0
        ? null
        : {
          opportunity,
          target: lootTarget(opportunity),
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

function explorationTarget(position: BlockPosition, radius: number, random: DeterministicRandom) {
  const half = Math.max(1, Math.floor(radius / 2));
  switch (random.nextEightWay()) {
    case 0:
      return offsetBlockPosition(position, radius, 0, 0);
    case 1:
      return offsetBlockPosition(position, radius, 0, half);
    case 2:
      return offsetBlockPosition(position, 0, 0, radius);
    case 3:
      return offsetBlockPosition(position, -half, 0, radius);
    case 4:
      return offsetBlockPosition(position, -radius, 0, 0);
    case 5:
      return offsetBlockPosition(position, -radius, 0, -half);
    case 6:
      return offsetBlockPosition(position, 0, 0, -radius);
    case 7:
      return offsetBlockPosition(position, half, 0, -radius);
    default:
      throw new RangeError('random exploration direction is outside 0..7');
  }
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
  if (value === null || typeof value !== 'object') {
    throw new TypeError('expected an object');
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TypeError(`object keys must be exactly: ${expected.join(', ')}`);
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
      && value !== 'unrepresentableTarget') {
    throw new TypeError(`unknown wait reason: ${String(value)}`);
  }
  return value;
}
