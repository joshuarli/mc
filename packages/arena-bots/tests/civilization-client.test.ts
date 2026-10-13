import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  blockPosition,
  civilizationProfileForSeat,
  type CivilizationPolicyContextInput,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import {
  createMineflayerCivilizationClient,
  type CivilizationRosterMember,
} from '../src/index.js';

const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const loadMinecraftData = mineflayerRequire('minecraft-data') as (version: string) => {
  readonly version: { readonly version: number };
  readonly blocksByName: Readonly<Record<string, { readonly id: number; readonly defaultState: number }>>;
  supportFeature(feature: string): boolean;
};
const loadPrismarineBlock = mineflayerRequire('prismarine-block') as (registry: unknown) => {
  fromStateId(stateId: number, biomeId: number): NonNullable<ReturnType<Bot['blockAt']>>;
};
const loadPrismarineWorld = mineflayerRequire('prismarine-world') as (version: string) => new (
  generator: null,
) => { readonly sync: PinnedWorld };
const { Vec3 } = mineflayerRequire('vec3') as {
  readonly Vec3: new (x: number, y: number, z: number) => Bot['entity']['position'];
};
const worldRegistry = loadMinecraftData('26.1.2');
const worldBlockFactory = loadPrismarineBlock(worldRegistry);
const PinnedWorldConstructor = loadPrismarineWorld('26.1.2');

interface PinnedWorld extends Bot['world'] {
  setColumn(
    chunkX: number,
    chunkZ: number,
    column: { getBlock(position: Bot['entity']['position']): NonNullable<ReturnType<Bot['blockAt']>> },
  ): void;
}

test('client waits for a received full inventory snapshot and validates reports at their shared tick', async () => {
  const bot = makeBot(0);
  bot.inventory.slots[9] = { name: 'oak_log', type: 10, metadata: 0, count: 4, slot: 9 } as never;
  const client = createMineflayerCivilizationClient(bot as unknown as Bot, options(0));

  try {
    assert.equal(client.observe(0).ownMaterials.kind, 'unknown');

    assert.throws(
      () => client.receiveTeamReport({
        authenticatedSenderSeat: 1,
        decodedReport: report(1),
        currentTick: 0,
      }),
      /future tick/,
    );
    client.receiveTeamReport({
      authenticatedSenderSeat: 1,
      decodedReport: report(0),
      currentTick: 0,
    });

    emitInventorySnapshot(bot);
    const observation = client.observe(0);
    assert.deepEqual(observation.ownMaterials, {
      kind: 'current',
      value: [{ inventorySlot: 9, item: 'oak_log', count: 4 }],
    });
    assert.equal(observation.base.tick, 0);
    assert.deepEqual(observation.teamMessages.map(({ sender }) => sender), [1]);

    bot.emit('respawn');
    assert.deepEqual(client.observe(1).ownMaterials, {
      kind: 'stale',
      value: [{ inventorySlot: 9, item: 'oak_log', count: 4 }],
      observedAt: 0,
    });
  } finally {
    await client.close();
  }
});

test('clients keep inventory snapshots and teammate reports within their own observer', async () => {
  const firstBot = makeBot(0);
  const secondBot = makeBot(1);
  firstBot.inventory.slots[9] = { name: 'oak_log', type: 10, metadata: 0, count: 3, slot: 9 } as never;
  secondBot.inventory.slots[10] = { name: 'oak_planks', type: 11, metadata: 0, count: 16, slot: 10 } as never;
  const first = createMineflayerCivilizationClient(firstBot as unknown as Bot, options(0));
  const second = createMineflayerCivilizationClient(secondBot as unknown as Bot, options(1));

  try {
    first.receiveTeamReport({
      authenticatedSenderSeat: 1,
      decodedReport: report(0),
      currentTick: 0,
    });
    emitInventorySnapshot(firstBot);
    emitInventorySnapshot(secondBot);

    const firstObservation = first.observe(0);
    const secondObservation = second.observe(0);
    assert.deepEqual(firstObservation.ownMaterials, {
      kind: 'current',
      value: [{ inventorySlot: 9, item: 'oak_log', count: 3 }],
    });
    assert.deepEqual(secondObservation.ownMaterials, {
      kind: 'current',
      value: [{ inventorySlot: 10, item: 'oak_planks', count: 16 }],
    });
    assert.equal(firstObservation.teamMessages.length, 1);
    assert.deepEqual(secondObservation.teamMessages, []);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('invalid civilization context unwinds the already-created base observer', () => {
  const bot = makeBot(0);
  const valid = options(0);

  assert.throws(() => createMineflayerCivilizationClient(bot as unknown as Bot, {
    ...valid,
    context: { ...valid.context, faction: 'tide' },
  }), /does not match its canonical seat profile/);

  assert.equal(bot.listenerCount('spawn'), 0);
  assert.equal(bot.listenerCount('health'), 0);
  assert.equal(bot.listenerCount('respawn'), 0);
  assert.equal(bot.listenerCount('end'), 0);
  assert.equal(bot.listenerCount('blockUpdate'), 0);
  assert.equal(bot.listenerCount('entityHurt'), 0);
  assert.equal(bot._client.listenerCount('window_items'), 0);
  assert.equal(bot._client.listenerCount('initialize_world_border'), 0);
});

test('client preserves protocol 775 setup, exact block navigation, and only releases owned listeners', async () => {
  const bot = makeBot(0);
  const baseSupportFeature = bot.supportFeature;
  const nativeStateIdUsed = baseSupportFeature('stateIdUsed');
  const externalHealthListener = () => undefined;
  const externalSnapshotListener = () => undefined;
  bot.on('health', externalHealthListener);
  bot._client.on('window_items', externalSnapshotListener);
  const client = createMineflayerCivilizationClient(bot as unknown as Bot, options(0));

  try {
    assert.equal(bot.physics.playerHalfWidth, Math.fround(0.6) / 2);
    assert.equal(bot.supportFeature('entityActionUsesStringMapper'), true);
    assert.equal(bot.supportFeature('stateIdUsed'), nativeStateIdUsed);

    bot._client.emit('initialize_world_border', {
      x: 0,
      z: 0,
      oldDiameter: 100,
      newDiameter: 100,
      speed: 0,
    });
    assert.deepEqual(await client.run({
      kind: 'navigateToBlock',
      target: blockPosition(0, 64, 0),
    }), { kind: 'succeeded' });
    await client.cancel('shutdown');
  } finally {
    const close = client.close();
    assert.equal(client.close(), close);
    await close;
  }

  assert.equal(bot.listenerCount('health'), 1);
  assert.equal(bot._client.listenerCount('window_items'), 1);
  assert.equal(bot.listenerCount('spawn'), 0);
  assert.equal(bot.listenerCount('respawn'), 0);
  assert.equal(bot.listenerCount('end'), 0);
  assert.equal(bot.listenerCount('blockUpdate'), 0);
  assert.equal(bot.listenerCount('entityHurt'), 0);
  assert.equal(bot.listenerCount('windowClose'), 0);
  for (const event of [
    'initialize_world_border', 'world_border_center', 'world_border_lerp_size',
    'world_border_size', 'login', 'respawn', 'end',
  ]) {
    assert.equal(bot._client.listenerCount(event), 0);
  }
  bot.removeListener('health', externalHealthListener);
  bot._client.removeListener('window_items', externalSnapshotListener);
});

function makeBot(seat: number) {
  const bot = new EventEmitter() as EventEmitter & {
    _client: EventEmitter;
    inventory: { slots: (null | { name: string; type: number; metadata: number; count: number; slot: number })[] };
    physics: { playerHalfWidth: number };
    supportFeature(feature: string): boolean;
  };
  const client = new EventEmitter();
  const world = makeLocalWorld();
  const pathfinder = {
    goal: null as unknown,
    thinkTimeout: 0,
    tickTimeout: 0,
    searchRadius: -1,
    setMovements: (_movements: unknown) => undefined,
    setGoal: (goal: unknown) => { pathfinder.goal = goal; },
    isMoving: () => false,
    stop: () => { pathfinder.goal = null; },
  };
  const roster = publicRoster();
  const member = roster[seat];
  assert.ok(member);

  Object.assign(bot, {
    _client: client,
    protocolVersion: '775',
    version: '26.1.2',
    username: member.username,
    player: { uuid: member.offlineUuid },
    registry: worldRegistry,
    world,
    inventory: {
      slots: new Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
      items: () => [],
      emptySlotCount: () => 36,
      firstEmptySlotRange: () => null,
    },
    physics: { playerHalfWidth: 0.3 },
    supportFeature: worldRegistry.supportFeature,
    pathfinder,
    health: 20,
    food: 10,
    quickBarSlot: 0,
    currentWindow: null,
    heldItem: null,
    usingHeldItem: false,
    entity: {
      id: seat + 1,
      position: vector(0, 64, 0),
      yaw: 0,
      pitch: 0,
      eyeHeight: 1.62,
      height: 1.8,
    },
    entities: {},
    players: {},
    hasPlugin: () => true,
    setQuickBarSlot: (slot: number) => Object.assign(bot, { quickBarSlot: slot }),
    clearControlStates: () => undefined,
    deactivateItem: () => Object.assign(bot, { usingHeldItem: false }),
    getEquipmentDestSlot: (slot: string) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[slot as 'head' | 'torso' | 'legs' | 'feet'] ?? 0,
    findBlocks: () => [],
    blockAt: (position: Bot['entity']['position']) => world.getBlock(position),
  });
  return bot;
}

function makeLocalWorld(): PinnedWorld {
  const world = new PinnedWorldConstructor(null).sync;
  const blockStates = new Map<string, number>();
  const airState = worldRegistry.blocksByName.air?.defaultState;
  if (airState === undefined) throw new Error('pinned registry has no air block state');
  for (let chunkX = -1; chunkX <= 0; chunkX += 1) {
    for (let chunkZ = -1; chunkZ <= 0; chunkZ += 1) {
      world.setColumn(chunkX, chunkZ, {
        getBlock: (position) => {
          const x = chunkX * 16 + Math.floor(position.x);
          const y = Math.floor(position.y);
          const z = chunkZ * 16 + Math.floor(position.z);
          return worldBlockFactory.fromStateId(blockStates.get(`${x},${y},${z}`) ?? airState, 0);
        },
      });
    }
  }
  return world;
}

function options(seat: number) {
  const profile = civilizationProfileForSeat(seat);
  assert.ok(profile);
  return {
    context: {
      seat: profile.seat,
      faction: profile.faction,
      role: profile.role,
      objective: {
        captureBox: { min: blockPosition(-8, 60, -8), max: blockPosition(8, 70, 8) },
        outpost: { blueprintId: 'oak-outpost-v1', anchor: blockPosition(0, 64, 0), rotationDegrees: 0 },
      },
    } satisfies CivilizationPolicyContextInput,
    publicRoster: publicRoster(),
  };
}

function publicRoster(): CivilizationRosterMember[] {
  return Array.from({ length: 6 }, (_, seat) => ({
    seat,
    username: `ArenaBot${seat}`,
    offlineUuid: `00000000-0000-3000-8000-${String(seat + 1).padStart(12, '0')}`,
  }));
}

function report(sourceTick: number) {
  return {
    sourceTick,
    declaredStale: false,
    kind: 'resourceSighting' as const,
    resource: 'oakLogBlock' as const,
    position: blockPosition(4, 64, 4),
  };
}

function emitInventorySnapshot(bot: ReturnType<typeof makeBot>): void {
  bot._client.emit('window_items', {
    windowId: 0,
    items: bot.inventory.slots.map((item) => item === null ? null : { ...item }),
  });
}

function vector(x: number, y: number, z: number) {
  return new Vec3(x, y, z);
}
