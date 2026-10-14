import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  CIVILIZATION_TEAM_MESSAGE_MAX_BYTES,
  blockPosition,
  type CivilizationPolicyContextInput,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { Buffer } from 'node:buffer';
import { MineflayerCivilizationObserver } from '../src/civilization-observer.js';
import { MineflayerObserver } from '../src/observer.js';

const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const loadRegistry = mineflayerRequire('prismarine-registry') as (version: string) => Bot['registry'];
const loadWorld = mineflayerRequire('prismarine-world') as (registry: Bot['registry']) => new (
  generator: null,
) => { readonly sync: PinnedWorld };
const loadChunk = mineflayerRequire('prismarine-chunk') as (registry: Bot['registry']) => new (
  options: { readonly minY: number; readonly worldHeight: number },
) => NonNullable<ReturnType<Bot['world']['getColumn']>>;
const { Vec3 } = mineflayerRequire('vec3') as {
  readonly Vec3: new (x: number, y: number, z: number) => Bot['entity']['position'];
};
const pinnedRegistry = loadRegistry('26.1.2');
const PinnedWorldConstructor = loadWorld(pinnedRegistry);
const PinnedChunkConstructor = loadChunk(pinnedRegistry);

type PinnedWorld = Bot['world'] & {
  unloadColumn(chunkX: number, chunkZ: number): void;
};

test('own materials stay unknown until this client receives a full inventory snapshot', () => {
  const bot = makeBot();
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());

  try {
    assert.equal(observer.observe(0, base.observe(0)).ownMaterials.kind, 'unknown');

    bot.inventory.slots[9] = { name: 'oak_log', type: 10, metadata: 0, count: 4, slot: 9 };
    bot._client.emit('window_items', { windowId: 0 });

    const observation = observer.observe(1, base.observe(1));
    assert.deepEqual(observation.ownMaterials, {
      kind: 'current',
      value: [{ inventorySlot: 9, item: 'oak_log', count: 4 }],
    });
  } finally {
    observer.close();
    base.close();
  }

  assert.equal(bot._client.listenerCount('window_items'), 0);
  assert.equal(bot.listenerCount('windowClose'), 0);
  assert.equal(bot.listenerCount('respawn'), 0);
  assert.equal(bot.listenerCount('end'), 0);
});

test('own material knowledge becomes stale across respawn until a new full snapshot', () => {
  const bot = makeBot();
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());

  try {
    bot.inventory.slots[9] = { name: 'oak_log', type: 10, metadata: 0, count: 4, slot: 9 };
    bot._client.emit('window_items', { windowId: 0 });
    const current = observer.observe(1, base.observe(1));
    assert.equal(current.ownMaterials.kind, 'current');

    bot.emit('respawn');
    assert.deepEqual(observer.observe(2, base.observe(2)).ownMaterials, {
      kind: 'stale',
      value: [{ inventorySlot: 9, item: 'oak_log', count: 4 }],
      observedAt: 1,
    });
  } finally {
    observer.close();
    base.close();
  }
});

test('team reports use authenticated same-faction seats and remain separate from local resources', () => {
  const bot = makeBot();
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());

  try {
    assert.throws(
      () => observer.receiveTeamReport(3, report(0), 0),
      /not an eligible teammate/,
    );
    observer.receiveTeamReport(1, report(0), 0);

    const observation = observer.observe(1, base.observe(1));
    assert.equal(observation.teamMessages.length, 1);
    assert.equal(observation.teamMessages[0]?.sender, 1);
    assert.deepEqual(observation.observedResources, { kind: 'unknown' });
  } finally {
    observer.close();
    base.close();
  }
});

test('team reports reject stale, future, malformed, over-rate, and over-capacity inputs', () => {
  const atTick = (currentTick: number, callback: (observer: MineflayerCivilizationObserver) => void) => {
    const bot = makeBot();
    const base = new MineflayerObserver(bot as unknown as Bot);
    const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());
    try {
      callback(observer);
      return observer.observe(currentTick, base.observe(currentTick));
    } finally {
      observer.close();
      base.close();
    }
  };

  assert.throws(() => atTick(1, (observer) => observer.receiveTeamReport(1, report(2), 1)), /future tick/);
  assert.throws(() => atTick(201, (observer) => observer.receiveTeamReport(1, report(0), 201)), /older than 200 ticks/);
  assert.throws(() => atTick(0, (observer) => observer.receiveTeamReport(1, { ...report(0), extra: true }, 0)), /unknown fields/);
  assert.throws(() => atTick(0, (observer) => observer.receiveTeamReport(1, { ...report(0), resource: 'diamonds' }, 0)), /unknown civilization reported resource/);

  const ageBoundary = atTick(200, (observer) => {
    observer.receiveTeamReport(1, {
      ...report(0),
      position: blockPosition(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    }, 200);
  });
  assert.equal(ageBoundary.teamMessages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(ageBoundary.teamMessages[0]), 'utf8') <= CIVILIZATION_TEAM_MESSAGE_MAX_BYTES);

  const rateBot = makeBot();
  const rateBase = new MineflayerObserver(rateBot as unknown as Bot);
  const rateObserver = new MineflayerCivilizationObserver(rateBot as unknown as Bot, context(), publicRoster());
  try {
    rateObserver.receiveTeamReport(1, report(0), 20);
    assert.throws(() => rateObserver.receiveTeamReport(1, report(20), 20), /20-tick interval/);
    rateObserver.receiveTeamReport(1, report(20), 40);
    assert.equal(rateObserver.observe(40, rateBase.observe(40)).teamMessages.length, 2);
  } finally {
    rateObserver.close();
    rateBase.close();
  }

  const queueBot = makeBot();
  const queueBase = new MineflayerObserver(queueBot as unknown as Bot);
  const queueObserver = new MineflayerCivilizationObserver(queueBot as unknown as Bot, context(), publicRoster());
  try {
    for (let currentTick = 0; currentTick < 160; currentTick += 20) {
      queueObserver.receiveTeamReport(1, report(currentTick), currentTick);
      queueObserver.receiveTeamReport(2, report(currentTick), currentTick);
    }
    assert.throws(() => queueObserver.receiveTeamReport(1, report(160), 160), /queue is full/);
    assert.equal(queueObserver.observe(160, queueBase.observe(160)).teamMessages.length, 16);
  } finally {
    queueObserver.close();
    queueBase.close();
  }
});

test('civilization observations exclude rostered teammates and retain rostered enemies', () => {
  const bot = makeBot(true);
  const teammate = { id: 2, type: 'player', position: vector(0, 64, -2), yaw: 0, pitch: 0, height: 1.8, width: 0.6, velocity: { x: 0, y: 0, z: 0 }, getDroppedItem: () => null };
  const enemy = { id: 3, type: 'player', position: vector(1, 64, -2), yaw: 0, pitch: 0, height: 1.8, width: 0.6, velocity: { x: 0, y: 0, z: 0 }, getDroppedItem: () => null };
  const roster = publicRoster();
  Object.assign(bot, {
    entity: {
      id: 1,
      position: vector(0, 64, 0),
      yaw: 0,
      pitch: 0,
      eyeHeight: 1.62,
      height: 1.8, width: 0.6, velocity: { x: 0, y: 0, z: 0 },
    },
    entities: { 2: teammate, 3: enemy },
    players: {
      [roster[1]?.username ?? '']: {
        username: roster[1]?.username,
        uuid: roster[1]?.offlineUuid,
        gamemode: 0,
        entity: teammate,
      },
      [roster[3]?.username ?? '']: {
        username: roster[3]?.username,
        uuid: roster[3]?.offlineUuid,
        gamemode: 0,
        entity: enemy,
      },
    },
    registry: pinnedRegistry,
    findBlocks: () => [],
  });
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), roster);
  bot.emit('spawn');

  try {
    const baseObservation = base.observe(1);
    assert.deepEqual(baseObservation.opponents.kind, 'current');
    if (baseObservation.opponents.kind !== 'current') return;
    assert.deepEqual(baseObservation.opponents.value.map((opponent) => opponent.id), [2, 3]);

    const observation = observer.observe(1, baseObservation);
    assert.equal(observation.base.opponents.kind, 'current');
    if (observation.base.opponents.kind !== 'current') return;
    assert.deepEqual(observation.base.opponents.value.map((opponent) => opponent.id), [3]);
  } finally {
    observer.close();
    base.close();
  }
});

test('civilization observations include item drops reported as other entities', () => {
  const bot = makeBot(true);
  const droppedLog = {
    id: 4,
    type: 'other',
    name: 'item',
    position: vector(0, 64, -2),
    height: 0.25,
    getDroppedItem: () => ({ name: 'oak_log', type: 10, metadata: 0, count: 1, slot: 0, stackSize: 64 }),
  };
  Object.assign(bot, {
    entity: { id: 1, position: vector(0, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, velocity: { x: 0, y: 0, z: 0 } },
    entities: { 4: droppedLog },
    registry: pinnedRegistry,
    findBlocks: () => [],
  });
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());
  bot.emit('spawn');

  try {
    const observation = observer.observe(1, base.observe(1));
    assert.equal(observation.observedResources.kind, 'current');
    if (observation.observedResources.kind !== 'current') return;
    assert.deepEqual(observation.observedResources.value.filter(({ kind }) => kind === 'materialDrop'), [{
      kind: 'materialDrop', entityId: 4, position: { x: 0, y: 64, z: -2 }, item: 'oak_log',
    }]);
  } finally {
    observer.close();
    base.close();
  }
});

test('unloaded outpost cells are omitted instead of reported as air', () => {
  const bot = makeBot();
  bot.unloadColumn(0, 0);
  Object.assign(bot, {
    entity: { id: 1, position: vector(0, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, velocity: { x: 0, y: 0, z: 0 } },
    registry: pinnedRegistry,
    entities: {},
    findBlocks: () => [],
  });
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());

  try {
    const observation = observer.observe(1, base.observe(1));
    assert.deepEqual(observation.observedResources, { kind: 'current', value: [] });
  } finally {
    observer.close();
    base.close();
  }
});

test('container contents become current only for this client’s synchronized open window', () => {
  const bot = makeBot();
  const chestPosition = blockPosition(1, 64, 0);
  bot.setBlock(vector(1, 64, 0), 'chest');
  const chestWindow = {
    id: 1,
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: Array.from({ length: 63 }, () => null) as (null | { name: string; type: number; metadata: number; count: number; slot: number })[],
    withdraw: () => Promise.resolve(),
  };
  chestWindow.slots[4] = { name: 'oak_planks', type: 11, metadata: 0, count: 16, slot: 4 };
  Object.assign(bot, {
    entity: {
      id: 1,
      position: vector(0, 64, 0),
      yaw: -Math.PI / 2,
      pitch: -0.2,
      eyeHeight: 1.62,
      height: 1.8, width: 0.6, velocity: { x: 0, y: 0, z: 0 },
    },
    registry: pinnedRegistry,
    entities: {},
    findBlocks: ({ matching }: { matching: number }) => matching === pinnedRegistry.blocksByName.chest!.id ? [vector(1, 64, 0)] : [],
  });
  const base = new MineflayerObserver(bot as unknown as Bot);
  const observer = new MineflayerCivilizationObserver(bot as unknown as Bot, context(), publicRoster());

  try {
    const unopened = observer.observe(1, base.observe(1));
    const unopenedChest = resourceContainer(unopened.observedResources);
    assert.equal(unopenedChest.contents.kind, 'unknown');

    bot.currentWindow = chestWindow;
    observer.markContainerOpened(chestPosition, chestWindow as never);
    const opened = observer.observe(2, base.observe(2));
    const openedChest = resourceContainer(opened.observedResources);
    assert.deepEqual(openedChest.contents, {
      kind: 'current',
      value: [{ slot: 4, item: 'oak_planks', count: 16 }],
    });
  } finally {
    observer.close();
    base.close();
  }
});

function context(): CivilizationPolicyContextInput {
  return {
    seat: 0,
    faction: 'ember',
    role: 'gatherer_crafter',
    objective: {
      captureBox: { min: blockPosition(0, 63, 0), max: blockPosition(8, 70, 8) },
      outpost: {
        blueprintId: 'oak-outpost-v1',
        anchor: blockPosition(0, 64, 0),
        rotationDegrees: 0,
      },
    },
  };
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

function publicRoster() {
  return Array.from({ length: 6 }, (_, seat) => ({
    seat,
    username: `ArenaBot${seat}`,
    offlineUuid: `00000000-0000-3000-8000-${String(seat + 1).padStart(12, '0')}`,
  }));
}

function makeBot(fullView = false): EventEmitter & {
  readonly _client: EventEmitter;
  readonly inventory: { readonly slots: (null | { name: string; type: number; metadata: number; count: number; slot: number })[] };
  readonly world: PinnedWorld;
  setBlock(position: Bot['entity']['position'], name: string): void;
  unloadColumn(chunkX: number, chunkZ: number): void;
  currentWindow: unknown;
} {
  const bot = new EventEmitter() as EventEmitter & {
    _client: EventEmitter;
    inventory: { slots: (null | { name: string; type: number; metadata: number; count: number; slot: number })[] };
    world: PinnedWorld;
    setBlock(position: Bot['entity']['position'], name: string): void;
    unloadColumn(chunkX: number, chunkZ: number): void;
    currentWindow: unknown;
  };
  const world = new PinnedWorldConstructor(null).sync;
  const minimumChunk = fullView ? -3 : -1;
  const maximumChunk = fullView ? 2 : 0;
  for (let chunkX = minimumChunk; chunkX <= maximumChunk; chunkX += 1) {
    for (let chunkZ = minimumChunk; chunkZ <= maximumChunk; chunkZ += 1) {
      world.setColumn(chunkX, chunkZ, new PinnedChunkConstructor({ minY: -64, worldHeight: 384 }));
    }
  }
  bot._client = new EventEmitter();
  bot.inventory = { slots: Array.from({ length: 46 }, () => null) };
  Object.assign(bot, {
    username: 'ArenaBot0',
    player: { uuid: publicRoster()[0]?.offlineUuid },
    players: {},
    entities: {},
    world,
    game: { minY: -64, height: 384 },
    registry: pinnedRegistry,
    findBlocks: () => [],
    blockAt: (position: Bot['entity']['position']) => world.getBlock(position),
  });
  bot.currentWindow = null;
  bot.setBlock = (position, name) => {
    const state = pinnedRegistry.blocksByName[name]?.defaultState;
    if (state === undefined) throw new Error(`pinned registry has no ${name} block state`);
    world.setBlockStateId(position, state);
  };
  bot.unloadColumn = (chunkX, chunkZ) => world.unloadColumn(chunkX, chunkZ);
  return bot;
}

function vector(x: number, y: number, z: number): Bot['entity']['position'] {
  return new Vec3(x, y, z);
}

function resourceContainer(resources: { readonly kind: string; readonly value?: readonly unknown[] }): {
  readonly contents: { readonly kind: string; readonly value?: readonly unknown[] };
} {
  assert.equal(resources.kind, 'current');
  const container = resources.value?.find((resource) =>
    typeof resource === 'object' && resource !== null && 'kind' in resource && resource.kind === 'container',
  ) as { readonly contents?: { readonly kind: string; readonly value?: readonly unknown[] } } | undefined;
  assert.ok(container?.contents);
  return { contents: container.contents };
}
