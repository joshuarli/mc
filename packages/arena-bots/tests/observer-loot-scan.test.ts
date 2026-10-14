import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  decide,
  DeterministicRandom,
  emptyPolicyMemory,
  PolicyParams,
  RandomStream,
  seatId,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { MineflayerObserver } from '../src/observer.js';

const require = createRequire(import.meta.url);
const pinned = createRequire(require.resolve('mineflayer'));
const registry = pinned('prismarine-registry')('26.1.2') as Bot['registry'];
const Chunk = pinned('prismarine-chunk')(registry) as new (options: { minY: number; worldHeight: number }) => NonNullable<ReturnType<Bot['world']['getColumn']>>;
const World = pinned('prismarine-world')(registry) as new (generator: null) => { sync: Bot['world'] };
const Vec3 = pinned('vec3').Vec3 as new (x: number, y: number, z: number) => Bot['entity']['position'];
const injectBlocks = pinned('mineflayer/lib/plugins/blocks') as (bot: Bot, options: { version: string; hideErrors: boolean }) => void;
const injectHealth = pinned('mineflayer/lib/plugins/health') as (bot: Bot, options: { respawn: boolean }) => void;

function clientWorld(position = new Vec3(8, 1, 8), height = 16, minY = 0): {
  readonly bot: Bot;
  readonly observer: MineflayerObserver;
  reads(): number;
  resetReads(): void;
} {
  const world = new World(null).sync;
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), registry, version: '26.1.2',
    supportFeature: registry.supportFeature.bind(registry),
    game: { minY, height }, world,
    entity: { id: 1, position, eyeHeight: 1.62, height: 1.8, yaw: 0, pitch: 0 },
    entities: {}, players: {}, health: 20, food: 20, heldItem: null,
    inventory: { slots: [], inventoryStart: 0, inventoryEnd: 0 },
    getEquipmentDestSlot: () => 0,
  }) as unknown as Bot;
  injectBlocks(bot, { version: bot.version, hideErrors: false });
  const centerX = Math.floor(position.x / 16);
  const centerZ = Math.floor(position.z / 16);
  for (let x = centerX - 3; x <= centerX + 3; x += 1) {
    for (let z = centerZ - 3; z <= centerZ + 3; z += 1) {
      world.setColumn(x, z, new Chunk({ minY, worldHeight: height }));
    }
  }
  let reads = 0;
  const getBlock = world.getBlock.bind(world);
  world.getBlock = (point) => { reads += 1; return getBlock(point); };
  const observer = new MineflayerObserver(bot);
  bot.emit('spawn');
  bot.emit('health');
  bot._client.emit('window_items', { windowId: 0 });
  return { bot, observer, reads: () => reads, resetReads: () => { reads = 0; } };
}

test('observer converts native fractional health to half-hearts without going stale', () => {
  const client = clientWorld();
  try {
    client.bot._client.write = () => undefined;
    injectHealth(client.bot, { respawn: false });
    client.bot._client.emit('update_health', { health: 0.98, food: 20, foodSaturation: 5 });
    const damaged = client.observer.observe(1).agent;
    if (damaged.kind !== 'current') throw new Error('fractional native health should remain current');
    assert.equal(damaged.value.healthHalfHearts, 1);

    client.bot._client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 });
    const full = client.observer.observe(2).agent;
    if (full.kind !== 'current') throw new Error('native full health should remain current');
    assert.equal(full.value.healthHalfHearts, 20);
  } finally {
    client.observer.close();
  }
});

test('observer keeps zero health at zero and rounds positive fractional health upward', () => {
  const client = clientWorld();
  try {
    client.bot._client.write = () => undefined;
    injectHealth(client.bot, { respawn: false });
    for (const [tick, health, expected] of [[0, 0, 0], [1, 0.01, 1], [2, 0.98, 1], [3, 1.25, 2]] as const) {
      client.bot._client.emit('update_health', { health, food: 20, foodSaturation: 5 });
      const agent = client.observer.observe(tick).agent;
      if (agent.kind !== 'current') throw new Error(`native health ${health} should remain current`);
      assert.equal(agent.value.healthHalfHearts, expected);
    }
  } finally {
    client.observer.close();
  }
});

test('observer quantization preserves every integer policy health threshold', () => {
  const client = clientWorld();
  try {
    client.bot._client.write = () => undefined;
    client.bot.entity.yaw = Math.PI;
    injectHealth(client.bot, { respawn: false });
    client.bot._client.emit('initialize_world_border', {
      x: 8, z: 8, oldDiameter: 100, newDiameter: 100, speed: 0,
    });
    const opponent = Object.assign(new EventEmitter(), {
      id: 2,
      type: 'player',
      position: new Vec3(8, 1, 10),
      height: 1.8,
      getDroppedItem: () => null,
    }) as unknown as Bot['entity'];
    Object.assign(client.bot.entities, { 2: opponent });
    Object.assign(client.bot.players, { Rival: { entity: opponent, gamemode: 0 } });

    let tick = 0;
    for (let threshold = 1; threshold < 40; threshold += 1) {
      const params = PolicyParams.create({
        ...PolicyParams.baseline().values,
        retreatAtHealthHalfHeartsOrBelow: threshold,
      });
      for (const { health, shouldRetreat } of [
        { health: threshold - 0.25, shouldRetreat: true },
        { health: threshold, shouldRetreat: true },
        { health: threshold + 0.25, shouldRetreat: false },
      ]) {
        client.bot._client.emit('update_health', { health, food: 20, foodSaturation: 5 });
        const observation = client.observer.observe(tick);
        tick += 1;
        if (observation.agent.kind !== 'current') throw new Error(`health ${health} should remain current`);
        assert.equal(observation.agent.value.healthHalfHearts, Math.ceil(health));
        if (observation.opponents.kind !== 'current' || observation.opponents.value.length !== 1) {
          throw new Error('the policy fixture requires one currently visible opponent');
        }
        const decision = decide(
          observation,
          emptyPolicyMemory(),
          params,
          DeterministicRandom.forStream(1n, RandomStream.search(seatId(0))),
        );
        assert.equal(
          decision.goal.kind,
          shouldRetreat ? 'retreatFromOpponent' : 'engageVisibleOpponent',
          `threshold ${threshold}, health ${health}`,
        );
      }
    }
  } finally {
    client.observer.close();
  }
});

test('observer includes item drops reported as other entities', () => {
  const client = clientWorld();
  const droppedApple = Object.assign(new EventEmitter(), {
    id: 3,
    type: 'other',
    name: 'item',
    position: new Vec3(8, 1, 6),
    height: 0.25,
    getDroppedItem: () => ({ name: 'apple', type: 1, metadata: 0, count: 1, slot: 0, stackSize: 64 }),
  }) as unknown as Bot['entity'];
  Object.assign(client.bot.entities, { 3: droppedApple });

  try {
    assert.deepEqual(client.observer.observe(0).loot, {
      kind: 'current',
      value: [{ kind: 'visibleDrop', entityId: 3, position: { x: 8, y: 1, z: 6 }, item: { kind: 'food' } }],
    });
  } finally {
    client.observer.close();
  }
});

test('observer rejects negative health before quantizing and keeps the core upper bound', () => {
  const client = clientWorld();
  try {
    client.bot._client.write = () => undefined;
    injectHealth(client.bot, { respawn: false });
    client.bot._client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 });
    const full = client.observer.observe(0).agent;
    if (full.kind !== 'current') throw new Error('native full health should remain current');

    client.bot._client.emit('update_health', { health: -0.1, food: 20, foodSaturation: 5 });
    assert.throws(() => client.observer.observe(1), RangeError);

    client.bot._client.emit('update_health', { health: 40.1, food: 20, foodSaturation: 5 });
    assert.throws(() => client.observer.observe(2), /health must be between 0 and 40 half-hearts/);
  } finally {
    client.observer.close();
  }
});

test('observer skips uniform air sections without changing current empty loot knowledge', () => {
  const client = clientWorld();
  try {
    const observation = client.observer.observe(0);
    assert.deepEqual(observation.loot, { kind: 'current', value: [] });
    assert.equal(client.reads(), 0, 'uniform air sections must not construct blocks for chest search');
    client.bot.world.setBlockStateId(new Vec3(8, 1, 8), registry.blocksByName.air!.minStateId);
    client.resetReads();
    assert.deepEqual(client.observer.observe(1).loot, observation.loot);
    assert.equal(client.reads(), 0, 'writing the same single value must refresh derived metadata');
  } finally {
    client.observer.close();
  }
});

function worldSnapshot(bot: Bot): unknown {
  return bot.world.getColumns().map(({ column }) => ({
    json: column.toJson(),
    bytes: (column as unknown as { dump(): Buffer }).dump(),
  }));
}

function nativeChests(bot: Bot, count = 65): string[] {
  return bot.findBlocks({
    point: bot.entity.position,
    matching: [registry.blocksByName.chest!.id, registry.blocksByName.trapped_chest!.id],
    maxDistance: 40,
    count,
  }).map((position) => position.toString());
}

test('observer preserves native chest ordering, range, trap chests, and candidate overflow', () => {
  const client = clientWorld();
  try {
    for (let index = 0; index < 70; index += 1) {
      const position = new Vec3(index % 16, 1, Math.floor(index / 16));
      const chest = index % 2 === 0 ? registry.blocksByName.chest! : registry.blocksByName.trapped_chest!;
      client.bot.world.setBlockStateId(position, chest.minStateId);
    }
    client.bot.world.setBlockStateId(new Vec3(48, 1, 8), registry.blocksByName.chest!.minStateId);
    client.bot.world.setBlockStateId(new Vec3(49, 1, 8), registry.blocksByName.trapped_chest!.minStateId);
    const reference = nativeChests(client.bot);
    assert.equal(reference.length, 65);
    const allReference = nativeChests(client.bot, 100);
    assert.ok(allReference.includes('(48, 1, 8)'), 'exact range boundary must be retained');
    assert.ok(!allReference.includes('(49, 1, 8)'), 'outside range must be excluded');
    assert.equal(client.observer.observe(0).loot.kind, 'unknown', '65 candidates must preserve incomplete loot knowledge');
    assert.deepEqual(nativeChests(client.bot), reference);
    assert.deepEqual(nativeChests(client.bot, 100), allReference);
  } finally {
    client.observer.close();
  }
});

test('observer handles single-value solid and chest sections without suppressing matches', () => {
  for (const name of ['stone', 'chest', 'trapped_chest'] as const) {
    const client = clientWorld();
    try {
      const column = client.bot.world.getColumn(0, 0)! as unknown as { sections: object[] };
      const section = column.sections[0]!;
      const Section = section.constructor as new (options: { singleValue: number }) => typeof section;
      column.sections[0] = new Section({ singleValue: registry.blocksByName[name]!.minStateId });
      const reference = nativeChests(client.bot);
      const worldBefore = worldSnapshot(client.bot);
      client.resetReads();
      const observation = client.observer.observe(0);
      if (name === 'stone') {
        assert.deepEqual(observation.loot, { kind: 'current', value: [] });
        assert.equal(client.reads(), 0, 'uniform nonchest sections must also skip block construction');
      } else {
        assert.equal(observation.loot.kind, 'unknown');
        assert.equal(reference.length, 65);
      }
      assert.deepEqual(nativeChests(client.bot), reference);
      assert.deepEqual(worldSnapshot(client.bot), worldBefore, 'derived palettes must not change chunk bytes or block state');
    } finally {
      client.observer.close();
    }
  }
});

test('observer preserves negative-height native discovery at the recorded six-seat positions', () => {
  const positions = [[64, 65, 41], [84, 65, 52], [84, 65, 76], [64, 65, 88], [44, 65, 76], [44, 65, 52]] as const;
  for (const [x, y, z] of positions) {
    const client = clientWorld(new Vec3(x, y, z), 384, -64);
    try {
      for (const [chestX, chestZ] of [[62, 62], [66, 62], [62, 66], [66, 66], [58, 64]]) {
        const chest = chestX === 58 ? registry.blocksByName.trapped_chest! : registry.blocksByName.chest!;
        client.bot.world.setBlockStateId(new Vec3(chestX!, 65, chestZ!), chest.minStateId);
      }
      const reference = nativeChests(client.bot);
      assert.equal(reference.length, 5);
      const originalReadCount = client.reads();
      const worldBefore = worldSnapshot(client.bot);
      client.observer.observe(0);
      client.resetReads();
      assert.deepEqual(nativeChests(client.bot), reference);
      assert.equal(client.reads(), 4 * 4096, 'native scans must construct blocks only in mixed chest-bearing sections');
      assert.ok(originalReadCount > client.reads(), 'the fixture must exercise uniform-air scanning in the original finder');
      assert.deepEqual(worldSnapshot(client.bot), worldBefore);
    } finally {
      client.observer.close();
    }
  }
});

test('observer discovers chest blocks below zero without changing native state reads', () => {
  const client = clientWorld(new Vec3(8, -31, 8), 384, -64);
  try {
    const position = new Vec3(8, -31, 6);
    client.bot.world.setBlockStateId(position, registry.blocksByName.trapped_chest!.minStateId);
    const stateBefore = client.bot.world.getBlockStateId(position);
    const reference = nativeChests(client.bot);
    const worldBefore = worldSnapshot(client.bot);
    assert.deepEqual(client.observer.observe(0).loot, {
      kind: 'current', value: [{ kind: 'unopenedContainer', position: { x: 8, y: -31, z: 6 } }],
    });
    assert.deepEqual(nativeChests(client.bot), reference);
    assert.equal(client.bot.world.getBlockStateId(position), stateBefore);
    assert.deepEqual(worldSnapshot(client.bot), worldBefore);
  } finally {
    client.observer.close();
  }
});

test('observer refreshes section metadata after placement, mining, and palette promotion', () => {
  const client = clientWorld();
  const chestPosition = new Vec3(8, 1, 6);
  try {
    client.observer.observe(0);
    client.bot.world.setBlockStateId(chestPosition, registry.blocksByName.chest!.minStateId);
    const chestReference = nativeChests(client.bot);
    const placed = client.observer.observe(1);
    assert.deepEqual(placed.loot, {
      kind: 'current', value: [{ kind: 'unopenedContainer', position: { x: 8, y: 1, z: 6 } }],
    });
    assert.deepEqual(nativeChests(client.bot), chestReference);
    client.bot.world.setBlockStateId(chestPosition, registry.blocksByName.air!.minStateId);
    assert.deepEqual(client.observer.observe(2).loot, { kind: 'current', value: [] });
    assert.deepEqual(nativeChests(client.bot), []);
    client.bot.world.setBlockStateId(chestPosition, registry.blocksByName.trapped_chest!.minStateId);
    assert.deepEqual(client.observer.observe(3).loot, placed.loot);
    assert.deepEqual(nativeChests(client.bot), [chestPosition.toString()]);
  } finally {
    client.observer.close();
  }
});

test('observer preserves missing-chunk knowledge and observes newly loaded section objects', () => {
  const client = clientWorld();
  try {
    client.observer.observe(0);
    client.bot.world.unloadColumn(0, 0);
    assert.deepEqual(client.observer.observe(1).loot, { kind: 'stale', value: [], observedAt: 0 });
    const replacement = new Chunk({ minY: 0, worldHeight: 16 });
    replacement.setBlockStateId(new Vec3(8, 1, 6), registry.blocksByName.chest!.minStateId);
    client.bot.world.setColumn(0, 0, replacement);
    const reference = nativeChests(client.bot);
    const reloaded = client.observer.observe(2);
    assert.deepEqual(reloaded.loot, {
      kind: 'current', value: [{ kind: 'unopenedContainer', position: { x: 8, y: 1, z: 6 } }],
    });
    assert.deepEqual(nativeChests(client.bot), reference);
  } finally {
    client.observer.close();
  }
});
