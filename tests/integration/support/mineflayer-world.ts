import assert from "node:assert/strict";

import type { Bot, Chest } from "mineflayer";
import type { BlockPosition, PlannedMapIr } from "@arena/spec";

import type {
  ObservedBlock,
  ObservedContainer,
  ObservedItem,
  PlayerInventoryObservation,
  SemanticWorldReader,
} from "./semantic-world.js";

const CHUNK_LOAD_TIMEOUT_MS = 30_000;
const CHEST_SLOT_COUNT = 27;
const MAX_RECEIPT_EVENTS = 4_096;

export function createMineflayerSemanticWorldReader(
  bot: Bot,
  usernamesBySeat: ReadonlyMap<number, string>,
): SemanticWorldReader {
  return {
    waitForMapChunks: async (map, signal) => {
      await waitForMapChunks(bot, map, signal);
    },
    readBlock: (position) => readBlock(bot, position),
    readSpawn: async (seat, signal) => {
      signal.throwIfAborted();
      const username = usernamesBySeat.get(seat);
      assert.ok(username, `no connected competitor identity is assigned to seat ${seat}`);
      const entity = username === bot.username ? bot.entity : bot.players[username]?.entity;
      assert.ok(entity, `client has not received the player entity for seat ${seat} (${username})`);
      return {
        seat,
        position: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
        },
      };
    },
    readContainer: async (position, signal) => {
      signal.throwIfAborted();
      const block = bot.blockAt(vectorAt(bot, position));
      assert.ok(block, `client has not received chest at ${position.x},${position.y},${position.z}`);
      assert.equal(block.name, "chest", `expected a chest at ${position.x},${position.y},${position.z}`);
      const chest = await bot.openChest(block);
      return readChest(chest, position, signal);
    },
  };
}

export interface MineflayerReceiptHistory {
  readonly chunkColumns: readonly { readonly x: number; readonly z: number }[];
  readonly entities: readonly {
    readonly id: number;
    readonly type: string;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }[];
}

export function recordMineflayerReceipts(bot: Bot): {
  snapshot(): MineflayerReceiptHistory;
  close(): void;
} {
  const chunkColumns: { x: number; z: number }[] = [];
  const entities: {
    id: number;
    type: string;
    position: { x: number; y: number; z: number };
  }[] = [];
  let closed = false;
  let overflowed = false;
  const onChunkColumnLoad = (position: { readonly x: number; readonly z: number }): void => {
    if (chunkColumns.length + entities.length >= MAX_RECEIPT_EVENTS) {
      overflowed = true;
      return;
    }
    chunkColumns.push({ x: position.x, z: position.z });
  };
  const onEntitySpawn = (entity: Bot["entity"]): void => {
    if (chunkColumns.length + entities.length >= MAX_RECEIPT_EVENTS) {
      overflowed = true;
      return;
    }
    entities.push({
      id: entity.id,
      type: entity.type,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    });
  };
  bot.on("chunkColumnLoad", onChunkColumnLoad);
  bot.on("entitySpawn", onEntitySpawn);
  return {
    snapshot: () => {
      assert.ok(!overflowed, `client receipt history exceeded ${MAX_RECEIPT_EVENTS} events`);
      return {
        chunkColumns: chunkColumns.map(({ x, z }) => ({ x, z })),
        entities: entities.map(({ id, type, position }) => ({
          id,
          type,
          position: { x: position.x, y: position.y, z: position.z },
        })),
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      bot.removeListener("chunkColumnLoad", onChunkColumnLoad);
      bot.removeListener("entitySpawn", onEntitySpawn);
    },
  };
}

export function observePlayerInventory(bot: Bot): PlayerInventoryObservation {
  assert.equal(bot.inventory.selectedItem, null, "player cursor must be empty");
  const items: PlayerInventoryObservation["items"][number][] = [];
  for (const [slot, item] of bot.inventory.slots.entries()) {
    if (item !== null) {
      items.push({
        slot,
        item: `minecraft:${item.name}`,
        count: item.count,
      });
    }
  }
  return { items };
}

async function waitForMapChunks(bot: Bot, map: PlannedMapIr, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const columns = new Map<string, { readonly x: number; readonly z: number }>();
  const positions: BlockPosition[] = [
    ...map.blocks.map(({ position }) => position),
    ...map.lootContainers.map(({ position }) => position),
    ...map.spawns.map(({ position }) => position),
  ];
  for (const position of positions) {
    const x = Math.floor(position.x / 16);
    const z = Math.floor(position.z / 16);
    columns.set(`${x},${z}`, { x: x * 16, z: z * 16 });
  }

  const allLoaded = (): boolean => {
    for (const column of columns.values()) {
      if (!bot.world.getColumnAt(vectorAt(bot, { x: column.x, y: 0, z: column.z }))) return false;
    }
    return true;
  };
  if (allLoaded()) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      bot.removeListener("chunkColumnLoad", checkLoaded);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const checkLoaded = (): void => {
      if (signal.aborted) {
        finish(signal.reason ?? new Error("map chunk wait aborted"));
      } else if (allLoaded()) {
        finish();
      }
    };
    const abort = (): void => finish(signal.reason ?? new Error("map chunk wait aborted"));
    const timeout = setTimeout(
      () => finish(new Error(`client did not receive every map chunk within ${CHUNK_LOAD_TIMEOUT_MS} ms`)),
      CHUNK_LOAD_TIMEOUT_MS,
    );

    bot.on("chunkColumnLoad", checkLoaded);
    signal.addEventListener("abort", abort, { once: true });
    checkLoaded();
  });
}

function readBlock(bot: Bot, position: BlockPosition): ObservedBlock | null {
  const block = bot.blockAt(vectorAt(bot, position));
  if (!block) return null;
  return {
    position,
    block: `minecraft:${block.name}`,
    stateId: block.stateId,
  };
}

async function readChest(
  chest: Chest,
  position: BlockPosition,
  signal: AbortSignal,
): Promise<ObservedContainer> {
  let failed = false;
  let failure: unknown;
  try {
    signal.throwIfAborted();
    const slots = chest.slots.slice(0, CHEST_SLOT_COUNT).map((item): ObservedItem | null =>
      item === null
        ? null
        : {
            item: `minecraft:${item.name}`,
            count: item.count,
          },
    );
    assert.equal(slots.length, CHEST_SLOT_COUNT, "opened chest must expose all 27 slots");
    return { position, slots };
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await chest.close();
    } catch (closeError) {
      if (failed) {
        throw new AggregateError([failure, closeError], "chest observation failed and the chest window did not close");
      }
      throw closeError;
    }
  }
}

function vectorAt(bot: Bot, position: { readonly x: number; readonly y: number; readonly z: number }) {
  const vector = bot.entity.position.clone();
  vector.set(position.x, position.y, position.z);
  return vector;
}
