import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import {
  blockPosition,
  isOutsideBorder,
  type BlockPosition,
  type EquipmentSlot,
  type Intent,
  type SkillCancellation,
  type SkillFailure,
  type SkillOutcome,
} from '@arena/core';
import type { Bot, BotEvents } from 'mineflayer';
import { classifyItem, mineflayerEquipmentDestination } from './items.js';
import { MineflayerObserver } from './observer.js';
import { isTargetablePlayer, isVisibleEntity, toBlockPosition } from './perception.js';
import { hasLocalVoxelLineOfSight } from './visibility.js';

const { Movements, goals, pathfinder } = createRequire(import.meta.url)('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');

const MAX_PATH_SEARCH_RADIUS_BLOCKS = 16;
/** Keep long routes inside the pathfinder's fixed search horizon. */
const MAX_PATH_LEG_BLOCKS = 8;
const MAX_NAVIGATION_LEGS = 128;
const MAX_PATH_THINK_MS = 1_000;
const MAX_PATH_SLICE_PER_CLIENT_MS = 3;
const MAX_WORKER_PATH_SLICE_MS = 10;
const MAX_ACTIVE_PATH_SEARCHES = Math.floor(MAX_WORKER_PATH_SLICE_MS / MAX_PATH_SLICE_PER_CLIENT_MS);
const PATH_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
const PICKUP_RANGE_BLOCKS = 1.25;
const APPROACH_RANGE_BLOCKS = 3;
const MAX_TARGET_REPLANS = 8;

type MineflayerItem = NonNullable<Bot['inventory']['slots'][number]>;
type MineflayerWindow = NonNullable<Bot['currentWindow']>;
type MineflayerChest = Awaited<ReturnType<Bot['openContainer']>>;
type MineflayerEntity = Bot['entity'];
type BoundedPathfinder = Bot['pathfinder'] & { searchRadius: number };
type PathfinderGoal = import('mineflayer-pathfinder').goals.Goal;

interface ActiveSkill {
  readonly controller: AbortController;
  readonly resources: SkillResources;
  cancellation: SkillCancellation | null;
  promise: Promise<SkillOutcome>;
}

interface SkillResources {
  navigationActive: boolean;
  eating: boolean;
  inventoryTouched: boolean;
  window: MineflayerChest | null;
  originalQuickBarSlot: number;
}

interface PathSearchWaiter {
  readonly pathfinder: Bot['pathfinder'];
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
  settled: boolean;
}

class SkillFault extends Error {
  readonly failure: SkillFailure;

  constructor(cause: SkillFailure, message: string) {
    super(message);
    this.name = 'SkillFault';
    this.failure = cause;
  }
}

class SkillInterrupted extends Error {
  constructor() {
    super('skill was cancelled');
    this.name = 'SkillInterrupted';
  }
}

const activePathfinders = new Set<Bot['pathfinder']>();
const queuedPathfinders: PathSearchWaiter[] = [];

/** Reserves only as many concurrent contexts as fit inside the worker path-search budget. */
function acquirePathSearchShare(
  pathfinderInstance: Bot['pathfinder'],
  signal: AbortSignal,
  deadline: number,
): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new SkillInterrupted());
  if (performance.now() >= deadline) {
    return Promise.reject(new SkillFault('timedOut', 'bounded navigation exceeded its deadline while waiting for a path search'));
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: PathSearchWaiter = {
      pathfinder: pathfinderInstance,
      signal,
      deadline,
      resolve,
      reject,
      timeout: null,
      onAbort: null,
      settled: false,
    };
    if (activePathfinders.size < MAX_ACTIVE_PATH_SEARCHES && queuedPathfinders.length === 0) {
      grantPathSearchShare(waiter);
      return;
    }

    waiter.onAbort = () => removePathSearchWaiter(waiter, new SkillInterrupted());
    waiter.timeout = setTimeout(
      () => removePathSearchWaiter(waiter, new SkillFault('timedOut', 'bounded navigation expired while waiting for a path search')),
      Math.max(0, deadline - performance.now()),
    );
    signal.addEventListener('abort', waiter.onAbort, { once: true });
    queuedPathfinders.push(waiter);
    if (signal.aborted) waiter.onAbort();
  });
}

function grantPathSearchShare(waiter: PathSearchWaiter): void {
  if (waiter.settled) return;
  if (waiter.signal.aborted) {
    rejectPathSearchWaiter(waiter, new SkillInterrupted());
    return;
  }
  if (performance.now() >= waiter.deadline) {
    rejectPathSearchWaiter(waiter, new SkillFault('timedOut', 'bounded navigation expired while waiting for a path search'));
    return;
  }
  waiter.settled = true;
  clearPathSearchWaiter(waiter);
  activePathfinders.add(waiter.pathfinder);
  let released = false;
  waiter.resolve(() => {
    if (released) return;
    released = true;
    activePathfinders.delete(waiter.pathfinder);
    grantQueuedPathSearches();
  });
}

function removePathSearchWaiter(waiter: PathSearchWaiter, error: Error): void {
  if (waiter.settled) return;
  waiter.settled = true;
  const index = queuedPathfinders.indexOf(waiter);
  if (index >= 0) queuedPathfinders.splice(index, 1);
  clearPathSearchWaiter(waiter);
  waiter.reject(error);
  grantQueuedPathSearches();
}

function rejectPathSearchWaiter(waiter: PathSearchWaiter, error: Error): void {
  if (waiter.settled) return;
  waiter.settled = true;
  clearPathSearchWaiter(waiter);
  waiter.reject(error);
}

function clearPathSearchWaiter(waiter: PathSearchWaiter): void {
  if (waiter.timeout !== null) clearTimeout(waiter.timeout);
  if (waiter.onAbort !== null) waiter.signal.removeEventListener('abort', waiter.onAbort);
  waiter.timeout = null;
  waiter.onAbort = null;
}

function grantQueuedPathSearches(): void {
  while (activePathfinders.size < MAX_ACTIVE_PATH_SEARCHES && queuedPathfinders.length > 0) {
    const waiter = queuedPathfinders.shift();
    if (waiter !== undefined) grantPathSearchShare(waiter);
  }
}

/** Runs one Mineflayer operation at a time and settles it before replacing or closing it. */
export class SkillOwner {
  readonly #bot: Bot;
  readonly #observer: MineflayerObserver;
  readonly #onHealth: () => void;
  #active: ActiveSkill | null = null;
  #transition: Promise<void> = Promise.resolve();
  #cleanupFailure: Error | null = null;
  #quarantinedOperation: Promise<void> | null = null;
  #closed = false;

  constructor(bot: Bot, observer: MineflayerObserver) {
    this.#bot = bot;
    this.#observer = observer;
    configurePathfinder(bot);
    this.#onHealth = () => {
      if (this.#bot.health !== 0) return;
      void this.cancel('agentEliminated').catch((error: unknown) => {
        this.#bot.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    };
    this.#bot.on('health', this.#onHealth);
  }

  run(intent: Intent): Promise<SkillOutcome> {
    const started = this.#enqueue(async () => {
      if (this.#closed) throw new Error('Mineflayer skill owner is closed');
      if (this.#cleanupFailure !== null || this.#quarantinedOperation !== null) {
        throw this.#cleanupFailure ?? new Error('Mineflayer inventory operation is still pending; this client is quarantined');
      }
      await this.#cancelActive('replaced');
      const active: ActiveSkill = {
        controller: new AbortController(),
        resources: {
          navigationActive: false,
          eating: false,
          inventoryTouched: false,
          window: null,
          originalQuickBarSlot: this.#bot.quickBarSlot,
        },
        cancellation: null,
        promise: Promise.resolve({ kind: 'pending' }),
      };
      this.#active = active;
      active.promise = this.#runOwned(intent, active);
      return active;
    });
    return started.then((active) => active.promise);
  }

  cancel(reason: SkillCancellation): Promise<void> {
    return this.#enqueue(() => this.#cancelActive(reason));
  }

  close(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      try {
        await this.#cancelActive('shutdown');
      } finally {
        this.#bot.removeListener('health', this.#onHealth);
      }
    });
  }

  #enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const result = this.#transition.then(action);
    this.#transition = result.then(() => undefined, () => undefined);
    return result;
  }

  async #cancelActive(reason: SkillCancellation): Promise<void> {
    const active = this.#active;
    if (active === null) return;
    active.cancellation ??= reason;
    if (active.resources.eating && this.#bot.usingHeldItem) this.#bot.deactivateItem();
    active.controller.abort();
    await active.promise;
  }

  async #runOwned(intent: Intent, active: ActiveSkill): Promise<SkillOutcome> {
    let outcome: SkillOutcome | null = null;
    let unhandled: unknown;
    try {
      await this.#execute(intent, active);
      if (active.controller.signal.aborted) throw new SkillInterrupted();
      outcome = { kind: 'succeeded' };
    } catch (error) {
      if (error instanceof SkillInterrupted || active.controller.signal.aborted) {
        outcome = { kind: 'cancelled', reason: active.cancellation ?? 'replaced' };
      } else if (error instanceof SkillFault) {
        outcome = { kind: 'failed', cause: error.failure };
      } else {
        unhandled = error;
      }
    }

    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      await this.#releaseResources(active);
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
      this.#cleanupFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (this.#active === active) this.#active = null;
    }
    if (cleanupFailed) {
      if (unhandled !== undefined) throw new AggregateError([unhandled, cleanupFailure], 'skill operation and cleanup both failed');
      throw cleanupFailure;
    }
    if (unhandled !== undefined) throw unhandled;
    if (outcome === null) throw new Error('skill completed without an outcome');
    return outcome;
  }

  async #execute(intent: Intent, active: ActiveSkill): Promise<void> {
    const signal = active.controller.signal;
    throwIfInterrupted(signal);
    switch (intent.kind) {
      case 'hold':
        return;
      case 'navigate':
        await this.#navigateTo(intent.target, 2, active);
        return;
      case 'approach':
        await this.#approach(intent.target, active);
        return;
      case 'attack':
        await this.#attack(intent.target, active);
        return;
      case 'dropCollect':
        await this.#collectDrop(intent.entityId, active);
        return;
      case 'containerOpen':
        await this.#openContainer(intent.position, active);
        return;
      case 'eat':
        await this.#eat(intent.inventorySlot, active);
        return;
      case 'equip':
        await this.#equip(intent.inventorySlot, intent.equipmentSlot, intent.rating, active);
        return;
      default:
        return assertNever(intent);
    }
  }

  async #navigateTo(position: BlockPosition, range: number, active: ActiveSkill): Promise<void> {
    const deadline = performance.now() + PATH_TIMEOUT_MS;
    for (let leg = 0; leg < MAX_NAVIGATION_LEGS; leg += 1) {
      throwIfInterrupted(active.controller.signal);
      const border = this.#observer.currentBorder();
      if (border.kind !== 'current' || isOutsideBorder(border.value, position)) {
        throw new SkillFault('preconditionsNotMet', 'navigation requires a current border and an in-border target');
      }

      const current = this.#bot.entity.position;
      const remainingDistance = distance(current, position);
      if (remainingDistance <= range) return;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new SkillFault('timedOut', 'bounded navigation exceeded its deadline');

      const waypoint = remainingDistance <= MAX_PATH_LEG_BLOCKS + range
        ? position
        : waypointToward(current, position, MAX_PATH_LEG_BLOCKS);
      const goalRange = waypoint === position ? range : 2;
      const goal = new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, goalRange);
      const releaseBudget = await acquirePathSearchShare(this.#bot.pathfinder, active.controller.signal, deadline);
      const searchRemainingMs = deadline - performance.now();
      if (searchRemainingMs <= 0) {
        releaseBudget();
        throw new SkillFault('timedOut', 'bounded navigation exceeded its deadline while waiting for a path search');
      }
      const stopWaits = new AbortController();
      const relayAbort = () => stopWaits.abort();
      active.controller.signal.addEventListener('abort', relayAbort, { once: true });
      const reached = waitForGoal(this.#bot, goal, stopWaits.signal, searchRemainingMs);
      const pathFailure = waitForPathFailure(this.#bot, stopWaits.signal, searchRemainingMs);
      active.resources.navigationActive = true;
      try {
        this.#bot.pathfinder.setGoal(goal, false);
        await Promise.race([reached, pathFailure]);
        throwIfInterrupted(active.controller.signal);
        if (distance(this.#bot.entity.position, position) <= range) return;
        if (leg === MAX_NAVIGATION_LEGS - 1) {
          throw new SkillFault('noProgress', `navigation exceeded ${MAX_NAVIGATION_LEGS} bounded path segments`);
        }
      } finally {
        active.controller.signal.removeEventListener('abort', relayAbort);
        stopWaits.abort();
        try {
          await waitForPathStop(this.#bot, ACTION_TIMEOUT_MS);
          active.resources.navigationActive = false;
        } finally {
          releaseBudget();
        }
      }
    }
    throw new Error('bounded navigation loop exited unexpectedly');
  }

  async #approach(targetId: number, active: ActiveSkill): Promise<void> {
    for (let attempt = 0; attempt < MAX_TARGET_REPLANS; attempt += 1) {
      throwIfInterrupted(active.controller.signal);
      const target = this.#visibleOpponent(targetId);
      if (distance(this.#bot.entity.position, target.position) <= APPROACH_RANGE_BLOCKS) return;
      await this.#navigateTo(toBlockPosition(target.position), 2, active);
    }
    throw new SkillFault('noProgress', `opponent ${targetId} kept moving during approach`);
  }

  async #attack(targetId: number, active: ActiveSkill): Promise<void> {
    let target = this.#visibleOpponent(targetId);
    if (distance(this.#bot.entity.position, target.position) > APPROACH_RANGE_BLOCKS) {
      throw new SkillFault('preconditionsNotMet', `opponent ${targetId} is outside melee reach`);
    }
    const aim = target.position.offset(0, target.height * 0.65, 0);
    await this.#bot.lookAt(aim, false);
    throwIfInterrupted(active.controller.signal);
    target = this.#visibleOpponent(targetId);
    if (distance(this.#bot.entity.position, target.position) > APPROACH_RANGE_BLOCKS) {
      throw new SkillFault('noProgress', `opponent ${targetId} moved out of melee reach`);
    }
    await this.#bot.lookAt(target.position.offset(0, target.height * 0.65, 0), false);
    throwIfInterrupted(active.controller.signal);
    target = this.#visibleOpponent(targetId);
    if (distance(this.#bot.entity.position, target.position) > APPROACH_RANGE_BLOCKS) {
      throw new SkillFault('noProgress', `opponent ${targetId} moved out of melee reach`);
    }
    const confirmation = waitForAttackConfirmation(
      this.#bot,
      targetId,
      active.controller.signal,
      ACTION_TIMEOUT_MS,
    );
    this.#bot.attack(target);
    await confirmation;
  }

  async #collectDrop(entityIdValue: number, active: ActiveSkill): Promise<void> {
    for (let attempt = 0; attempt < MAX_TARGET_REPLANS; attempt += 1) {
      throwIfInterrupted(active.controller.signal);
      const drop = this.#visibleDrop(entityIdValue);
      if (distance(this.#bot.entity.position, drop.position) <= PICKUP_RANGE_BLOCKS) break;
      await this.#navigateTo(toBlockPosition(drop.position), 1, active);
      if (attempt === MAX_TARGET_REPLANS - 1) {
        throw new SkillFault('noProgress', `drop ${entityIdValue} remained outside pickup reach`);
      }
    }
    const drop = this.#visibleDrop(entityIdValue);
    await this.#bot.lookAt(drop.position.offset(0, 0.15, 0), false);
    throwIfInterrupted(active.controller.signal);
    this.#visibleDrop(entityIdValue);
    const confirmation = waitForDropCollection(this.#bot, entityIdValue, active.controller.signal, ACTION_TIMEOUT_MS);
    await confirmation;
  }

  async #openContainer(position: BlockPosition, active: ActiveSkill): Promise<void> {
    const key = `${position.x},${position.y},${position.z}`;
    if (this.#observer.isContainerOpened(position)) {
      throw new SkillFault('preconditionsNotMet', `container ${key} has already been opened by this client`);
    }
    const blockPosition = this.#bot.entity.position.offset(
      position.x + 0.5 - this.#bot.entity.position.x,
      position.y + 0.5 - this.#bot.entity.position.y,
      position.z + 0.5 - this.#bot.entity.position.z,
    );
    let block = this.#bot.blockAt(blockPosition);
    if (block === null || (block.name !== 'chest' && block.name !== 'trapped_chest')) {
      throw new SkillFault('preconditionsNotMet', `container ${key} is not present in this client's loaded world`);
    }
    if (distance(this.#bot.entity.position, block.position.offset(0.5, 0.5, 0.5)) > 3) {
      throw new SkillFault('preconditionsNotMet', `container ${key} is outside interaction reach`);
    }
    if (!hasLocalVoxelLineOfSight(this.#bot, block.position)) {
      throw new SkillFault('preconditionsNotMet', `container ${key} is occluded from this client`);
    }
    if (this.#bot.inventory.selectedItem !== null) {
      throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before opening a container');
    }
    if (this.#bot.currentWindow !== null) {
      throw new SkillFault('preconditionsNotMet', 'another inventory window is already open');
    }

    await this.#bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    throwIfInterrupted(active.controller.signal);
    const currentBlock = this.#bot.blockAt(block.position);
    if (currentBlock === null || (currentBlock.name !== 'chest' && currentBlock.name !== 'trapped_chest')) {
      throw new SkillFault('preconditionsNotMet', `container ${key} changed before activation`);
    }
    if (distance(this.#bot.entity.position, currentBlock.position.offset(0.5, 0.5, 0.5)) > 3
      || !hasLocalVoxelLineOfSight(this.#bot, currentBlock.position)) {
      throw new SkillFault('preconditionsNotMet', `container ${key} is no longer reachable from this client`);
    }
    if (this.#bot.currentWindow !== null) {
      throw new SkillFault('preconditionsNotMet', 'another inventory window opened before container activation');
    }
    if (this.#bot.inventory.selectedItem !== null) {
      throw new SkillFault('preconditionsNotMet', 'inventory cursor became occupied before container activation');
    }
    block = currentBlock;
    const opening = waitForChestWindow(this.#bot, ACTION_TIMEOUT_MS);
    let activationError: unknown;
    try {
      await this.#bot.activateBlock(block);
    } catch (error) {
      activationError = error;
    }
    // Once activation may have sent a packet, wait for its possible window so cancellation can close it.
    let window: MineflayerChest;
    try {
      window = await opening;
    } catch (error) {
      if (activationError !== undefined) {
        throw new SkillFault('serverRejected', errorMessage(activationError));
      }
      throw error;
    }
    active.resources.window = window;
    this.#observer.markContainerOpened(position);
    if (activationError !== undefined) throw new SkillFault('serverRejected', errorMessage(activationError));
    throwIfInterrupted(active.controller.signal);
    await this.#collectKnownContainerItems(window, active);
  }

  async #collectKnownContainerItems(window: MineflayerChest, active: ActiveSkill): Promise<void> {
    for (let slot = 0; slot < window.inventoryStart; slot += 1) {
      throwIfInterrupted(active.controller.signal);
      if (this.#bot.currentWindow !== window) {
        throw new SkillFault('serverRejected', 'container window closed before the client received the item transfer');
      }
      const item = window.slots[slot];
      if (item === null || item === undefined || classifyItem(this.#bot, item) === null) continue;
      if (this.#bot.inventory.emptySlotCount() === 0) continue;
      const before = countInventoryItem(this.#bot, item);
      try {
        await this.#awaitInventoryOperation(
          active,
          `withdraw ${item.name}`,
          () => this.#bot.clickWindow(slot, 0, 1),
        );
      } catch (error) {
        if (active.controller.signal.aborted) throw new SkillInterrupted();
        throw new SkillFault('serverRejected', errorMessage(error));
      }
      throwIfInterrupted(active.controller.signal);
      await waitForCondition(
        this.#bot,
        () => countInventoryItem(this.#bot, item) > before,
        active.controller.signal,
        ACTION_TIMEOUT_MS,
      );
      if (countInventoryItem(this.#bot, item) <= before) {
        throw new SkillFault('noProgress', `container item ${item.name} did not enter the player inventory`);
      }
    }
  }

  async #eat(slot: number, active: ActiveSkill): Promise<void> {
    const item = inventoryItem(this.#bot, slot);
    if (item === null || classifyItem(this.#bot, item)?.kind !== 'food') {
      throw new SkillFault('preconditionsNotMet', `inventory slot ${slot} does not contain known food`);
    }
    if (this.#bot.inventory.selectedItem !== null) {
      throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before eating');
    }
    const beforeFood = this.#bot.food;
    const beforeCount = item.count;
    try {
      await this.#awaitInventoryOperation(active, 'equip food', () => this.#bot.equip(item, 'hand'));
    } catch (error) {
      if (error instanceof SkillInterrupted) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    throwIfInterrupted(active.controller.signal);
    const heldItem = this.#bot.heldItem;
    if (heldItem === null || heldItem.type !== item.type || heldItem.name !== item.name) {
      throw new SkillFault('noProgress', `food from inventory slot ${slot} was not equipped in hand`);
    }
    const heldSlot = heldItem.slot;
    active.resources.eating = true;
    try {
      await this.#awaitInventoryOperation(
        active,
        'consume held food',
        () => this.#bot.consume(),
        ACTION_TIMEOUT_MS,
        null,
      );
    } catch (error) {
      if (active.controller.signal.aborted) throw new SkillInterrupted();
      throw new SkillFault('serverRejected', errorMessage(error));
    } finally {
      active.resources.eating = false;
    }
    throwIfInterrupted(active.controller.signal);
    await waitForCondition(
      this.#bot,
      () => this.#bot.food > beforeFood || slotCount(this.#bot, heldSlot, item) < beforeCount,
      active.controller.signal,
      ACTION_TIMEOUT_MS,
    );
  }

  async #equip(slot: number, equipmentSlot: EquipmentSlot, rating: number, active: ActiveSkill): Promise<void> {
    const item = inventoryItem(this.#bot, slot);
    const known = item === null ? null : classifyItem(this.#bot, item);
    const expected = equipmentSlot === 'weapon'
      ? known?.kind === 'weapon' ? known : null
      : known?.kind === 'armor' && known.equipmentSlot === equipmentSlot ? known : null;
    if (item === null || expected === null || expected.rating !== rating) {
      throw new SkillFault('preconditionsNotMet', `inventory slot ${slot} no longer contains the requested upgrade`);
    }
    if (this.#bot.inventory.selectedItem !== null) {
      throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before equipping');
    }
    const destination = mineflayerEquipmentDestination(equipmentSlot);
    try {
      await this.#awaitInventoryOperation(active, `equip ${equipmentSlot}`, () => this.#bot.equip(item, destination));
    } catch (error) {
      if (error instanceof SkillInterrupted) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    throwIfInterrupted(active.controller.signal);
    const equipped = equipmentSlot === 'weapon'
      ? this.#bot.heldItem
      : this.#bot.inventory.slots[this.#bot.getEquipmentDestSlot(destination)];
    if (equipped === null || equipped === undefined || equipped.type !== item.type || equipped.name !== item.name) {
      throw new SkillFault('noProgress', `inventory slot ${slot} was not equipped as ${equipmentSlot}`);
    }
  }

  #visibleOpponent(entityIdValue: number): MineflayerEntity {
    const entity = this.#bot.entities[String(entityIdValue)];
    if (entity === undefined || !isTargetablePlayer(this.#bot, entity)) {
      throw new SkillFault('preconditionsNotMet', `opponent ${entityIdValue} is not currently targetable`);
    }
    if (!isVisibleEntity(this.#bot, entity)) {
      throw new SkillFault('preconditionsNotMet', `opponent ${entityIdValue} is not currently visible to this client`);
    }
    return entity;
  }

  #visibleDrop(entityIdValue: number): MineflayerEntity {
    const entity = this.#bot.entities[String(entityIdValue)];
    if (entity === undefined || entity.type !== 'object' || entity.getDroppedItem() === null) {
      throw new SkillFault('preconditionsNotMet', `drop ${entityIdValue} is not currently present`);
    }
    if (!isVisibleEntity(this.#bot, entity)) {
      throw new SkillFault('preconditionsNotMet', `drop ${entityIdValue} is not currently visible to this client`);
    }
    return entity;
  }

  async #releaseResources(active: ActiveSkill): Promise<void> {
    const failures: unknown[] = [];
    let cursorRestored = true;
    if (active.resources.navigationActive) {
      try {
        await waitForPathStop(this.#bot, ACTION_TIMEOUT_MS);
      } catch (error) {
        failures.push(error);
      }
      active.resources.navigationActive = false;
    }
    if (active.resources.inventoryTouched) {
      if (this.#cleanupFailure !== null) {
        cursorRestored = false;
        failures.push(this.#cleanupFailure);
      } else {
        try {
          await this.#restoreCursor(active, active.resources.window);
        } catch (error) {
          cursorRestored = false;
          failures.push(error);
        }
      }
    }
    if (cursorRestored && this.#cleanupFailure === null
      && active.resources.window !== null && this.#bot.currentWindow === active.resources.window) {
      try {
        await this.#awaitInventoryOperation(
          active,
          'close owned container',
          () => closeOwnedWindow(this.#bot, active.resources.window as MineflayerChest, ACTION_TIMEOUT_MS),
          ACTION_TIMEOUT_MS + 100,
          null,
        );
        active.resources.window = null;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (this.#bot.quickBarSlot !== active.resources.originalQuickBarSlot) {
        this.#bot.setQuickBarSlot(active.resources.originalQuickBarSlot);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      this.#bot.clearControlStates();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Mineflayer skill cleanup failed');
  }

  async #restoreCursor(active: ActiveSkill, window: MineflayerWindow | null): Promise<void> {
    const selected = window === null ? this.#bot.inventory.selectedItem : window.selectedItem;
    if (selected === null) return;
    const destination = window === null
      ? this.#bot.inventory.firstEmptySlotRange(
        this.#bot.inventory.inventoryStart,
        this.#bot.inventory.inventoryEnd,
      )
      : window.firstEmptySlotRange(window.inventoryStart, window.inventoryEnd)
        ?? window.firstEmptySlotRange(0, window.inventoryStart);
    if (destination === null) {
      throw new Error('cancelled inventory action left an item cursor with no observed empty slot');
    }
    await this.#awaitInventoryOperation(
      active,
      'restore inventory cursor',
      () => this.#bot.clickWindow(destination, 0, 0),
      ACTION_TIMEOUT_MS,
      null,
    );
    if ((window === null ? this.#bot.inventory.selectedItem : window.selectedItem) !== null) {
      throw new Error('Mineflayer did not clear the selected inventory cursor');
    }
  }

  async #awaitInventoryOperation(
    active: ActiveSkill,
    name: string,
    action: () => Promise<void>,
    timeoutMs = ACTION_TIMEOUT_MS,
    signal: AbortSignal | null = active.controller.signal,
  ): Promise<void> {
    if (signal !== null) throwIfInterrupted(signal);
    if (signal?.aborted) throw new SkillInterrupted();
    active.resources.inventoryTouched = true;
    let settled = false;
    const pendingOperation = action();
    const operation = Promise.resolve(pendingOperation)
      .then(
        () => { settled = true; },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
    try {
      await waitForBoundedOperation(operation, signal, timeoutMs, name);
    } catch (error) {
      if (!settled) {
        const quarantineFailure = new Error(`Mineflayer inventory operation "${name}" did not settle; this client is quarantined`);
        this.#cleanupFailure ??= quarantineFailure;
        this.#quarantinedOperation = operation;
        void operation.then(
          () => { if (this.#quarantinedOperation === operation) this.#quarantinedOperation = null; },
          () => { if (this.#quarantinedOperation === operation) this.#quarantinedOperation = null; },
        );
      }
      throw error;
    }
  }
}

function configurePathfinder(bot: Bot): void {
  if (!bot.hasPlugin(pathfinder)) bot.loadPlugin(pathfinder);
  bot.pathfinder.thinkTimeout = MAX_PATH_THINK_MS;
  bot.pathfinder.tickTimeout = MAX_PATH_SLICE_PER_CLIENT_MS;
  (bot.pathfinder as BoundedPathfinder).searchRadius = MAX_PATH_SEARCH_RADIUS_BLOCKS;
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
}

async function waitForGoal(
  bot: Bot,
  target: PathfinderGoal,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'pathfinder did not reach the requested position')), timeoutMs);
    const onAbort = () => finish(new SkillInterrupted());
    const onGoal = (goal: PathfinderGoal) => {
      if (goal === target) finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('goal_reached', onGoal);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('goal_reached', onGoal);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForBoundedOperation(
  operation: Promise<void>,
  signal: AbortSignal | null,
  timeoutMs: number,
  name: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new SkillFault('timedOut', `inventory operation ${name} did not settle before its deadline`)),
      timeoutMs,
    );
    const onAbort = () => finish(new SkillInterrupted());
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal !== null) signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    operation.then(
      () => finish(),
      (error: unknown) => finish(error ?? new Error(`inventory operation ${name} rejected without an error`)),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function waitForPathFailure(bot: Bot, signal: AbortSignal, timeoutMs: number): Promise<never> {
  await new Promise<never>((_resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'pathfinder did not produce a path')), timeoutMs);
    const onAbort = () => finish(new SkillInterrupted());
    const onPath = (path: { readonly status: string }) => {
      if (path.status === 'noPath') finish(new SkillFault('noProgress', 'pathfinder found no path through received blocks'));
      if (path.status === 'timeout') finish(new SkillFault('timedOut', 'pathfinder exhausted its bounded search time'));
    };
    const finish = (error: Error) => {
      clearTimeout(timeout);
      bot.removeListener('path_update', onPath);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    bot.on('path_update', onPath);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  throw new Error('unreachable path failure wait');
}

async function waitForPathStop(bot: Bot, timeoutMs: number): Promise<void> {
  if (bot.pathfinder.goal === null && !bot.pathfinder.isMoving()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'pathfinder did not stop after cancellation')), timeoutMs);
    const onStop = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('path_stop', onStop);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('path_stop', onStop);
    bot.pathfinder.stop();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    if (bot.pathfinder.goal === null && !bot.pathfinder.isMoving()) finish();
  });
}

async function waitForAttackConfirmation(
  bot: Bot,
  targetId: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', `attack on entity ${targetId} had no observed damage`)), timeoutMs);
    const onAbort = () => finish(new SkillInterrupted());
    const onHurt = (entity?: MineflayerEntity, source?: MineflayerEntity) => {
      if (entity?.id === targetId && source?.id === bot.entity.id) finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('entityHurt', onHurt);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('entityHurt', onHurt);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForDropCollection(
  bot: Bot,
  targetId: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', `drop ${targetId} was not collected`)), timeoutMs);
    const onAbort = () => finish(new SkillInterrupted());
    const onCollect: BotEvents['playerCollect'] = (collector, collected) => {
      if (collector.id !== bot.entity.id || collected.id !== targetId) return;
      finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('playerCollect', onCollect);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('playerCollect', onCollect);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForChestWindow(bot: Bot, timeoutMs: number): Promise<MineflayerChest> {
  let finish!: (error?: Error, window?: MineflayerChest) => void;
  return new Promise<MineflayerChest>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'server did not open the requested chest')), timeoutMs);
    const onOpen: BotEvents['windowOpen'] = (window) => {
      if (!isChestWindow(window)) return;
      finish(undefined, window);
    };
    finish = (error?: Error, window?: MineflayerChest) => {
      clearTimeout(timeout);
      bot.removeListener('windowOpen', onOpen);
      if (error !== undefined) reject(error);
      else if (window !== undefined) resolve(window);
      else reject(new Error('chest window event did not include a window'));
    };
    bot.on('windowOpen', onOpen);
  });
}

async function closeOwnedWindow(bot: Bot, window: MineflayerChest, timeoutMs: number): Promise<void> {
  if (bot.currentWindow !== window) return;
  let finish!: (error?: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'server did not confirm the container closed')), timeoutMs);
    const onClose: BotEvents['windowClose'] = (closedWindow) => {
      if (closedWindow === window) finish();
    };
    finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('windowClose', onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('windowClose', onClose);
  });
  try {
    try {
      await bot.closeWindow(window);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    if (bot.currentWindow !== window) finish();
    await closed;
  } finally {
    if (bot.currentWindow !== window) finish();
  }
}

async function waitForCondition(
  bot: Bot,
  condition: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    throwIfInterrupted(signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new SkillFault('timedOut', 'expected client state did not arrive');
    await waitForPhysicsTick(bot, signal, remaining);
  }
}

async function waitForPhysicsTick(bot: Bot, signal: AbortSignal, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'client did not advance to the next physics tick')), timeoutMs);
    const onAbort = () => finish(new SkillInterrupted());
    const onTick = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('physicsTick', onTick);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('physicsTick', onTick);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function isChestWindow(window: MineflayerWindow): window is MineflayerChest {
  return (window.inventoryStart === 27 || window.inventoryStart === 54)
    && typeof (window as MineflayerChest).withdraw === 'function';
}

function inventoryItem(bot: Bot, slot: number): MineflayerItem | null {
  const item = bot.inventory.slots[slot];
  return item === undefined ? null : item;
}

function countInventoryItem(bot: Bot, target: MineflayerItem): number {
  return bot.inventory.items()
    .filter((item) => item.type === target.type && item.metadata === target.metadata)
    .reduce((count, item) => count + item.count, 0);
}

function slotCount(bot: Bot, slot: number, target: MineflayerItem): number {
  const item = bot.inventory.slots[slot];
  return item !== null && item !== undefined && item.type === target.type && item.metadata === target.metadata
    ? item.count
    : 0;
}

function distance(first: { readonly x: number; readonly y: number; readonly z: number }, second: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function waypointToward(
  current: { readonly x: number; readonly y: number; readonly z: number },
  target: BlockPosition,
  distanceBlocks: number,
): BlockPosition {
  const distanceToTarget = distance(current, target);
  if (distanceToTarget <= distanceBlocks) return target;
  const fraction = distanceBlocks / distanceToTarget;
  return blockPosition(
    Math.round(current.x + (target.x - current.x) * fraction),
    Math.round(current.y + (target.y - current.y) * fraction),
    Math.round(current.z + (target.z - current.z) * fraction),
  );
}

function throwIfInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillInterrupted();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`unsupported skill intent: ${String((value as { kind?: unknown }).kind)}`);
}
