import { PathDiagnosticRing } from "@arena/bots";
import type { Bot } from "mineflayer";
import { performance } from "node:perf_hooks";

import type { AcceptanceRunContext } from "../integration/support/owned-run.js";
import type { MeasuredValue } from "./hunger-measurements.js";

const CHEST_SLOT_COUNT = 27;
const MAX_CHANGED_ITEM_NAMES = 64;

interface WindowItemsPacket {
  readonly windowId?: unknown;
  readonly items?: unknown;
}

interface PacketEventSource {
  on(event: "window_items", listener: (packet: WindowItemsPacket) => void): unknown;
  removeListener(event: "window_items", listener: (packet: WindowItemsPacket) => void): unknown;
}

type MineflayerWindow = NonNullable<Bot["currentWindow"]>;

interface LootItemCounts {
  player: number;
  container: number;
}

interface TrackedWindow {
  readonly window: MineflayerWindow;
  readonly lootItemCounts: ReadonlyMap<string, LootItemCounts>;
}

export interface HungerGameplayEvidence {
  readonly seats: ReadonlyMap<number, HungerSeatGameplayEvidence>;
  readonly maximumMovementBySeat: ReadonlyMap<number, number>;
  readonly lootedSeats: ReadonlySet<number>;
  readonly pvpEngagements: ReadonlySet<string>;
}

export interface HungerSeatGameplayEvidence {
  readonly movement: Readonly<{
    readonly distanceBlocks: number;
    readonly maximumDisplacementBlocks: number;
    readonly moveEventCount: number;
    readonly maximumIntervalBetweenMoveEventsMs: number;
    readonly maximumActiveIntervalBetweenMoveEventsMs: MeasuredValue<number>;
  }>;
  readonly loot: Readonly<{
    readonly confirmedTransferCount: number;
    readonly itemCounts: Readonly<Record<string, number>>;
  }>;
  readonly inventory: Readonly<{
    readonly slotUpdateCount: number;
    readonly changedItemNameObservationCount: number;
    readonly omittedChangedItemNameObservationCount: number;
    readonly changedItems: readonly string[];
    readonly equipmentChangeCount: number;
    readonly changedEquipmentSlots: readonly string[];
  }>;
  readonly combat: Readonly<{
    readonly dealtHitCount: number;
    readonly receivedHitCount: number;
    readonly healthLost: number;
    readonly healthRestored: number;
  }>;
  readonly path: Readonly<{
    readonly searchQueue: Readonly<{
      readonly queueScope: "shared_pathfinder_scheduler";
      readonly queuedSearchCount: number;
      readonly acquiredSearchCount: number;
      readonly releasedSearchCount: number;
      readonly cancelledBeforeAcquireCount: number;
      readonly timedOutBeforeAcquireCount: number;
      readonly maximumActiveSearches: number;
      readonly maximumQueuedSearches: number;
      readonly queueWaitCount: number;
      readonly queueWaitTotalMs: number;
      readonly queueWaitMaximumMs: number;
      readonly pendingQueueWaitMs: number;
    }>;
    readonly search: Readonly<{
      readonly pathUpdateCount: number;
      readonly statusCounts: Readonly<Record<string, number>>;
      readonly visitedNodeCount: number;
      readonly generatedNodeCount: number;
      readonly maximumContextTimeMs: number;
      readonly contextTimeMeaning: "cumulative_pathfinder_context_elapsed_not_single_compute_cpu";
      readonly latestTarget: Readonly<{
        readonly type: string;
        readonly x: number | null;
        readonly y: number | null;
        readonly z: number | null;
        readonly rangeSq: number | null;
        readonly entityId: number | null;
      }> | null;
    }>;
    readonly movementDiagnostics: Readonly<{
      readonly physicsSampleCount: number;
      readonly stationaryNavigationSampleCount: number;
      readonly positionCorrectionCount: number;
      readonly goalUpdateCount: number;
      readonly goalReachedCount: number;
    }>;
  }>;
}

interface InventoryItem {
  readonly name: string;
  readonly count: number;
}

interface InventoryEventSource {
  on(event: "updateSlot", listener: (slot: number, oldItem: InventoryItem | null, newItem: InventoryItem | null) => void): unknown;
  removeListener(event: "updateSlot", listener: (slot: number, oldItem: InventoryItem | null, newItem: InventoryItem | null) => void): unknown;
}

interface ItemSlotBot {
  readonly inventory: { readonly slots: readonly (InventoryItem | null)[] };
  getEquipmentDestSlot(slot: "head" | "torso" | "legs" | "feet"): number;
  readonly heldItem: InventoryItem | null;
}

/** Records bounded movement, inventory, chest-transfer, health, and hit observations from each client. */
export function recordHungerGameplayEvidence(
  active: AcceptanceRunContext,
  authorityTick: () => number | null = () => null,
): {
  snapshot(): HungerGameplayEvidence;
  markActiveBoundary(): void;
  close(): void;
} {
  const seats = new Map<number, MutableSeatEvidence>();
  const maximumMovementBySeat = new Map<number, number>();
  const lootedSeats = new Set<number>();
  const pvpEngagements = new Set<string>();
  const cleanup: Array<() => void> = [];
  const lastMovementAtBySeat = new Map<number, number>();
  const lastActiveMovementAtBySeat = new Map<number, number>();
  const queuedPathAtBySeat = new Map<number, number>();
  const pathRingsBySeat = new Map<number, PathDiagnosticRing>();
  let activeBoundaryRecorded = false;
  if (active.prepare.type !== "prepare") throw new Error("gameplay evidence requires the prepare event");
  const seatByUsername = new Map(active.prepare.payload.roster.map(({ seat, username }) => [username, seat] as const));
  const lootItems = new Set(active.preparedRun.scenario.map.lootContainers.flatMap(({ inventory }) => inventory));

  for (const planned of active.prepare.payload.roster) {
    seats.set(planned.seat, makeSeatEvidence());
    const handle = active.competitors.find(({ identity }) => identity.username === planned.username);
    if (!handle) throw new Error(`runtime did not connect competitor ${planned.username}`);
    attachCompetitorBot(planned.seat, handle.bot);
  }

  return {
    snapshot: () => {
      const now = recordCurrentMovementSilence();
      for (const ring of pathRingsBySeat.values()) ring.snapshot();
      return {
        seats: new Map([...seats].map(([seat, evidence]) => [seat, freezeSeatEvidence(
          evidence,
          queuedPathAtBySeat.has(seat) ? Math.max(0, now - queuedPathAtBySeat.get(seat)!) : 0,
          activeBoundaryRecorded,
        )])),
        maximumMovementBySeat: new Map(maximumMovementBySeat),
        lootedSeats: new Set(lootedSeats),
        pvpEngagements: new Set(pvpEngagements),
      };
    },
    markActiveBoundary: () => {
      if (activeBoundaryRecorded) throw new Error("gameplay active boundary was already recorded");
      const atMs = performance.now();
      if (!Number.isFinite(atMs)) throw new RangeError("monotonic clock returned a non-finite active boundary");
      activeBoundaryRecorded = true;
      for (const seat of seats.keys()) lastActiveMovementAtBySeat.set(seat, atMs);
    },
    close: () => {
      let snapshotFailure: unknown;
      for (const ring of pathRingsBySeat.values()) {
        try {
          ring.snapshot();
        } catch (error) {
          snapshotFailure ??= error;
        } finally {
          ring.close();
        }
      }
      for (const detach of cleanup.splice(0)) detach();
      if (snapshotFailure !== undefined) throw snapshotFailure;
    },
  };

  function attachCompetitorBot(seat: number, bot: Bot): void {
    const seatEvidence = requireSeat(seat);
    const startPosition = bot.entity.position.clone();
    let previousPosition = bot.entity.position.clone();
    let lastMoveAt = performance.now();
    let health = Number.isFinite(bot.health) ? bot.health : null;
    let equipmentSnapshot = readEquipment(bot);
    let queuedAtMs: number | null = null;
    const client = bot._client as unknown as PacketEventSource;
    const inventory = bot.inventory as unknown as InventoryEventSource;
    const openWindows = new Map<number, TrackedWindow>();

    const observeMovement = (): void => {
      const position = bot.entity.position;
      const displacement = position.distanceTo(startPosition);
      const step = position.distanceTo(previousPosition);
      const now = performance.now();
      if (![displacement, step, now].every(Number.isFinite) || displacement < 0 || step < 0) {
        throw new RangeError("Mineflayer movement evidence contains an invalid position or time");
      }
      seatEvidence.movement.distanceBlocks += step;
      seatEvidence.movement.maximumDisplacementBlocks = Math.max(
        seatEvidence.movement.maximumDisplacementBlocks,
        displacement,
      );
      seatEvidence.movement.moveEventCount += 1;
      seatEvidence.movement.maximumIntervalBetweenMoveEventsMs = Math.max(
        seatEvidence.movement.maximumIntervalBetweenMoveEventsMs,
        now - lastMoveAt,
      );
      maximumMovementBySeat.set(seat, seatEvidence.movement.maximumDisplacementBlocks);
      previousPosition = position.clone();
      lastMoveAt = now;
      lastMovementAtBySeat.set(seat, now);
      const activeLastMovementAt = lastActiveMovementAtBySeat.get(seat);
      if (activeLastMovementAt !== undefined) {
        seatEvidence.movement.maximumActiveIntervalBetweenMoveEventsMs = Math.max(
          seatEvidence.movement.maximumActiveIntervalBetweenMoveEventsMs,
          now - activeLastMovementAt,
        );
        lastActiveMovementAtBySeat.set(seat, now);
      }
    };
    const onMove = (): void => observeMovement();
    const onForcedMove = (): void => observeMovement();
    const onEntityHurt = (entity?: Bot["entity"], source?: Bot["entity"]): void => {
      if (entity?.type !== "player" || source?.type !== "player") return;
      if (entity.username === undefined || source.username === undefined) return;
      const victimSeat = seatByUsername.get(entity.username);
      const attackerSeat = seatByUsername.get(source.username);
      if (victimSeat === undefined || attackerSeat !== seat || victimSeat === attackerSeat) return;
      pvpEngagements.add(`${attackerSeat}:${victimSeat}`);
      requireSeat(victimSeat).combat.receivedHitCount += 1;
      requireSeat(attackerSeat).combat.dealtHitCount += 1;
    };
    const onHealth = (): void => {
      const current = bot.health;
      if (!Number.isFinite(current)) return;
      if (health !== null) {
        if (current < health) seatEvidence.combat.healthLost += health - current;
        else if (current > health) seatEvidence.combat.healthRestored += current - health;
      }
      health = current;
    };
    const onInventoryUpdate = (_slot: number, oldItem: InventoryItem | null, newItem: InventoryItem | null): void => {
      if (sameItem(oldItem, newItem)) return;
      seatEvidence.inventory.slotUpdateCount += 1;
      if (oldItem !== null) recordChangedItemName(seatEvidence.inventory, itemName(oldItem));
      if (newItem !== null) recordChangedItemName(seatEvidence.inventory, itemName(newItem));
      const currentEquipment = readEquipment(bot);
      for (const slot of EQUIPMENT_SLOTS) {
        if (equipmentSnapshot[slot] !== currentEquipment[slot]) {
          seatEvidence.inventory.changedEquipmentSlots.add(slot);
        }
      }
      if (EQUIPMENT_SLOTS.some((slot) => equipmentSnapshot[slot] !== currentEquipment[slot])) {
        seatEvidence.inventory.equipmentChangeCount += 1;
      }
      equipmentSnapshot = currentEquipment;
    };
    const onHeldItemChanged = (): void => {
      const currentEquipment = readEquipment(bot);
      for (const slot of EQUIPMENT_SLOTS) {
        if (equipmentSnapshot[slot] !== currentEquipment[slot]) {
          seatEvidence.inventory.changedEquipmentSlots.add(slot);
        }
      }
      if (EQUIPMENT_SLOTS.some((slot) => equipmentSnapshot[slot] !== currentEquipment[slot])) {
        seatEvidence.inventory.equipmentChangeCount += 1;
      }
      equipmentSnapshot = currentEquipment;
    };
    const onWindowOpen = (window: MineflayerWindow): void => {
      openWindows.delete(window.id);
      if (bot.currentWindow !== window
        || window.inventoryStart !== CHEST_SLOT_COUNT
        || window.inventoryEnd > window.slots.length) return;
      const lootNames = new Set(window.slots.slice(0, CHEST_SLOT_COUNT)
        .flatMap((item) => item === null ? [] : [`minecraft:${item.name}`])
        .filter((item) => lootItems.has(item)));
      if (lootNames.size === 0) return;
      openWindows.set(window.id, {
        window,
        lootItemCounts: new Map([...lootNames].map((item) => [item, {
          container: countWindowItem(window, item, 0, window.inventoryStart),
          player: countWindowItem(window, item, window.inventoryStart, window.inventoryEnd),
        }] as const)),
      });
    };
    const onWindowClose = (window: MineflayerWindow): void => {
      if (openWindows.get(window.id)?.window === window) openWindows.delete(window.id);
    };
    const onWindowItems = (packet: WindowItemsPacket): void => {
      if (typeof packet.windowId !== "number" || !Array.isArray(packet.items)) return;
      const opened = openWindows.get(packet.windowId);
      if (!opened
        || bot.currentWindow !== opened.window
        || packet.items.length !== opened.window.slots.length) return;

      // Mineflayer updates currentWindow synchronously before this later raw-client listener runs.
      let transferredItemCount = 0;
      for (const [item, before] of opened.lootItemCounts) {
        const container = countWindowItem(opened.window, item, 0, opened.window.inventoryStart);
        const player = countWindowItem(opened.window, item, opened.window.inventoryStart, opened.window.inventoryEnd);
        const movedFromContainer = Math.max(0, before.container - container);
        const gainedByPlayer = Math.max(0, player - before.player);
        const transferred = Math.min(movedFromContainer, gainedByPlayer);
        if (transferred > 0) {
          transferredItemCount += transferred;
          seatEvidence.loot.itemCounts.set(item, (seatEvidence.loot.itemCounts.get(item) ?? 0) + transferred);
        }
        before.container = container;
        before.player = player;
      }
      if (transferredItemCount === 0) return;
      seatEvidence.loot.confirmedTransferCount += 1;
      lootedSeats.add(seat);
    };

    const pathRing = new PathDiagnosticRing(bot, {
      clientLabel: `seat-${seat}`,
      clock: () => ({ clientMs: performance.now(), authorityTick: authorityTick() }),
      onRecord: (record) => {
        const path = seatEvidence.path;
        if (record.kind === "pathSearch") {
          path.searchQueue.maximumQueuedSearches = Math.max(path.searchQueue.maximumQueuedSearches, record.queuedSearches);
          path.searchQueue.maximumActiveSearches = Math.max(path.searchQueue.maximumActiveSearches, record.activeSearches);
          if (record.transition === "queued") {
            path.searchQueue.queuedSearchCount += 1;
            queuedAtMs = record.clientMs;
            queuedPathAtBySeat.set(seat, record.clientMs);
          } else if (record.transition === "acquired") {
            path.searchQueue.acquiredSearchCount += 1;
            recordQueueWait(record.clientMs);
          } else if (record.transition === "released") {
            path.searchQueue.releasedSearchCount += 1;
          } else if (record.transition === "cancelled") {
            path.searchQueue.cancelledBeforeAcquireCount += 1;
            recordQueueWait(record.clientMs);
          } else if (record.transition === "timedOut") {
            path.searchQueue.timedOutBeforeAcquireCount += 1;
            recordQueueWait(record.clientMs);
          }
          return;
        }
        if (record.kind === "pathUpdate") {
          path.search.pathUpdateCount += 1;
          path.search.statusCounts.set(record.path.status, (path.search.statusCounts.get(record.path.status) ?? 0) + 1);
          path.search.visitedNodeCount += record.path.visitedNodes;
          path.search.generatedNodeCount += record.path.generatedNodes;
          path.search.maximumContextTimeMs = Math.max(path.search.maximumContextTimeMs, record.path.contextTimeMs);
          return;
        }
        if (record.kind === "goalUpdated") {
          path.movementDiagnostics.goalUpdateCount += 1;
          path.search.latestTarget = record.goal;
          return;
        }
        if (record.kind === "goalReached") {
          path.movementDiagnostics.goalReachedCount += 1;
          return;
        }
        if (record.kind === "physicsTick") {
          path.movementDiagnostics.physicsSampleCount += 1;
          if (record.navigationActive && !record.moving) {
            path.movementDiagnostics.stationaryNavigationSampleCount += 1;
          }
          return;
        }
        if (record.kind === "positionCorrection") path.movementDiagnostics.positionCorrectionCount += 1;
      },
    });
    const recordQueueWait = (completedAtMs: number): void => {
      if (queuedAtMs === null) return;
      const waitMs = completedAtMs - queuedAtMs;
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new RangeError("path queue clock moved backwards");
      seatEvidence.path.searchQueue.queueWaitCount += 1;
      seatEvidence.path.searchQueue.queueWaitTotalMs += waitMs;
      seatEvidence.path.searchQueue.queueWaitMaximumMs = Math.max(seatEvidence.path.searchQueue.queueWaitMaximumMs, waitMs);
      queuedAtMs = null;
      queuedPathAtBySeat.delete(seat);
    };
    pathRingsBySeat.set(seat, pathRing);

    bot.on("move", onMove);
    bot.on("forcedMove", onForcedMove);
    bot.on("entityHurt", onEntityHurt);
    bot.on("health", onHealth);
    bot.on("heldItemChanged", onHeldItemChanged);
    bot.on("windowOpen", onWindowOpen);
    bot.on("windowClose", onWindowClose);
    inventory.on("updateSlot", onInventoryUpdate);
    client.on("window_items", onWindowItems);
    cleanup.push(() => {
      bot.removeListener("move", onMove);
      bot.removeListener("forcedMove", onForcedMove);
      bot.removeListener("entityHurt", onEntityHurt);
      bot.removeListener("health", onHealth);
      bot.removeListener("heldItemChanged", onHeldItemChanged);
      bot.removeListener("windowOpen", onWindowOpen);
      bot.removeListener("windowClose", onWindowClose);
      inventory.removeListener("updateSlot", onInventoryUpdate);
      client.removeListener("window_items", onWindowItems);
      openWindows.clear();
      lastMovementAtBySeat.delete(seat);
      lastActiveMovementAtBySeat.delete(seat);
      queuedPathAtBySeat.delete(seat);
      pathRingsBySeat.delete(seat);
      pathRing.close();
    });
    lastMovementAtBySeat.set(seat, lastMoveAt);
  }

  function requireSeat(seat: number): MutableSeatEvidence {
    const evidence = seats.get(seat);
    if (evidence === undefined) throw new Error(`gameplay evidence has no competitor seat ${seat}`);
    return evidence;
  }

  function recordCurrentMovementSilence(): number {
    const now = performance.now();
    if (!Number.isFinite(now)) throw new RangeError("monotonic clock returned a non-finite time");
    for (const [seat, lastMovementAt] of lastMovementAtBySeat) {
      const evidence = requireSeat(seat);
      evidence.movement.maximumIntervalBetweenMoveEventsMs = Math.max(
        evidence.movement.maximumIntervalBetweenMoveEventsMs,
        now - lastMovementAt,
      );
      const activeLastMovementAt = lastActiveMovementAtBySeat.get(seat);
      if (activeLastMovementAt !== undefined) {
        evidence.movement.maximumActiveIntervalBetweenMoveEventsMs = Math.max(
          evidence.movement.maximumActiveIntervalBetweenMoveEventsMs,
          now - activeLastMovementAt,
        );
      }
    }
    return now;
  }
}

const EQUIPMENT_SLOTS = ["mainHand", "head", "torso", "legs", "feet"] as const;
type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];
type EquipmentSnapshot = Readonly<Record<EquipmentSlot, string | null>>;

interface MutableSeatEvidence {
  readonly movement: {
    distanceBlocks: number;
    maximumDisplacementBlocks: number;
    moveEventCount: number;
    maximumIntervalBetweenMoveEventsMs: number;
    maximumActiveIntervalBetweenMoveEventsMs: number;
  };
  readonly loot: {
    confirmedTransferCount: number;
    readonly itemCounts: Map<string, number>;
  };
  readonly inventory: {
    slotUpdateCount: number;
    changedItemNameObservationCount: number;
    omittedChangedItemNameObservationCount: number;
    readonly changedItems: Set<string>;
    equipmentChangeCount: number;
    readonly changedEquipmentSlots: Set<string>;
  };
  readonly combat: {
    dealtHitCount: number;
    receivedHitCount: number;
    healthLost: number;
    healthRestored: number;
  };
  readonly path: {
    readonly searchQueue: {
      queuedSearchCount: number;
      acquiredSearchCount: number;
      releasedSearchCount: number;
      cancelledBeforeAcquireCount: number;
      timedOutBeforeAcquireCount: number;
      maximumActiveSearches: number;
      maximumQueuedSearches: number;
      queueWaitCount: number;
      queueWaitTotalMs: number;
      queueWaitMaximumMs: number;
    };
    readonly search: {
      pathUpdateCount: number;
      readonly statusCounts: Map<string, number>;
      visitedNodeCount: number;
      generatedNodeCount: number;
      maximumContextTimeMs: number;
      latestTarget: Readonly<{
        readonly type: string;
        readonly x: number | null;
        readonly y: number | null;
        readonly z: number | null;
        readonly rangeSq: number | null;
        readonly entityId: number | null;
      }> | null;
    };
    readonly movementDiagnostics: {
      physicsSampleCount: number;
      stationaryNavigationSampleCount: number;
      positionCorrectionCount: number;
      goalUpdateCount: number;
      goalReachedCount: number;
    };
  };
}

function makeSeatEvidence(): MutableSeatEvidence {
  return {
    movement: {
      distanceBlocks: 0,
      maximumDisplacementBlocks: 0,
      moveEventCount: 0,
      maximumIntervalBetweenMoveEventsMs: 0,
      maximumActiveIntervalBetweenMoveEventsMs: 0,
    },
    loot: { confirmedTransferCount: 0, itemCounts: new Map() },
    inventory: {
      slotUpdateCount: 0,
      changedItemNameObservationCount: 0,
      omittedChangedItemNameObservationCount: 0,
      changedItems: new Set(),
      equipmentChangeCount: 0,
      changedEquipmentSlots: new Set(),
    },
    combat: { dealtHitCount: 0, receivedHitCount: 0, healthLost: 0, healthRestored: 0 },
    path: {
      searchQueue: {
        queuedSearchCount: 0,
        acquiredSearchCount: 0,
        releasedSearchCount: 0,
        cancelledBeforeAcquireCount: 0,
        timedOutBeforeAcquireCount: 0,
        maximumActiveSearches: 0,
        maximumQueuedSearches: 0,
        queueWaitCount: 0,
        queueWaitTotalMs: 0,
        queueWaitMaximumMs: 0,
      },
      search: {
        pathUpdateCount: 0,
        statusCounts: new Map(),
        visitedNodeCount: 0,
        generatedNodeCount: 0,
        maximumContextTimeMs: 0,
        latestTarget: null,
      },
      movementDiagnostics: {
        physicsSampleCount: 0,
        stationaryNavigationSampleCount: 0,
        positionCorrectionCount: 0,
        goalUpdateCount: 0,
        goalReachedCount: 0,
      },
    },
  };
}

function freezeSeatEvidence(
  evidence: MutableSeatEvidence,
  pendingQueueWaitMs: number,
  activeBoundaryRecorded: boolean,
): HungerSeatGameplayEvidence {
  return Object.freeze({
    movement: Object.freeze({
      distanceBlocks: evidence.movement.distanceBlocks,
      maximumDisplacementBlocks: evidence.movement.maximumDisplacementBlocks,
      moveEventCount: evidence.movement.moveEventCount,
      maximumIntervalBetweenMoveEventsMs: evidence.movement.maximumIntervalBetweenMoveEventsMs,
      maximumActiveIntervalBetweenMoveEventsMs: activeBoundaryRecorded
        ? Object.freeze({ status: "available" as const, value: evidence.movement.maximumActiveIntervalBetweenMoveEventsMs })
        : Object.freeze({ status: "unavailable" as const, reason: "active phase was not observed" }),
    }),
    loot: Object.freeze({
      confirmedTransferCount: evidence.loot.confirmedTransferCount,
      itemCounts: Object.freeze(Object.fromEntries(evidence.loot.itemCounts)),
    }),
    inventory: Object.freeze({
      slotUpdateCount: evidence.inventory.slotUpdateCount,
      changedItemNameObservationCount: evidence.inventory.changedItemNameObservationCount,
      omittedChangedItemNameObservationCount: evidence.inventory.omittedChangedItemNameObservationCount,
      changedItems: Object.freeze([...evidence.inventory.changedItems].sort()),
      equipmentChangeCount: evidence.inventory.equipmentChangeCount,
      changedEquipmentSlots: Object.freeze([...evidence.inventory.changedEquipmentSlots].sort()),
    }),
    combat: Object.freeze({ ...evidence.combat }),
    path: Object.freeze({
      searchQueue: Object.freeze({
        ...evidence.path.searchQueue,
        queueScope: "shared_pathfinder_scheduler" as const,
        pendingQueueWaitMs,
      }),
      search: Object.freeze({
        pathUpdateCount: evidence.path.search.pathUpdateCount,
        statusCounts: Object.freeze(Object.fromEntries(evidence.path.search.statusCounts)),
        visitedNodeCount: evidence.path.search.visitedNodeCount,
        generatedNodeCount: evidence.path.search.generatedNodeCount,
        maximumContextTimeMs: evidence.path.search.maximumContextTimeMs,
        contextTimeMeaning: "cumulative_pathfinder_context_elapsed_not_single_compute_cpu",
        latestTarget: evidence.path.search.latestTarget === null ? null : Object.freeze({ ...evidence.path.search.latestTarget }),
      }),
      movementDiagnostics: Object.freeze({ ...evidence.path.movementDiagnostics }),
    }),
  });
}

function recordChangedItemName(evidence: MutableSeatEvidence["inventory"], item: string): void {
  evidence.changedItemNameObservationCount += 1;
  if (evidence.changedItems.has(item)) return;
  if (evidence.changedItems.size === MAX_CHANGED_ITEM_NAMES) {
    evidence.omittedChangedItemNameObservationCount += 1;
    return;
  }
  evidence.changedItems.add(item);
}

function readEquipment(bot: Bot): EquipmentSnapshot {
  const typedBot = bot as unknown as ItemSlotBot;
  return Object.freeze({
    mainHand: typedBot.heldItem === null ? null : itemName(typedBot.heldItem),
    head: itemAtEquipmentSlot(typedBot, "head"),
    torso: itemAtEquipmentSlot(typedBot, "torso"),
    legs: itemAtEquipmentSlot(typedBot, "legs"),
    feet: itemAtEquipmentSlot(typedBot, "feet"),
  });
}

function itemAtEquipmentSlot(bot: ItemSlotBot, slot: "head" | "torso" | "legs" | "feet"): string | null {
  const item = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
  return item === null || item === undefined ? null : itemName(item);
}

function itemName(item: InventoryItem): string {
  return item.name.startsWith("minecraft:") ? item.name : `minecraft:${item.name}`;
}

function sameItem(first: InventoryItem | null, second: InventoryItem | null): boolean {
  return first === null
    ? second === null
    : second !== null && first.name === second.name && first.count === second.count;
}

function countWindowItem(window: MineflayerWindow, item: string, start: number, end: number): number {
  const name = item.startsWith("minecraft:") ? item.slice("minecraft:".length) : item;
  let count = 0;
  for (let slotIndex = start; slotIndex < end; slotIndex += 1) {
    const slot = window.slots[slotIndex];
    if (slot?.name === name) count += slot.count;
  }
  return count;
}

