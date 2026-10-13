import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";

import { recordHungerGameplayEvidence } from "./hunger-gameplay.js";
import type { AcceptanceRunContext } from "../integration/support/owned-run.js";

interface TestItem {
  readonly name: string;
  readonly count: number;
}

interface TestWindow {
  readonly id: number;
  readonly inventoryStart: number;
  readonly inventoryEnd: number;
  slots: (TestItem | null)[];
}

interface WindowItemsPacket {
  readonly windowId: number;
  readonly items: readonly (TestItem | null)[];
}

interface TestBot extends EventEmitter {
  readonly _client: EventEmitter;
  currentWindow: TestWindow | null;
  readonly inventory: EventEmitter & { slots: (TestItem | null)[] };
  readonly entity: {
    readonly type: "player";
    readonly username: string;
    readonly position: {
      clone(): TestBot["entity"]["position"];
      distanceTo(other: TestBot["entity"]["position"]): number;
    };
  };
}

test("hunger evidence ignores matching player gains when the chest contents are unchanged", () => {
  const fixture = makeRecorder();
  const window = chestWindow(11, 4, 2);
  openChest(fixture.bot, window);

  fixture.bot.inventory.slots[0] = { name: "bread", count: 3 };
  fixture.bot.inventory.emit("updateSlot", 0);
  fixture.client.emit("window_items", {
    windowId: window.id,
    items: snapshot(window, { chestBread: 4, playerBread: 3 }),
  } satisfies WindowItemsPacket);
  closeChest(fixture.bot, window);

  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], []);
  fixture.evidence.close();
});

test("hunger evidence counts a transfer only after one full snapshot shows chest loss and player gain", () => {
  const fixture = makeRecorder();
  const window = chestWindow(12, 4, 2);
  openChest(fixture.bot, window);

  // Mineflayer's predicted slot changes and inventory events are not transfer evidence.
  window.slots = snapshot(window, { chestBread: 1, playerBread: 5 });
  fixture.bot.inventory.slots[0] = { name: "bread", count: 5 };
  fixture.bot.inventory.emit("updateSlot", 0);
  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], []);

  fixture.client.emit("window_items", {
    windowId: window.id,
    items: snapshot(window, { chestBread: 1, playerBread: 5 }),
  } satisfies WindowItemsPacket);

  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], [2]);
  fixture.evidence.close();
});

test("hunger evidence ignores full snapshots for a different window id", () => {
  const fixture = makeRecorder();
  const window = chestWindow(13, 4, 2);
  openChest(fixture.bot, window);

  fixture.client.emit("window_items", {
    windowId: window.id + 1,
    items: snapshot(window, { chestBread: 1, playerBread: 5 }),
  } satisfies WindowItemsPacket);

  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], []);
  fixture.evidence.close();
});

test("hunger evidence ignores damage events without a tracked attacker", () => {
  const fixture = makeRecorder();

  assert.doesNotThrow(() => fixture.bot.emit("entityHurt", fixture.bot.entity, undefined));
  assert.deepEqual([...fixture.evidence.snapshot().pvpEngagements], []);

  fixture.evidence.close();
});

function makeRecorder(): {
  readonly bot: TestBot;
  readonly client: EventEmitter;
  readonly evidence: ReturnType<typeof recordHungerGameplayEvidence>;
} {
  const client = new EventEmitter();
  const position = {
    clone() { return this; },
    distanceTo(_other: unknown) { return 0; },
  };
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    currentWindow: null as TestWindow | null,
    inventory: Object.assign(new EventEmitter(), { slots: Array<TestItem | null>(36).fill(null) }),
    entity: { type: "player" as const, username: "bot-seat-2", position },
  }) as TestBot;

  // Mineflayer installs this handler before the acceptance recorder subscribes.
  client.on("window_items", (packet: WindowItemsPacket) => {
    const window = bot.currentWindow;
    if (window === null || packet.windowId !== window.id || packet.items.length !== window.slots.length) return;
    window.slots = packet.items.map((item) => item === null ? null : { ...item });
  });

  const active = {
    prepare: { type: "prepare", payload: { roster: [{ seat: 2, username: "bot-seat-2" }] } },
    preparedRun: { scenario: { map: { lootContainers: [{ inventory: ["minecraft:bread"] }] } } },
    competitors: [{ identity: { username: "bot-seat-2" }, bot: bot as unknown as Bot }],
  } as unknown as AcceptanceRunContext;

  return {
    bot,
    client,
    evidence: recordHungerGameplayEvidence(active),
  };
}

function chestWindow(id: number, chestBread: number, playerBread: number): TestWindow {
  const window: TestWindow = {
    id,
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: Array<TestItem | null>(63).fill(null),
  };
  window.slots[0] = { name: "bread", count: chestBread };
  window.slots[27] = { name: "bread", count: playerBread };
  return window;
}

function snapshot(
  window: TestWindow,
  counts: Readonly<{ chestBread: number; playerBread: number }>,
): (TestItem | null)[] {
  const slots: (TestItem | null)[] = Array<TestItem | null>(window.slots.length).fill(null);
  if (counts.chestBread > 0) slots[0] = { name: "bread", count: counts.chestBread };
  if (counts.playerBread > 0) slots[27] = { name: "bread", count: counts.playerBread };
  return slots;
}

function openChest(bot: TestBot, window: TestWindow): void {
  bot.currentWindow = window;
  bot.inventory.slots[0] = window.slots[27] ?? null;
  bot.emit("windowOpen", window);
}

function closeChest(bot: TestBot, window: TestWindow): void {
  bot.currentWindow = null;
  bot.emit("windowClose", window);
}
