import {
  cloneCombatBody,
  cloneCombatSelfBody,
  combatBodyBlock,
  type CombatBody,
  type CombatSelfBody,
} from './combat.js';
import {
  blockPosition,
  type BlockPosition,
  type WorldBorder,
  worldBorder,
} from './geometry.js';

declare const tickBrand: unique symbol;
declare const observationSequenceBrand: unique symbol;
declare const seatIdBrand: unique symbol;
declare const entityIdBrand: unique symbol;
declare const inventorySlotBrand: unique symbol;

export type Tick = number & { readonly [tickBrand]: 'Tick' };
export type ObservationSequence = number & { readonly [observationSequenceBrand]: 'ObservationSequence' };
export type SeatId = number & { readonly [seatIdBrand]: 'SeatId' };
export type EntityId = number & { readonly [entityIdBrand]: 'EntityId' };
export type InventorySlot = number & { readonly [inventorySlotBrand]: 'InventorySlot' };

const validatedAgentObservation: unique symbol = Symbol('validated-agent-observation');
const legacyReplayObservation: unique symbol = Symbol('legacy-replay-observation');

export function tick(value: number): Tick {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`tick must be a nonnegative safe integer, received ${value}`);
  }
  return value as Tick;
}

export function observationSequence(value: number): ObservationSequence {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`observation sequence must be a positive safe integer, received ${value}`);
  }
  return value as ObservationSequence;
}

export function seatId(value: number): SeatId {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`seat ID must be between 0 and 255, received ${value}`);
  }
  return value as SeatId;
}

export function entityId(value: number): EntityId {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`entity ID must be a positive safe integer, received ${value}`);
  }
  return value as EntityId;
}

export function inventorySlot(value: number): InventorySlot {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`inventory slot must be a nonnegative safe integer, received ${value}`);
  }
  return value as InventorySlot;
}

export type Knowledge<T> =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'current'; readonly value: T }
  | { readonly kind: 'stale'; readonly value: T; readonly observedAt: Tick };

export function unknownKnowledge<T = never>(): Knowledge<T> {
  return Object.freeze({ kind: 'unknown' });
}

export function currentKnowledge<T>(value: T): Knowledge<T> {
  return Object.freeze({ kind: 'current', value });
}

export function staleKnowledge<T>(value: T, observedAt: Tick): Knowledge<T> {
  return Object.freeze({ kind: 'stale', value, observedAt: tick(observedAt) });
}

export type ArmorSlot = 'helmet' | 'chestplate' | 'leggings' | 'boots';
export type EquipmentSlot = 'weapon' | ArmorSlot;

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = Object.freeze([
  'weapon',
  'helmet',
  'chestplate',
  'leggings',
  'boots',
]);

export type EquipmentSnapshot = Readonly<Record<EquipmentSlot, number | null>>;

export function emptyEquipment(): EquipmentSnapshot {
  return Object.freeze({
    weapon: null,
    helmet: null,
    chestplate: null,
    leggings: null,
    boots: null,
  });
}

export interface FoodStack {
  readonly inventorySlot: InventorySlot;
  readonly count: number;
  readonly restores?: number;
}

export function foodStack(slot: number, count: number, restores?: number): FoodStack {
  const inventorySlotValue = inventorySlot(slot);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError(`food stack count must be a positive safe integer, received ${count}`);
  }
  if (restores !== undefined && (!Number.isSafeInteger(restores) || restores < 1 || restores > 20)) {
    throw new RangeError(`food restoration must be between 1 and 20 hunger points, received ${restores}`);
  }
  return Object.freeze({
    inventorySlot: inventorySlotValue,
    count,
    ...(restores === undefined ? {} : { restores }),
  });
}

export interface EquipmentUpgrade {
  readonly inventorySlot: InventorySlot;
  readonly equipmentSlot: EquipmentSlot;
  readonly rating: number;
}

export function equipmentUpgrade(
  slot: number,
  equipmentSlot: EquipmentSlot,
  rating: number,
): EquipmentUpgrade {
  const inventorySlotValue = inventorySlot(slot);
  assertEquipmentSlot(equipmentSlot);
  assertRating(rating);
  return Object.freeze({ inventorySlot: inventorySlotValue, equipmentSlot, rating });
}

export const MAX_TERRAIN_CHANGES = 32;
export const MAX_ARROW_COUNT = 2304;

export const DIRECTION_COUNT = 8;
export const OBSERVED_DIRECTION_RADIUS_BLOCKS = 8;

export type DirectionSupport =
  | { readonly kind: 'supported'; readonly support: BlockPosition; readonly hazard: boolean }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'unloaded' };

export interface RangedLoadout {
  readonly arrows: number;
}

export interface AgentState {
  readonly position: BlockPosition;
  readonly combat?: CombatSelfBody;
  readonly ranged?: RangedLoadout;
  readonly terrainChanges?: readonly BlockPosition[];
  readonly directions?: readonly DirectionSupport[];
  readonly healthHalfHearts: number;
  readonly hungerPoints: number;
  readonly foodStacks: readonly FoodStack[];
  readonly equipped: EquipmentSnapshot;
  readonly upgrades: readonly EquipmentUpgrade[];
}

export interface AgentStateInput {
  readonly position: BlockPosition;
  readonly combat?: CombatSelfBody;
  readonly ranged?: RangedLoadout;
  readonly terrainChanges?: readonly BlockPosition[];
  readonly directions?: readonly DirectionSupport[];
  readonly healthHalfHearts: number;
  readonly hungerPoints: number;
  readonly foodStacks: readonly FoodStack[];
  readonly equipped: EquipmentSnapshot;
  readonly upgrades: readonly EquipmentUpgrade[];
}

export function agentState(input: AgentStateInput): AgentState {
  assertObjectKeys(input, [
    'position',
    'healthHalfHearts',
    'hungerPoints',
    'foodStacks',
    'equipped',
    'upgrades',
  ], 'agent state', ['combat', 'ranged', 'terrainChanges', 'directions']);

  if (!Number.isSafeInteger(input.healthHalfHearts) || input.healthHalfHearts < 0 || input.healthHalfHearts > 40) {
    throw new RangeError(`health must be between 0 and 40 half-hearts, received ${input.healthHalfHearts}`);
  }
  if (!Number.isSafeInteger(input.hungerPoints) || input.hungerPoints < 0 || input.hungerPoints > 20) {
    throw new RangeError(`hunger must be between 0 and 20 points, received ${input.hungerPoints}`);
  }

  const position = cloneBlockPosition(input.position);
  const combat = input.combat === undefined ? undefined : cloneCombatSelfBody(input.combat);
  if (combat !== undefined) assertBlockIdentity(position, combat, 'agent state');
  const ranged = input.ranged === undefined ? undefined : cloneRangedLoadout(input.ranged);
  const terrainChanges = input.terrainChanges === undefined ? undefined : cloneTerrainChanges(input.terrainChanges);
  const directions = input.directions === undefined ? undefined : cloneDirections(input.directions);
  const equipped = cloneEquipmentSnapshot(input.equipped);
  const foodStacks = input.foodStacks.map(cloneFoodStack);
  const upgrades = input.upgrades.map(cloneEquipmentUpgrade);
  const occupiedInventorySlots = new Set<number>();
  for (const stack of foodStacks) {
    if (occupiedInventorySlots.has(stack.inventorySlot)) {
      throw new RangeError(`inventory slot ${stack.inventorySlot} appears more than once`);
    }
    occupiedInventorySlots.add(stack.inventorySlot);
  }
  for (const upgrade of upgrades) {
    if (occupiedInventorySlots.has(upgrade.inventorySlot)) {
      throw new RangeError(`inventory slot ${upgrade.inventorySlot} appears more than once`);
    }
    occupiedInventorySlots.add(upgrade.inventorySlot);
  }

  return Object.freeze({
    position,
    ...(combat === undefined ? {} : { combat }),
    ...(ranged === undefined ? {} : { ranged }),
    ...(terrainChanges === undefined ? {} : { terrainChanges }),
    ...(directions === undefined ? {} : { directions }),
    healthHalfHearts: input.healthHalfHearts,
    hungerPoints: input.hungerPoints,
    foodStacks: Object.freeze(foodStacks),
    equipped,
    upgrades: Object.freeze(upgrades),
  });
}

export interface VisibleOpponent {
  readonly id: EntityId;
  readonly position: BlockPosition;
  readonly attackingAgent: boolean;
  readonly combat?: CombatBody;
}

export function visibleOpponent(
  id: EntityId,
  position: BlockPosition,
  attackingAgent: boolean,
  combat?: CombatBody,
): VisibleOpponent {
  const clonedPosition = cloneBlockPosition(position);
  const clonedCombat = combat === undefined ? undefined : cloneCombatBody(combat);
  if (clonedCombat !== undefined) assertBlockIdentity(clonedPosition, clonedCombat, 'visible opponent');
  return Object.freeze({
    id: entityId(id),
    position: clonedPosition,
    attackingAgent: assertBoolean(attackingAgent, 'attackingAgent'),
    ...(clonedCombat === undefined ? {} : { combat: clonedCombat }),
  });
}

export type KnownItem =
  | { readonly kind: 'food' }
  | { readonly kind: 'ammunition' }
  | { readonly kind: 'rangedWeapon' }
  | { readonly kind: 'weapon'; readonly rating: number }
  | { readonly kind: 'armor'; readonly equipmentSlot: ArmorSlot; readonly rating: number };

export function knownFood(): KnownItem {
  return Object.freeze({ kind: 'food' });
}

export function knownAmmunition(): KnownItem {
  return Object.freeze({ kind: 'ammunition' });
}

export function knownRangedWeapon(): KnownItem {
  return Object.freeze({ kind: 'rangedWeapon' });
}

export function knownWeapon(rating: number): KnownItem {
  assertRating(rating);
  return Object.freeze({ kind: 'weapon', rating });
}

export function knownArmor(equipmentSlot: ArmorSlot, rating: number): KnownItem {
  assertArmorSlot(equipmentSlot);
  assertRating(rating);
  return Object.freeze({ kind: 'armor', equipmentSlot, rating });
}

export type LootOpportunity =
  | {
    readonly kind: 'visibleDrop';
    readonly entityId: EntityId;
    readonly position: BlockPosition;
    readonly item: KnownItem;
  }
  | {
    readonly kind: 'unopenedContainer';
    readonly position: BlockPosition;
  };

export type LootTarget =
  | { readonly kind: 'drop'; readonly entityId: EntityId }
  | { readonly kind: 'container'; readonly position: BlockPosition };

export function visibleDrop(id: EntityId, position: BlockPosition, item: KnownItem): LootOpportunity {
  return Object.freeze({
    kind: 'visibleDrop',
    entityId: entityId(id),
    position: cloneBlockPosition(position),
    item: cloneKnownItem(item),
  });
}

export function unopenedContainer(position: BlockPosition): LootOpportunity {
  return Object.freeze({ kind: 'unopenedContainer', position: cloneBlockPosition(position) });
}

export function lootTarget(opportunity: LootOpportunity): LootTarget {
  if (opportunity.kind === 'visibleDrop') {
    return Object.freeze({ kind: 'drop', entityId: entityId(opportunity.entityId) });
  }
  if (opportunity.kind === 'unopenedContainer') {
    return Object.freeze({ kind: 'container', position: cloneBlockPosition(opportunity.position) });
  }
  throw new TypeError(`unknown loot opportunity kind: ${String((opportunity as { kind?: unknown }).kind)}`);
}

export type ObservationField = 'agent' | 'border' | 'opponents' | 'loot';
export type ObservationValidationCode =
  | 'invalid-field-state'
  | 'stale-sample-not-older'
  | 'duplicate-opponent-id'
  | 'duplicate-drop-id'
  | 'duplicate-container-position';

export class ObservationValidationError extends Error {
  constructor(readonly code: ObservationValidationCode, readonly field: ObservationField) {
    super(`${field} observation is invalid: ${code}`);
    this.name = 'ObservationValidationError';
  }
}

export interface AgentObservationInput {
  readonly tick: Tick;
  readonly sequence: ObservationSequence;
  readonly agent: Knowledge<AgentState>;
  readonly border: Knowledge<WorldBorder>;
  readonly opponents: Knowledge<readonly VisibleOpponent[]>;
  readonly loot: Knowledge<readonly LootOpportunity[]>;
}

export interface AgentObservation {
  readonly [validatedAgentObservation]: true;
  readonly tick: Tick;
  readonly sequence: ObservationSequence;
  readonly agent: Knowledge<AgentState>;
  readonly border: Knowledge<WorldBorder>;
  readonly opponents: Knowledge<readonly VisibleOpponent[]>;
  readonly loot: Knowledge<readonly LootOpportunity[]>;
}

export function agentObservation(input: AgentObservationInput): AgentObservation {
  return buildAgentObservation(input, false);
}

export function legacyAgentObservation(input: AgentObservationInput): AgentObservation {
  return buildAgentObservation(input, true);
}

export function isLegacyReplayObservation(observation: AgentObservation): boolean {
  return Object.getOwnPropertyDescriptor(observation, legacyReplayObservation)?.value === true;
}

function assertLegacyObservationShape(observation: {
  readonly agent: Knowledge<AgentState>;
  readonly opponents: Knowledge<readonly VisibleOpponent[]>;
  readonly loot: Knowledge<readonly LootOpportunity[]>;
}): void {
  const reject = (field: string): never => {
    throw new TypeError(`historical policy inputs cannot carry ${field}`);
  };
  if (observation.agent.kind !== 'unknown') {
    const agent = observation.agent.value;
    if (agent.combat !== undefined) reject('a combat view');
    if (agent.ranged !== undefined) reject('a ranged loadout');
    if (agent.terrainChanges !== undefined) reject('terrain changes');
    if (agent.directions !== undefined) reject('direction support');
    if (agent.foodStacks.some((stack) => stack.restores !== undefined)) reject('food restoration');
  }
  if (observation.opponents.kind !== 'unknown' && observation.opponents.value.some((value) => value.combat !== undefined)) {
    reject('an opponent combat view');
  }
  if (observation.loot.kind !== 'unknown' && observation.loot.value.some((value) => (
    value.kind === 'visibleDrop' && (value.item.kind === 'ammunition' || value.item.kind === 'rangedWeapon')
  ))) reject('ranged supplies');
}

function buildAgentObservation(input: AgentObservationInput, legacy: boolean): AgentObservation {
  assertObjectKeys(input, ['tick', 'sequence', 'agent', 'border', 'opponents', 'loot'], 'agent observation');
  const currentTick = tick(input.tick);
  const sequence = observationSequence(input.sequence);
  const agent = cloneKnowledge(input.agent, cloneAgentState, 'agent', currentTick);
  const border = cloneKnowledge(input.border, cloneWorldBorder, 'border', currentTick);
  const opponents = cloneKnowledge(input.opponents, cloneOpponents, 'opponents', currentTick);
  const loot = cloneKnowledge(input.loot, cloneLoot, 'loot', currentTick);

  if (opponents.kind !== 'unknown') {
    const ids = new Set<number>();
    for (const opponent of opponents.value) {
      if (ids.has(opponent.id)) {
        throw new ObservationValidationError('duplicate-opponent-id', 'opponents');
      }
      ids.add(opponent.id);
    }
  }

  if (loot.kind !== 'unknown') {
    const dropIds = new Set<number>();
    const containerPositions = new Set<string>();
    for (const opportunity of loot.value) {
      if (opportunity.kind === 'visibleDrop') {
        if (dropIds.has(opportunity.entityId)) {
          throw new ObservationValidationError('duplicate-drop-id', 'loot');
        }
        dropIds.add(opportunity.entityId);
      } else {
        const key = positionKey(opportunity.position);
        if (containerPositions.has(key)) {
          throw new ObservationValidationError('duplicate-container-position', 'loot');
        }
        containerPositions.add(key);
      }
    }
  }

  const observation = { tick: currentTick, sequence, agent, border, opponents, loot };
  if (legacy) {
    assertLegacyObservationShape(observation);
    Object.defineProperty(observation, legacyReplayObservation, { value: true });
  }
  Object.defineProperty(observation, validatedAgentObservation, { value: true });
  return Object.freeze(observation) as AgentObservation;
}

export function assertValidatedAgentObservation(value: unknown): asserts value is AgentObservation {
  if (value === null
      || typeof value !== 'object'
      || Object.getOwnPropertyDescriptor(value, validatedAgentObservation)?.value !== true) {
    throw new TypeError('policy decisions require an AgentObservation created by agentObservation');
  }
}

function cloneKnowledge<T>(
  knowledge: Knowledge<T>,
  cloneValue: (value: T) => T,
  field: ObservationField,
  currentTick: Tick,
): Knowledge<T> {
  if (knowledge.kind === 'unknown') {
    assertObjectKeys(knowledge, ['kind'], `${field} knowledge`);
    return unknownKnowledge();
  }
  if (knowledge.kind === 'current') {
    assertObjectKeys(knowledge, ['kind', 'value'], `${field} knowledge`);
    return currentKnowledge(cloneValue(knowledge.value));
  }
  if (knowledge.kind === 'stale') {
    assertObjectKeys(knowledge, ['kind', 'value', 'observedAt'], `${field} knowledge`);
    const observedAt = tick(knowledge.observedAt);
    if (observedAt >= currentTick) {
      throw new ObservationValidationError('stale-sample-not-older', field);
    }
    return staleKnowledge(cloneValue(knowledge.value), observedAt);
  }
  throw new ObservationValidationError('invalid-field-state', field);
}

function cloneAgentState(value: AgentState): AgentState {
  return agentState(value);
}

function cloneWorldBorder(value: WorldBorder): WorldBorder {
  return worldBorder(value.centerX, value.centerZ, value.radiusBlocks);
}

function cloneOpponents(values: readonly VisibleOpponent[]): readonly VisibleOpponent[] {
  return Object.freeze(values.map((value) => {
    assertObjectKeys(value, ['id', 'position', 'attackingAgent'], 'visible opponent', ['combat']);
    return visibleOpponent(value.id, value.position, value.attackingAgent, value.combat);
  }));
}

function cloneLoot(values: readonly LootOpportunity[]): readonly LootOpportunity[] {
  return Object.freeze(values.map((value) => {
    if (value.kind === 'visibleDrop') {
      assertObjectKeys(value, ['kind', 'entityId', 'position', 'item'], 'visible drop');
      return visibleDrop(value.entityId, value.position, value.item);
    }
    if (value.kind === 'unopenedContainer') {
      assertObjectKeys(value, ['kind', 'position'], 'unopened container');
      return unopenedContainer(value.position);
    }
    throw new TypeError(`unknown loot opportunity kind: ${String((value as { kind?: unknown }).kind)}`);
  }));
}

function cloneBlockPosition(value: BlockPosition): BlockPosition {
  return blockPosition(value.x, value.y, value.z);
}

function cloneEquipmentSnapshot(value: EquipmentSnapshot): EquipmentSnapshot {
  assertObjectKeys(value, ['weapon', 'helmet', 'chestplate', 'leggings', 'boots'], 'equipment snapshot');
  const result = {} as Record<EquipmentSlot, number | null>;
  for (const slot of ['weapon', 'helmet', 'chestplate', 'leggings', 'boots'] as const) {
    const rating = value[slot];
    if (rating !== null) {
      assertRating(rating);
    }
    result[slot] = rating;
  }
  return Object.freeze(result);
}

function cloneFoodStack(value: FoodStack): FoodStack {
  assertObjectKeys(value, ['inventorySlot', 'count'], 'food stack', ['restores']);
  return foodStack(value.inventorySlot, value.count, value.restores);
}

function cloneEquipmentUpgrade(value: EquipmentUpgrade): EquipmentUpgrade {
  assertObjectKeys(value, ['inventorySlot', 'equipmentSlot', 'rating'], 'equipment upgrade');
  return equipmentUpgrade(value.inventorySlot, value.equipmentSlot, value.rating);
}

function cloneKnownItem(value: KnownItem): KnownItem {
  if (value.kind === 'food') {
    assertObjectKeys(value, ['kind'], 'known food');
    return knownFood();
  }
  if (value.kind === 'ammunition') {
    assertObjectKeys(value, ['kind'], 'known ammunition');
    return knownAmmunition();
  }
  if (value.kind === 'rangedWeapon') {
    assertObjectKeys(value, ['kind'], 'known ranged weapon');
    return knownRangedWeapon();
  }
  if (value.kind === 'weapon') {
    assertObjectKeys(value, ['kind', 'rating'], 'known weapon');
    return knownWeapon(value.rating);
  }
  if (value.kind === 'armor') {
    assertObjectKeys(value, ['kind', 'equipmentSlot', 'rating'], 'known armor');
    return knownArmor(value.equipmentSlot, value.rating);
  }
  throw new TypeError(`unknown known-item kind: ${String((value as { kind?: unknown }).kind)}`);
}

function assertEquipmentSlot(value: string): asserts value is EquipmentSlot {
  if (!EQUIPMENT_SLOTS.includes(value as EquipmentSlot)) {
    throw new TypeError(`unknown equipment slot: ${value}`);
  }
}

function assertArmorSlot(value: string): asserts value is ArmorSlot {
  if (value === 'weapon' || !EQUIPMENT_SLOTS.includes(value as EquipmentSlot)) {
    throw new TypeError(`unknown armor slot: ${value}`);
  }
}

function assertRating(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`equipment rating must be between 0 and 255, received ${value}`);
  }
}

function assertBoolean(value: boolean, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function cloneDirections(values: readonly DirectionSupport[]): readonly DirectionSupport[] {
  if (!Array.isArray(values) || values.length !== DIRECTION_COUNT) {
    throw new RangeError(`direction support must hold exactly ${DIRECTION_COUNT} entries`);
  }
  return Object.freeze(values.map((value): DirectionSupport => {
    if (value.kind === 'supported') {
      assertObjectKeys(value, ['kind', 'support', 'hazard'], 'supported direction');
      return Object.freeze({
        kind: 'supported',
        support: cloneBlockPosition(value.support),
        hazard: assertBoolean(value.hazard, 'hazard'),
      });
    }
    if (value.kind === 'blocked' || value.kind === 'unloaded') {
      assertObjectKeys(value, ['kind'], 'direction support');
      return Object.freeze({ kind: value.kind });
    }
    throw new TypeError(`unknown direction support kind: ${String((value as { kind?: unknown }).kind)}`);
  }));
}

function cloneRangedLoadout(value: RangedLoadout): RangedLoadout {
  assertObjectKeys(value, ['arrows'], 'ranged loadout');
  if (!Number.isSafeInteger(value.arrows) || value.arrows < 0 || value.arrows > MAX_ARROW_COUNT) {
    throw new RangeError(`arrow count must be between 0 and ${MAX_ARROW_COUNT}, received ${value.arrows}`);
  }
  return Object.freeze({ arrows: value.arrows });
}

function cloneTerrainChanges(values: readonly BlockPosition[]): readonly BlockPosition[] {
  if (!Array.isArray(values) || values.length > MAX_TERRAIN_CHANGES) {
    throw new RangeError(`terrain changes can hold at most ${MAX_TERRAIN_CHANGES} positions`);
  }
  return Object.freeze(values.map(cloneBlockPosition));
}

function assertBlockIdentity(position: BlockPosition, combat: CombatBody, label: string): void {
  const block = combatBodyBlock(combat);
  if (block.x !== position.x || block.y !== position.y || block.z !== position.z) {
    throw new RangeError(`${label} block position must be the floor of its fractional combat position`);
  }
}

function assertObjectKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !optional.includes(key)) {
      throw new TypeError(`${label} contains unknown field ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing required field ${key}`);
    }
  }
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}
