import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import type { Bot } from 'mineflayer';
import { createCombatArena, Vec3 } from './combat-arena.js';

const require = createRequire(import.meta.url);
const mineflayerRequire = createRequire(require.resolve('mineflayer'));
const { goals } = require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');
type Movements = import('mineflayer-pathfinder').Movements;
const AStar = require('mineflayer-pathfinder/lib/astar') as new (
  start: unknown,
  movements: unknown,
  goal: unknown,
  timeout: number,
  tickTimeout: number,
  searchRadius: number,
) => { compute(): { status: string; path: { x: number; y: number; z: number; toBreak: unknown[]; toPlace: unknown[] }[] } };
const Move = require('mineflayer-pathfinder/lib/move') as new (
  x: number, y: number, z: number, remainingBlocks: number, cost: number,
) => unknown;

const FLOOR_Y = 3;

function setBlock(bot: Bot, name: string, x: number, y: number, z: number): void {
  const block = bot.registry.blocksByName[name];
  assert.ok(block !== undefined, `registry has ${name}`);
  bot.world.setBlockStateId(new Vec3(x, y, z), block.minStateId!);
}

function buildCourse(bot: Bot): void {
  for (let x = 0; x <= 40; x += 1) {
    for (let z = -3; z <= 3; z += 1) {
      setBlock(bot, 'stone', x, FLOOR_Y, z);
    }
  }
  for (let z = -3; z <= 3; z += 1) {
    for (let x = 6; x <= 9; x += 1) setBlock(bot, 'stone', x, FLOOR_Y + 1, z);
    setBlock(bot, 'stone_slab', 10, FLOOR_Y + 1, z);
    for (let x = 14; x <= 15; x += 1) setBlock(bot, 'oak_leaves', x, FLOOR_Y + 1, z);
    for (let x = 18; x <= 20; x += 1) {
      setBlock(bot, 'stone', x, FLOOR_Y - 1, z);
      setBlock(bot, 'water', x, FLOOR_Y, z);
    }
  }
  for (let x = 22; x <= 24; x += 1) {
    for (let z = -2; z <= 2; z += 1) {
      setBlock(bot, 'stone', x, FLOOR_Y - 1, z);
      setBlock(bot, 'lava', x, FLOOR_Y, z);
    }
  }
}

function search(bot: Bot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const movements = (bot.pathfinder as unknown as { movements: Movements }).movements;
  const goal = new goals.GoalBlock(to.x, to.y, to.z);
  const start = new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0);
  const astar = new AStar(start, movements, goal, 5_000, 5_000, 64);
  const deadline = performance.now() + 8_000;
  let result = astar.compute();
  while (result.status === 'partial' && performance.now() < deadline) result = astar.compute();
  return result;
}

test('curriculum 11: navigation crosses rises, partial blocks and water, and routes around lava', () => {
  const arena = createCombatArena({ self: { x: 0.5, y: FLOOR_Y + 1, z: 0.5 }, opponents: [] });
  try {
    buildCourse(arena.bot);
    const result = search(arena.bot, { x: 0, y: FLOOR_Y + 1, z: 0 }, { x: 30, y: FLOOR_Y + 1, z: 0 });
    assert.equal(result.status, 'success');
    assert.ok(result.path.every((node) => node.toBreak.length === 0 && node.toPlace.length === 0));
    assert.ok(result.path.some((node) => node.x > 20));
    assert.ok(result.path.some((node) => node.x >= 22 && node.x <= 24 && Math.abs(node.z) >= 3));
  } finally {
    void arena.close();
  }
});

test('curriculum 11: a three-block fall is a safe descent and a four-block fall is refused', () => {
  const arena = createCombatArena({ self: { x: 0.5, y: 8, z: 0.5 }, opponents: [] });
  try {
    const movements = (arena.bot.pathfinder as unknown as { movements: Movements }).movements;
    assert.ok(movements.maxDropDown <= 4, 'the pathfinder counts the landing block, so 4 is a three-block fall');
    assert.equal(movements.canDig, false);
    for (let x = 0; x <= 6; x += 1) for (let z = -2; z <= 2; z += 1) setBlock(arena.bot, 'stone', x, 7, z);
    for (let x = 7; x <= 14; x += 1) for (let z = -2; z <= 2; z += 1) setBlock(arena.bot, 'stone', x, 4, z);
    for (let x = 15; x <= 22; x += 1) for (let z = -2; z <= 2; z += 1) setBlock(arena.bot, 'stone', x, 0, z);
    const safe = search(arena.bot, { x: 0, y: 8, z: 0 }, { x: 10, y: 5, z: 0 });
    assert.equal(safe.status, 'success');
    const unsafe = search(arena.bot, { x: 10, y: 5, z: 0 }, { x: 18, y: 1, z: 0 });
    assert.notEqual(unsafe.status, 'success');
  } finally {
    void arena.close();
  }
});

test('a deep pit has no exit when every route would require the forbidden drop', () => {
  const arena = createCombatArena({ self: { x: 0.5, y: 24, z: 0.5 }, opponents: [] });
  try {
    const Chunk = mineflayerRequire('prismarine-chunk')(arena.bot.registry) as new (options: {
      minY: number;
      worldHeight: number;
    }) => NonNullable<ReturnType<Bot['world']['getColumn']>>;
    const world = arena.bot.world as unknown as {
      setColumn(chunkX: number, chunkZ: number, column: NonNullable<ReturnType<Bot['world']['getColumn']>>): void;
    };
    for (let chunkZ = -1; chunkZ <= 0; chunkZ += 1) {
      world.setColumn(0, chunkZ, new Chunk({ minY: 0, worldHeight: 32 }));
    }
    Object.assign(arena.bot.game, { height: 32 });
    arena.bot.entity.position.set(0.5, 24, 0.5);
    for (let x = -2; x <= 12; x += 1) {
      for (let z = -5; z <= 5; z += 1) {
        if (x >= 4 && x <= 5 && z >= -3 && z <= 3) continue;
        setBlock(arena.bot, 'stone', x, 23, z);
      }
    }
    for (let x = 4; x <= 5; x += 1) {
      for (let z = -3; z <= 3; z += 1) setBlock(arena.bot, 'stone', x, 2, z);
    }

    const movements = (arena.bot.pathfinder as unknown as { readonly movements: Movements }).movements;
    assert.equal(movements.maxDropDown, 4);
    const surfaceRoute = search(arena.bot, { x: 0, y: 24, z: 0 }, { x: 8, y: 24, z: 0 });
    assert.equal(surfaceRoute.status, 'success');
    assert.ok(surfaceRoute.path.some((node) => node.x >= 4 && node.x <= 5 && Math.abs(node.z) >= 4));
    assert.ok(surfaceRoute.path.every((node) => node.y >= 24));

    const pitExit = search(arena.bot, { x: 4, y: 3, z: 0 }, { x: 8, y: 24, z: 0 });
    assert.equal(pitExit.status, 'noPath');
  } finally {
    void arena.close();
  }
});
