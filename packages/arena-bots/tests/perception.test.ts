import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { hasLocalVoxelLineOfSight } from '../src/visibility.js';
import { isVisiblePosition } from '../src/perception.js';

const require = createRequire(import.meta.url);
const mineflayerRequire = createRequire(require.resolve('mineflayer'));
const minecraftData = mineflayerRequire('minecraft-data') as (version: string) => Registry;
const { Vec3 } = mineflayerRequire('vec3') as { readonly Vec3: Vec3Constructor };
const PrismarineBlock = mineflayerRequire('prismarine-block') as (registry: Registry) => BlockConstructor;
const loadWorld = mineflayerRequire('prismarine-world') as (version: string) => WorldConstructor;
const injectBlocks = mineflayerRequire('./lib/plugins/blocks.js') as (
  bot: object,
  options: { readonly version: string; readonly storageBuilder: null; readonly hideErrors: boolean },
) => void;

const registry = minecraftData('26.1.2');
const blockFactory = PrismarineBlock(registry);
const World = loadWorld('26.1.2');
const VIEWER_POSITION = new Vec3(30.4546025, 65, 29.5);
const TARGET_POSITION = new Vec3(52.5, 65, 32.5);
const TARGET_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;

test('entity visibility reaches the observed opponent center past Mineflayer canSeeBlock range', () => {
  const { bot } = makeBot();
  aimAtTarget(bot.entity as unknown as TestEntity, TARGET_POSITION, TARGET_HEIGHT);
  const targetBlock = bot.blockAt(TARGET_POSITION);
  assert.ok(targetBlock);

  // The pinned canSeeBlock aims at the block center but stops at the distance to its origin.
  const pinnedCanSeeBlock = (bot as Bot & { canSeeBlock(block: unknown): boolean | null }).canSeeBlock;
  assert.equal(pinnedCanSeeBlock(targetBlock), null);
  assert.equal(hasLocalVoxelLineOfSight(bot, targetBlock.position), true);
  assert.equal(isVisiblePosition(bot, TARGET_POSITION, TARGET_HEIGHT), true);
});

test('entity visibility follows collision shapes for glass and partial blocks', () => {
  const glass = makeBot();
  aimAtTarget(glass.bot.entity as unknown as TestEntity, TARGET_POSITION, TARGET_HEIGHT);
  glass.setBlock(40, 66, 30, registry.blocksByName.glass.defaultState);
  assert.equal(isVisiblePosition(glass.bot, TARGET_POSITION, TARGET_HEIGHT), false);

  const topSlab = makeBot();
  aimAtTarget(topSlab.bot.entity as unknown as TestEntity, TARGET_POSITION, TARGET_HEIGHT);
  const slabState = blockFactory.fromProperties('stone_slab', { type: 'top', waterlogged: false }, 0).stateId;
  assert.ok(slabState !== null && slabState !== undefined);
  topSlab.setBlock(40, 66, 30, slabState);
  assert.equal(isVisiblePosition(topSlab.bot, TARGET_POSITION, TARGET_HEIGHT), true);

  const bottomSlab = makeBot();
  aimAtTarget(bottomSlab.bot.entity as unknown as TestEntity, TARGET_POSITION, TARGET_HEIGHT);
  const bottomSlabState = blockFactory.fromProperties('stone_slab', { type: 'bottom', waterlogged: false }, 0).stateId;
  assert.ok(bottomSlabState !== null && bottomSlabState !== undefined);
  bottomSlab.setBlock(40, 66, 30, bottomSlabState);
  assert.equal(isVisiblePosition(bottomSlab.bot, TARGET_POSITION, TARGET_HEIGHT), false);
});

test('entity visibility fails closed when a voxel on the ray is unloaded', () => {
  const { bot, unloadColumn } = makeBot();
  aimAtTarget(bot.entity as unknown as TestEntity, TARGET_POSITION, TARGET_HEIGHT);
  assert.ok(bot.blockAt(TARGET_POSITION));

  unloadColumn(2, 1);

  assert.equal(isVisiblePosition(bot, TARGET_POSITION, TARGET_HEIGHT), false);
});

function makeBot(): {
  readonly bot: Bot;
  readonly setBlock: (x: number, y: number, z: number, stateId: number) => void;
  readonly unloadColumn: (chunkX: number, chunkZ: number) => void;
} {
  const world = new World(null);
  const blockStates = new Map<string, number>();
  const airState = registry.blocksByName.air.defaultState;
  for (let chunkX = 1; chunkX <= 3; chunkX += 1) {
    for (let chunkZ = 1; chunkZ <= 2; chunkZ += 1) {
      world.sync.setColumn(chunkX, chunkZ, {
        getBlock: (position) => {
          const x = chunkX * 16 + Math.floor(position.x);
          const y = Math.floor(position.y);
          const z = chunkZ * 16 + Math.floor(position.z);
          return blockFactory.fromStateId(blockStates.get(`${x},${y},${z}`) ?? airState, 0);
        },
      });
    }
  }

  const rawBot = new EventEmitter() as EventEmitter & {
    _client: EventEmitter;
    registry: Registry;
    world: WorldSync;
    entity: TestEntity;
  };
  rawBot._client = new EventEmitter();
  rawBot.registry = registry;
  rawBot.world = world.sync;
  rawBot.entity = {
    position: VIEWER_POSITION.clone(),
    eyeHeight: EYE_HEIGHT,
    yaw: 0,
    pitch: 0,
  };
  injectBlocks(rawBot, { version: '26.1.2', storageBuilder: null, hideErrors: false });

  return {
    bot: rawBot as unknown as Bot,
    setBlock: (x, y, z, stateId) => blockStates.set(`${x},${y},${z}`, stateId),
    unloadColumn: (chunkX, chunkZ) => world.sync.unloadColumn(chunkX, chunkZ),
  };
}

function aimAtTarget(entity: TestEntity, position: Vec3Like, height: number): void {
  const targetX = position.x;
  const targetY = position.y + height / 2;
  const targetZ = position.z;
  const dx = targetX - entity.position.x;
  const dy = targetY - (entity.position.y + entity.eyeHeight);
  const dz = targetZ - entity.position.z;
  entity.yaw = Math.atan2(-dx, -dz);
  entity.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

type Vec3Like = Bot['entity']['position'];

interface Vec3Constructor {
  new (x: number, y: number, z: number): Vec3Like;
}

interface TestEntity {
  readonly position: Vec3Like;
  readonly eyeHeight: number;
  yaw: number;
  pitch: number;
}

interface Registry {
  readonly blocksByName: {
    readonly air: { readonly defaultState: number };
    readonly glass: { readonly defaultState: number };
    readonly stone_slab: { readonly defaultState: number };
  };
}

interface Block {
  readonly position: Vec3Like;
  readonly stateId: number | null;
}

interface BlockConstructor {
  fromStateId(stateId: number, biomeId: number): Block;
  fromProperties(
    block: string,
    properties: { readonly type: string; readonly waterlogged: boolean },
    biomeId: number,
  ): Block;
}

interface WorldSync {
  setColumn(chunkX: number, chunkZ: number, column: { getBlock(position: Vec3Like): Block }): void;
  unloadColumn(chunkX: number, chunkZ: number): void;
}

interface WorldConstructor {
  new (chunkGenerator: null): { readonly sync: WorldSync };
}
