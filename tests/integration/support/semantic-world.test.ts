import assert from "node:assert/strict";
import test from "node:test";

import type { MapIr } from "@arena/spec";

import {
  assertPlayerDeathStatsReset,
  assertPlayerDeathWasRecorded,
  assertPlayerInventoryEmpty,
  assertResetWorldMatchesFirst,
  assertSemanticWorldMatchesMap,
  type SemanticWorldObservation,
} from "./semantic-world.js";

const map: MapIr = {
  name: "semantic-world-oracle",
  dimensions: { width: 3, depth: 1, minY: 0, maxY: 1 },
  blocks: [
    { position: { x: 0, y: 0, z: 0 }, block: "minecraft:stone" },
    { position: { x: 1, y: 0, z: 0 }, block: "minecraft:chest" },
  ],
  spawns: [
    { seat: 0, position: { x: 0, y: 1, z: 0 } },
    { seat: 1, position: { x: 2, y: 1, z: 0 } },
  ],
  lootContainers: [
    {
      position: { x: 1, y: 0, z: 0 },
      inventory: ["minecraft:bread", "minecraft:stone_sword"],
    },
  ],
  semanticId: "a".repeat(64) as MapIr["semanticId"],
};

function observedWorld(): SemanticWorldObservation {
  const slots: (SemanticWorldObservation["containers"][number]["slots"][number])[] = Array.from(
    { length: 27 },
    () => null,
  );
  slots[0] = { item: "minecraft:bread", count: 1 };
  slots[1] = { item: "minecraft:stone_sword", count: 1 };

  return {
    blocks: [
      { position: { x: 0, y: 0, z: 0 }, block: "minecraft:stone" },
      { position: { x: 1, y: 0, z: 0 }, block: "minecraft:chest" },
    ],
    spawns: [
      { seat: 0, position: { x: 0, y: 1, z: 0 } },
      { seat: 1, position: { x: 2, y: 1, z: 0 } },
    ],
    containers: [{ position: { x: 1, y: 0, z: 0 }, slots }],
  };
}

test("semantic world oracle rejects wrong block content and order", () => {
  const observed = observedWorld();
  assertSemanticWorldMatchesMap(map, observed);

  assert.throws(
    () => assertSemanticWorldMatchesMap(map, {
      ...observed,
      blocks: observed.blocks.map((block, index) => index === 0
        ? { ...block, block: "minecraft:dirt" }
        : block),
    }),
    /client-observed map blocks must match/,
  );
  assert.throws(
    () => assertSemanticWorldMatchesMap(map, { ...observed, blocks: [...observed.blocks].reverse() }),
    /client-observed map blocks must match/,
  );
});

test("semantic world oracle rejects wrong spawn seats, positions, and order", () => {
  const observed = observedWorld();
  assertSemanticWorldMatchesMap(map, observed);

  assert.throws(
    () => assertSemanticWorldMatchesMap(map, {
      ...observed,
      spawns: observed.spawns.map((spawn, index) => index === 0
        ? { ...spawn, seat: 1 }
        : spawn),
    }),
    /prepared spawn positions must retain/,
  );
  assert.throws(
    () => assertSemanticWorldMatchesMap(map, {
      ...observed,
      spawns: observed.spawns.map((spawn, index) => index === 0
        ? { ...spawn, position: { ...spawn.position, x: 1 } }
        : spawn),
    }),
    /prepared spawn positions must retain/,
  );
  assert.throws(
    () => assertSemanticWorldMatchesMap(map, { ...observed, spawns: [...observed.spawns].reverse() }),
    /prepared spawn positions must retain/,
  );
});

test("semantic world oracle checks chest item slots, empty slots, and window size", () => {
  const observed = observedWorld();
  assertSemanticWorldMatchesMap(map, observed);

  const chest = observed.containers[0]!;
  const reversedItems = [...chest.slots];
  [reversedItems[0], reversedItems[1]] = [reversedItems[1]!, reversedItems[0]!];
  assert.throws(
    () => assertSemanticWorldMatchesMap(map, {
      ...observed,
      containers: [{ ...chest, slots: reversedItems }],
    }),
    /client-observed chest inventories must match/,
  );

  const occupiedEmptySlot = [...chest.slots];
  occupiedEmptySlot[26] = { item: "minecraft:diamond", count: 1 };
  assert.throws(
    () => assertSemanticWorldMatchesMap(map, {
      ...observed,
      containers: [{ ...chest, slots: occupiedEmptySlot }],
    }),
    /client-observed chest inventories must match/,
  );
  assert.throws(
    () => assertSemanticWorldMatchesMap(map, {
      ...observed,
      containers: [{ ...chest, slots: chest.slots.slice(0, 26) }],
    }),
    /client-observed chest inventories must match/,
  );
});

test("reset world comparison preserves exact block, spawn, and chest observations", () => {
  const first = observedWorld();
  assertResetWorldMatchesFirst(first, observedWorld());

  const changedChest = [...first.containers[0]!.slots];
  [changedChest[0], changedChest[1]] = [changedChest[1]!, changedChest[0]!];
  const reset = {
    ...first,
    containers: [{ ...first.containers[0]!, slots: changedChest }],
  };
  assert.throws(() => assertResetWorldMatchesFirst(first, reset), /reset must reproduce/);
});

test("reset player inventory must contain no items", () => {
  assertPlayerInventoryEmpty({ items: [] });
  assert.throws(
    () => assertPlayerInventoryEmpty({ items: [{ item: "minecraft:stone", count: 1, slot: 0 }] }),
    /reset player must not retain/,
  );
});

test("death reset requires a recorded prior death and a zero stopped-run count", () => {
  assertPlayerDeathWasRecorded({ deaths: 1 });
  assertPlayerDeathStatsReset({ deaths: 0 });
  assert.throws(() => assertPlayerDeathWasRecorded({ deaths: 0 }), /must persist at least one/);
  assert.throws(() => assertPlayerDeathStatsReset({ deaths: 1 }), /must start with zero/);
});
