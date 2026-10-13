import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  blockPosition,
  civilizationPolicyContext,
  civilizationPolicyFeedbackBatch,
  decideCivilization,
  DeterministicRandom,
  emptyCivilizationPolicyMemory,
  entityId,
  PolicyParams,
  RandomStream,
  seatId,
  type CivilizationPolicyContextInput,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { MineflayerCivilizationObserver } from '../src/civilization-observer.js';
import { MineflayerObserver } from '../src/observer.js';
import { SkillOwner } from '../src/skills.js';

const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const MINECRAFT_VERSION = '26.1.2';
type MineflayerItem = NonNullable<Bot['inventory']['slots'][number]>;
type MineflayerWindow = NonNullable<Bot['currentWindow']>;

const loadPrismarineRegistry = mineflayerRequire('prismarine-registry') as (version: string) => {
  readonly itemsByName: { readonly oak_planks: { readonly id: number } };
};
const loadPrismarineItem = mineflayerRequire('prismarine-item') as (registry: unknown) => new (
  type: number,
  count: number,
  metadata: number,
  nbt: null,
) => MineflayerItem;
const loadPrismarineWindows = mineflayerRequire('prismarine-windows') as (registry: unknown) => {
  createWindow: (id: number, type: string, title: string) => MineflayerWindow | null;
};
const loadMinecraftData = mineflayerRequire('minecraft-data') as (version: string) => {
  readonly blocksByName: Readonly<Record<string, { readonly defaultState: number }>>;
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
const worldRegistry = loadMinecraftData(MINECRAFT_VERSION);
const worldBlockFactory = loadPrismarineBlock(worldRegistry);
const PinnedWorldConstructor = loadPrismarineWorld(MINECRAFT_VERSION);

type PinnedWorld = Bot['world'] & {
  setColumn(
    chunkX: number,
    chunkZ: number,
    column: { getBlock(position: Bot['entity']['position']): NonNullable<ReturnType<Bot['blockAt']>> },
  ): void;
};

test('craft spends four observed oak logs for sixteen observed oak planks', async () => {
  const harness = makeHarness();
  const logs = item('oak_log', 10, 4, 9);
  harness.inventory.slots[9] = logs;
  Object.assign(harness.bot.registry.itemsByName, { oak_log: { id: 10 }, oak_planks: { id: 11 } });
  Object.assign(harness.bot, {
    recipesFor: () => [{
      result: { id: 11, count: 4 },
      delta: [{ id: 10, count: -1 }, { id: 11, count: 4 }],
    }],
    craft: async (_recipe: unknown, count: number) => {
      assert.equal(count, 4);
      harness.inventory.slots[9] = null;
      harness.inventory.slots[10] = item('oak_planks', 11, 16, 10);
    },
  });

  try {
    assert.deepEqual(await harness.owner.runCivilization({
      kind: 'craft', output: 'oak_planks', resultCount: 16, table: null,
    }), { kind: 'succeeded' });
    assert.equal(harness.inventory.items().filter((stack) => stack.name === 'oak_log').length, 0);
    assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_planks')?.count, 16);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('core residual craft decision spends two oak logs for the remaining eight planks', async () => {
  const harness = makeHarness();
  const logs = item('oak_log', 10, 2, 9);
  const planks = item('oak_planks', 11, 8, 10);
  harness.inventory.slots[9] = logs;
  harness.inventory.slots[10] = planks;
  Object.assign(harness.bot, { food: 20 });
  harness.bot.emit('spawn');
  harness.bot.emit('health');
  harness.bot._client.emit('window_items', { windowId: 0 });
  const recipe = {
    result: { id: 11, count: 4 },
    delta: [{ id: 10, count: -1 }, { id: 11, count: 4 }],
  };
  let craftIterations = 0;
  Object.assign(harness.bot, {
    recipesFor: (_itemType: number, _metadata: null, minimumResultCount: number, craftingTable: null) => {
      assert.equal(minimumResultCount, 8);
      assert.equal(craftingTable, null);
      return [recipe];
    },
    craft: async (_recipe: unknown, count: number) => {
      assert.equal(count, 2);
      for (let index = 0; index < count; index += 1) {
        assert.ok(logs.count > 0);
        logs.count -= 1;
        planks.count += 4;
        craftIterations += 1;
      }
      if (logs.count === 0) harness.inventory.slots[9] = null;
    },
  });

  try {
    const policyContext = civilizationPolicyContext(context());
    const observation = harness.civilization.observe(1, harness.observer.observe(1));
    const decision = decideCivilization(
      policyContext,
      observation,
      emptyCivilizationPolicyMemory(),
      PolicyParams.baseline(),
      DeterministicRandom.forStream(456n, RandomStream.search(seatId(0))),
      civilizationPolicyFeedbackBatch({ shared: [], actions: [] }),
    );
    if (decision.goal.kind !== 'craftMaterial' || decision.intent.kind !== 'craft') {
      throw new Error('two logs and eight planks should produce an eight-plank craft decision');
    }
    assert.deepEqual(decision.goal, { kind: 'craftMaterial', item: 'oak_planks', resultCount: 8 });
    assert.deepEqual(decision.intent, {
      kind: 'craft',
      output: 'oak_planks',
      resultCount: 8,
      table: null,
    });

    assert.deepEqual(await harness.owner.runCivilization(decision.intent), { kind: 'succeeded' });
    assert.equal(craftIterations, 2);
    assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_log')?.count ?? 0, 0);
    assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_planks')?.count, 16);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('craft supports one and three oak log recipe iterations', async () => {
  for (const { resultCount, logsRequired, planksBefore } of [
    { resultCount: 4, logsRequired: 1, planksBefore: 12 },
    { resultCount: 12, logsRequired: 3, planksBefore: 4 },
  ]) {
    const harness = makeHarness();
    const logs = item('oak_log', 10, logsRequired, 9);
    const planks = item('oak_planks', 11, planksBefore, 10);
    harness.inventory.slots[9] = logs;
    harness.inventory.slots[10] = planks;
    let craftIterations = 0;
    Object.assign(harness.bot, {
      recipesFor: (_itemType: number, _metadata: null, minimumResultCount: number, craftingTable: null) => {
        assert.equal(minimumResultCount, resultCount);
        assert.equal(craftingTable, null);
        return [{
          result: { id: 11, count: 4 },
          delta: [{ id: 10, count: -1 }, { id: 11, count: 4 }],
        }];
      },
      craft: async (_recipe: unknown, count: number) => {
        assert.equal(count, logsRequired);
        for (let index = 0; index < count; index += 1) {
          logs.count -= 1;
          planks.count += 4;
          craftIterations += 1;
        }
        harness.inventory.slots[9] = null;
      },
    });

    try {
      assert.deepEqual(await harness.owner.runCivilization({
        kind: 'craft', output: 'oak_planks', resultCount, table: null,
      }), { kind: 'succeeded' });
      assert.equal(craftIterations, logsRequired);
      assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_log')?.count ?? 0, 0);
      assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_planks')?.count, 16);
    } finally {
      await harness.owner.close();
      harness.civilization.close();
      harness.observer.close();
    }
  }
});

test('craft rejects non-recipe-aligned and unbounded result counts before lookup', async () => {
  const harness = makeHarness();
  harness.inventory.slots[9] = item('oak_log', 10, 4, 9);
  let recipeLookups = 0;
  let craftCalls = 0;
  Object.assign(harness.bot, {
    recipesFor: () => { recipeLookups += 1; return []; },
    craft: async () => { craftCalls += 1; },
  });

  try {
    for (const resultCount of [0, 3, 5, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(await harness.owner.runCivilization({
        kind: 'craft', output: 'oak_planks', resultCount, table: null,
      }), { kind: 'failed', cause: 'preconditionsNotMet' });
    }
    assert.equal(recipeLookups, 0);
    assert.equal(craftCalls, 0);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('craft rejects recipes that do not consume exactly one oak log for four planks', async () => {
  const harness = makeHarness();
  harness.inventory.slots[9] = item('oak_log', 10, 1, 9);
  let craftCalls = 0;
  Object.assign(harness.bot, {
    recipesFor: () => [{
      result: { id: 11, count: 4 },
      delta: [{ id: 12, count: -1 }, { id: 11, count: 4 }],
    }],
    craft: async () => { craftCalls += 1; },
  });

  try {
    assert.deepEqual(await harness.owner.runCivilization({
      kind: 'craft', output: 'oak_planks', resultCount: 4, table: null,
    }), { kind: 'failed', cause: 'preconditionsNotMet' });
    assert.equal(craftCalls, 0);
    assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_log')?.count, 1);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('mine succeeds only after the local block update removes the oak log', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, {
    position: new TestVector(0, 63, 0),
    yaw: Math.PI,
    pitch: -Math.PI / 2,
  });
  const logPosition = new TestVector(0, 64, 0);
  harness.setBlock(logPosition, block('oak_log', logPosition));
  let finishDig!: () => void;
  let reportDigStarted!: () => void;
  const digStarted = new Promise<void>((resolve) => { reportDigStarted = resolve; });
  const digSettlement = new Promise<void>((resolve) => { finishDig = resolve; });
  Object.assign(harness.bot, {
    canDigBlock: () => true,
    dig: () => { reportDigStarted(); return digSettlement; },
  });

  try {
    const mining = harness.owner.runCivilization({
      kind: 'mineBlock', position: blockPosition(0, 64, 0), expectedBlock: 'oak_log',
    });
    await waitForDigStart(digStarted, mining);
    let miningSettled = false;
    void mining.then(() => { miningSettled = true; }, () => { miningSettled = true; });
    finishDig();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(miningSettled, false);
    harness.setBlock(logPosition, block('air', logPosition));
    harness.bot.emit('physicsTick');
    assert.deepEqual(await mining, { kind: 'succeeded' });
    assert.equal(harness.blocks.get(key(logPosition))?.name, 'air');
  } finally {
    finishDig();
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('cancelling a pending mining skill stops digging and waits for settlement', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, {
    position: new TestVector(0, 63, 0),
    yaw: Math.PI,
    pitch: -Math.PI / 2,
  });
  const logPosition = new TestVector(0, 64, 0);
  harness.setBlock(logPosition, block('oak_log', logPosition));
  let finishDig!: () => void;
  let reportDigStarted!: () => void;
  let reportStopRequested!: () => void;
  const digStarted = new Promise<void>((resolve) => { reportDigStarted = resolve; });
  const stopRequested = new Promise<void>((resolve) => { reportStopRequested = resolve; });
  const digSettlement = new Promise<void>((resolve) => { finishDig = resolve; });
  Object.assign(harness.bot, {
    canDigBlock: () => true,
    dig: () => { reportDigStarted(); return digSettlement; },
    stopDigging: () => { reportStopRequested(); },
  });

  try {
    const mining = harness.owner.runCivilization({
      kind: 'mineBlock', position: blockPosition(0, 64, 0), expectedBlock: 'oak_log',
    });
    await waitForDigStart(digStarted, mining);
    const cancellation = harness.owner.cancel('shutdown');
    await stopRequested;
    let miningSettled = false;
    void mining.then(() => { miningSettled = true; }, () => { miningSettled = true; });
    let cancellationSettled = false;
    void cancellation.then(() => { cancellationSettled = true; }, () => { cancellationSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(miningSettled, false);
    assert.equal(cancellationSettled, false);
    finishDig();
    assert.deepEqual(await mining, { kind: 'cancelled', reason: 'shutdown' });
    await cancellation;
  } finally {
    finishDig();
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('cancellation preserves a dig stop failure after the dig settles', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, {
    position: new TestVector(0, 63, 0),
    yaw: Math.PI,
    pitch: -Math.PI / 2,
  });
  const logPosition = new TestVector(0, 64, 0);
  harness.setBlock(logPosition, block('oak_log', logPosition));
  const stopFailure = new Error('stop digging failed');
  let finishDig!: () => void;
  let reportDigStarted!: () => void;
  let reportStopRequested!: () => void;
  const digStarted = new Promise<void>((resolve) => { reportDigStarted = resolve; });
  const stopRequested = new Promise<void>((resolve) => { reportStopRequested = resolve; });
  const digSettlement = new Promise<void>((resolve) => { finishDig = resolve; });
  Object.assign(harness.bot, {
    canDigBlock: () => true,
    dig: () => { reportDigStarted(); return digSettlement; },
    stopDigging: () => {
      reportStopRequested();
      finishDig();
      throw stopFailure;
    },
  });

  try {
    const mining = harness.owner.runCivilization({
      kind: 'mineBlock', position: blockPosition(0, 64, 0), expectedBlock: 'oak_log',
    });
    await waitForDigStart(digStarted, mining);
    const cancellation = harness.owner.cancel('shutdown');
    const miningFailure = assert.rejects(mining, (error: unknown) => error === stopFailure);
    const cancellationFailure = assert.rejects(cancellation, (error: unknown) => error === stopFailure);
    await stopRequested;
    await Promise.all([miningFailure, cancellationFailure]);
    await assert.rejects(
      harness.owner.runCivilization({ kind: 'hold', reason: 'materialsUnknown' }),
      (error: unknown) => error === stopFailure,
    );
  } finally {
    finishDig();
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('container transfer uses the received chest window and confirms both inventories', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, { yaw: -Math.PI / 2, pitch: -Math.PI / 4 });
  const planks = item('oak_planks', 11, 16, 9);
  harness.inventory.slots[9] = planks;
  const chestPosition = new TestVector(1, 64, 0);
  harness.setBlock(chestPosition, block('chest', chestPosition));
  const chestWindow = makeChestWindow();
  chestWindow.slots[27] = planks;
  Object.assign(harness.bot, {
    lookAt: async () => undefined,
    activateBlock: async () => {
      Object.assign(harness.bot, { currentWindow: chestWindow });
      harness.bot.emit('windowOpen', chestWindow as never);
    },
    clickWindow: async (slot: number, _mouseButton: number, mode: number) => {
      assert.equal(mode, 1);
      assert.equal(slot, 27);
      harness.inventory.slots[9] = null;
      chestWindow.slots[27] = null;
      chestWindow.slots[0] = planks;
    },
    closeWindow: async () => {
      Object.assign(harness.bot, { currentWindow: null });
      harness.bot.emit('windowClose', chestWindow as never);
    },
  });

  try {
    assert.deepEqual(await harness.owner.runCivilization({
      kind: 'containerTransfer',
      position: blockPosition(1, 64, 0),
      direction: 'deposit',
      item: 'oak_planks',
      count: 16,
    }), { kind: 'succeeded' });
    assert.equal(harness.inventory.items().some((stack) => stack.name === 'oak_planks'), false);
    assert.equal(chestWindow.slots[0]?.count, 16);
    assert.equal(harness.bot.currentWindow, null);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('container transfer moves an exact partial stack and returns the remainder to inventory', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, { yaw: -Math.PI / 2, pitch: -Math.PI / 4 });
  const planks = item('oak_planks', 11, 32, 9);
  harness.inventory.slots[9] = planks;
  const chestPosition = new TestVector(1, 64, 0);
  harness.setBlock(chestPosition, block('chest', chestPosition));
  const chestWindow = makePinnedChestWindow(32);
  Object.assign(harness.bot, {
    lookAt: async () => undefined,
    activateBlock: async () => {
      Object.assign(harness.bot, { currentWindow: chestWindow });
      harness.bot.emit('windowOpen', chestWindow as never);
    },
    clickWindow: async (slot: number, button: number, mode: number) => {
      assert.equal(mode, 0);
      const click = {
        slot,
        mouseButton: button,
        mode,
        item: chestWindow.slots[slot] ?? null,
      };
      chestWindow.acceptClick(click, 0);
      syncInventoryFromChestWindow(harness, chestWindow);
    },
    closeWindow: async () => {
      Object.assign(harness.bot, { currentWindow: null });
      harness.bot.emit('windowClose', chestWindow as never);
    },
  });

  try {
    assert.deepEqual(await harness.owner.runCivilization({
      kind: 'containerTransfer',
      position: blockPosition(1, 64, 0),
      direction: 'deposit',
      item: 'oak_planks',
      count: 16,
    }), { kind: 'succeeded' });
    assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_planks')?.count, 16);
    assert.equal(chestWindow.slots[0]?.count, 16);
    assert.equal(chestWindow.selectedItem, null);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('place spends a plank only when the received target and inventory both change', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, {
    position: new TestVector(0, 63, 0),
    yaw: -Math.PI / 2,
    pitch: 0,
  });
  const planks = item('oak_planks', 11, 16, 9);
  harness.inventory.slots[9] = planks;
  const supportPosition = new TestVector(1, 64, 0);
  const targetPosition = new TestVector(1, 65, 0);
  harness.setBlock(supportPosition, block('stone', supportPosition));
  harness.setBlock(targetPosition, block('air', targetPosition));
  Object.assign(harness.bot, {
    equip: async (stack: typeof planks) => { Object.assign(harness.bot, { heldItem: stack }); },
    placeBlock: async (support: { readonly position: TestVector }, face: Bot['entity']['position']) => {
      assert.deepEqual([face.x, face.y, face.z], [0, 1, 0]);
      const placedPosition = support.position.offset(face.x, face.y, face.z);
      harness.setBlock(placedPosition, block('oak_planks', placedPosition));
      planks.count = 15;
    },
  });

  try {
    assert.deepEqual(await harness.owner.runCivilization({
      kind: 'placeBlock',
      target: blockPosition(1, 65, 0),
      referencePosition: blockPosition(1, 64, 0),
      face: 'up',
      item: 'oak_planks',
    }), { kind: 'succeeded' });
    assert.equal(harness.blocks.get(key(targetPosition))?.name, 'oak_planks');
    assert.equal(harness.inventory.items().find((stack) => stack.name === 'oak_planks')?.count, 15);
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

test('C2 skills reject a nearby teammate and still allow a rostered enemy target', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot.entity, { yaw: -Math.atan2(1, 2), pitch: -Math.atan2(0.72, Math.hypot(1, 2)) });
  const roster = civilizationRoster();
  const teammate = playerEntity(2, 0, 64, -2);
  const enemy = playerEntity(3, 1, 64, -2);
  Object.assign(harness.bot, {
    players: {
      [roster[1]?.username ?? '']: rosterPlayer(roster[1]!, teammate),
      [roster[3]?.username ?? '']: rosterPlayer(roster[3]!, enemy),
    },
    entities: { 2: teammate, 3: enemy },
    lookAt: async () => undefined,
    attack: (target: typeof enemy) => harness.bot.emit('entityHurt', target as never, harness.bot.entity),
  });

  try {
    assert.deepEqual(await harness.owner.run({ kind: 'attack', target: entityId(2) }), {
      kind: 'failed', cause: 'preconditionsNotMet',
    });
    assert.deepEqual(await harness.owner.run({ kind: 'attack', target: entityId(3) }), { kind: 'succeeded' });
  } finally {
    await harness.owner.close();
    harness.civilization.close();
    harness.observer.close();
  }
});

function makeHarness() {
  const emitter = new EventEmitter();
  const client = new EventEmitter();
  const blocks = new Map<string, ReturnType<typeof block>>();
  const localWorld = makeLocalWorld();
  const setBlock = (position: TestVector, value: ReturnType<typeof block>): void => {
    blocks.set(key(position), value);
    localWorld.setBlock(position, value.name);
  };
  const names = ['chest', 'trapped_chest', 'stone', 'oak_log', 'oak_planks', 'air', 'fire', 'cobweb', 'web', 'lava', 'water', 'sand', 'gravel', 'ladder'];
  const registry = {
    version: { type: 'pc', minecraftVersion: MINECRAFT_VERSION, '>=': () => true },
    supportFeature: () => false,
    blocksByName: Object.fromEntries(names.map((name, id) => [name, { id }])),
    blocksArray: [],
    blocksByStateId: {},
    blocks: {},
    itemsByName: { oak_log: { id: 10 }, oak_planks: { id: 11 }, dirt: { id: 12 }, cobblestone: { id: 13 } },
    foodsByName: {},
  };
  const slots = new Array(46).fill(null) as (ReturnType<typeof item> | null)[];
  const inventory = {
    slots,
    selectedItem: null,
    inventoryStart: 9,
    inventoryEnd: 45,
    items: () => slots.filter((stack) => stack !== null),
    emptySlotCount: () => slots.slice(9, 45).filter((stack) => stack === null).length,
    firstEmptySlotRange: (start: number, end: number) => {
      for (let slot = start; slot < end; slot += 1) if (slots[slot] === null) return slot;
      return null;
    },
  };
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
  const entity = {
    id: 1,
    position: new TestVector(0, 64, 0),
    yaw: 0,
    pitch: 0,
    eyeHeight: 1.62,
    height: 1.8,
  };
  Object.assign(emitter, {
    _client: client,
    username: 'ArenaBot0',
    player: { uuid: civilizationRoster()[0]?.offlineUuid },
    registry,
    pathfinder,
    inventory,
    entity,
    entities: {},
    players: {},
    world: localWorld.world,
    health: 20,
    food: 10,
    quickBarSlot: 0,
    currentWindow: null,
    heldItem: null,
    usingHeldItem: false,
    hasPlugin: () => true,
    setQuickBarSlot: (slot: number) => Object.assign(emitter, { quickBarSlot: slot }),
    clearControlStates: () => undefined,
    deactivateItem: () => Object.assign(emitter, { usingHeldItem: false }),
    blockAt: (position: TestVector) => blocks.get(key(position)) ?? localWorld.world.getBlock(position) ?? null,
    findBlocks: () => [],
  });
  const bot = emitter as unknown as Bot;
  const observer = new MineflayerObserver(bot);
  client.emit('initialize_world_border', {
    x: 0,
    z: 0,
    oldDiameter: 100,
    newDiameter: 100,
    speed: 0,
  });
  const civilization = new MineflayerCivilizationObserver(bot, context(), civilizationRoster());
  client.emit('window_items', { windowId: 0 });
  const owner = new SkillOwner(bot, observer, civilization);
  return { bot, inventory, blocks, setBlock, owner, observer, civilization };
}

function makeLocalWorld(): {
  readonly world: PinnedWorld;
  setBlock(position: TestVector, name: string): void;
} {
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
          return worldBlockFactory.fromStateId(blockStates.get(keyXYZ(x, y, z)) ?? airState, 0);
        },
      });
    }
  }
  return {
    world,
    setBlock: (position, name) => {
      const state = worldRegistry.blocksByName[name]?.defaultState;
      if (state === undefined) throw new Error(`pinned registry has no ${name} block state`);
      blockStates.set(key(position), state);
    },
  };
}

function context(): CivilizationPolicyContextInput {
  return {
    seat: 0,
    faction: 'ember',
    role: 'gatherer_crafter',
    objective: {
      captureBox: { min: blockPosition(-8, 60, -8), max: blockPosition(8, 70, 8) },
      outpost: { blueprintId: 'oak-outpost-v1', anchor: blockPosition(0, 64, 0), rotationDegrees: 0 },
    },
  };
}

async function waitForDigStart(started: Promise<void>, skill: Promise<unknown>): Promise<void> {
  await Promise.race([
    started,
    skill.then(() => { throw new Error('mining skill completed before digging started'); }),
  ]);
}

function civilizationRoster() {
  return Array.from({ length: 6 }, (_, seat) => ({
    seat,
    username: `ArenaBot${seat}`,
    offlineUuid: `00000000-0000-3000-8000-${String(seat + 1).padStart(12, '0')}`,
  }));
}

function rosterPlayer(
  member: ReturnType<typeof civilizationRoster>[number],
  entity: ReturnType<typeof playerEntity>,
) {
  return { username: member.username, uuid: member.offlineUuid, gamemode: 0, entity };
}

function playerEntity(id: number, x: number, y: number, z: number) {
  return {
    id,
    type: 'player',
    position: new TestVector(x, y, z),
    height: 1.8,
  };
}

function item(name: string, type: number, count: number, slot: number) {
  return { name, type, metadata: 0, count, slot, stackSize: 64 };
}

function block(name: string, position: TestVector) {
  return { name, position, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name === 'oak_log' };
}

function makeChestWindow() {
  let selectedItem: ReturnType<typeof item> | null = null;
  const window = {
    id: 1,
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: new Array(63).fill(null) as (ReturnType<typeof item> | null)[],
    get selectedItem() { return selectedItem; },
    set selectedItem(value: ReturnType<typeof item> | null) { selectedItem = value; },
    withdraw: async () => undefined,
    firstEmptySlotRange: (start: number, end: number) => {
      for (let slot = start; slot < end; slot += 1) if (window.slots[slot] === null) return slot;
      return null;
    },
  };
  return window;
}

function makePinnedChestWindow(plankCount: number): MineflayerWindow {
  const registry = loadPrismarineRegistry(MINECRAFT_VERSION);
  const chestWindow = loadPrismarineWindows(registry).createWindow(1, 'minecraft:generic_9x3', 'Chest');
  if (chestWindow === null) throw new Error('pinned Mineflayer registry has no generic chest window');
  Object.assign(chestWindow, {
    withdraw: async () => { throw new Error('unexpected withdrawal in partial-transfer fixture'); },
  });
  const Item = loadPrismarineItem(registry);
  chestWindow.updateSlot(27, new Item(registry.itemsByName.oak_planks.id, plankCount, 0, null));
  return chestWindow;
}

function syncInventoryFromChestWindow(
  harness: ReturnType<typeof makeHarness>,
  chestWindow: MineflayerWindow,
): void {
  for (let windowSlot = chestWindow.inventoryStart; windowSlot < chestWindow.inventoryEnd; windowSlot += 1) {
    const inventorySlot = windowSlot - chestWindow.inventoryStart + 9;
    const chestItem = chestWindow.slots[windowSlot];
    harness.inventory.slots[inventorySlot] = chestItem == null
      ? null
      : {
        name: chestItem.name,
        type: chestItem.type,
        metadata: chestItem.metadata,
        count: chestItem.count,
        slot: inventorySlot,
        stackSize: chestItem.stackSize,
      };
  }
}

function key(position: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function keyXYZ(x: number, y: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

class TestVector extends Vec3 {}
