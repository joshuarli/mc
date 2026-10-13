import type { Bot } from "mineflayer";

import type { AcceptanceRunContext } from "../integration/support/owned-run.js";

const CHEST_SLOT_COUNT = 27;

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
  readonly player: number;
  readonly container: number;
}

interface TrackedWindow {
  readonly window: MineflayerWindow;
  readonly lootItemCounts: ReadonlyMap<string, LootItemCounts>;
}

export interface HungerGameplayEvidence {
  readonly maximumMovementBySeat: ReadonlyMap<number, number>;
  readonly lootedSeats: ReadonlySet<number>;
  readonly pvpEngagements: ReadonlySet<string>;
}

/** Records movement, chest transfers, and player-on-player damage received by Mineflayer clients. */
export function recordHungerGameplayEvidence(active: AcceptanceRunContext): {
  snapshot(): HungerGameplayEvidence;
  close(): void;
} {
  const maximumMovementBySeat = new Map<number, number>();
  const lootedSeats = new Set<number>();
  const pvpEngagements = new Set<string>();
  const cleanup: Array<() => void> = [];
  if (active.prepare.type !== "prepare") throw new Error("gameplay evidence requires the prepare event");
  const seatByUsername = new Map(active.prepare.payload.roster.map(({ seat, username }) => [username, seat] as const));
  const lootItems = new Set(active.preparedRun.scenario.map.lootContainers.flatMap(({ inventory }) => inventory));

  for (const planned of active.prepare.payload.roster) {
    const handle = active.competitors.find(({ identity }) => identity.username === planned.username);
    if (!handle) throw new Error(`runtime did not connect competitor ${planned.username}`);
    attachCompetitorBot(planned.seat, handle.bot);
  }

  return {
    snapshot: () => ({
      maximumMovementBySeat: new Map(maximumMovementBySeat),
      lootedSeats: new Set(lootedSeats),
      pvpEngagements: new Set(pvpEngagements),
    }),
    close: () => {
      for (const detach of cleanup.splice(0)) detach();
    },
  };

  function attachCompetitorBot(seat: number, bot: Bot): void {
    const startPosition = bot.entity.position.clone();
    const client = bot._client as unknown as PacketEventSource;
    const openWindows = new Map<number, TrackedWindow>();

    const observeMovement = (): void => {
      const distance = bot.entity.position.distanceTo(startPosition);
      maximumMovementBySeat.set(seat, Math.max(maximumMovementBySeat.get(seat) ?? 0, distance));
    };
    const onMove = (): void => observeMovement();
    const onForcedMove = (): void => observeMovement();
    const onEntityHurt = (entity?: Bot["entity"], source?: Bot["entity"]): void => {
      if (entity?.type !== "player" || source?.type !== "player") return;
      if (entity.username === undefined || source.username === undefined) return;
      const victimSeat = seatByUsername.get(entity.username);
      const attackerSeat = seatByUsername.get(source.username);
      if (victimSeat === undefined || attackerSeat === undefined || victimSeat === attackerSeat) return;
      pvpEngagements.add(`${attackerSeat}:${victimSeat}`);
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
      const transferredLoot = [...opened.lootItemCounts].some(([item, before]) =>
        countWindowItem(opened.window, item, 0, opened.window.inventoryStart) < before.container
        && countWindowItem(opened.window, item, opened.window.inventoryStart, opened.window.inventoryEnd) > before.player,
      );
      if (!transferredLoot) return;
      lootedSeats.add(seat);
      openWindows.delete(packet.windowId);
    };

    bot.on("move", onMove);
    bot.on("forcedMove", onForcedMove);
    bot.on("entityHurt", onEntityHurt);
    bot.on("windowOpen", onWindowOpen);
    bot.on("windowClose", onWindowClose);
    client.on("window_items", onWindowItems);
    cleanup.push(() => {
      bot.removeListener("move", onMove);
      bot.removeListener("forcedMove", onForcedMove);
      bot.removeListener("entityHurt", onEntityHurt);
      bot.removeListener("windowOpen", onWindowOpen);
      bot.removeListener("windowClose", onWindowClose);
      client.removeListener("window_items", onWindowItems);
      openWindows.clear();
    });
  }
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

