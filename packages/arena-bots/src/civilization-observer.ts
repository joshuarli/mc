import {
  CIVILIZATION_TEAM_MESSAGE_MAX_BYTES,
  CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS,
  CIVILIZATION_TEAM_MESSAGE_MIN_INTERVAL_TICKS,
  CIVILIZATION_TEAM_MESSAGE_QUEUE_LIMIT,
  agentObservation,
  civilizationObservation,
  civilizationOutpostCells,
  civilizationPolicyContext,
  civilizationProfileForSeat,
  civilizationTeamMessage,
  currentKnowledge,
  entityId,
  materialStack,
  outpostCell,
  staleKnowledge,
  storedMaterialStack,
  tick,
  unknownKnowledge,
  type BlockPosition,
  type CivilizationResourceObservation,
  type CivilizationPolicyContextInput,
  type Knowledge,
  type MaterialItem,
  type ReportedResource,
  type VisibleOpponent,
} from '@arena/core';
import { Buffer } from 'node:buffer';
import type { Bot, BotEvents } from 'mineflayer';
import { isVisibleEntity, isVisiblePosition, toBlockPosition } from './perception.js';
import { MineflayerObserver } from './observer.js';

const MAX_LOCAL_BLOCK_CANDIDATES = 64;
const MAX_LOCAL_DROP_CANDIDATES = 64;
type CivilizationPolicyContext = ReturnType<typeof civilizationPolicyContext>;
type CivilizationObservation = ReturnType<typeof civilizationObservation>;
type CivilizationTeamMessage = ReturnType<typeof civilizationTeamMessage>;
type MineflayerItem = NonNullable<Bot['inventory']['slots'][number]>;
type MineflayerBlock = NonNullable<ReturnType<Bot['blockAt']>>;
type MineflayerChest = Awaited<ReturnType<Bot['openContainer']>>;

interface DecodedCivilizationTeamReport {
  readonly sourceTick: number;
  readonly declaredStale: boolean;
  readonly kind: 'resourceSighting';
  readonly resource: ReportedResource;
  readonly position: BlockPosition;
}

export interface CivilizationRosterMember {
  readonly seat: number;
  readonly username: string;
  readonly offlineUuid: string;
}

interface Observed<T> {
  readonly value: T;
  readonly observedAt: ReturnType<typeof tick>;
}

export class MineflayerCivilizationObserver {
  readonly #bot: Bot;
  readonly #context: CivilizationPolicyContext;
  readonly #profile: NonNullable<ReturnType<typeof civilizationProfileForSeat>>;
  readonly #seatByIdentity: ReadonlyMap<string, number>;
  readonly #client: Bot['_client'];
  readonly #containerWindows = new Map<string, MineflayerChest>();
  readonly #messages: CivilizationTeamMessage[] = [];
  readonly #lastMessageTickBySender = new Map<number, number>();
  readonly #onWindowItems: (packet: { readonly windowId?: unknown }) => void;
  readonly #onWindowClose: BotEvents['windowClose'];
  readonly #onRespawn: () => void;
  readonly #onEnd: () => void;
  #lastTick: ReturnType<typeof tick> | null = null;
  #inventorySynchronized = false;
  #lastMaterials: Observed<readonly ReturnType<typeof materialStack>[]> | null = null;
  #lastResources: Observed<readonly CivilizationResourceObservation[]> | null = null;
  #closed = false;

  constructor(
    bot: Bot,
    input: CivilizationPolicyContextInput,
    publicRoster: readonly CivilizationRosterMember[],
  ) {
    this.#bot = bot;
    this.#context = civilizationPolicyContext(input);
    const profile = civilizationProfileForSeat(this.#context.seat);
    if (profile === null || profile.faction !== this.#context.faction || profile.role !== this.#context.role) {
      throw new RangeError('civilization context does not match its canonical seat profile');
    }
    this.#profile = profile;
    this.#seatByIdentity = seatByPublicIdentity(publicRoster);
    this.#client = bot._client;
    this.#onWindowItems = (packet) => {
      if (packet.windowId === 0) this.#inventorySynchronized = true;
    };
    this.#onWindowClose = (window) => {
      for (const [key, ownedWindow] of this.#containerWindows) {
        if (ownedWindow === window) this.#containerWindows.delete(key);
      }
    };
    this.#onRespawn = () => {
      this.#inventorySynchronized = false;
      this.#containerWindows.clear();
    };
    this.#onEnd = () => {
      this.#inventorySynchronized = false;
      this.#containerWindows.clear();
    };
    this.#client.on('window_items', this.#onWindowItems);
    this.#bot.on('windowClose', this.#onWindowClose);
    this.#bot.on('respawn', this.#onRespawn);
    this.#bot.on('end', this.#onEnd);
  }

  observe(tickValue: number, base: ReturnType<MineflayerObserver['observe']>): CivilizationObservation {
    this.#assertOpen();
    this.#assertOwnRosterIdentity();
    const currentTick = tick(tickValue);
    if (base.tick !== currentTick) {
      throw new RangeError(`civilization observation tick ${currentTick} does not match base observation tick ${base.tick}`);
    }
    this.#recordTick(currentTick);
    const ownMaterials = this.#ownMaterials(currentTick);
    const observedResources = this.#observedResources(currentTick);
    const teamMessages = this.#currentTeamMessages(currentTick);
    const filteredBase = agentObservation({
      tick: base.tick,
      sequence: base.sequence,
      agent: base.agent,
      border: base.border,
      opponents: this.#filterTeammates(base.opponents),
      loot: base.loot,
    });
    const observation = civilizationObservation({ base: filteredBase, ownMaterials, observedResources, teamMessages }, this.#context);
    this.#messages.length = 0;
    return observation;
  }

  isRosteredOpponent(entityIdValue: number): boolean {
    this.#assertOpen();
    this.#assertOwnRosterIdentity();
    const player = Object.values(this.#bot.players)
      .find((candidate) => candidate.entity?.id === entityIdValue);
    if (player === undefined) return false;
    const seat = this.#seatByIdentity.get(publicIdentityKey(player.username, player.uuid));
    const profile = seat === undefined ? null : civilizationProfileForSeat(seat);
    return profile !== null && profile.faction !== this.#profile.faction;
  }

  receiveTeamReport(
    authenticatedSenderSeat: number,
    decodedReport: unknown,
    currentTickValue: number,
  ): void {
    this.#assertOpen();
    this.#assertOwnRosterIdentity();
    const sender = civilizationProfileForSeat(authenticatedSenderSeat);
    if (sender === null || sender.faction !== this.#profile.faction || sender.seat === this.#profile.seat) {
      throw new RangeError(`team report sender seat ${authenticatedSenderSeat} is not an eligible teammate`);
    }
    const currentTick = tick(currentTickValue);
    this.#recordTick(currentTick);
    this.#discardExpiredMessages(currentTick);
    const report = decodeTeamReport(decodedReport);
    const sourceTick = tick(report.sourceTick);
    if (sourceTick > currentTick) {
      throw new RangeError(`team report from seat ${authenticatedSenderSeat} is from future tick ${sourceTick}`);
    }
    if (currentTick - sourceTick > CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS) {
      throw new RangeError(`team report from seat ${authenticatedSenderSeat} is older than ${CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS} ticks`);
    }
    if (this.#messages.length >= CIVILIZATION_TEAM_MESSAGE_QUEUE_LIMIT) {
      throw new RangeError(`team report queue is full at ${CIVILIZATION_TEAM_MESSAGE_QUEUE_LIMIT} messages`);
    }
    const previousTick = this.#lastMessageTickBySender.get(authenticatedSenderSeat);
    if (previousTick !== undefined && currentTick - previousTick < CIVILIZATION_TEAM_MESSAGE_MIN_INTERVAL_TICKS) {
      throw new RangeError(`team report from seat ${authenticatedSenderSeat} arrived before its ${CIVILIZATION_TEAM_MESSAGE_MIN_INTERVAL_TICKS}-tick interval`);
    }
    const typedMessage = civilizationTeamMessage({
      sender: authenticatedSenderSeat,
      sourceTick,
      declaredStale: report.declaredStale,
      kind: report.kind,
      resource: report.resource,
      position: report.position,
    });
    const encodedMessage = JSON.stringify(typedMessage);
    if (encodedMessage === undefined) {
      throw new TypeError('civilization team report could not be encoded as JSON');
    }
    const encodedBytes = Buffer.byteLength(encodedMessage, 'utf8');
    if (encodedBytes > CIVILIZATION_TEAM_MESSAGE_MAX_BYTES) {
      throw new RangeError(`team report is ${encodedBytes} bytes; maximum is ${CIVILIZATION_TEAM_MESSAGE_MAX_BYTES}`);
    }
    this.#messages.push(typedMessage);
    this.#lastMessageTickBySender.set(authenticatedSenderSeat, currentTick);
  }

  isInventorySynchronized(): boolean {
    this.#assertOpen();
    return this.#inventorySynchronized;
  }

  markContainerOpened(position: BlockPosition, window: MineflayerChest): void {
    this.#assertOpen();
    if (this.#bot.currentWindow !== window || !isChestWindow(window)) {
      throw new Error('container can be recorded only after this client receives a synchronized chest window');
    }
    this.#containerWindows.set(positionKey(position), window);
  }

  containerWindowAt(position: BlockPosition): MineflayerChest | null {
    this.#assertOpen();
    const window = this.#containerWindows.get(positionKey(position));
    if (window === undefined || this.#bot.currentWindow !== window) return null;
    return window;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.removeListener('window_items', this.#onWindowItems);
    this.#bot.removeListener('windowClose', this.#onWindowClose);
    this.#bot.removeListener('respawn', this.#onRespawn);
    this.#bot.removeListener('end', this.#onEnd);
    this.#containerWindows.clear();
    this.#messages.length = 0;
    this.#lastMessageTickBySender.clear();
  }

  #ownMaterials(at: ReturnType<typeof tick>): Knowledge<readonly ReturnType<typeof materialStack>[]> {
    if (!this.#inventorySynchronized) return this.#stale(this.#lastMaterials, at);
    const materials: ReturnType<typeof materialStack>[] = [];
    for (let slot = 0; slot < this.#bot.inventory.slots.length; slot += 1) {
      const item = this.#bot.inventory.slots[slot];
      if (item === null || item === undefined) continue;
      const material = materialItem(item);
      if (material === null) continue;
      materials.push(materialStack(slot, material, item.count));
    }
    this.#lastMaterials = { value: materials, observedAt: at };
    return currentKnowledge(materials);
  }

  #filterTeammates(
    opponents: Knowledge<readonly VisibleOpponent[]>,
  ): Knowledge<readonly VisibleOpponent[]> {
    if (opponents.kind === 'unknown') return unknownKnowledge();
    const filtered = opponents.value.filter((opponent) => this.isRosteredOpponent(opponent.id));
    return opponents.kind === 'current'
      ? currentKnowledge(filtered)
      : staleKnowledge(filtered, opponents.observedAt);
  }

  #assertOwnRosterIdentity(): void {
    const player = this.#bot.player;
    if (typeof this.#bot.username !== 'string' || player === undefined || player === null
      || typeof player.uuid !== 'string') {
      throw new Error('Mineflayer client identity is unavailable for civilization roster verification');
    }
    const seat = this.#seatByIdentity.get(publicIdentityKey(this.#bot.username, player.uuid));
    if (seat !== this.#profile.seat) {
      throw new Error(`Mineflayer client identity does not match civilization seat ${this.#profile.seat}`);
    }
  }

  #observedResources(at: ReturnType<typeof tick>): Knowledge<readonly CivilizationResourceObservation[]> {
    const entity = this.#bot.entity;
    if (entity === undefined || entity === null || !isFinitePosition(entity.position)) {
      return this.#stale(this.#lastResources, at);
    }
    const resources: CivilizationResourceObservation[] = [];
    this.#appendBlocks(resources, 'oak_log', 'logBlock');
    this.#appendDrops(resources);
    this.#appendContainers(resources);
    this.#appendOutpostCells(resources);
    this.#lastResources = { value: resources, observedAt: at };
    return currentKnowledge(resources);
  }

  #appendBlocks(
    resources: CivilizationResourceObservation[],
    blockName: 'oak_log',
    kind: 'logBlock',
  ): void {
    const blockType = this.#bot.registry.blocksByName[blockName];
    if (blockType === undefined) throw new Error(`Mineflayer registry lacks required block ${blockName}`);
    for (const position of this.#bot.findBlocks({
      matching: blockType.id,
      maxDistance: 40,
      count: MAX_LOCAL_BLOCK_CANDIDATES,
    })) {
      const block = this.#bot.blockAt(position);
      if (block === null || block.name !== blockName || !isVisiblePosition(this.#bot, position, 1)) continue;
      resources.push({ kind, position: toBlockPosition(position) });
    }
  }

  #appendDrops(resources: CivilizationResourceObservation[]): void {
    let count = 0;
    for (const entity of Object.values(this.#bot.entities)) {
      if (count >= MAX_LOCAL_DROP_CANDIDATES) break;
      const item = entity.getDroppedItem();
      const material = item === null ? null : materialItem(item);
      if (material === null || !isVisibleEntity(this.#bot, entity)) continue;
      resources.push({
        kind: 'materialDrop',
        entityId: entityId(entity.id),
        position: toBlockPosition(entity.position),
        item: material,
      });
      count += 1;
    }
  }

  #appendContainers(resources: CivilizationResourceObservation[]): void {
    for (const blockName of ['chest', 'trapped_chest'] as const) {
      const blockType = this.#bot.registry.blocksByName[blockName];
      if (blockType === undefined) throw new Error(`Mineflayer registry lacks required block ${blockName}`);
      for (const position of this.#bot.findBlocks({
        matching: blockType.id,
        maxDistance: 40,
        count: MAX_LOCAL_BLOCK_CANDIDATES,
      })) {
        const block = this.#bot.blockAt(position);
        if (block === null || block.name !== blockName || !isVisiblePosition(this.#bot, position, 1)) continue;
        const blockPositionValue = toBlockPosition(position);
        const window = this.containerWindowAt(blockPositionValue);
        resources.push({
          kind: 'container',
          position: blockPositionValue,
          contents: window === null ? unknownKnowledge() : currentKnowledge(this.#containerContents(window)),
        });
      }
    }
  }

  #appendOutpostCells(resources: CivilizationResourceObservation[]): void {
    const { anchor, rotationDegrees } = this.#context.objective.outpost;
    for (const cell of civilizationOutpostCells(anchor, rotationDegrees)) {
      const block = this.#bot.blockAt(asVec3(this.#bot, cell.position));
      if (block === null) continue;
      const support = this.#bot.blockAt(asVec3(this.#bot, cell.supportPosition));
      resources.push(outpostCell(
        cell.position,
        outpostBlockState(block),
        support === null ? 'unknown' : support.boundingBox === 'block' ? 'solid' : 'notSolid',
      ));
    }
  }

  #containerContents(window: MineflayerChest): readonly ReturnType<typeof storedMaterialStack>[] {
    const contents: ReturnType<typeof storedMaterialStack>[] = [];
    for (let slot = 0; slot < window.inventoryStart; slot += 1) {
      const item = window.slots[slot];
      if (item === null || item === undefined) continue;
      const material = materialItem(item);
      if (material === null) continue;
      contents.push(storedMaterialStack(slot, material, item.count));
    }
    return contents;
  }

  #currentTeamMessages(at: ReturnType<typeof tick>): readonly CivilizationTeamMessage[] {
    const current: CivilizationTeamMessage[] = [];
    for (const message of this.#messages) {
      if (message.sourceTick > at) {
        throw new Error(`queued team report source tick ${message.sourceTick} is after observation tick ${at}`);
      }
      if (at - message.sourceTick > CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS) continue;
      current.push(message);
    }
    return current;
  }

  #discardExpiredMessages(at: ReturnType<typeof tick>): void {
    for (let index = this.#messages.length - 1; index >= 0; index -= 1) {
      const message = this.#messages[index];
      if (message !== undefined && at - message.sourceTick > CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS) {
        this.#messages.splice(index, 1);
      }
    }
  }

  #stale<T>(sample: Observed<T> | null, at: ReturnType<typeof tick>): Knowledge<T> {
    return sample === null || sample.observedAt >= at
      ? unknownKnowledge()
      : staleKnowledge(sample.value, sample.observedAt);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Mineflayer civilization observer is closed');
  }

  #recordTick(at: ReturnType<typeof tick>): void {
    if (this.#lastTick !== null && at < this.#lastTick) {
      throw new RangeError(`civilization observation tick moved backwards from ${this.#lastTick} to ${at}`);
    }
    this.#lastTick = at;
  }
}

function decodeTeamReport(value: unknown): DecodedCivilizationTeamReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('civilization team report must be a plain object');
  }
  const report = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(report);
  const expectedKeys = ['sourceTick', 'declaredStale', 'kind', 'resource', 'position'];
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    throw new TypeError('civilization team report has missing or unknown fields');
  }
  const position = report.position;
  if (typeof report.sourceTick !== 'number' || typeof report.declaredStale !== 'boolean'
    || report.kind !== 'resourceSighting' || typeof report.resource !== 'string'
    || typeof position !== 'object' || position === null || Array.isArray(position)
    || (Object.getPrototypeOf(position) !== Object.prototype && Object.getPrototypeOf(position) !== null)) {
    throw new TypeError('civilization team report fields are malformed');
  }
  const positionFields = Reflect.ownKeys(position);
  if (positionFields.length !== 3 || positionFields.some((field) =>
    field !== 'x' && field !== 'y' && field !== 'z')) {
    throw new TypeError('civilization team report position has missing or unknown fields');
  }
  return {
    sourceTick: report.sourceTick,
    declaredStale: report.declaredStale,
    kind: 'resourceSighting',
    resource: report.resource as ReportedResource,
    position: position as BlockPosition,
  };
}

function materialItem(item: MineflayerItem): MaterialItem | null {
  return item.name === 'oak_log' || item.name === 'oak_planks' ? item.name : null;
}

function outpostBlockState(block: MineflayerBlock): 'air' | 'oak_planks' | 'other' {
  if (block.name === 'air') return 'air';
  if (block.name === 'oak_planks') return 'oak_planks';
  return 'other';
}

function isChestWindow(window: MineflayerChest): boolean {
  return (window.inventoryStart === 27 || window.inventoryStart === 54)
    && typeof (window as MineflayerChest & { withdraw?: unknown }).withdraw === 'function';
}

function asVec3(bot: Bot, position: BlockPosition): Parameters<Bot['blockAt']>[0] {
  const current = bot.entity.position;
  return current.offset(position.x - current.x, position.y - current.y, position.z - current.z);
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function seatByPublicIdentity(
  publicRoster: readonly CivilizationRosterMember[],
): ReadonlyMap<string, number> {
  if (publicRoster.length !== 6) {
    throw new RangeError(`civilization public roster must contain six seats, received ${publicRoster.length}`);
  }
  const seatsByIdentity = new Map<string, number>();
  const seats = new Set<number>();
  const usernames = new Set<string>();
  const uuids = new Set<string>();
  for (const member of publicRoster) {
    const profile = civilizationProfileForSeat(member.seat);
    if (profile === null || seats.has(member.seat)) {
      throw new RangeError(`civilization public roster has an invalid or repeated seat ${member.seat}`);
    }
    if (!/^[A-Za-z0-9_]{1,16}$/.test(member.username) || usernames.has(member.username)) {
      throw new RangeError(`civilization public roster has an invalid or repeated username ${member.username}`);
    }
    const normalizedUuid = member.offlineUuid.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalizedUuid)
      || uuids.has(normalizedUuid)) {
      throw new RangeError(`civilization public roster has an invalid or repeated UUID for ${member.username}`);
    }
    seatsByIdentity.set(publicIdentityKey(member.username, normalizedUuid), member.seat);
    seats.add(member.seat);
    usernames.add(member.username);
    uuids.add(normalizedUuid);
  }
  return seatsByIdentity;
}

function publicIdentityKey(username: string, uuid: string): string {
  return `${username}\u0000${uuid.toLowerCase()}`;
}

function isFinitePosition(position: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}
