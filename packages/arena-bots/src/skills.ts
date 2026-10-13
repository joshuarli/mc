import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import {
  blockPosition,
  OUTPOST_LOGS_REQUIRED,
  OUTPOST_PLANKS_REQUIRED,
  isOutsideBorder,
  type BlockPosition,
  type CivIntent,
  type EquipmentSlot,
  type SkillCancellation,
  type SkillFailure,
  type SkillOutcome,
} from '@arena/core';
import type { Bot, BotEvents } from 'mineflayer';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { classifyItem, mineflayerEquipmentDestination } from './items.js';
import { MineflayerCivilizationObserver } from './civilization-observer.js';
import { MineflayerObserver } from './observer.js';
import { recordPathDiagnostic } from './path-diagnostics.js';
import { isTargetablePlayer, isVisibleEntity, isVisiblePosition, toBlockPosition } from './perception.js';
import type { ArenaSkillIntent } from './skill-intent.js';
import { hasLocalVoxelLineOfSight } from './visibility.js';

const { Movements, goals, pathfinder } = createRequire(import.meta.url)('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');
const AStar = createRequire(import.meta.url)('mineflayer-pathfinder/lib/astar') as AStarConstructor;
const { version: PATHFINDER_VERSION } = createRequire(import.meta.url)('mineflayer-pathfinder/package.json') as { version: string };

const MAX_PATH_SEARCH_RADIUS_BLOCKS = 16;
/** Keep long routes inside the pathfinder's fixed search horizon. */
const MAX_PATH_LEG_BLOCKS = 8;
const MAX_NAVIGATION_LEGS = 128;
const MAX_PATH_THINK_MS = 1_000;
const MAX_PATH_SLICE_PER_CLIENT_MS = 3;
const MAX_WORKER_PATH_SLICE_MS = 10;
const PINNED_PATHFINDER_VERSION = '2.4.5';
const PATH_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
const INVENTORY_TRANSFER_TIMEOUT_MS = 15_000;
const PICKUP_RANGE_BLOCKS = 1.25;
const APPROACH_RANGE_BLOCKS = 3;
const MAX_TARGET_REPLANS = 8;

type MineflayerItem = NonNullable<Bot['inventory']['slots'][number]>;
type MineflayerWindow = NonNullable<Bot['currentWindow']>;
type MineflayerChest = Awaited<ReturnType<Bot['openContainer']>>;
type MineflayerBlock = NonNullable<ReturnType<Bot['blockAt']>>;
type MineflayerEntity = Bot['entity'];
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

interface ActiveSkill {
  readonly controller: AbortController;
  readonly resources: SkillResources;
  cancellation: SkillCancellation | null;
  promise: Promise<SkillOutcome>;
}

/** Separates the existing near-target policy behavior from exact bot-owned block arrival. */
type NavigationArrival =
  | { readonly kind: 'withinRange'; readonly range: number }
  | { readonly kind: 'exactBlock' };

interface SkillResources {
  navigationActive: boolean;
  digging: { readonly settlement: Promise<void>; stopRequested: boolean } | null;
  eating: boolean;
  inventoryTouched: boolean;
  window: MineflayerChest | null;
  quickBarSlotToRestore: number | null;
}

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

/** Serializes skill intents and quarantines Mineflayer operations that outlive cancellation. */
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
        await this.#mineBlock(intent, active);
        return;
      case 'craft':
        await this.#craftCivilizationMaterial(intent, active);
        return;
      case 'containerTransfer':
        await this.#transferContainerMaterial(intent, active);
        return;
      case 'placeBlock':
        await this.#placeCivilizationBlock(intent, active);
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

  async #mineBlock(intent: Extract<CivIntent, { readonly kind: 'mineBlock' }>, active: ActiveSkill): Promise<void> {
    this.#requireSynchronizedCivilizationInventory();
    this.#requireInsideBorder(intent.position);
    await this.#navigateTo(intent.position, 4, active);
    throwIfInterrupted(active.controller.signal);
    const block = this.#localBlock(intent.position);
    if (block === null || block.name !== intent.expectedBlock) {
      throw new SkillFault('preconditionsNotMet', `block at ${positionText(intent.position)} is not the expected oak log`);
    }
    if (distance(this.#bot.entity.position, block.position.offset(0.5, 0.5, 0.5)) > 4.5
      || !isVisiblePosition(this.#bot, block.position, 1)
      || !this.#bot.canDigBlock(block)) {
      throw new SkillFault('preconditionsNotMet', `oak log at ${positionText(intent.position)} is not locally reachable`);
    }

    try {
      await this.#awaitOwnedOperation(
        active,
        `dig oak log at ${positionText(intent.position)}`,
        () => {
          const operation = this.#bot.dig(block, true);
          const digging = {
            settlement: Promise.resolve(operation).then(() => undefined, () => undefined),
            stopRequested: false,
          };
          active.resources.digging = digging;
          void digging.settlement.then(() => {
            if (active.resources.digging === digging) active.resources.digging = null;
          });
          return operation;
        },
      );
    } catch (error) {
      if (active.cancellation !== null) throw new SkillInterrupted();
      if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    if (active.cancellation !== null) throw new SkillInterrupted();
    throwIfInterrupted(active.controller.signal);
    await waitForCondition(
      this.#bot,
      () => {
        const changed = this.#localBlock(intent.position);
        return changed !== null && changed.name !== intent.expectedBlock;
      },
      active.controller.signal,
      ACTION_TIMEOUT_MS,
    );
    const changed = this.#localBlock(intent.position);
    if (changed === null || changed.name === intent.expectedBlock) {
      throw new SkillFault('noProgress', `oak log at ${positionText(intent.position)} was not observed removed`);
    }
  }

  async #craftCivilizationMaterial(
    intent: Extract<CivIntent, { readonly kind: 'craft' }>,
    active: ActiveSkill,
  ): Promise<void> {
    this.#requireSynchronizedCivilizationInventory();
    if (intent.table !== null || intent.resultCount !== OUTPOST_PLANKS_REQUIRED) {
      throw new SkillFault('preconditionsNotMet', 'the outpost recipe requires four oak logs and exactly sixteen oak planks in hand crafting');
    }
    const logType = this.#bot.registry.itemsByName.oak_log;
    const plankType = this.#bot.registry.itemsByName.oak_planks;
    if (logType === undefined || plankType === undefined) {
      throw new Error('Mineflayer registry lacks the required oak log or plank item');
    }
    const recipe = this.#bot.recipesFor(plankType.id, null, intent.resultCount, null)
      .find((candidate) => candidate.result.id === plankType.id
        && candidate.result.count === 4
        && candidate.delta.reduce((count, entry) => count + (entry.id === logType.id ? entry.count : 0), 0) === -1
        && candidate.delta.reduce((count, entry) => count + (entry.id === plankType.id ? entry.count : 0), 0) === 4
        && candidate.delta.every((entry) => entry.id === logType.id || entry.id === plankType.id));
    if (recipe === undefined || intent.resultCount % recipe.result.count !== 0) {
      throw new SkillFault('preconditionsNotMet', 'no legal four-log oak plank recipe is available in this client inventory');
    }
    const craftCount = intent.resultCount / recipe.result.count;
    const logsBefore = countInventoryItemByName(this.#bot, 'oak_log');
    const planksBefore = countInventoryItemByName(this.#bot, 'oak_planks');
    if (logsBefore < OUTPOST_LOGS_REQUIRED) {
      throw new SkillFault('preconditionsNotMet', 'crafting the outpost planks requires four available oak logs');
    }
    try {
      await this.#awaitInventoryOperation(
        active,
        'craft oak planks',
        () => this.#bot.craft(recipe, craftCount),
        ACTION_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    throwIfInterrupted(active.controller.signal);
    await waitForCondition(
      this.#bot,
      () => countInventoryItemByName(this.#bot, 'oak_log') === logsBefore - OUTPOST_LOGS_REQUIRED
        && countInventoryItemByName(this.#bot, 'oak_planks') === planksBefore + OUTPOST_PLANKS_REQUIRED,
      active.controller.signal,
      ACTION_TIMEOUT_MS,
    );
    if (countInventoryItemByName(this.#bot, 'oak_log') !== logsBefore - OUTPOST_LOGS_REQUIRED
      || countInventoryItemByName(this.#bot, 'oak_planks') !== planksBefore + OUTPOST_PLANKS_REQUIRED) {
      throw new SkillFault('noProgress', 'the client did not observe the four-log to sixteen-plank inventory change');
    }
  }

  async #transferContainerMaterial(
    intent: Extract<CivIntent, { readonly kind: 'containerTransfer' }>,
    active: ActiveSkill,
  ): Promise<void> {
    this.#requireSynchronizedCivilizationInventory();
    this.#requireInsideBorder(intent.position);
    if (this.#bot.inventory.selectedItem !== null) {
      throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before a container transfer');
    }
    await this.#navigateTo(intent.position, 3, active);
    const window = await this.#openCivilizationContainer(intent.position, active);
    const source = findTransferStack(window, intent.item, intent.direction);
    if (source === null) {
      throw new SkillFault('preconditionsNotMet', `no observed ${intent.item} stack is available for transfer`);
    }
    const destinationSlots = intent.direction === 'deposit'
      ? window.slots.slice(0, window.inventoryStart)
      : window.slots.slice(window.inventoryStart, window.inventoryEnd);
    if (availableStackCapacity(destinationSlots, source.item) < intent.count) {
      throw new SkillFault('preconditionsNotMet', `container transfer destination lacks room for ${intent.count} ${intent.item}`);
    }

    const inventoryBefore = countInventoryItemByName(this.#bot, intent.item);
    const containerBefore = countWindowItemByName(window, intent.item);
    const totalAvailable = intent.direction === 'deposit' ? inventoryBefore : containerBefore;
    if (totalAvailable < intent.count) {
      throw new SkillFault('preconditionsNotMet', `container transfer has only ${totalAvailable} observed ${intent.item}`);
    }

    let remaining = intent.count;
    const deadline = performance.now() + INVENTORY_TRANSFER_TIMEOUT_MS;
    while (remaining > 0) {
      throwIfInterrupted(active.controller.signal);
      if (this.#bot.currentWindow !== window) {
        throw new SkillFault('serverRejected', 'container window closed during the requested transfer');
      }
      const nextSource = findTransferStack(window, intent.item, intent.direction);
      if (nextSource === null) {
        throw new SkillFault('noProgress', `no synchronized ${intent.item} stack remains during transfer`);
      }
      // Prismarine can reuse the source Item as the selected cursor, mutating its count after a click.
      const sourceCount = nextSource.item.count;
      const destination = findTransferDestination(window, intent.direction, nextSource.item);
      if (destination === null || destination.capacity <= 0) {
        throw new SkillFault('preconditionsNotMet', `container transfer destination has no room for ${intent.item}`);
      }
      const amount = Math.min(remaining, sourceCount, destination.capacity);
      const operationTimeout = transferOperationTimeout(deadline);
      try {
        if (amount === sourceCount) {
          await this.#awaitInventoryOperation(
            active,
            `${intent.direction} ${amount} ${intent.item}`,
            () => this.#bot.clickWindow(nextSource.slot, 0, 1),
            operationTimeout,
          );
        } else {
          // Shift-click moves the whole stack, so right-click only the requested number of items.
          await this.#awaitInventoryOperation(
            active,
            `pick up ${intent.item} for transfer`,
            () => this.#bot.clickWindow(nextSource.slot, 0, 0),
            operationTimeout,
          );
          if (window.selectedItem?.name !== intent.item || window.selectedItem.count !== sourceCount) {
            throw new SkillFault('noProgress', 'the client did not observe the selected transfer stack');
          }
          for (let moved = 0; moved < amount; moved += 1) {
            await this.#awaitInventoryOperation(
              active,
              `transfer ${intent.item} item ${moved + 1} of ${amount}`,
              () => this.#bot.clickWindow(destination.slot, 1, 0),
              transferOperationTimeout(deadline),
            );
            const expectedCursorCount = sourceCount - moved - 1;
            if ((window.selectedItem?.count ?? 0) !== expectedCursorCount) {
              throw new SkillFault('noProgress', 'the client did not observe the requested one-item transfer');
            }
          }
          await this.#awaitInventoryOperation(
            active,
            `return remaining ${intent.item} stack`,
            () => this.#bot.clickWindow(nextSource.slot, 0, 0),
            transferOperationTimeout(deadline),
          );
          if (window.selectedItem !== null) {
            throw new SkillFault('noProgress', 'the client did not observe the remaining stack returned to inventory');
          }
        }
      } catch (error) {
        if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
        throw new SkillFault('serverRejected', errorMessage(error));
      }

      remaining -= amount;
      const transferred = intent.count - remaining;
      const expectedInventory = intent.direction === 'deposit'
        ? inventoryBefore - transferred
        : inventoryBefore + transferred;
      const expectedContainer = intent.direction === 'deposit'
        ? containerBefore + transferred
        : containerBefore - transferred;
      await waitForCondition(
        this.#bot,
        () => this.#bot.currentWindow === window
          && window.selectedItem === null
          && countInventoryItemByName(this.#bot, intent.item) === expectedInventory
          && countWindowItemByName(window, intent.item) === expectedContainer,
        active.controller.signal,
        transferOperationTimeout(deadline),
      );
    }

    const expectedInventory = intent.direction === 'deposit'
      ? inventoryBefore - intent.count
      : inventoryBefore + intent.count;
    const expectedContainer = intent.direction === 'deposit'
      ? containerBefore + intent.count
      : containerBefore - intent.count;
    if (this.#bot.currentWindow !== window || window.selectedItem !== null
      || countInventoryItemByName(this.#bot, intent.item) !== expectedInventory
      || countWindowItemByName(window, intent.item) !== expectedContainer) {
      throw new SkillFault('noProgress', 'the client did not observe the requested container transfer');
    }
  }

  async #placeCivilizationBlock(
    intent: Extract<CivIntent, { readonly kind: 'placeBlock' }>,
    active: ActiveSkill,
  ): Promise<void> {
    this.#requireSynchronizedCivilizationInventory();
    this.#requireInsideBorder(intent.target);
    this.#requireInsideBorder(intent.referencePosition);
    if (intent.face !== 'up'
      || intent.target.x !== intent.referencePosition.x
      || intent.target.z !== intent.referencePosition.z
      || intent.target.y !== intent.referencePosition.y + 1) {
      throw new SkillFault('preconditionsNotMet', 'oak plank placement must target the block directly above its support');
    }
    await this.#navigateTo(intent.referencePosition, 4, active);
    const reference = this.#localBlock(intent.referencePosition);
    const target = this.#localBlock(intent.target);
    if (target?.name === 'oak_planks') return;
    if (reference === null || reference.boundingBox !== 'block' || target === null || target.name !== 'air') {
      throw new SkillFault('preconditionsNotMet', 'the locally observed placement target is unloaded, obstructed, or unsupported');
    }
    if (distance(this.#bot.entity.position, reference.position.offset(0.5, 0.5, 0.5)) > 4.5
      || !isVisiblePosition(this.#bot, reference.position, 1)) {
      throw new SkillFault('preconditionsNotMet', 'the placement support is not locally reachable');
    }
    if (this.#bot.inventory.selectedItem !== null) {
      throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before placing an outpost plank');
    }
    const plank = findInventoryStack(this.#bot, 'oak_planks');
    if (plank === null) {
      throw new SkillFault('preconditionsNotMet', 'no observed oak planks remain for the outpost');
    }
    const beforePlanks = countInventoryItemByName(this.#bot, 'oak_planks');
    if (this.#bot.heldItem?.name !== 'oak_planks') {
      try {
        await this.#awaitInventoryOperation(active, 'equip oak plank', () => this.#bot.equip(plank, 'hand'));
      } catch (error) {
        if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
        throw new SkillFault('serverRejected', errorMessage(error));
      }
      throwIfInterrupted(active.controller.signal);
      if (this.#bot.heldItem?.name !== 'oak_planks') {
        throw new SkillFault('noProgress', 'the client did not observe oak planks in hand');
      }
    }
    try {
      await this.#awaitInventoryOperation(
        active,
        `place oak plank at ${positionText(intent.target)}`,
        () => this.#bot.placeBlock(reference, reference.position.offset(0, 1, 0).minus(reference.position)),
      );
    } catch (error) {
      if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    throwIfInterrupted(active.controller.signal);
    await waitForCondition(
      this.#bot,
      () => this.#localBlock(intent.target)?.name === 'oak_planks'
        && countInventoryItemByName(this.#bot, 'oak_planks') === beforePlanks - 1,
      active.controller.signal,
      ACTION_TIMEOUT_MS,
    );
    if (this.#localBlock(intent.target)?.name !== 'oak_planks'
      || countInventoryItemByName(this.#bot, 'oak_planks') !== beforePlanks - 1) {
      throw new SkillFault('noProgress', 'the client did not observe the placed oak plank and consumed inventory');
    }
  }

  async #openCivilizationContainer(position: BlockPosition, active: ActiveSkill): Promise<MineflayerChest> {
    const key = positionText(position);
    if (this.#bot.currentWindow !== null) {
      throw new SkillFault('preconditionsNotMet', 'another inventory window is already open');
    }
    const block = this.#localBlock(position);
    if (block === null || (block.name !== 'chest' && block.name !== 'trapped_chest')) {
      throw new SkillFault('preconditionsNotMet', `container ${key} is not present in this client's loaded world`);
    }
    if (distance(this.#bot.entity.position, block.position.offset(0.5, 0.5, 0.5)) > 3
      || !isVisiblePosition(this.#bot, block.position, 1)) {
      throw new SkillFault('preconditionsNotMet', `container ${key} is outside interaction reach or occluded`);
    }
    await this.#awaitOwnedOperation(active, 'look at civilization container', () => this.#bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true));
    throwIfInterrupted(active.controller.signal);
    const currentBlock = this.#localBlock(position);
    if (currentBlock === null || (currentBlock.name !== 'chest' && currentBlock.name !== 'trapped_chest')
      || distance(this.#bot.entity.position, currentBlock.position.offset(0.5, 0.5, 0.5)) > 3
      || !isVisiblePosition(this.#bot, currentBlock.position, 1)) {
      throw new SkillFault('preconditionsNotMet', `container ${key} changed before activation`);
    }
    const opening = waitForChestWindow(this.#bot, ACTION_TIMEOUT_MS);
    const activation = this.#awaitOwnedOperation(
      active,
      `activate civilization container ${key}`,
      () => this.#bot.activateBlock(currentBlock),
    );
    const [activationResult, openingResult] = await Promise.allSettled([activation, opening]);
    if (openingResult.status === 'fulfilled') {
      active.resources.window = openingResult.value;
      this.#requireCivilizationObserver().markContainerOpened(position, openingResult.value);
    }
    if (activationResult.status === 'rejected') {
      const error = activationResult.reason;
      if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    if (openingResult.status === 'rejected') throw openingResult.reason;
    throwIfInterrupted(active.controller.signal);
    return openingResult.value;
  }

  #localBlock(position: BlockPosition): MineflayerBlock | null {
    return this.#bot.blockAt(asVec3(this.#bot, position));
  }

  #requireSynchronizedCivilizationInventory(): void {
    if (!this.#requireCivilizationObserver().isInventorySynchronized()) {
      throw new SkillFault('preconditionsNotMet', 'civilization inventory is unknown until this client receives a full inventory snapshot');
    }
  }

  #requireCivilizationObserver(): MineflayerCivilizationObserver {
    const observer = this.#civilizationObserver;
    if (observer === null) throw new Error('civilization skills require a civilization observer');
    return observer;
  }

  #requireInsideBorder(position: BlockPosition): void {
    const border = this.#observer.currentBorder();
    if (border.kind !== 'current' || isOutsideBorder(border.value, position)) {
      throw new SkillFault('preconditionsNotMet', 'civilization action requires a current border and an in-border target');
    }
  }

  async #navigateTo(position: BlockPosition, range: number, active: ActiveSkill): Promise<void> {
    await this.#navigate(position, { kind: 'withinRange', range }, active);
  }

  async #navigateToBlock(position: BlockPosition, active: ActiveSkill): Promise<void> {
    await this.#navigate(position, { kind: 'exactBlock' }, active);
  }

  async #navigate(position: BlockPosition, arrival: NavigationArrival, active: ActiveSkill): Promise<void> {
    const deadline = performance.now() + PATH_TIMEOUT_MS;
    for (let leg = 0; leg < MAX_NAVIGATION_LEGS; leg += 1) {
      throwIfInterrupted(active.controller.signal);
      const border = this.#observer.currentBorder();
      if (border.kind !== 'current' || isOutsideBorder(border.value, position)) {
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
      const endSearchOwner = this.#pathSearchRegistration.beginNavigation(active.controller.signal, deadline);
      active.controller.signal.addEventListener('abort', relayAbort, { once: true });
      const reached = waitForGoal(this.#bot, goal, stopWaits.signal, remainingMs);
      const pathFailure = waitForPathFailure(this.#bot, stopWaits.signal, remainingMs);
      active.resources.navigationActive = true;
      recordPathDiagnostic(this.#bot, { kind: 'navigation', active: true });
      try {
        this.#bot.pathfinder.setGoal(goal, false);
        await Promise.race([reached, pathFailure]);
        throwIfInterrupted(active.controller.signal);
        if (hasArrived(this.#bot.entity.position, position, arrival)) return;
        if (leg === MAX_NAVIGATION_LEGS - 1) {
          throw new SkillFault('noProgress', `navigation exceeded ${MAX_NAVIGATION_LEGS} bounded path segments`);
        }
      } finally {
        active.controller.signal.removeEventListener('abort', relayAbort);
        const completion: PathSearchCompletion = active.controller.signal.aborted
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
    await this.#awaitOwnedOperation(active, 'look at opponent', () => this.#bot.lookAt(aim));
    throwIfInterrupted(active.controller.signal);
    target = this.#visibleOpponent(targetId);
    if (distance(this.#bot.entity.position, target.position) > APPROACH_RANGE_BLOCKS) {
      throw new SkillFault('noProgress', `opponent ${targetId} moved out of melee reach`);
    }
    await this.#awaitOwnedOperation(
      active,
      'look at opponent',
      () => this.#bot.lookAt(target.position.offset(0, target.height * 0.65, 0)),
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
    await this.#awaitOwnedOperation(active, 'look at dropped item', () => this.#bot.lookAt(drop.position.offset(0, 0.15, 0)));
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

    await this.#awaitOwnedOperation(
      active,
      'look at container',
      () => this.#bot.lookAt(block.position.offset(0.5, 0.5, 0.5)),
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
    // Attach handlers to both bounded operations before either can reject.
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
      // An unresolved inventory operation may still be applying server updates to the selected slot.
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

  async #awaitOwnedOperation(
    active: ActiveSkill,
    name: string,
    action: () => Promise<void>,
    timeoutMs = ACTION_TIMEOUT_MS,
    signal: AbortSignal | null = active.controller.signal,
  ): Promise<void> {
    if (signal !== null) throwIfInterrupted(signal);
    if (signal?.aborted) throw new SkillInterrupted();
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
        const quarantineFailure = new Error(`Mineflayer operation "${name}" did not settle; this client is quarantined`);
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

function findInventoryStack(bot: Bot, name: string): MineflayerItem | null {
  return bot.inventory.items().find((item) => item.name === name) ?? null;
}

function countInventoryItemByName(bot: Bot, name: string): number {
  return bot.inventory.items()
    .filter((item) => item.name === name)
    .reduce((count, item) => count + item.count, 0);
}

function findTransferStack(
  window: MineflayerChest,
  name: string,
  direction: 'deposit' | 'withdraw',
): { readonly slot: number; readonly item: MineflayerItem } | null {
  const start = direction === 'deposit' ? window.inventoryStart : 0;
  const end = direction === 'deposit' ? window.inventoryEnd : window.inventoryStart;
  for (let slot = start; slot < end; slot += 1) {
    const item = window.slots[slot];
    if (item !== null && item !== undefined && item.name === name && item.count > 0) {
      return { slot, item };
    }
  }
  return null;
}

function findTransferDestination(
  window: MineflayerChest,
  direction: 'deposit' | 'withdraw',
  source: MineflayerItem,
): { readonly slot: number; readonly capacity: number } | null {
  const start = direction === 'deposit' ? 0 : window.inventoryStart;
  const end = direction === 'deposit' ? window.inventoryStart : window.inventoryEnd;
  let bestMatching: { readonly slot: number; readonly capacity: number } | null = null;
  let bestEmpty: { readonly slot: number; readonly capacity: number } | null = null;
  for (let slot = start; slot < end; slot += 1) {
    const item = window.slots[slot];
    if (item === null || item === undefined) {
      bestEmpty ??= { slot, capacity: source.stackSize };
    } else if (item.name === source.name) {
      const capacity = Math.max(0, source.stackSize - item.count);
      if (capacity > (bestMatching?.capacity ?? 0)) bestMatching = { slot, capacity };
    }
  }
  return bestMatching ?? bestEmpty;
}

function countWindowItemByName(window: MineflayerChest, name: string): number {
  return window.slots.slice(0, window.inventoryStart)
    .filter((item) => item !== null && item !== undefined && item.name === name)
    .reduce((count, item) => count + (item?.count ?? 0), 0);
}

function availableStackCapacity(
  destination: readonly (MineflayerItem | null | undefined)[],
  source: MineflayerItem,
): number {
  return destination.reduce((capacity, item) => {
    if (item === null || item === undefined) return capacity + source.stackSize;
    if (item.name !== source.name) return capacity;
    return capacity + Math.max(0, source.stackSize - item.count);
  }, 0);
}

function transferOperationTimeout(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new SkillFault('timedOut', 'bounded container transfer exceeded its deadline');
  return Math.min(ACTION_TIMEOUT_MS, remaining);
}

function asVec3(bot: Bot, position: BlockPosition): Parameters<Bot['blockAt']>[0] {
  const current = bot.entity.position;
  return current.offset(position.x - current.x, position.y - current.y, position.z - current.z);
}

function positionText(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
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

/** Watches full client snapshots until both sides of a requested container transfer are visible. */
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

function distance(first: { readonly x: number; readonly y: number; readonly z: number }, second: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function hasArrived(
  current: { readonly x: number; readonly y: number; readonly z: number },
  target: BlockPosition,
  arrival: NavigationArrival,
): boolean {
  if (arrival.kind === 'withinRange') return distance(current, target) <= arrival.range;
  return Math.floor(current.x) === target.x
    && Math.floor(current.y) === target.y
    && Math.floor(current.z) === target.z;
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
