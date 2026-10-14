import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import {
  agentObservation,
  BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD,
  MAX_ARROW_COUNT,
  MAX_TERRAIN_CHANGES,
  agentState,
  blockPosition,
  currentKnowledge,
  emptyEquipment,
  entityId,
  equipmentUpgrade,
  foodStack,
  observationSequence,
  staleKnowledge,
  tick,
  unknownKnowledge,
  unopenedContainer,
  visibleDrop,
  visibleOpponent,
  type AgentObservation,
  type AgentState,
  type BlockPosition,
  type ClientDiagnosticSink,
  type DirectionSupport,
  type Knowledge,
  type LootOpportunity,
  type Tick,
  type VisibleOpponent,
  type WorldBorder,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { readCombatBody, readCombatSelfBody } from './combat-view.js';
import { classifyItem } from './items.js';
import { isTargetablePlayer, isVisibleEntity, isVisiblePosition, toBlockPosition } from './perception.js';
import { ClientWorldBorder } from './world-border.js';

const MAX_ENTITY_RANGE_BLOCKS = 40;
const MAX_LOOT_CANDIDATES = 64;
const DIRECTION_RING = [[8, 0], [8, 4], [0, 8], [-4, 8], [-8, 0], [-8, -4], [0, -8], [4, -8]] as const;
const DIRECTION_STEP_UP_BLOCKS = 1;
const DIRECTION_STEP_DOWN_BLOCKS = 3;
const HAZARD_BLOCKS: ReadonlySet<string> = new Set([
  'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'cobweb', 'powder_snow',
]);
const ATTACKING_RECENCY_MS = 1_500;
const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const { SingleValueContainer } = mineflayerRequire('prismarine-chunk/src/pc/common/PaletteContainer') as {
  readonly SingleValueContainer: new (...args: unknown[]) => { readonly value: number };
};
const { OctahedronIterator } = mineflayerRequire('prismarine-world').iterators as {
  readonly OctahedronIterator: new (
    start: Bot['entity']['position'], radius: number,
  ) => { next(): Bot['entity']['position'] | null };
};

interface PacketEventSource {
  on(event: string, listener: (packet: { readonly windowId?: unknown }) => void): unknown;
  removeListener(event: string, listener: (packet: { readonly windowId?: unknown }) => void): unknown;
}

interface Sample<T> {
  readonly value: T;
  readonly observedAt: Tick;
}

type MineflayerBlock = NonNullable<ReturnType<Bot['blockAt']>>;
type MineflayerEntity = Bot['entity'];

export class MineflayerObserver {
  readonly #bot: Bot;
  readonly #border: ClientWorldBorder;
  readonly #clock: () => number;
  readonly #client: PacketEventSource;
  readonly #openedContainers = new Set<string>();
  readonly #onWindowItems: (packet: { readonly windowId?: unknown }) => void;
  readonly #onSpawn: () => void;
  readonly #onHealth: () => void;
  readonly #onRespawn: () => void;
  readonly #onEnd: () => void;
  readonly #onBlockUpdate: (oldBlock: MineflayerBlock | null, newBlock: MineflayerBlock) => void;
  readonly #onEntityHurt: (entity?: MineflayerEntity, source?: MineflayerEntity) => void;
  readonly #diagnostics: ClientDiagnosticSink | null;
  #unknownBorderObservations = 0;
  #pendingTerrainChanges: BlockPosition[] = [];
  #sequence = 0;
  #lastTick: Tick | null = null;
  #spawned = false;
  #healthObserved = false;
  #inventorySynchronized = false;
  #closed = false;
  #lastAgent: Sample<AgentState> | null = null;
  #lastOpponents: Sample<readonly VisibleOpponent[]> | null = null;
  #lastLoot: Sample<readonly LootOpportunity[]> | null = null;
  #lastDamage: { readonly entityId: number; readonly at: number } | null = null;

  constructor(
    bot: Bot,
    clock: () => number = () => performance.now(),
    diagnostics: ClientDiagnosticSink | null = null,
  ) {
    this.#bot = bot;
    this.#diagnostics = diagnostics;
    this.#clock = clock;
    this.#client = bot._client;
    this.#border = new ClientWorldBorder(bot._client, clock);
    this.#onWindowItems = (packet) => {
      if (packet.windowId === 0) this.#inventorySynchronized = true;
    };
    this.#onSpawn = () => {
      this.#spawned = true;
    };
    this.#onHealth = () => {
      this.#healthObserved = true;
    };
    this.#onRespawn = () => this.#resetWorldKnowledge();
    this.#onEnd = () => this.#resetWorldKnowledge();
    this.#onBlockUpdate = (oldBlock, newBlock) => {
      if (oldBlock === null || oldBlock.stateId !== newBlock.stateId) this.#recordTerrainChange(newBlock);
      const key = positionKey(newBlock.position.x, newBlock.position.y, newBlock.position.z);
      if (newBlock.name !== 'chest' && newBlock.name !== 'trapped_chest') {
        this.#openedContainers.delete(key);
      }
    };
    this.#onEntityHurt = (entity, source) => {
      if (entity?.id !== this.#bot.entity?.id || source?.type !== 'player') return;
      const at = this.#clock();
      if (!Number.isFinite(at)) throw new RangeError(`monotonic clock returned a non-finite value: ${at}`);
      this.#lastDamage = { entityId: source.id, at };
    };

    this.#client.on('window_items', this.#onWindowItems);
    this.#bot.on('spawn', this.#onSpawn);
    this.#bot.on('health', this.#onHealth);
    this.#bot.on('respawn', this.#onRespawn);
    this.#bot.on('end', this.#onEnd);
    this.#bot.on('blockUpdate', this.#onBlockUpdate);
    this.#bot.on('entityHurt', this.#onEntityHurt);
  }

  observe(tickValue: number): AgentObservation {
    this.#assertOpen();
    const currentTick = tick(tickValue);
    if (this.#lastTick !== null && currentTick < this.#lastTick) {
      throw new RangeError(`observation tick moved backwards from ${this.#lastTick} to ${currentTick}`);
    }
    this.#lastTick = currentTick;
    this.#sequence += 1;
    const sequence = observationSequence(this.#sequence);

    const agent = this.#agentKnowledge(currentTick);
    const border = this.#border.snapshot();
    this.#trackBorderKnowledge(border);
    const complete = this.#hasCompletePerceptionRange();
    const opponents = complete ? this.#opponentKnowledge(currentTick) : this.#stale(this.#lastOpponents, currentTick);
    const loot = complete ? this.#lootKnowledge(currentTick) : this.#stale(this.#lastLoot, currentTick);

    return agentObservation({
      tick: currentTick,
      sequence,
      agent,
      border,
      opponents,
      loot,
    });
  }

  #recordTerrainChange(block: MineflayerBlock): void {
    const entity = this.#bot.entity;
    if (entity === undefined || entity === null || !isFinitePosition(entity.position)) return;
    const { x, y, z } = block.position;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) return;
    if (Math.hypot(x - entity.position.x, y - entity.position.y, z - entity.position.z) > MAX_ENTITY_RANGE_BLOCKS) return;
    this.#pendingTerrainChanges.push(blockPosition(x, y, z));
    if (this.#pendingTerrainChanges.length > MAX_TERRAIN_CHANGES) this.#pendingTerrainChanges.shift();
  }

  #drainTerrainChanges(): readonly BlockPosition[] | undefined {
    if (this.#pendingTerrainChanges.length === 0) return undefined;
    const drained = this.#pendingTerrainChanges;
    this.#pendingTerrainChanges = [];
    return drained;
  }

  #arrowCount(): number | null {
    let count = 0;
    let hasBow = false;
    for (const item of this.#bot.inventory.slots) {
      if (item === null || item === undefined) continue;
      if (item.name === 'bow') hasBow = true;
      else if (item.name === 'arrow' || item.name === 'tipped_arrow' || item.name === 'spectral_arrow') count += item.count;
    }
    return hasBow ? Math.min(count, MAX_ARROW_COUNT) : null;
  }

  #directionSupport(entity: MineflayerEntity): readonly DirectionSupport[] {
    const baseX = Math.floor(entity.position.x);
    const baseY = Math.floor(entity.position.y);
    const baseZ = Math.floor(entity.position.z);
    const at = (x: number, y: number, z: number): MineflayerBlock | null => this.#bot.blockAt(
      entity.position.offset(x + 0.5 - entity.position.x, y + 0.5 - entity.position.y, z + 0.5 - entity.position.z),
    );
    return DIRECTION_RING.map(([dx, dz]): DirectionSupport => {
      const x = baseX + dx;
      const z = baseZ + dz;
      for (let y = baseY + DIRECTION_STEP_UP_BLOCKS; y >= baseY - DIRECTION_STEP_DOWN_BLOCKS; y -= 1) {
        const ground = at(x, y - 1, z);
        const feet = at(x, y, z);
        const head = at(x, y + 1, z);
        if (ground === null || feet === null || head === null) return Object.freeze({ kind: 'unloaded' as const });
        if (ground.boundingBox !== 'block' || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
        if (HAZARD_BLOCKS.has(head.name) || HAZARD_BLOCKS.has(feet.name)) continue;
        return Object.freeze({
          kind: 'supported' as const,
          support: blockPosition(x, y, z),
          hazard: HAZARD_BLOCKS.has(ground.name),
        });
      }
      return Object.freeze({ kind: 'blocked' as const });
    });
  }

  #trackBorderKnowledge(border: Knowledge<WorldBorder>): void {
    if (border.kind !== 'unknown' || !this.#spawned) {
      this.#unknownBorderObservations = 0;
      return;
    }
    this.#unknownBorderObservations += 1;
    const count = this.#unknownBorderObservations;
    if (count <= BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD
      || (count - 1) % BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD !== 0) return;
    const reason = this.#border.unknownReason();
    if (reason === null) return;
    this.#diagnostics?.({ kind: 'borderUnknown', reason, consecutiveObservations: count });
  }

  isContainerOpened(position: BlockPosition): boolean {
    this.#assertOpen();
    return this.#openedContainers.has(positionKey(position.x, position.y, position.z));
  }

  markContainerOpened(position: BlockPosition): void {
    this.#assertOpen();
    this.#openedContainers.add(positionKey(position.x, position.y, position.z));
  }

  currentBorder(): Knowledge<WorldBorder> {
    this.#assertOpen();
    return this.#border.snapshot();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.removeListener('window_items', this.#onWindowItems);
    this.#bot.removeListener('spawn', this.#onSpawn);
    this.#bot.removeListener('health', this.#onHealth);
    this.#bot.removeListener('respawn', this.#onRespawn);
    this.#bot.removeListener('end', this.#onEnd);
    this.#bot.removeListener('blockUpdate', this.#onBlockUpdate);
    this.#bot.removeListener('entityHurt', this.#onEntityHurt);
    this.#border.close();
    this.#resetWorldKnowledge();
  }

  #agentKnowledge(at: Tick): Knowledge<AgentState> {
    if (!this.#spawned || !this.#healthObserved || !this.#inventorySynchronized) {
      return this.#stale(this.#lastAgent, at);
    }
    const snapshot = this.#readAgentState();
    if (snapshot === null) return this.#stale(this.#lastAgent, at);
    this.#lastAgent = { value: snapshot, observedAt: at };
    return currentKnowledge(snapshot);
  }

  #readAgentState(): AgentState | null {
    const entity = this.#bot.entity;
    if (entity === undefined || entity === null || !isFinitePosition(entity.position)) return null;
    if (!Number.isFinite(this.#bot.health) || !Number.isFinite(this.#bot.food)) return null;
    if (this.#bot.health < 0) {
      throw new RangeError(`health must be between 0 and 40 half-hearts, received ${this.#bot.health}`);
    }
    // Mineflayer already reports half-hearts; ceiling preserves integer policy thresholds and living health.
    const healthHalfHearts = Math.ceil(this.#bot.health);
    if (!Number.isSafeInteger(healthHalfHearts) || !Number.isSafeInteger(this.#bot.food)) return null;

    const inventory = this.#bot.inventory;
    const equipped = {
      ...emptyEquipment(),
      weapon: null as number | null,
    };
    const heldItem = this.#bot.heldItem;
    if (heldItem !== null) {
      const held = classifyItem(this.#bot, heldItem);
      if (held?.kind === 'weapon') equipped.weapon = held.rating;
    }

    const armorSlots = [
      ['helmet', 'head'],
      ['chestplate', 'torso'],
      ['leggings', 'legs'],
      ['boots', 'feet'],
    ] as const;
    for (const [equipmentSlot, mineflayerSlot] of armorSlots) {
      const inventorySlotIndex = this.#bot.getEquipmentDestSlot(mineflayerSlot);
      const item = inventory.slots[inventorySlotIndex];
      if (item === null || item === undefined) continue;
      const known = classifyItem(this.#bot, item);
      if (known?.kind !== 'armor' || known.equipmentSlot !== equipmentSlot) return null;
      equipped[equipmentSlot] = known.rating;
    }

    const foods = [];
    const upgrades = [];
    for (let slot = inventory.inventoryStart; slot < inventory.inventoryEnd; slot += 1) {
      const item = inventory.slots[slot];
      if (item === null || item === undefined) continue;
      const known = classifyItem(this.#bot, item);
      if (known === null) continue;
      if (known.kind === 'ammunition' || known.kind === 'rangedWeapon') continue;
      if (known.kind === 'food') {
        const points = this.#bot.registry.foodsByName[item.name]?.foodPoints;
        const restores = typeof points === 'number' && Number.isSafeInteger(points) && points >= 1 && points <= 20
          ? points
          : undefined;
        foods.push(foodStack(slot, item.count, restores));
      } else {
        const equipmentSlot = known.kind === 'weapon' ? 'weapon' : known.equipmentSlot;
        upgrades.push(equipmentUpgrade(slot, equipmentSlot, known.rating));
      }
    }

    const arrows = this.#arrowCount();
    const directions = this.#directionSupport(entity);
    const terrainChanges = this.#drainTerrainChanges();
    return agentState({
      position: toBlockPosition(entity.position),
      combat: readCombatSelfBody(entity),
      ...(arrows === null ? {} : { ranged: { arrows } }),
      directions,
      ...(terrainChanges === undefined ? {} : { terrainChanges }),
      healthHalfHearts,
      hungerPoints: this.#bot.food,
      foodStacks: foods,
      equipped,
      upgrades,
    });
  }

  #opponentKnowledge(at: Tick): Knowledge<readonly VisibleOpponent[]> {
    if (!this.#spawned || this.#bot.entity === undefined || this.#bot.entity === null) {
      return this.#stale(this.#lastOpponents, at);
    }
    const opponents = Object.values(this.#bot.entities)
      .filter((entity) => entity.id !== this.#bot.entity.id)
      .filter((entity) => isTargetablePlayer(this.#bot, entity))
      .filter((entity) => isVisibleEntity(this.#bot, entity))
      .map((entity) => visibleOpponent(
        entityId(entity.id),
        toBlockPosition(entity.position),
        this.#isRecentAttacker(entity.id),
        readCombatBody(entity),
      ))
      .sort((first, second) => first.id - second.id);
    this.#lastOpponents = { value: opponents, observedAt: at };
    return currentKnowledge(opponents);
  }

  #lootKnowledge(at: Tick): Knowledge<readonly LootOpportunity[]> {
    if (!this.#spawned || this.#bot.entity === undefined || this.#bot.entity === null) {
      return this.#stale(this.#lastLoot, at);
    }
    const loot: LootOpportunity[] = [];
    for (const entity of Object.values(this.#bot.entities)) {
      const item = entity.getDroppedItem();
      if (item === null || !isVisibleEntity(this.#bot, entity)) continue;
      const known = classifyItem(this.#bot, item);
      if (known === null) continue;
      loot.push(visibleDrop(
        entityId(entity.id),
        toBlockPosition(entity.position),
        known,
      ));
    }

    const chestIds = [
      this.#bot.registry.blocksByName.chest?.id,
      this.#bot.registry.blocksByName.trapped_chest?.id,
    ].filter((id): id is number => id !== undefined);
    if (chestIds.length === 0) throw new Error('Mineflayer registry has no chest block IDs');
    prepareLootSearchPalettes(this.#bot);
    const chests = this.#bot.findBlocks({
      point: this.#bot.entity.position,
      matching: chestIds,
      maxDistance: MAX_ENTITY_RANGE_BLOCKS,
      count: MAX_LOOT_CANDIDATES + 1,
    });
    if (chests.length > MAX_LOOT_CANDIDATES) {
      return this.#stale(this.#lastLoot, at);
    }

    for (const candidate of chests) {
      const position = blockPosition(candidate.x, candidate.y, candidate.z);
      if (this.#openedContainers.has(positionKey(position.x, position.y, position.z))) continue;
      const block = this.#bot.blockAt(candidate);
      if (block === null) return this.#stale(this.#lastLoot, at);
      if (block.name !== 'chest' && block.name !== 'trapped_chest') continue;
      if (!isVisiblePosition(this.#bot, block.position, 1)) continue;
      loot.push(unopenedContainer(position));
    }
    loot.sort(compareLoot);
    this.#lastLoot = { value: loot, observedAt: at };
    return currentKnowledge(loot);
  }

  #hasCompletePerceptionRange(): boolean {
    if (!this.#spawned || this.#bot.entity === undefined || this.#bot.entity === null) return false;
    const { x, z } = this.#bot.entity.position;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const minimumChunkX = Math.floor((x - MAX_ENTITY_RANGE_BLOCKS) / 16);
    const maximumChunkX = Math.floor((x + MAX_ENTITY_RANGE_BLOCKS) / 16);
    const minimumChunkZ = Math.floor((z - MAX_ENTITY_RANGE_BLOCKS) / 16);
    const maximumChunkZ = Math.floor((z + MAX_ENTITY_RANGE_BLOCKS) / 16);
    for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
      for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
        const nearestX = clamp(x, chunkX * 16, chunkX * 16 + 16);
        const nearestZ = clamp(z, chunkZ * 16, chunkZ * 16 + 16);
        const distanceX = x - nearestX;
        const distanceZ = z - nearestZ;
        if (distanceX * distanceX + distanceZ * distanceZ > MAX_ENTITY_RANGE_BLOCKS ** 2) continue;
        if (!this.#bot.world.getColumn(chunkX, chunkZ)) return false;
      }
    }
    return true;
  }

  #isRecentAttacker(entityIdValue: number): boolean {
    const damage = this.#lastDamage;
    if (damage === null || damage.entityId !== entityIdValue) return false;
    const elapsed = this.#clock() - damage.at;
    if (!Number.isFinite(elapsed)) throw new RangeError(`monotonic clock returned a non-finite value: ${elapsed}`);
    return elapsed >= 0 && elapsed <= ATTACKING_RECENCY_MS;
  }

  #stale<T>(sample: Sample<T> | null, at: Tick): Knowledge<T> {
    if (sample === null || sample.observedAt >= at) return unknownKnowledge();
    return staleKnowledge(sample.value, sample.observedAt);
  }

  #resetWorldKnowledge(): void {
    this.#spawned = false;
    this.#healthObserved = false;
    this.#inventorySynchronized = false;
    this.#lastAgent = null;
    this.#lastOpponents = null;
    this.#lastLoot = null;
    this.#lastDamage = null;
    this.#openedContainers.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Mineflayer observer is closed');
  }
}

function prepareLootSearchPalettes(bot: Bot): void {
  const game = bot.game as Bot['game'] & { readonly minY: number; readonly height: number };
  const point = bot.entity.position.floored();
  const start = point.offset(
    Math.floor(point.x / 16) - point.x,
    Math.floor(point.y / 16) - point.y,
    Math.floor(point.z / 16) - point.z,
  );
  const iterator = new OctahedronIterator(start, Math.ceil((MAX_ENTITY_RANGE_BLOCKS + 8) / 16));
  let next: Bot['entity']['position'] | null = start;
  while (next !== null) {
    const sectionY = next.y + Math.abs(game.minY >> 4);
    if (sectionY >= 0 && sectionY < (game.height >> 4)) {
      const column = bot.world.getColumn(next.x, next.z) as unknown as {
        readonly sections: readonly { readonly data: unknown; palette: number[] | undefined }[];
      } | undefined;
      const section = column?.sections[sectionY];
      if (section !== undefined && section.palette === undefined && section.data instanceof SingleValueContainer) {
        section.palette = [section.data.value];
      }
    }
    next = iterator.next();
  }
}

function compareLoot(first: LootOpportunity, second: LootOpportunity): number {
  if (first.kind === 'visibleDrop' && second.kind === 'visibleDrop') return first.entityId - second.entityId;
  if (first.kind === 'unopenedContainer' && second.kind === 'unopenedContainer') {
    return first.position.x - second.position.x
      || first.position.y - second.position.y
      || first.position.z - second.position.z;
  }
  return first.kind === 'visibleDrop' ? -1 : 1;
}

function positionKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function isFinitePosition(position: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

