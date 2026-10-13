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
  health: number;
  heldItem: TestItem | null;
  getEquipmentDestSlot(slot: "head" | "torso" | "legs" | "feet"): number;
  readonly entity: {
    readonly type: "player";
    readonly username: string;
    readonly position: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
      set(x: number, y: number, z: number): void;
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
  fixture.bot.inventory.emit("updateSlot", 0, null, { name: "bread", count: 3 });
  fixture.client.emit("window_items", {
    windowId: window.id,
    items: snapshot(window, { chestBread: 4, playerBread: 3 }),
  } satisfies WindowItemsPacket);
  closeChest(fixture.bot, window);

  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], []);
  assert.equal(
    fixture.evidence.snapshot().seats.get(2)?.movement.maximumActiveIntervalBetweenMoveEventsMs.status,
    "unavailable",
  );
  fixture.evidence.close();
});

test("hunger evidence counts a transfer only after one full snapshot shows chest loss and player gain", () => {
  const fixture = makeRecorder();
  const window = chestWindow(12, 4, 2);
  openChest(fixture.bot, window);

  // Mineflayer's predicted slot changes and inventory events are not transfer evidence.
  window.slots = snapshot(window, { chestBread: 1, playerBread: 5 });
  fixture.bot.inventory.slots[0] = { name: "bread", count: 5 };
  fixture.bot.inventory.emit("updateSlot", 0, null, { name: "bread", count: 5 });
  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], []);

  fixture.client.emit("window_items", {
    windowId: window.id,
    items: snapshot(window, { chestBread: 1, playerBread: 5 }),
  } satisfies WindowItemsPacket);

  assert.deepEqual([...fixture.evidence.snapshot().lootedSeats], [2]);
  const seatEvidence = fixture.evidence.snapshot().seats.get(2);
  assert.ok(seatEvidence);
  assert.equal(seatEvidence.loot.confirmedTransferCount, 1);
  assert.equal(seatEvidence.loot.itemCounts["minecraft:bread"], 3);
  fixture.evidence.close();
});

test("hunger evidence accumulates separate confirmed transfers from one chest", () => {
  const fixture = makeRecorder();
  const window = chestWindow(14, 4, 2);
  openChest(fixture.bot, window);

  const first = snapshot(window, { chestBread: 1, playerBread: 5 });
  window.slots = first;
  fixture.client.emit("window_items", { windowId: window.id, items: first } satisfies WindowItemsPacket);
  const second = snapshot(window, { chestBread: 0, playerBread: 6 });
  window.slots = second;
  fixture.client.emit("window_items", { windowId: window.id, items: second } satisfies WindowItemsPacket);

  const seatEvidence = fixture.evidence.snapshot().seats.get(2);
  assert.ok(seatEvidence);
  assert.equal(seatEvidence.loot.confirmedTransferCount, 2);
  assert.equal(seatEvidence.loot.itemCounts["minecraft:bread"], 4);
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

test("hunger evidence records observed movement distance and movement-event gaps", () => {
  const fixture = makeRecorder();
  fixture.evidence.markActiveBoundary();
  fixture.bot.entity.position.set(3, 4, 0);
  fixture.bot.emit("move");
  fixture.bot.entity.position.set(3, 4, 12);
  fixture.bot.emit("forcedMove");

  const movement = fixture.evidence.snapshot().seats.get(2)?.movement;
  assert.ok(movement);
  assert.equal(movement.distanceBlocks, 17);
  assert.equal(movement.maximumDisplacementBlocks, 13);
  assert.equal(movement.moveEventCount, 2);
  assert.ok(movement.maximumIntervalBetweenMoveEventsMs >= 0);
  assert.equal(movement.maximumActiveIntervalBetweenMoveEventsMs.status, "available");
  if (movement.maximumActiveIntervalBetweenMoveEventsMs.status !== "available") {
    throw new Error("active movement interval must be available after observing the active phase");
  }
  assert.ok(movement.maximumActiveIntervalBetweenMoveEventsMs.value >= 0);
  fixture.evidence.close();
});

test("hunger evidence separates attacker and victim hit receipts and health changes", () => {
  const fixture = makeRecorder();
  fixture.bot.health = 13;
  fixture.bot.emit("health");
  fixture.attacker.emit("entityHurt", fixture.bot.entity, fixture.attacker.entity);

  const evidence = fixture.evidence.snapshot();
  assert.equal(evidence.seats.get(1)?.combat.dealtHitCount, 1);
  assert.equal(evidence.seats.get(2)?.combat.receivedHitCount, 1);
  assert.equal(evidence.seats.get(2)?.combat.healthLost, 7);
  assert.deepEqual([...evidence.pvpEngagements], ["1:2"]);
  fixture.evidence.close();
});

test("hunger evidence records inventory and equipment changes from Mineflayer events", () => {
  const fixture = makeRecorder();
  fixture.bot.heldItem = { name: "iron_sword", count: 1 };
  fixture.bot.emit("heldItemChanged");
  fixture.bot.inventory.emit("updateSlot", 0, null, { name: "bread", count: 2 });

  const inventory = fixture.evidence.snapshot().seats.get(2)?.inventory;
  assert.ok(inventory);
  assert.equal(inventory.slotUpdateCount, 1);
  assert.equal(inventory.changedItemNameObservationCount, 1);
  assert.equal(inventory.omittedChangedItemNameObservationCount, 0);
  assert.equal(inventory.equipmentChangeCount, 1);
  assert.deepEqual(inventory.changedItems, ["minecraft:bread"]);
  assert.deepEqual(inventory.changedEquipmentSlots, ["mainHand"]);
  fixture.evidence.close();
});

test("hunger evidence summarizes path targets and search failures without keeping the event stream", () => {
  const fixture = makeRecorder();
  fixture.bot.emit("goal_updated", { x: 4, y: 65, z: -2, rangeSq: 4 }, false);
  fixture.bot.emit("path_update", {
    status: "noPath",
    cost: 0,
    time: 12,
    visitedNodes: 7,
    generatedNodes: 9,
    path: [],
  });

  const path = fixture.evidence.snapshot().seats.get(2)?.path;
  assert.ok(path);
  assert.equal(path.search.latestTarget?.x, 4);
  assert.equal(path.search.latestTarget?.y, 65);
  assert.equal(path.search.latestTarget?.z, -2);
  assert.equal(path.search.pathUpdateCount, 1);
  assert.equal(path.search.statusCounts.noPath, 1);
  assert.equal(path.search.visitedNodeCount, 7);
  assert.equal(path.search.generatedNodeCount, 9);
  assert.equal(path.search.maximumContextTimeMs, 12);
  fixture.evidence.close();
});

function makeRecorder(): {
  readonly bot: TestBot;
  readonly attacker: TestBot;
  readonly client: EventEmitter;
  readonly evidence: ReturnType<typeof recordHungerGameplayEvidence>;
} {
  const bot = makeBot("bot-seat-2");
  const attacker = makeBot("bot-seat-1");
  const client = bot._client;

  // Mineflayer installs this handler before the acceptance recorder subscribes.
  client.on("window_items", (packet: WindowItemsPacket) => {
    const window = bot.currentWindow;
    if (window === null || packet.windowId !== window.id || packet.items.length !== window.slots.length) return;
    window.slots = packet.items.map((item) => item === null ? null : { ...item });
  });

  const active = {
    prepare: { type: "prepare", payload: { roster: [
      { seat: 1, username: "bot-seat-1" },
      { seat: 2, username: "bot-seat-2" },
    ] } },
    preparedRun: { scenario: { map: { lootContainers: [{ inventory: ["minecraft:bread"] }] } } },
    competitors: [
      { identity: { username: "bot-seat-1" }, bot: attacker as unknown as Bot },
      { identity: { username: "bot-seat-2" }, bot: bot as unknown as Bot },
    ],
  } as unknown as AcceptanceRunContext;

  return {
    bot,
    attacker,
    client,
    evidence: recordHungerGameplayEvidence(active),
  };
}

function makeBot(username: string): TestBot {
  const client = new EventEmitter();
  const position = makePosition();
  return Object.assign(new EventEmitter(), {
    _client: client,
    currentWindow: null as TestWindow | null,
    inventory: Object.assign(new EventEmitter(), { slots: Array<TestItem | null>(36).fill(null) }),
    health: 20,
    heldItem: null as TestItem | null,
    getEquipmentDestSlot(slot: "head" | "torso" | "legs" | "feet") {
      return ({ head: 5, torso: 6, legs: 7, feet: 8 } as const)[slot];
    },
    entity: { type: "player" as const, username, position },
  }) as TestBot;
}

function makePosition(): TestBot["entity"]["position"] {
  const point = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    },
    clone() {
      return makePositionAt(this.x, this.y, this.z);
    },
    distanceTo(other: TestBot["entity"]["position"]) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  return point;
}

function makePositionAt(x: number, y: number, z: number): TestBot["entity"]["position"] {
  const position = makePosition();
  position.set(x, y, z);
  return position;
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
