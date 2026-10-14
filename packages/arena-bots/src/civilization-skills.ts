import { performance } from 'node:perf_hooks';
import {
  OUTPOST_LOGS_REQUIRED,
  OUTPOST_PLANKS_REQUIRED,
  isOutsideBorder,
  type BlockPosition,
  type CivIntent,
  type Knowledge,
  type WorldBorder,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import type { MineflayerCivilizationObserver } from './civilization-observer.js';
import { isVisiblePosition } from './perception.js';
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
  type MineflayerBlock,
  type MineflayerChest,
  type MineflayerItem,
} from './skill-support.js';

const INVENTORY_TRANSFER_TIMEOUT_MS = 15_000;

export interface CivilizationSkillHost {
  readonly bot: Bot;
  readonly civilizationObserver: MineflayerCivilizationObserver;
  currentBorder(): Knowledge<WorldBorder>;
  navigateTo(position: BlockPosition, range: number, active: ActiveSkill): Promise<void>;
  awaitOwnedOperation(
    active: ActiveSkill,
    name: string,
    action: () => Promise<void>,
    timeoutMs?: number,
    signal?: AbortSignal | null,
    settleOnInterruption?: () => Promise<void>,
  ): Promise<void>;
  awaitInventoryOperation(
    active: ActiveSkill,
    name: string,
    action: () => Promise<void>,
    timeoutMs?: number,
    signal?: AbortSignal | null,
  ): Promise<void>;
}

export async function mineCivilizationBlock(
  host: CivilizationSkillHost,
  intent: Extract<CivIntent, { readonly kind: 'mineBlock' }>,
  active: ActiveSkill,
): Promise<void> {
  requireSynchronizedCivilizationInventory(host);
  requireInsideBorder(host, intent.position);
  await host.navigateTo(intent.position, 4, active);
  throwIfInterrupted(active.controller.signal);
  const block = localBlock(host, intent.position);
  if (block === null || block.name !== intent.expectedBlock) {
    throw new SkillFault('preconditionsNotMet', `block at ${positionText(intent.position)} is not the expected oak log`);
  }
  if (distance(host.bot.entity.position, block.position.offset(0.5, 0.5, 0.5)) > 4.5
    || !isVisiblePosition(host.bot, block.position, 1)
    || !host.bot.canDigBlock(block)) {
    throw new SkillFault('preconditionsNotMet', `oak log at ${positionText(intent.position)} is not locally reachable`);
  }

  try {
    await host.awaitOwnedOperation(
      active,
      `dig oak log at ${positionText(intent.position)}`,
      () => {
        const operation = host.bot.dig(block, true);
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
    host.bot,
    () => {
      const changed = localBlock(host, intent.position);
      return changed !== null && changed.name !== intent.expectedBlock;
    },
    active.controller.signal,
    ACTION_TIMEOUT_MS,
  );
  const changed = localBlock(host, intent.position);
  if (changed === null || changed.name === intent.expectedBlock) {
    throw new SkillFault('noProgress', `oak log at ${positionText(intent.position)} was not observed removed`);
  }
}

export async function craftCivilizationMaterial(
  host: CivilizationSkillHost,
  intent: Extract<CivIntent, { readonly kind: 'craft' }>,
  active: ActiveSkill,
): Promise<void> {
  requireSynchronizedCivilizationInventory(host);
  const planksPerOakLog = OUTPOST_PLANKS_REQUIRED / OUTPOST_LOGS_REQUIRED;
  if (intent.table !== null
    || !Number.isSafeInteger(intent.resultCount)
    || intent.resultCount < planksPerOakLog
    || intent.resultCount > OUTPOST_PLANKS_REQUIRED
    || intent.resultCount % planksPerOakLog !== 0) {
    throw new SkillFault(
      'preconditionsNotMet',
      `outpost crafting requires whole multiples of ${planksPerOakLog} oak planks, up to ${OUTPOST_PLANKS_REQUIRED}, in hand crafting`,
    );
  }
  const resultCount = intent.resultCount;
  const craftCount = resultCount / planksPerOakLog;
  const logType = host.bot.registry.itemsByName.oak_log;
  const plankType = host.bot.registry.itemsByName.oak_planks;
  if (logType === undefined || plankType === undefined) {
    throw new Error('Mineflayer registry lacks the required oak log or plank item');
  }
  const recipe = host.bot.recipesFor(plankType.id, null, resultCount, null)
    .find((candidate) => candidate.result.id === plankType.id
      && candidate.result.count === planksPerOakLog
      && candidate.delta.reduce((count, entry) => count + (entry.id === logType.id ? entry.count : 0), 0) === -1
      && candidate.delta.reduce((count, entry) => count + (entry.id === plankType.id ? entry.count : 0), 0) === planksPerOakLog
      && candidate.delta.every((entry) => entry.id === logType.id || entry.id === plankType.id));
  if (recipe === undefined) {
    throw new SkillFault('preconditionsNotMet', 'no legal one-log to four-plank oak recipe is available in this client inventory');
  }
  const logsBefore = countInventoryItemByName(host.bot, 'oak_log');
  const planksBefore = countInventoryItemByName(host.bot, 'oak_planks');
  if (logsBefore < craftCount) {
    throw new SkillFault('preconditionsNotMet', `crafting ${resultCount} oak planks requires ${craftCount} available oak logs`);
  }
  try {
    await host.awaitInventoryOperation(
      active,
      'craft oak planks',
      () => host.bot.craft(recipe, craftCount),
      ACTION_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
    throw new SkillFault('serverRejected', errorMessage(error));
  }
  throwIfInterrupted(active.controller.signal);
  await waitForCondition(
    host.bot,
    () => countInventoryItemByName(host.bot, 'oak_log') === logsBefore - craftCount
      && countInventoryItemByName(host.bot, 'oak_planks') === planksBefore + resultCount,
    active.controller.signal,
    ACTION_TIMEOUT_MS,
  );
  if (countInventoryItemByName(host.bot, 'oak_log') !== logsBefore - craftCount
    || countInventoryItemByName(host.bot, 'oak_planks') !== planksBefore + resultCount) {
    throw new SkillFault('noProgress', `the client did not observe consuming ${craftCount} oak logs for ${resultCount} oak planks`);
  }
}

export async function transferContainerMaterial(
  host: CivilizationSkillHost,
  intent: Extract<CivIntent, { readonly kind: 'containerTransfer' }>,
  active: ActiveSkill,
): Promise<void> {
  requireSynchronizedCivilizationInventory(host);
  requireInsideBorder(host, intent.position);
  if (host.bot.inventory.selectedItem !== null) {
    throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before a container transfer');
  }
  await host.navigateTo(intent.position, 3, active);
  const window = await openCivilizationContainer(host, intent.position, active);
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

  const inventoryBefore = countInventoryItemByName(host.bot, intent.item);
  const containerBefore = countWindowItemByName(window, intent.item);
  const totalAvailable = intent.direction === 'deposit' ? inventoryBefore : containerBefore;
  if (totalAvailable < intent.count) {
    throw new SkillFault('preconditionsNotMet', `container transfer has only ${totalAvailable} observed ${intent.item}`);
  }

  let remaining = intent.count;
  const deadline = performance.now() + INVENTORY_TRANSFER_TIMEOUT_MS;
  while (remaining > 0) {
    throwIfInterrupted(active.controller.signal);
    if (host.bot.currentWindow !== window) {
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
        await host.awaitInventoryOperation(
          active,
          `${intent.direction} ${amount} ${intent.item}`,
          () => host.bot.clickWindow(nextSource.slot, 0, 1),
          operationTimeout,
        );
      } else {
        // Shift-click moves the whole stack, so right-click only the requested number of items.
        await host.awaitInventoryOperation(
          active,
          `pick up ${intent.item} for transfer`,
          () => host.bot.clickWindow(nextSource.slot, 0, 0),
          operationTimeout,
        );
        if (window.selectedItem?.name !== intent.item || window.selectedItem.count !== sourceCount) {
          throw new SkillFault('noProgress', 'the client did not observe the selected transfer stack');
        }
        for (let moved = 0; moved < amount; moved += 1) {
          await host.awaitInventoryOperation(
            active,
            `transfer ${intent.item} item ${moved + 1} of ${amount}`,
            () => host.bot.clickWindow(destination.slot, 1, 0),
            transferOperationTimeout(deadline),
          );
          const expectedCursorCount = sourceCount - moved - 1;
          if ((window.selectedItem?.count ?? 0) !== expectedCursorCount) {
            throw new SkillFault('noProgress', 'the client did not observe the requested one-item transfer');
          }
        }
        await host.awaitInventoryOperation(
          active,
          `return remaining ${intent.item} stack`,
          () => host.bot.clickWindow(nextSource.slot, 0, 0),
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
      host.bot,
      () => host.bot.currentWindow === window
        && window.selectedItem === null
        && countInventoryItemByName(host.bot, intent.item) === expectedInventory
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
  if (host.bot.currentWindow !== window || window.selectedItem !== null
    || countInventoryItemByName(host.bot, intent.item) !== expectedInventory
    || countWindowItemByName(window, intent.item) !== expectedContainer) {
    throw new SkillFault('noProgress', 'the client did not observe the requested container transfer');
  }
}

export async function placeCivilizationBlock(
  host: CivilizationSkillHost,
  intent: Extract<CivIntent, { readonly kind: 'placeBlock' }>,
  active: ActiveSkill,
): Promise<void> {
  requireSynchronizedCivilizationInventory(host);
  requireInsideBorder(host, intent.target);
  requireInsideBorder(host, intent.referencePosition);
  if (intent.face !== 'up'
    || intent.target.x !== intent.referencePosition.x
    || intent.target.z !== intent.referencePosition.z
    || intent.target.y !== intent.referencePosition.y + 1) {
    throw new SkillFault('preconditionsNotMet', 'oak plank placement must target the block directly above its support');
  }
  await host.navigateTo(intent.referencePosition, 4, active);
  const reference = localBlock(host, intent.referencePosition);
  const target = localBlock(host, intent.target);
  if (target?.name === 'oak_planks') return;
  if (reference === null || reference.boundingBox !== 'block' || target === null || target.name !== 'air') {
    throw new SkillFault('preconditionsNotMet', 'the locally observed placement target is unloaded, obstructed, or unsupported');
  }
  if (distance(host.bot.entity.position, reference.position.offset(0.5, 0.5, 0.5)) > 4.5
    || !isVisiblePosition(host.bot, reference.position, 1)) {
    throw new SkillFault('preconditionsNotMet', 'the placement support is not locally reachable');
  }
  if (host.bot.inventory.selectedItem !== null) {
    throw new SkillFault('preconditionsNotMet', 'inventory cursor is occupied before placing an outpost plank');
  }
  const plank = findInventoryStack(host.bot, 'oak_planks');
  if (plank === null) {
    throw new SkillFault('preconditionsNotMet', 'no observed oak planks remain for the outpost');
  }
  const beforePlanks = countInventoryItemByName(host.bot, 'oak_planks');
  if (host.bot.heldItem?.name !== 'oak_planks') {
    try {
      await host.awaitInventoryOperation(active, 'equip oak plank', () => host.bot.equip(plank, 'hand'));
    } catch (error) {
      if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
      throw new SkillFault('serverRejected', errorMessage(error));
    }
    throwIfInterrupted(active.controller.signal);
    if (host.bot.heldItem?.name !== 'oak_planks') {
      throw new SkillFault('noProgress', 'the client did not observe oak planks in hand');
    }
  }
  try {
    await host.awaitInventoryOperation(
      active,
      `place oak plank at ${positionText(intent.target)}`,
      () => host.bot.placeBlock(reference, reference.position.offset(0, 1, 0).minus(reference.position)),
    );
  } catch (error) {
    if (error instanceof SkillInterrupted || error instanceof SkillFault) throw error;
    throw new SkillFault('serverRejected', errorMessage(error));
  }
  throwIfInterrupted(active.controller.signal);
  await waitForCondition(
    host.bot,
    () => localBlock(host, intent.target)?.name === 'oak_planks'
      && countInventoryItemByName(host.bot, 'oak_planks') === beforePlanks - 1,
    active.controller.signal,
    ACTION_TIMEOUT_MS,
  );
  if (localBlock(host, intent.target)?.name !== 'oak_planks'
    || countInventoryItemByName(host.bot, 'oak_planks') !== beforePlanks - 1) {
    throw new SkillFault('noProgress', 'the client did not observe the placed oak plank and consumed inventory');
  }
}

async function openCivilizationContainer(
  host: CivilizationSkillHost,
  position: BlockPosition,
  active: ActiveSkill,
): Promise<MineflayerChest> {
  const key = positionText(position);
  if (host.bot.currentWindow !== null) {
    throw new SkillFault('preconditionsNotMet', 'another inventory window is already open');
  }
  const block = localBlock(host, position);
  if (block === null || (block.name !== 'chest' && block.name !== 'trapped_chest')) {
    throw new SkillFault('preconditionsNotMet', `container ${key} is not present in this client's loaded world`);
  }
  if (distance(host.bot.entity.position, block.position.offset(0.5, 0.5, 0.5)) > 3
    || !isVisiblePosition(host.bot, block.position, 1)) {
    throw new SkillFault('preconditionsNotMet', `container ${key} is outside interaction reach or occluded`);
  }
  await host.awaitOwnedOperation(active, 'look at civilization container', () => host.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true));
  throwIfInterrupted(active.controller.signal);
  const currentBlock = localBlock(host, position);
  if (currentBlock === null || (currentBlock.name !== 'chest' && currentBlock.name !== 'trapped_chest')
    || distance(host.bot.entity.position, currentBlock.position.offset(0.5, 0.5, 0.5)) > 3
    || !isVisiblePosition(host.bot, currentBlock.position, 1)) {
    throw new SkillFault('preconditionsNotMet', `container ${key} changed before activation`);
  }
  const opening = waitForChestWindow(host.bot, ACTION_TIMEOUT_MS);
  const activation = host.awaitOwnedOperation(
    active,
    `activate civilization container ${key}`,
    () => host.bot.activateBlock(currentBlock),
  );
  const [activationResult, openingResult] = await Promise.allSettled([activation, opening]);
  if (openingResult.status === 'fulfilled') {
    active.resources.window = openingResult.value;
    host.civilizationObserver.markContainerOpened(position, openingResult.value);
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

function localBlock(host: CivilizationSkillHost, position: BlockPosition): MineflayerBlock | null {
  return host.bot.blockAt(asVec3(host.bot, position));
}

function requireSynchronizedCivilizationInventory(host: CivilizationSkillHost): void {
  if (!host.civilizationObserver.isInventorySynchronized()) {
    throw new SkillFault('preconditionsNotMet', 'civilization inventory is unknown until this client receives a full inventory snapshot');
  }
}

function requireInsideBorder(host: CivilizationSkillHost, position: BlockPosition): void {
  const border = host.currentBorder();
  if (border.kind !== 'current' || isOutsideBorder(border.value, position)) {
    throw new SkillFault('preconditionsNotMet', 'civilization action requires a current border and an in-border target');
  }
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
