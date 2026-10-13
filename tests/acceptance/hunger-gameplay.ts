import type { Bot } from "mineflayer";

import type { AcceptanceRunContext } from "../integration/support/owned-run.js";

const CHEST_SLOT_COUNT = 27;
const WINDOW_CLEANUP_DELAY_MS = 1_000;

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
  const timers = new Set<ReturnType<typeof setTimeout>>();
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
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };

  function attachCompetitorBot(seat: number, bot: Bot): void {
    const startPosition = bot.entity.position.clone();
    const openWindows = new Map<number, {
      readonly lootNames: ReadonlySet<string>;
      readonly inventoryBefore: ReadonlyMap<string, number>;
      cleanupTimer?: ReturnType<typeof setTimeout>;
    }>();

    const observeMovement = (): void => {
      const distance = bot.entity.position.distanceTo(startPosition);
      maximumMovementBySeat.set(seat, Math.max(maximumMovementBySeat.get(seat) ?? 0, distance));
    };
    const onMove = (): void => observeMovement();
    const onForcedMove = (): void => observeMovement();
    const onEntityHurt = (entity: Bot["entity"], source: Bot["entity"]): void => {
      if (entity.type !== "player" || source.type !== "player") return;
      if (entity.username === undefined || source.username === undefined) return;
      const victimSeat = seatByUsername.get(entity.username);
      const attackerSeat = seatByUsername.get(source.username);
      if (victimSeat === undefined || attackerSeat === undefined || victimSeat === attackerSeat) return;
      pvpEngagements.add(`${attackerSeat}:${victimSeat}`);
    };
    const onWindowOpen = (window: NonNullable<Bot["currentWindow"]>): void => {
      if (window.inventoryStart !== CHEST_SLOT_COUNT) return;
      const lootNames = new Set(window.slots.slice(0, CHEST_SLOT_COUNT)
        .flatMap((item) => item === null ? [] : [`minecraft:${item.name}`])
        .filter((item) => lootItems.has(item)));
      if (lootNames.size === 0) return;
      const previous = openWindows.get(window.id);
      if (previous?.cleanupTimer !== undefined) {
        clearTimeout(previous.cleanupTimer);
        timers.delete(previous.cleanupTimer);
      }
      openWindows.set(window.id, {
        lootNames,
        inventoryBefore: new Map([...lootNames].map((item) => [item, inventoryCount(bot, item)] as const)),
      });
    };
    const onWindowClose = (window: NonNullable<Bot["currentWindow"]>): void => {
      const opened = openWindows.get(window.id);
      if (!opened) return;
      onInventoryUpdate();
      if (!openWindows.has(window.id)) return;
      const timer = setTimeout(() => {
        openWindows.delete(window.id);
        timers.delete(timer);
      }, WINDOW_CLEANUP_DELAY_MS);
      opened.cleanupTimer = timer;
      timers.add(timer);
    };
    const onInventoryUpdate = (): void => {
      for (const [windowId, opened] of openWindows) {
        const movedLoot = [...opened.lootNames].some((item) =>
          inventoryCount(bot, item) > (opened.inventoryBefore.get(item) ?? 0),
        );
        if (!movedLoot) continue;
        lootedSeats.add(seat);
        if (opened.cleanupTimer !== undefined) {
          clearTimeout(opened.cleanupTimer);
          timers.delete(opened.cleanupTimer);
        }
        openWindows.delete(windowId);
      }
    };

    bot.on("move", onMove);
    bot.on("forcedMove", onForcedMove);
    bot.on("entityHurt", onEntityHurt);
    bot.on("windowOpen", onWindowOpen);
    bot.on("windowClose", onWindowClose);
    bot.inventory.on("updateSlot", onInventoryUpdate);
    cleanup.push(() => {
      bot.removeListener("move", onMove);
      bot.removeListener("forcedMove", onForcedMove);
      bot.removeListener("entityHurt", onEntityHurt);
      bot.removeListener("windowOpen", onWindowOpen);
      bot.removeListener("windowClose", onWindowClose);
      bot.inventory.removeListener("updateSlot", onInventoryUpdate);
      for (const opened of openWindows.values()) {
        if (opened.cleanupTimer !== undefined) {
          clearTimeout(opened.cleanupTimer);
          timers.delete(opened.cleanupTimer);
        }
      }
      openWindows.clear();
    });
  }
}

function inventoryCount(bot: Bot, item: string): number {
  const name = item.startsWith("minecraft:") ? item.slice("minecraft:".length) : item;
  return bot.inventory.slots.reduce((count, slot) =>
    count + (slot?.name === name ? slot.count : 0),
  0);
}

