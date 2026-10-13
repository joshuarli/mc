import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { blockPosition, inventorySlot } from '@arena/core';
import type { Bot } from 'mineflayer';
import { MineflayerObserver } from '../src/observer.js';
import { SkillOwner } from '../src/skills.js';

test('cancellation stops the owned path and clears client controls before settling', async () => {
  const harness = makeHarness();

  try {
    const running = harness.owner.run({ kind: 'navigate', target: blockPosition(20, 64, 0) });
    await waitUntil(() => harness.pathfinder.goal !== null);

    const cancellation = harness.owner.cancel('shutdown');
    assert.deepEqual(await running, { kind: 'cancelled', reason: 'shutdown' });
    await cancellation;
    assert.equal(harness.pathfinder.goal, null);
    assert.ok(harness.controlsCleared() > 0);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('worker caps active A-star searches and removes cancelled path waiters', async () => {
  let activeSearches = 0;
  let maximumActiveSearches = 0;
  let startedSearches = 0;
  const harnesses = Array.from({ length: 5 }, () => makeHarness(
    () => {
      activeSearches += 1;
      startedSearches += 1;
      maximumActiveSearches = Math.max(maximumActiveSearches, activeSearches);
    },
    () => { activeSearches -= 1; },
  ));

  try {
    const runs = harnesses.map((harness) => harness.owner.run({
      kind: 'navigate',
      target: blockPosition(20, 64, 0),
    }));
    await waitUntil(() => startedSearches === 3);
    assert.equal(maximumActiveSearches, 3);
    assert.equal(harnesses[3]?.pathfinder.goal, null);
    assert.equal(harnesses[4]?.pathfinder.goal, null);

    const queued = harnesses[3];
    assert.ok(queued);
    const queuedCancellation = queued.owner.cancel('shutdown');
    assert.deepEqual(await runs[3], { kind: 'cancelled', reason: 'shutdown' });
    await queuedCancellation;
    assert.equal(startedSearches, 3);

    const first = harnesses[0];
    assert.ok(first);
    const firstCancellation = first.owner.cancel('shutdown');
    assert.deepEqual(await runs[0], { kind: 'cancelled', reason: 'shutdown' });
    await firstCancellation;
    await waitUntil(() => startedSearches === 4);
    assert.equal(maximumActiveSearches, 3);
    assert.notEqual(harnesses[4]?.pathfinder.goal, null);

    await Promise.all([harnesses[1], harnesses[2], harnesses[4]].map((harness) => harness?.owner.cancel('shutdown')));
    for (const run of [runs[1], runs[2], runs[4]]) {
      assert.ok(run);
      assert.deepEqual(await run, { kind: 'cancelled', reason: 'shutdown' });
    }
  } finally {
    await Promise.all(harnesses.map((harness) => harness.owner.close()));
    for (const harness of harnesses) harness.observer.close();
  }
});

test('cancellation quarantines an inventory operation that never receives its update', async () => {
  const harness = makeHarness();
  const sword = { name: 'iron_helmet', type: 5, metadata: 0, count: 1, slot: 9 } as NonNullable<Bot['inventory']['slots'][number]>;
  harness.bot.inventory.slots[9] = sword;
  let equipStarted = false;
  let finishEquip!: () => void;
  let equipmentSlotChecks = 0;
  Object.assign(harness.bot, {
    equip: () => {
      equipStarted = true;
      return new Promise<void>((resolve) => { finishEquip = resolve; });
    },
    getEquipmentDestSlot: () => {
      equipmentSlotChecks += 1;
      return 5;
    },
  });

  try {
    const running = harness.owner.run({
      kind: 'equip',
      inventorySlot: inventorySlot(9),
      equipmentSlot: 'helmet',
      rating: 3,
    });
    await waitUntil(() => equipStarted);
    const cancellation = harness.owner.cancel('shutdown');
    await assert.rejects(running, /client is quarantined/);
    await assert.rejects(cancellation, /client is quarantined/);
    assert.ok(harness.controlsCleared() > 0);
    await assert.rejects(
      harness.owner.run({ kind: 'hold', reason: 'agentStateUnknown' }),
      /client is quarantined/,
    );

    finishEquip();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(equipmentSlotChecks, 0);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

function makeHarness(onPathStarted: () => void = () => undefined, onPathStopped: () => void = () => undefined) {
  const botEmitter = new EventEmitter();
  const client = new EventEmitter();
  let moving = false;
  let controlsCleared = 0;
  const pathfinder = {
    goal: null as unknown,
    thinkTimeout: 0,
    tickTimeout: 0,
    searchRadius: -1,
    setMovements: (_movements: unknown) => undefined,
    setGoal: (goal: unknown) => {
      pathfinder.goal = goal;
      if (goal !== null && !moving) {
        moving = true;
        onPathStarted();
      }
    },
    isMoving: () => moving,
    stop: () => {
      if (moving) {
        moving = false;
        onPathStopped();
      }
      pathfinder.goal = null;
      botEmitter.emit('path_stop');
    },
  };
  const names = ['chest', 'fire', 'cobweb', 'web', 'lava', 'water', 'sand', 'gravel', 'ladder', 'air'];
  // These tests stop searches before node expansion, so movement setup needs only named block entries.
  const registry = {
    version: { type: 'pc', minecraftVersion: '26.1.2', '>=': () => true },
    supportFeature: () => false,
    blocksByName: Object.fromEntries(names.map((name, id) => [name, { id }])),
    blocksArray: [],
    blocksByStateId: {},
    blocks: {},
    itemsByName: { dirt: { id: 1 }, cobblestone: { id: 2 } },
    foodsByName: {},
  };
  const slots = new Array(46).fill(null);
  const inventory = {
    slots,
    selectedItem: null,
    inventoryStart: 9,
    inventoryEnd: 45,
    items: () => slots.filter((item) => item !== null),
    emptySlotCount: () => slots.slice(9, 45).filter((item) => item === null).length,
    firstEmptySlotRange: (start: number, end: number) => {
      for (let slot = start; slot < end; slot += 1) if (slots[slot] === null) return slot;
      return null;
    },
  };
  Object.assign(botEmitter, {
    _client: client,
    registry,
    pathfinder,
    inventory,
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 10,
    quickBarSlot: 0,
    currentWindow: null,
    heldItem: null,
    usingHeldItem: false,
    hasPlugin: () => true,
    setQuickBarSlot: (slot: number) => Object.assign(botEmitter, { quickBarSlot: slot }),
    clearControlStates: () => { controlsCleared += 1; },
    deactivateItem: () => Object.assign(botEmitter, { usingHeldItem: false }),
  });
  const bot = botEmitter as unknown as Bot;
  const observer = new MineflayerObserver(bot);
  client.emit('initialize_world_border', {
    x: 0,
    z: 0,
    oldDiameter: 100,
    newDiameter: 100,
    speed: 0,
  });
  const owner = new SkillOwner(bot, observer);
  return { bot, observer, owner, pathfinder, controlsCleared: () => controlsCleared };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true');
}
