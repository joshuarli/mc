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
}

export function foodStack(slot: number, count: number): FoodStack {
  const inventorySlotValue = inventorySlot(slot);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError(`food stack count must be a positive safe integer, received ${count}`);
  }
  return Object.freeze({ inventorySlot: inventorySlotValue, count });
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

export interface AgentState {
  readonly position: BlockPosition;
  readonly healthHalfHearts: number;
  readonly hungerPoints: number;
  readonly foodStacks: readonly FoodStack[];
  readonly equipped: EquipmentSnapshot;
  readonly upgrades: readonly EquipmentUpgrade[];
}

export interface AgentStateInput {
  readonly position: BlockPosition;
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
  ], 'agent state');

  if (!Number.isSafeInteger(input.healthHalfHearts) || input.healthHalfHearts < 0 || input.healthHalfHearts > 40) {
    throw new RangeError(`health must be between 0 and 40 half-hearts, received ${input.healthHalfHearts}`);
  }
  if (!Number.isSafeInteger(input.hungerPoints) || input.hungerPoints < 0 || input.hungerPoints > 20) {
    throw new RangeError(`hunger must be between 0 and 20 points, received ${input.hungerPoints}`);
  }

  const position = cloneBlockPosition(input.position);
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
}

export function visibleOpponent(
  id: EntityId,
  position: BlockPosition,
  attackingAgent: boolean,
): VisibleOpponent {
  return Object.freeze({
    id: entityId(id),
    position: cloneBlockPosition(position),
    attackingAgent: assertBoolean(attackingAgent, 'attackingAgent'),
  });
}

export type KnownItem =
  | { readonly kind: 'food' }
  | { readonly kind: 'weapon'; readonly rating: number }
  | { readonly kind: 'armor'; readonly equipmentSlot: ArmorSlot; readonly rating: number };

export function knownFood(): KnownItem {
  return Object.freeze({ kind: 'food' });
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
    assertObjectKeys(value, ['id', 'position', 'attackingAgent'], 'visible opponent');
    return visibleOpponent(value.id, value.position, value.attackingAgent);
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
  assertObjectKeys(value, ['inventorySlot', 'count'], 'food stack');
  return foodStack(value.inventorySlot, value.count);
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

function assertObjectKeys(value: object, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
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
