import assert from "node:assert/strict";

import type { BlockPosition, PlannedMapIr } from "@arena/spec";

export interface ObservedBlock {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly block: string;
  /** Canonical protocol state ID, which includes the block's default properties. */
  readonly stateId: number;
}

export interface BlockStateRegistry {
  readonly blocksByName: Readonly<Record<string, { readonly defaultState: number } | undefined>>;
}

export interface ObservedContainer {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly slots: readonly (ObservedItem | null)[];
}

export interface ObservedItem {
  readonly item: string;
  readonly count: number;
}

export interface ObservedPlayerItem extends ObservedItem {
  readonly slot: number;
}

export interface SemanticWorldObservation {
  readonly blocks: readonly ObservedBlock[];
  readonly spawns: readonly {
    readonly seat: number;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }[];
  readonly containers: readonly ObservedContainer[];
}

export interface PlayerInventoryObservation {
  readonly items: readonly ObservedPlayerItem[];
}

export interface PlayerDeathStatsObservation {
  readonly deaths: number;
}

export interface SemanticWorldReader {
  waitForMapChunks(map: PlannedMapIr, signal: AbortSignal): Promise<void>;
  readBlock(position: BlockPosition): ObservedBlock | null;
  readSpawn(seat: number, signal: AbortSignal): Promise<{
    readonly seat: number;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }>;
  readContainer(position: BlockPosition, signal: AbortSignal): Promise<ObservedContainer>;
}

export async function captureSemanticWorld(
  map: PlannedMapIr,
  reader: SemanticWorldReader,
  signal: AbortSignal,
): Promise<SemanticWorldObservation> {
  await reader.waitForMapChunks(map, signal);

  const blocks: ObservedBlock[] = [];
  for (const { position } of map.blocks) {
    signal.throwIfAborted();
    const observed = reader.readBlock(position);
    assert.ok(observed, `client has not received map block at ${position.x},${position.y},${position.z}`);
    blocks.push(observed);
  }

  const containers: ObservedContainer[] = [];
  for (const { position } of map.lootContainers) {
    signal.throwIfAborted();
    containers.push(await reader.readContainer(position, signal));
  }

  const spawns: SemanticWorldObservation["spawns"][number][] = [];
  for (const { seat } of map.spawns) {
    signal.throwIfAborted();
    spawns.push(await reader.readSpawn(seat, signal));
  }

  return {
    blocks,
    spawns,
    containers,
  };
}

export function assertSemanticWorldMatchesMap(
  map: PlannedMapIr,
  observed: SemanticWorldObservation,
  registry: BlockStateRegistry,
): void {
  assert.deepStrictEqual(
    observed.blocks,
    map.blocks.map(({ position, block }) => {
      assert.ok(block.startsWith("minecraft:"), `map block must use a Minecraft resource id: ${block}`);
      const material = block.slice("minecraft:".length);
      const registryBlock = registry.blocksByName[material];
      assert.ok(registryBlock, `locked Mineflayer registry has no block ${block}`);
      assert.ok(
        Number.isSafeInteger(registryBlock.defaultState),
        `locked Mineflayer registry has no default state for ${block}`,
      );
      return { position, block, stateId: registryBlock.defaultState };
    }),
    "client-observed map blocks and default states must match the compiled semantic world in canonical order",
  );
  assert.deepStrictEqual(
    observed.spawns,
    map.spawns.map(({ seat, position }) => ({
      seat,
      position: { x: position.x + 0.5, y: position.y, z: position.z + 0.5 },
    })),
    "client-observed spawn centers must match their stable prepared seat order",
  );
  assert.deepStrictEqual(
    observed.containers,
    map.lootContainers.map(({ position, inventory }) => ({
      position,
      slots: chestSlots(inventory),
    })),
    "client-observed chest inventories must match every declared slot",
  );
}

export function assertResetWorldMatchesFirst(
  first: SemanticWorldObservation,
  reset: SemanticWorldObservation,
): void {
  assert.deepStrictEqual(reset, first, "reset must reproduce the exact semantic world observation");
}

export function assertPlayerInventoryEmpty(observed: PlayerInventoryObservation): void {
  assert.deepStrictEqual(observed.items, [], "a reset player must not retain items from the earlier run");
}

export function assertPlayerDeathWasRecorded(observed: PlayerDeathStatsObservation): void {
  assert.ok(
    Number.isSafeInteger(observed.deaths) && observed.deaths > 0,
    "the completed run must persist a positive whole-number death count",
  );
}

export function assertPlayerDeathStatsReset(observed: PlayerDeathStatsObservation): void {
  assert.equal(observed.deaths, 0, "a reset player must start with zero recorded deaths");
}

function chestSlots(items: readonly string[]): readonly (ObservedItem | null)[] {
  const slots: (ObservedItem | null)[] = Array.from({ length: 27 }, () => null);
  for (const [slot, item] of items.entries()) {
    slots[slot] = { item, count: 1 };
  }
  return slots;
}
