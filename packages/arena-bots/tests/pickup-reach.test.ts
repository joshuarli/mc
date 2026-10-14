import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { PickupReachGoal, withinPickupReach } from '../src/pickup-reach.js';

const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const { goals, Movements } = packageRequire('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');
const AStar = packageRequire('mineflayer-pathfinder/lib/astar') as new (
  start: unknown,
  movements: unknown,
  goal: unknown,
  timeoutMs: number,
  tickTimeoutMs: number,
  searchRadius: number,
) => { compute(): { readonly status: string; readonly path: readonly { x: number; y: number; z: number }[] } };
const PathMove = packageRequire('mineflayer-pathfinder/lib/move') as new (
  x: number,
  y: number,
  z: number,
  remainingBlocks: number,
  cost: number,
) => unknown;
const { Vec3 } = mineflayerRequire('vec3') as {
  readonly Vec3: new (x: number, y: number, z: number) => Bot['entity']['position'];
};
const createWorld = mineflayerRequire('prismarine-world') as (version: string) => new (generator: null) => {
  readonly sync: Bot['world'] & {
    setColumn(chunkX: number, chunkZ: number, column: { getBlock(position: { x: number; y: number; z: number }): unknown }): void;
  };
};
const minecraftData = mineflayerRequire('minecraft-data') as (version: string) => {
  readonly blocksByName: Record<string, { readonly defaultState: number }>;
};
const createBlock = mineflayerRequire('prismarine-block') as (registry: unknown) => {
  fromStateId(stateId: number, biomeId: number): unknown;
};

function trunkWorld(): Bot {
  const registry = minecraftData('26.1.2');
  const blocks = createBlock(registry);
  const world = new (createWorld('26.1.2'))(null);
  const trunk = new Set(['54,66,86', '54,67,86', '54,68,86']);
  for (let chunkX = 0; chunkX <= 5; chunkX += 1) {
    for (let chunkZ = 0; chunkZ <= 8; chunkZ += 1) {
      world.sync.setColumn(chunkX, chunkZ, {
        getBlock: (position) => {
          const x = chunkX * 16 + position.x;
          const z = chunkZ * 16 + position.z;
          const name = position.y <= 64 ? 'stone' : trunk.has(`${x},${position.y},${z}`) ? 'oak_log' : 'air';
          return blocks.fromStateId(registry.blocksByName[name]?.defaultState ?? 0, 0);
        },
      });
    }
  }
  return {
    game: { minY: 0 },
    registry,
    world: world.sync,
    entities: {},
    entity: { position: new Vec3(53.5, 65, 86.5), effects: {} },
    inventory: { items: () => [] },
    blockAt: (position: unknown) => world.sync.getBlock(position as never),
    pathfinder: { bestHarvestTool: () => null },
  } as unknown as Bot;
}

function search(goal: unknown): { status: string; last: { x: number; y: number; z: number } | null } {
  const movements = new Movements(trunkWorld()) as unknown as Record<string, unknown>;
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  const result = new AStar(new PathMove(53, 65, 86, 0, 0), movements, goal, 2_000, 2_000, 16).compute();
  const last = result.path.at(-1);
  return { status: result.status, last: last ?? null };
}

test('pickup reach accepts a standable neighbour of a drop inside a one-block gap', async () => {
  const drop = { x: 54.987, y: 65, z: 86.568 };
  assert.equal(withinPickupReach({ x: 53.5, y: 65, z: 86.5 }, drop), false);
  assert.equal(withinPickupReach({ x: 55.5, y: 65, z: 86.5 }, drop), true);

  const unreachable = search(new goals.GoalNear(54, 65, 86, 0.9));
  assert.notEqual(unreachable.status, 'success');

  const reached = search(new PickupReachGoal(drop));
  assert.equal(reached.status, 'success');
  assert.ok(reached.last);
  assert.equal(withinPickupReach({ x: reached.last.x + 0.5, y: reached.last.y, z: reached.last.z + 0.5 }, drop), true);
});
