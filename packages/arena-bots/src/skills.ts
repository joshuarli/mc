import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import {
  blockPosition,
  isOutsideBorder,
  type BlockPosition,
  type CivIntent,
  type EquipmentSlot,
  type SkillCancellation,
  type SkillOutcome,
} from '@arena/core';
import type { Bot, BotEvents } from 'mineflayer';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { classifyItem, mineflayerEquipmentDestination } from './items.js';
import { MineflayerCivilizationObserver } from './civilization-observer.js';
import {
  craftCivilizationMaterial,
  mineCivilizationBlock,
  placeCivilizationBlock,
  transferContainerMaterial,
  type CivilizationSkillHost,
} from './civilization-skills.js';
import { MineflayerObserver } from './observer.js';
import { recordPathDiagnostic } from './path-diagnostics.js';
import { isTargetablePlayer, isVisibleEntity, toBlockPosition } from './perception.js';
import type { ArenaSkillIntent } from './skill-intent.js';
import {
  ACTION_TIMEOUT_MS,
  SkillFault,
  SkillInterrupted,
  distance,
  errorMessage,
  throwIfInterrupted,
  waitForChestWindow,
  waitForCondition,
  type ActiveSkill,
  type MineflayerChest,
  type MineflayerEntity,
  type MineflayerItem,
  type MineflayerWindow,
} from './skill-support.js';
import { hasLocalVoxelLineOfSight } from './visibility.js';

const { Movements, goals, pathfinder } = createRequire(import.meta.url)('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');
const AStar = createRequire(import.meta.url)('mineflayer-pathfinder/lib/astar') as AStarConstructor;
const { version: PATHFINDER_VERSION } = createRequire(import.meta.url)('mineflayer-pathfinder/package.json') as { version: string };

const MAX_PATH_SEARCH_RADIUS_BLOCKS = 16;
const MAX_PATH_LEG_BLOCKS = 8;
const MAX_NAVIGATION_LEGS = 128;
const MAX_PATH_THINK_MS = 1_000;
const MAX_PATH_SLICE_PER_CLIENT_MS = 3;
const MAX_WORKER_PATH_SLICE_MS = 10;
const PINNED_PATHFINDER_VERSION = '2.4.5';
const PATH_TIMEOUT_MS = 20_000;
const PICKUP_RANGE_BLOCKS = 0.9;
const APPROACH_RANGE_BLOCKS = 3;
const MAX_TARGET_REPLANS = 8;

type BoundedPathfinder = Bot['pathfinder'] & { searchRadius: number };
type PathfinderGoal = import('mineflayer-pathfinder').goals.Goal;
type SkillIntent = ArenaSkillIntent | CivIntent;

interface WindowItemsPacket {
  readonly windowId?: unknown;
  readonly items?: readonly unknown[];
}

type MineflayerWindowSynchronizer = Bot & {
  readonly _syncWindow?: (window: MineflayerWindow) => Promise<void>;
};

interface WindowTransferReceipt {
  readonly promise: Promise<void>;
  arm(): void;
  dispose(): void;
}

interface DropCollectionReceipt {
  readonly promise: Promise<void>;
  readonly collected: boolean;
  arm(): void;
  dispose(): void;
}

type NavigationArrival =
  | { readonly kind: 'withinRange'; readonly range: number }
  | { readonly kind: 'exactBlock' };
type NavigationPosition = Readonly<{ x: number; y: number; z: number }>;


interface AStarContext {
  readonly movements: InstanceType<typeof Movements>;
  readonly bestNode: unknown;
  tickTimeout: number;
  makeResult(status: 'partial', node: unknown): PartiallyComputedPath;
}

type AStarCompute = (this: AStarContext) => PartiallyComputedPath;

interface AStarConstructor {
  new (...args: unknown[]): AStarContext;
  readonly prototype: AStarContext & { compute: AStarCompute };
}

type PathSearchTransition = 'queued' | 'acquired' | 'released' | 'cancelled' | 'timedOut';
type PathSearchCompletion = Extract<PathSearchTransition, 'released' | 'cancelled' | 'timedOut'>;

interface PathSearchOwner {
  readonly bot: Bot;
  readonly movements: InstanceType<typeof Movements>;
  readonly onGoalUpdated: (goal: PathfinderGoal | null) => void;
  readonly onPathStop: () => void;
  closed: boolean;
  queued: boolean;
  signal: AbortSignal | null;
  deadline: number | null;
  onAbort: (() => void) | null;
}

interface PathSearchRegistration {
  beginNavigation(signal: AbortSignal, deadline: number): (completion: PathSearchCompletion) => void;
  close(): void;
}

// The pathfinder mutates and consumes returned Move objects while AStar still owns partial-route nodes.
function snapshotPathResult(result: PartiallyComputedPath): PartiallyComputedPath {
  const path = result.path.map((node) => Object.assign(
    Object.create(Object.getPrototypeOf(node)) as typeof node,
    node,
    {
      x: node.x,
      y: node.y,
      z: node.z,
      toBreak: [...node.toBreak],
      toPlace: [...node.toPlace],
    },
  ));
  return { ...result, path };
}

/**
 * Mineflayer pathfinder 2.4.5 hides AStar contexts inside getPathTo and advances
 * partial contexts from physicsTick, so both routes must share the same owner queue.
 */
class PathSearchWorker {
  readonly #ownersByBot = new WeakMap<Bot, PathSearchOwner>();
  readonly #arenaBots = new WeakSet<Bot>();
  readonly #owners = new Set<PathSearchOwner>();
  readonly #queuedOwners: PathSearchOwner[] = [];
  readonly #clientSpentMs = new Map<PathSearchOwner, number>();
  readonly #computeHook: AStarCompute;
  #originalCompute: AStarCompute | null = null;
  #windowStartedAt: number | null = null;
  #workerSpentMs = 0;
  #activeSearches = 0;

  constructor() {
    const worker = this;
    this.#computeHook = function (this: AStarContext): PartiallyComputedPath {
      return worker.#compute(this);
    };
  }

  register(bot: Bot, movements: InstanceType<typeof Movements>): PathSearchRegistration {
    if (PATHFINDER_VERSION !== PINNED_PATHFINDER_VERSION) {
      throw new Error(`Path search scheduling requires mineflayer-pathfinder ${PINNED_PATHFINDER_VERSION}; found ${PATHFINDER_VERSION}`);
    }
    if (this.#ownersByBot.has(bot)) throw new Error('a path search worker owner is already registered for this bot');
    this.#installHook();

    const owner: PathSearchOwner = {
      bot,
      movements,
      closed: false,
      queued: false,
      signal: null,
      deadline: null,
      onAbort: null,
      onGoalUpdated: (goal) => {
        if (goal === null) this.#removeQueuedOwner(owner, 'cancelled');
      },
      onPathStop: () => this.#removeQueuedOwner(owner, 'cancelled'),
    };
    this.#ownersByBot.set(bot, owner);
    this.#arenaBots.add(bot);
    this.#owners.add(owner);
    try {
      bot.on('goal_updated', owner.onGoalUpdated as BotEvents['goal_updated']);
      bot.on('path_stop', owner.onPathStop);
    } catch (error) {
      this.#ownersByBot.delete(bot);
      this.#owners.delete(owner);
      owner.closed = true;
      bot.removeListener('goal_updated', owner.onGoalUpdated as BotEvents['goal_updated']);
      bot.removeListener('path_stop', owner.onPathStop);
      try {
        this.#restoreHookWhenUnused();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'path search registration and cleanup both failed');
      }
      throw error;
    }

    return {
      beginNavigation: (signal, deadline) => this.#beginNavigation(owner, signal, deadline),
      close: () => this.#unregister(owner),
    };
  }

  #installHook(): void {
    if (this.#owners.size > 0) return;
    const original = AStar.prototype.compute;
    if (original === this.#computeHook) throw new Error('path search worker hook is installed without an owner');
    if (typeof original !== 'function') throw new Error('pinned pathfinder AStar.compute is unavailable');
    this.#originalCompute = original;
    AStar.prototype.compute = this.#computeHook;
  }

  #beginNavigation(
    owner: PathSearchOwner,
    signal: AbortSignal,
    deadline: number,
  ): (completion: PathSearchCompletion) => void {
    if (owner.closed) throw new Error('cannot navigate with a closed path search owner');
    if (owner.signal !== null) throw new Error('path search owner already has an active navigation');
    owner.signal = signal;
    owner.deadline = deadline;
    owner.onAbort = () => this.#removeQueuedOwner(owner, 'cancelled');
    signal.addEventListener('abort', owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();

    let ended = false;
    return (completion) => {
      if (ended) return;
      ended = true;
      if (owner.onAbort !== null) signal.removeEventListener('abort', owner.onAbort);
      owner.onAbort = null;
      owner.signal = null;
      owner.deadline = null;
      this.#removeQueuedOwner(owner, completion);
    };
  }

  #unregister(owner: PathSearchOwner): void {
    if (owner.closed) return;
    owner.closed = true;
    const failures: unknown[] = [];
    if (owner.signal !== null && owner.onAbort !== null) {
      try {
        owner.signal.removeEventListener('abort', owner.onAbort);
      } catch (error) {
        failures.push(error);
      }
    }
    owner.onAbort = null;
    owner.signal = null;
    owner.deadline = null;
    try {
      this.#removeQueuedOwner(owner, 'cancelled');
    } catch (error) {
      failures.push(error);
    }
    try {
      owner.bot.removeListener('goal_updated', owner.onGoalUpdated as BotEvents['goal_updated']);
      owner.bot.removeListener('path_stop', owner.onPathStop);
    } catch (error) {
      failures.push(error);
    }
    this.#ownersByBot.delete(owner.bot);
    this.#owners.delete(owner);
    this.#clientSpentMs.delete(owner);
    try {
      this.#restoreHookWhenUnused();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'path search owner cleanup failed');
  }

  #restoreHookWhenUnused(): void {
    if (this.#owners.size > 0) return;
    const original = this.#originalCompute;
    if (original === null) return;
    if (AStar.prototype.compute !== this.#computeHook) {
      this.#originalCompute = null;
      throw new Error('mineflayer-pathfinder AStar.compute changed while the Arena worker hook was active');
    }
    AStar.prototype.compute = original;
    this.#originalCompute = null;
    this.#windowStartedAt = null;
    this.#workerSpentMs = 0;
    this.#clientSpentMs.clear();
  }

  #compute(context: AStarContext): PartiallyComputedPath {
    const original = this.#originalCompute;
    if (original === null) throw new Error('path search worker has no original AStar.compute method');
    const bot = (context as { readonly movements?: { readonly bot?: unknown } }).movements?.bot;
    const owner = typeof bot === 'object' && bot !== null
      ? this.#ownersByBot.get(bot as Bot)
      : undefined;
    if (owner === undefined) {
      if (typeof bot === 'object' && bot !== null && this.#arenaBots.has(bot as Bot)) {
        throw new Error('Arena-owned pathfinding context uses unregistered Movements');
      }
      return original.call(context);
    }
    if (owner.closed || owner.movements !== context.movements) {
      throw new Error('Arena-owned pathfinding context uses unregistered Movements');
    }
    if (!(context instanceof AStar) || context.constructor !== AStar) {
      throw new Error('Arena path search encountered an unsupported AStar context');
    }
    if (!Number.isFinite(context.tickTimeout) || context.tickTimeout < 0
      || typeof context.makeResult !== 'function' || context.bestNode === null) {
      throw new Error('Arena path search encountered an unsupported AStar context shape');
    }

    const now = performance.now();
    if (!Number.isFinite(now)) throw new Error('monotonic path search clock returned a non-finite value');
    this.#rollWindow(now);
    if (owner.signal?.aborted) {
      this.#removeQueuedOwner(owner, 'cancelled');
      return snapshotPathResult(context.makeResult('partial', context.bestNode));
    }
    if (owner.deadline !== null && now >= owner.deadline) {
      this.#removeQueuedOwner(owner, 'timedOut');
      return snapshotPathResult(context.makeResult('partial', context.bestNode));
    }

    const workerRemainingMs = MAX_WORKER_PATH_SLICE_MS - this.#workerSpentMs;
    const clientRemainingMs = MAX_PATH_SLICE_PER_CLIENT_MS - (this.#clientSpentMs.get(owner) ?? 0);
    const queueHead = this.#queuedOwners[0];
    const sliceMs = Math.min(
      context.tickTimeout,
      MAX_PATH_SLICE_PER_CLIENT_MS,
      workerRemainingMs,
      clientRemainingMs,
    );
    if ((queueHead !== undefined && queueHead !== owner) || sliceMs <= 0) {
      this.#queueOwner(owner);
      return snapshotPathResult(context.makeResult('partial', context.bestNode));
    }

    const computeStartedAt = now;
    if (owner.queued) this.#dequeueOwner(owner);
    this.#activeSearches += 1;
    this.#record(owner.bot, 'acquired');
    const originalTimeout = context.tickTimeout;
    context.tickTimeout = sliceMs;
    let result: PartiallyComputedPath | undefined;
    let computeError: unknown;
    let computeFailed = false;
    try {
      result = original.call(context);
    } catch (error) {
      computeFailed = true;
      computeError = error;
    } finally {
      let computeFinishedAt: number | null = null;
      try {
        computeFinishedAt = performance.now();
      } catch (error) {
        if (!computeFailed) {
          computeFailed = true;
          computeError = error;
        }
      }
      context.tickTimeout = originalTimeout;
      this.#activeSearches -= 1;
      this.#record(owner.bot, 'released');
      if (computeFinishedAt !== null) {
        const durationMs = computeFinishedAt - computeStartedAt;
        if (!Number.isFinite(durationMs) || durationMs < 0) {
          computeFailed = true;
          computeError = new Error('monotonic path search clock moved backwards during AStar.compute');
        } else {
          this.#workerSpentMs += durationMs;
          this.#clientSpentMs.set(owner, (this.#clientSpentMs.get(owner) ?? 0) + durationMs);
        }
      }
    }
    if (computeFailed) {
      this.#removeQueuedOwner(owner, 'cancelled');
      throw computeError;
    }
    if (result === undefined) throw new Error('AStar.compute completed without a result');

    if (result.status === 'partial') {
      if (owner.signal?.aborted) this.#removeQueuedOwner(owner, 'cancelled');
      else if (owner.deadline !== null && performance.now() >= owner.deadline) this.#removeQueuedOwner(owner, 'timedOut');
      else this.#queueOwner(owner);
    } else if (result.status === 'timeout') {
      this.#removeQueuedOwner(owner, 'timedOut');
    } else {
      this.#removeQueuedOwner(owner, 'released');
    }
    return snapshotPathResult(result);
  }

  #rollWindow(now: number): void {
    if (!Number.isFinite(now)) throw new Error('monotonic path search clock returned a non-finite value');
    const startedAt = this.#windowStartedAt;
    if (startedAt === null || now - startedAt >= MAX_WORKER_PATH_SLICE_MS) {
      this.#windowStartedAt = now;
      this.#workerSpentMs = 0;
      this.#clientSpentMs.clear();
      return;
    }
    if (now < startedAt) throw new Error('monotonic path search clock moved backwards');
  }

  #queueOwner(owner: PathSearchOwner): void {
    if (owner.closed || owner.queued) return;
    if (this.#queuedOwners.length >= this.#owners.size) throw new Error('path search owner queue exceeded its registered capacity');
    owner.queued = true;
    this.#queuedOwners.push(owner);
    this.#record(owner.bot, 'queued');
  }

  #dequeueOwner(owner: PathSearchOwner): void {
    const index = this.#queuedOwners.indexOf(owner);
    if (index < 0) throw new Error('queued path search owner is missing from the worker queue');
    this.#queuedOwners.splice(index, 1);
    owner.queued = false;
  }

  #removeQueuedOwner(owner: PathSearchOwner, transition: PathSearchCompletion): void {
    if (!owner.queued) return;
    const index = this.#queuedOwners.indexOf(owner);
    if (index < 0) throw new Error('queued path search owner is missing from the worker queue');
    this.#queuedOwners.splice(index, 1);
    owner.queued = false;
    this.#record(owner.bot, transition);
  }

  #record(bot: Bot, transition: PathSearchTransition): void {
    recordPathDiagnostic(bot, {
      kind: 'pathSearch',
      transition,
      activeSearches: this.#activeSearches,
      queuedSearches: this.#queuedOwners.length,
    });
  }
}

const pathSearchWorker = new PathSearchWorker();

export class SkillOwner {
  readonly #bot: Bot;
  readonly #observer: MineflayerObserver;
  readonly #civilizationObserver: MineflayerCivilizationObserver | null;
  readonly #onHealth: () => void;
  readonly #pathSearchRegistration: PathSearchRegistration;
  #active: ActiveSkill | null = null;
  #transition: Promise<void> = Promise.resolve();
  #cleanupFailure: Error | null = null;
  #quarantinedOperation: Promise<void> | null = null;
  #closed = false;

  constructor(
    bot: Bot,
    observer: MineflayerObserver,
    civilizationObserver: MineflayerCivilizationObserver | null = null,
  ) {
    this.#bot = bot;
    this.#observer = observer;
    this.#civilizationObserver = civilizationObserver;
    this.#onHealth = () => {
      if (this.#bot.health !== 0) return;
      void this.cancel('agentEliminated').catch((error: unknown) => {
        this.#bot.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    };
    this.#pathSearchRegistration = configurePathfinder(bot);
    try {
      this.#bot.on('health', this.#onHealth);
    } catch (error) {
      try {
        this.#pathSearchRegistration.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'skill owner setup and path search cleanup both failed');
      }
      throw error;
    }
  }

  run(intent: ArenaSkillIntent): Promise<SkillOutcome> {
    return this.#start(intent);
  }

  runCivilization(intent: CivIntent): Promise<SkillOutcome> {
    if (this.#civilizationObserver === null) {
      return Promise.reject(new Error('civilization skills require a civilization observer'));
    }
    return this.#start(intent);
  }

  #start(intent: SkillIntent): Promise<SkillOutcome> {
    const started = this.#enqueue(async () => {
      if (this.#closed) throw new Error('Mineflayer skill owner is closed');
      if (this.#cleanupFailure !== null || this.#quarantinedOperation !== null) {
        throw this.#cleanupFailure ?? new Error('Mineflayer operation is still pending; this client is quarantined');
      }
      await this.#cancelActive('replaced');
      const active: ActiveSkill = {
        controller: new AbortController(),
        resources: {
          navigationActive: false,
          digging: null,
          eating: false,
          inventoryTouched: false,
          window: null,
          quickBarSlotToRestore: this.#bot.quickBarSlot,
        },
        cancellation: null,
        promise: Promise.resolve({ kind: 'pending' }),
      };
      this.#active = active;
      recordPathDiagnostic(this.#bot, { kind: 'skillOwner', owner: intent.kind });
      recordPathDiagnostic(this.#bot, { kind: 'navigation', active: false });
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
      let cancellationError: unknown;
      try {
        await this.#cancelActive('shutdown');
      } catch (error) {
        cancellationError = error;
      } finally {
        this.#bot.removeListener('health', this.#onHealth);
      }
      try {
        this.#pathSearchRegistration.close();
      } catch (cleanupError) {
        if (cancellationError !== undefined) {
          throw new AggregateError([cancellationError, cleanupError], 'skill shutdown and path search cleanup both failed');
        }
        throw cleanupError;
      }
      if (cancellationError !== undefined) throw cancellationError;
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
    if (active.resources.digging !== null) {
      try {
        await this.#stopActiveDigging(active);
      } catch (error) {
        this.#cleanupFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    active.controller.abort();
    await active.promise;
  }

  async #stopActiveDigging(active: ActiveSkill): Promise<void> {
    const digging = active.resources.digging;
    if (digging === null) return;
    const failures: unknown[] = [];
    if (!digging.stopRequested) {
      digging.stopRequested = true;
      try {
        this.#bot.stopDigging();
      } catch (error) {
        failures.push(error);
      }
    }
    let settled = false;
    try {
      await waitForBoundedOperation(
        digging.settlement,
        null,
        ACTION_TIMEOUT_MS + 100,
        'stop digging',
      );
      settled = true;
    } catch (error) {
      failures.push(error);
    }
    if (settled && active.resources.digging === digging) active.resources.digging = null;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'stopping a Mineflayer dig operation failed');
  }

  async #runOwned(intent: SkillIntent, active: ActiveSkill): Promise<SkillOutcome> {
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
      if (this.#active === active) {
        this.#active = null;
        recordPathDiagnostic(this.#bot, { kind: 'skillOwner', owner: null });
      }
    }
    if (cleanupFailed) {
      if (unhandled !== undefined) throw new AggregateError([unhandled, cleanupFailure], 'skill operation and cleanup both failed');
      throw cleanupFailure;
    }
    if (unhandled !== undefined) throw unhandled;
    if (outcome === null) throw new Error('skill completed without an outcome');
    return outcome;
  }

  async #execute(intent: SkillIntent, active: ActiveSkill): Promise<void> {
    const signal = active.controller.signal;
    throwIfInterrupted(signal);
    switch (intent.kind) {
      case 'mineBlock':
        await mineCivilizationBlock(this.#civilizationHost(), intent, active);
        return;
      case 'craft':
        await craftCivilizationMaterial(this.#civilizationHost(), intent, active);
        return;
      case 'containerTransfer':
        await transferContainerMaterial(this.#civilizationHost(), intent, active);
        return;
      case 'placeBlock':
        await placeCivilizationBlock(this.#civilizationHost(), intent, active);
        return;
      case 'hold':
        return;
      case 'navigate':
        await this.#navigateTo(intent.target, 2, active);
        return;
      case 'navigateToBlock':
        await this.#navigateToBlock(intent.target, active);
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

  #civilizationHost(): CivilizationSkillHost {
    const civilizationObserver = this.#civilizationObserver;
    if (civilizationObserver === null) throw new Error('civilization skills require a civilization observer');
    return {
      bot: this.#bot,
      civilizationObserver,
      currentBorder: () => this.#observer.currentBorder(),
      navigateTo: (position, range, active) => this.#navigateTo(position, range, active),
      awaitOwnedOperation: (active, name, action, timeoutMs, signal, settleOnInterruption) =>
        this.#awaitOwnedOperation(active, name, action, timeoutMs, signal, settleOnInterruption),
      awaitInventoryOperation: (active, name, action, timeoutMs, signal) =>
        this.#awaitInventoryOperation(active, name, action, timeoutMs, signal),
    };
  }

  async #navigateTo(position: BlockPosition, range: number, active: ActiveSkill): Promise<void> {
    await this.#navigate(position, { kind: 'withinRange', range }, active);
  }

  async #navigateToDrop(position: MineflayerEntity['position'], active: ActiveSkill, signal: AbortSignal): Promise<void> {
    await this.#navigate(position, { kind: 'withinRange', range: PICKUP_RANGE_BLOCKS }, active, signal);
  }

  async #navigateToBlock(position: BlockPosition, active: ActiveSkill): Promise<void> {
    await this.#navigate(position, { kind: 'exactBlock' }, active);
  }

  async #navigate(
    position: NavigationPosition,
    arrival: NavigationArrival,
    active: ActiveSkill,
    signal: AbortSignal = active.controller.signal,
  ): Promise<void> {
    const deadline = performance.now() + PATH_TIMEOUT_MS;
    for (let leg = 0; leg < MAX_NAVIGATION_LEGS; leg += 1) {
      throwIfInterrupted(signal);
      const border = this.#observer.currentBorder();
      const borderPosition = blockPosition(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
      if (border.kind !== 'current' || isOutsideBorder(border.value, borderPosition)) {
        throw new SkillFault('preconditionsNotMet', 'navigation requires a current border and an in-border target');
      }

      const current = this.#bot.entity.position;
      const remainingDistance = distance(current, position);
      if (hasArrived(current, position, arrival)) return;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new SkillFault('timedOut', 'bounded navigation exceeded its deadline');

      const finalLegAllowance = arrival.kind === 'withinRange' ? arrival.range : 0;
      const waypoint = remainingDistance <= MAX_PATH_LEG_BLOCKS + finalLegAllowance
        ? position
        : waypointToward(current, position, MAX_PATH_LEG_BLOCKS);
      const goal = waypoint === position && arrival.kind === 'exactBlock'
        ? new goals.GoalBlock(waypoint.x, waypoint.y, waypoint.z)
        : new goals.GoalNear(
          waypoint.x,
          waypoint.y,
          waypoint.z,
          waypoint === position && arrival.kind === 'withinRange' ? arrival.range : 2,
        );
      const stopWaits = new AbortController();
      const relayAbort = () => stopWaits.abort();
      const endSearchOwner = this.#pathSearchRegistration.beginNavigation(signal, deadline);
      signal.addEventListener('abort', relayAbort, { once: true });
      const reached = waitForGoal(this.#bot, goal, stopWaits.signal, remainingMs);
      const pathFailure = waitForPathFailure(this.#bot, stopWaits.signal, remainingMs);
      active.resources.navigationActive = true;
      recordPathDiagnostic(this.#bot, { kind: 'navigation', active: true });
      try {
        this.#bot.pathfinder.setGoal(goal, false);
        await Promise.race([reached, pathFailure]);
        throwIfInterrupted(signal);
        if (hasArrived(this.#bot.entity.position, position, arrival)) return;
        if (leg === MAX_NAVIGATION_LEGS - 1) {
          throw new SkillFault('noProgress', `navigation exceeded ${MAX_NAVIGATION_LEGS} bounded path segments`);
        }
      } finally {
        signal.removeEventListener('abort', relayAbort);
        const completion: PathSearchCompletion = signal.aborted
          ? 'cancelled'
          : performance.now() >= deadline ? 'timedOut' : 'released';
        endSearchOwner(completion);
        stopWaits.abort();
        await waitForPathStop(this.#bot, ACTION_TIMEOUT_MS);
        active.resources.navigationActive = false;
        recordPathDiagnostic(this.#bot, { kind: 'navigation', active: false });
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
    await this.#lookAt(active, 'look at opponent', aim);
    throwIfInterrupted(active.controller.signal);
    target = this.#visibleOpponent(targetId);
    if (distance(this.#bot.entity.position, target.position) > APPROACH_RANGE_BLOCKS) {
      throw new SkillFault('noProgress', `opponent ${targetId} moved out of melee reach`);
    }
    await this.#lookAt(
      active,
      'look at opponent',
      target.position.offset(0, target.height * 0.65, 0),
    );
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
    const receipt = waitForDropCollection(this.#bot, entityIdValue, active.controller.signal, ACTION_TIMEOUT_MS);
    const currentDrop = (initial: boolean): MineflayerEntity | null => {
      if (receipt.collected) return null;
      try {
        return initial ? this.#visibleDrop(entityIdValue) : this.#presentDrop(entityIdValue);
      } catch (error) {
        if (receipt.collected) return null;
        throw error;
      }
    };
    try {
      for (let attempt = 0; attempt < MAX_TARGET_REPLANS; attempt += 1) {
        throwIfInterrupted(active.controller.signal);
        const drop = currentDrop(attempt === 0);
        if (drop === null) return;
        if (distance(this.#bot.entity.position, drop.position) <= PICKUP_RANGE_BLOCKS) break;
        const approach = new AbortController();
        const stopApproachOnSkillCancellation = () => approach.abort();
        active.controller.signal.addEventListener('abort', stopApproachOnSkillCancellation, { once: true });
        const navigation = this.#navigateToDrop(drop.position, active, approach.signal).then(
          () => ({ kind: 'arrived' as const }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
        try {
          const result = await Promise.race([
            navigation,
            receipt.promise.then(() => ({ kind: 'collected' as const })),
          ]);
          if (result.kind === 'collected') {
            approach.abort();
            const settledNavigation = await navigation;
            if (active.controller.signal.aborted) throw new SkillInterrupted();
            if (settledNavigation.kind === 'failed' && !(settledNavigation.error instanceof SkillInterrupted)) {
              throw settledNavigation.error;
            }
            return;
          }
          if (result.kind === 'failed') {
            if (receipt.collected && !active.controller.signal.aborted) return;
            throw result.error;
          }
        } finally {
          active.controller.signal.removeEventListener('abort', stopApproachOnSkillCancellation);
        }
        if (attempt === MAX_TARGET_REPLANS - 1) {
          throw new SkillFault('noProgress', `drop ${entityIdValue} remained outside pickup reach`);
        }
      }
      if (currentDrop(false) === null) return;
      if (receipt.collected) return;
      receipt.arm();
      await receipt.promise;
    } finally {
      receipt.dispose();
    }
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
    const block = this.#bot.blockAt(blockPosition);
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

    await this.#lookAt(
      active,
      'look at container',
      block.position.offset(0.5, 0.5, 0.5),
    );
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
    const opening = waitForChestWindow(this.#bot, ACTION_TIMEOUT_MS);
    const activation = this.#awaitOwnedOperation(
      active,
      `activate container ${key}`,
      () => this.#bot.activateBlock(currentBlock),
    );
    const [activationResult, openingResult] = await Promise.allSettled([activation, opening]);
    if (openingResult.status === 'fulfilled') {
      active.resources.window = openingResult.value;
      this.#observer.markContainerOpened(position);
      this.#civilizationObserver?.markContainerOpened(position, openingResult.value);
    }
    if (activationResult.status === 'rejected') {
      const error = activationResult.reason;
      if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    if (openingResult.status === 'rejected') throw openingResult.reason;
    const window = openingResult.value;
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
      if (countWindowEmptySlots(window) === 0) continue;
      const inventoryBefore = countWindowItem(window, item, window.inventoryStart, window.inventoryEnd);
      const containerBefore = countWindowItem(window, item, 0, window.inventoryStart);
      const syncWindow = requireWindowSynchronizer(this.#bot);
      const receipt = waitForWindowTransferReceipt(
        this.#bot,
        window,
        item,
        inventoryBefore,
        containerBefore,
        active.controller.signal,
        ACTION_TIMEOUT_MS,
      );
      const receiptError = receipt.promise.then(() => null, (error: unknown) => error);
      try {
        await this.#awaitInventoryOperation(
          active,
          `withdraw ${item.name}`,
          () => {
            const click = this.#bot.clickWindow(slot, 0, 1);
            receipt.arm();
            return click;
          },
        );
        await this.#awaitInventoryOperation(
          active,
          `synchronize window after withdrawing ${item.name}`,
          () => syncWindow(window),
        );
        const error = await receiptError;
        if (error !== null) throw error;
      } catch (error) {
        if (active.controller.signal.aborted) throw new SkillInterrupted();
        if (error instanceof SkillFault) throw error;
        throw new SkillFault('serverRejected', errorMessage(error));
      } finally {
        receipt.dispose();
      }
      throwIfInterrupted(active.controller.signal);
      if (this.#bot.currentWindow !== window) {
        throw new SkillFault('serverRejected', 'container window closed during inventory synchronization');
      }
      if (countWindowItem(window, item, window.inventoryStart, window.inventoryEnd) <= inventoryBefore
        || countWindowItem(window, item, 0, window.inventoryStart) >= containerBefore) {
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
    // Mineflayer allows golden apples at full hunger, when eating cannot raise the food level.
    const hungerReceiptExpected = beforeFood < 20;
    await waitForCondition(
      this.#bot,
      () => slotCount(this.#bot, heldSlot, item) < beforeCount
        && (!hungerReceiptExpected || this.#bot.food > beforeFood),
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
    if (equipmentSlot === 'weapon') active.resources.quickBarSlotToRestore = null;
  }

  #visibleOpponent(entityIdValue: number): MineflayerEntity {
    const entity = this.#bot.entities[String(entityIdValue)];
    if (entity === undefined || !isTargetablePlayer(this.#bot, entity)) {
      throw new SkillFault('preconditionsNotMet', `opponent ${entityIdValue} is not currently targetable`);
    }
    if (this.#civilizationObserver !== null && !this.#civilizationObserver.isRosteredOpponent(entityIdValue)) {
      throw new SkillFault('preconditionsNotMet', `entity ${entityIdValue} is not a rostered opposing-faction player`);
    }
    if (!isVisibleEntity(this.#bot, entity)) {
      throw new SkillFault('preconditionsNotMet', `opponent ${entityIdValue} is not currently visible to this client`);
    }
    return entity;
  }

  #visibleDrop(entityIdValue: number): MineflayerEntity {
    const entity = this.#presentDrop(entityIdValue);
    if (!isVisibleEntity(this.#bot, entity)) {
      throw new SkillFault('preconditionsNotMet', `drop ${entityIdValue} is not currently visible to this client`);
    }
    return entity;
  }

  #presentDrop(entityIdValue: number): MineflayerEntity {
    const entity = this.#bot.entities[String(entityIdValue)];
    if (entity === undefined || entity.getDroppedItem() === null) {
      throw new SkillFault('preconditionsNotMet', `drop ${entityIdValue} is not currently present`);
    }
    return entity;
  }

  async #releaseResources(active: ActiveSkill): Promise<void> {
    const failures: unknown[] = [];
    let cursorRestored = true;
    if (active.resources.digging !== null && active.cancellation === null) {
      try {
        await this.#stopActiveDigging(active);
      } catch (error) {
        failures.push(error);
      }
    }
    if (active.resources.navigationActive) {
      try {
        await waitForPathStop(this.#bot, ACTION_TIMEOUT_MS);
      } catch (error) {
        failures.push(error);
      }
      active.resources.navigationActive = false;
    }
    if (this.#cleanupFailure !== null) {
      cursorRestored = false;
      failures.push(this.#cleanupFailure);
    } else if (active.resources.inventoryTouched) {
      try {
        await this.#restoreCursor(active, active.resources.window);
      } catch (error) {
        cursorRestored = false;
        failures.push(error);
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
      if (this.#cleanupFailure === null
        && active.resources.quickBarSlotToRestore !== null
        && this.#bot.quickBarSlot !== active.resources.quickBarSlotToRestore) {
        this.#bot.setQuickBarSlot(active.resources.quickBarSlotToRestore);
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
    await this.#awaitOwnedOperation(active, name, action, timeoutMs, signal);
  }

  /**
   * Pinned native look has no cancellation signal. An unchanged, nonforced look finishes
   * its previous task without changing aim or controls; both promises must settle before
   * ownership transfers. The zero-change native task has no remaining effects or timer.
   */
  #lookAt(active: ActiveSkill, name: string, point: Bot['entity']['position']): Promise<void> {
    return this.#awaitOwnedOperation(
      active,
      name,
      () => this.#bot.lookAt(point),
      ACTION_TIMEOUT_MS,
      active.controller.signal,
      () => this.#bot.look(this.#bot.entity.yaw, this.#bot.entity.pitch),
    );
  }

  async #awaitOwnedOperation(
    active: ActiveSkill,
    name: string,
    action: () => Promise<void>,
    timeoutMs = ACTION_TIMEOUT_MS,
    signal: AbortSignal | null = active.controller.signal,
    settleOnInterruption?: () => Promise<void>,
  ): Promise<void> {
    if (signal !== null) throwIfInterrupted(signal);
    if (signal?.aborted) throw new SkillInterrupted();
    const deadline = performance.now() + timeoutMs;
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
      const settlementFailures: unknown[] = [];
      let ownedOperation = operation;
      let ownedOperationSettled = (): boolean => settled;
      if (!settled && settleOnInterruption !== undefined) {
        let jointSettled = false;
        const drain = Promise.resolve().then(settleOnInterruption);
        const watched = [drain, operation].map((pending) => pending.catch((failure: unknown) => {
          if (!settlementFailures.includes(failure)) settlementFailures.push(failure);
          throw failure;
        }));
        ownedOperation = Promise.allSettled(watched).then(() => { jointSettled = true; });
        ownedOperationSettled = () => jointSettled;
        try {
          await waitForBoundedOperation(
            ownedOperation,
            null,
            Math.max(0, deadline - performance.now()),
            `settle interrupted ${name}`,
          );
        } catch (failure) {
          if (!settlementFailures.includes(failure)) settlementFailures.push(failure);
        }
      }
      if (!ownedOperationSettled()) {
        const quarantineFailure = new Error(`Mineflayer operation "${name}" did not settle; this client is quarantined`);
        this.#cleanupFailure ??= settlementFailures.length === 0 ? quarantineFailure : new AggregateError(
          [error, ...settlementFailures, quarantineFailure], quarantineFailure.message, { cause: error },
        );
        this.#quarantinedOperation = ownedOperation;
        void ownedOperation.then(
          () => { if (this.#quarantinedOperation === ownedOperation) this.#quarantinedOperation = null; },
          () => { if (this.#quarantinedOperation === ownedOperation) this.#quarantinedOperation = null; },
        );
      }
      if (settlementFailures.length > 0) {
        const failure = new AggregateError([error, ...settlementFailures], `interrupted ${name} and its settlement failed`, { cause: error });
        this.#cleanupFailure ??= failure;
        throw failure;
      }
      throw error;
    }
  }
}

function configurePathfinder(bot: Bot): PathSearchRegistration {
  if (!bot.hasPlugin(pathfinder)) bot.loadPlugin(pathfinder);
  bot.pathfinder.thinkTimeout = MAX_PATH_THINK_MS;
  bot.pathfinder.tickTimeout = MAX_PATH_SLICE_PER_CLIENT_MS;
  (bot.pathfinder as BoundedPathfinder).searchRadius = MAX_PATH_SEARCH_RADIUS_BLOCKS;
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  const registration = pathSearchWorker.register(bot, movements);
  try {
    bot.pathfinder.setMovements(movements);
  } catch (error) {
    try {
      registration.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'pathfinder movement setup and worker cleanup both failed');
    }
    throw error;
  }
  return registration;
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
      () => finish(new SkillFault('timedOut', `Mineflayer operation ${name} did not settle before its deadline`)),
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
      (error: unknown) => finish(error ?? new Error(`Mineflayer operation ${name} rejected without an error`)),
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

function waitForDropCollection(
  bot: Bot,
  targetId: number,
  signal: AbortSignal,
  timeoutMs: number,
): DropCollectionReceipt {
  let armed = false;
  let settled = false;
  let collected = false;
  let timeout: NodeJS.Timeout | null = null;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const onAbort = () => finish(new SkillInterrupted());
  const onCollect: BotEvents['playerCollect'] = (collector, itemEntity) => {
    if (collector.id !== bot.entity.id || itemEntity.id !== targetId) return;
    collected = true;
    finish();
  };
  const cleanup = () => {
    if (timeout !== null) clearTimeout(timeout);
    bot.removeListener('playerCollect', onCollect);
    signal.removeEventListener('abort', onAbort);
  };
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  };

  bot.on('playerCollect', onCollect);

  return {
    promise,
    get collected() { return collected; },
    arm: () => {
      if (settled || armed) return;
      armed = true;
      timeout = setTimeout(() => finish(new SkillFault('timedOut', `drop ${targetId} was not collected`)), timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    dispose: () => finish(),
  };
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

function inventoryItem(bot: Bot, slot: number): MineflayerItem | null {
  const item = bot.inventory.slots[slot];
  return item === undefined ? null : item;
}

function countWindowItem(
  window: MineflayerWindow,
  target: MineflayerItem,
  start: number,
  end: number,
): number {
  let count = 0;
  for (let slot = start; slot < end; slot += 1) {
    const item = window.slots[slot];
    if (item !== null && item !== undefined && item.type === target.type && item.metadata === target.metadata) {
      count += item.count;
    }
  }
  return count;
}

function countWindowEmptySlots(window: MineflayerWindow): number {
  let count = 0;
  for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
    if (window.slots[slot] === null || window.slots[slot] === undefined) count += 1;
  }
  return count;
}

/** Mineflayer's narrow internal hook requests a full authoritative snapshot for an open window. */
function requireWindowSynchronizer(bot: Bot): (window: MineflayerWindow) => Promise<void> {
  const synchronize = (bot as MineflayerWindowSynchronizer)._syncWindow;
  if (typeof synchronize !== 'function' || !bot.supportFeature('stateIdUsed')) {
    throw new SkillFault('preconditionsNotMet', 'Mineflayer cannot synchronize the open container window');
  }
  return (window) => synchronize.call(bot, window);
}

function waitForWindowTransferReceipt(
  bot: Bot,
  window: MineflayerWindow,
  target: MineflayerItem,
  inventoryBefore: number,
  containerBefore: number,
  signal: AbortSignal,
  timeoutMs: number,
): WindowTransferReceipt {
  const client = bot._client;
  let armed = false;
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const onAbort = () => finish(new SkillInterrupted());
  const onWindowItems = (packet: WindowItemsPacket) => {
    if (!armed || packet.windowId !== window.id || !Array.isArray(packet.items)
      || packet.items.length !== window.slots.length || bot.currentWindow !== window) return;

    // Mineflayer's window_items handler updates this window before later client listeners run.
    if (countWindowItem(window, target, window.inventoryStart, window.inventoryEnd) > inventoryBefore
      && countWindowItem(window, target, 0, window.inventoryStart) < containerBefore) {
      finish();
    }
  };
  const cleanup = () => {
    if (timeout !== null) clearTimeout(timeout);
    client.removeListener('window_items', onWindowItems);
    signal.removeEventListener('abort', onAbort);
  };
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  };

  timeout = setTimeout(
    () => finish(new SkillFault('noProgress', 'a full window snapshot did not confirm the container transfer')),
    timeoutMs,
  );
  client.on('window_items', onWindowItems);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  return {
    promise,
    arm: () => { armed = true; },
    dispose: () => finish(new SkillInterrupted()),
  };
}

function slotCount(bot: Bot, slot: number, target: MineflayerItem): number {
  const item = bot.inventory.slots[slot];
  return item !== null && item !== undefined && item.type === target.type && item.metadata === target.metadata
    ? item.count
    : 0;
}

function hasArrived(
  current: { readonly x: number; readonly y: number; readonly z: number },
  target: NavigationPosition,
  arrival: NavigationArrival,
): boolean {
  if (arrival.kind === 'withinRange') return distance(current, target) <= arrival.range;
  return Math.floor(current.x) === Math.floor(target.x)
    && Math.floor(current.y) === Math.floor(target.y)
    && Math.floor(current.z) === Math.floor(target.z);
}

function waypointToward(
  current: { readonly x: number; readonly y: number; readonly z: number },
  target: NavigationPosition,
  distanceBlocks: number,
): NavigationPosition {
  const distanceToTarget = distance(current, target);
  if (distanceToTarget <= distanceBlocks) return target;
  const fraction = distanceBlocks / distanceToTarget;
  return blockPosition(
    Math.round(current.x + (target.x - current.x) * fraction),
    Math.round(current.y + (target.y - current.y) * fraction),
    Math.round(current.z + (target.z - current.z) * fraction),
  );
}

function assertNever(value: never): never {
  throw new Error(`unsupported skill intent: ${String((value as { kind?: unknown }).kind)}`);
}
