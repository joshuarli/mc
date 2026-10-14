import assert from "node:assert/strict";

import type { BlockPosition, MapIr } from "@arena/spec";

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

/** A client-read snapshot of only the map content that has declared meaning. */
export interface SemanticWorldObservation {
  readonly blocks: readonly ObservedBlock[];
  readonly spawns: readonly {
    readonly seat: number;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }[];
  readonly containers: readonly ObservedContainer[];
}

export interface PlayerInventoryObservation {
  /** Every occupied slot in the client's player inventory, in slot order. */
  readonly items: readonly ObservedPlayerItem[];
}

export interface PlayerDeathStatsObservation {
  readonly deaths: number;
}

/**
 * Case-owned adapters over ordinary Mineflayer clients. `readContainer` must
 * open the real container and close its window before it settles; `readSpawn`
 * must report the position received by that seat's client.
 */
export interface SemanticWorldReader {
  waitForMapChunks(map: MapIr, signal: AbortSignal): Promise<void>;
  readBlock(position: BlockPosition): ObservedBlock | null;
  readSpawn(seat: number, signal: AbortSignal): Promise<{
    readonly seat: number;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }>;
  readContainer(position: BlockPosition, signal: AbortSignal): Promise<ObservedContainer>;
}

/** Reads one client's loaded map blocks and chest windows in spec order. */
export async function captureSemanticWorld(
  map: MapIr,
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

/**
 * Compares client-observed blocks and every chest slot with the compiled map.
 * The caller must query positions in the order supplied by the compiled map.
 */
export function assertSemanticWorldMatchesMap(
  map: MapIr,
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

/**
 * Reset is correct only when the independently observed world state is exact.
 * Inventory slot order and all observed values are part of this comparison.
 */
export function assertResetWorldMatchesFirst(
  first: SemanticWorldObservation,
  reset: SemanticWorldObservation,
): void {
  assert.deepStrictEqual(reset, first, "reset must reproduce the exact semantic world observation");
}

/** A fresh reset must not restore any item collected in the earlier run. */
export function assertPlayerInventoryEmpty(observed: PlayerInventoryObservation): void {
  assert.deepStrictEqual(observed.items, [], "a reset player must not retain items from the earlier run");
}

/** A reset proves the death counter was cleared only after the prior run recorded a death. */
export function assertPlayerDeathWasRecorded(observed: PlayerDeathStatsObservation): void {
  assert.ok(
    Number.isSafeInteger(observed.deaths) && observed.deaths > 0,
    "the completed run must persist a positive whole-number death count",
  );
}

/** Player statistics are part of the reset; a completed fresh run must start with zero deaths. */
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
