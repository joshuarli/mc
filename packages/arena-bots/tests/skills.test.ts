import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { blockPosition, entityId, inventorySlot } from '@arena/core';
import type { Bot } from 'mineflayer';
import { PathDiagnosticRing } from '../src/index.js';
import { MineflayerObserver } from '../src/observer.js';
import { SkillOwner } from '../src/skills.js';

const { goals } = createRequire(import.meta.url)('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');

test('cancellation stops the owned path and clears client controls before settling', async () => {
  const harness = makeHarness();

  try {
    const running = harness.owner.run({ kind: 'navigate', target: blockPosition(20, 64, 0) });
    await waitUntil(() => harness.pathfinder.goal !== null);
    assert.ok(harness.pathfinder.goal instanceof goals.GoalNear);

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

test('navigateToBlock requires the ramp top and the owned skill checks the observed tile', async () => {
  const target = blockPosition(31, 66, 21);
  const goal = new goals.GoalBlock(target.x, target.y, target.z);
  const pathfinderNode = (x: number, y: number, z: number) => ({
    x,
    y,
    z,
    remainingBlocks: 0,
    cost: 0,
    toBreak: [],
    toPlace: [],
    parkour: false,
    hash: `${x},${y},${z}`,
  } satisfies Parameters<typeof goal.isEnd>[0]);
  assert.equal(goal.isEnd(pathfinderNode(31, 66, 20)), false);
  assert.equal(goal.isEnd(pathfinderNode(31, 66, 21)), true);

  const harness = makeHarness();
  Object.assign(harness.bot, { entity: { id: 1, position: new TestPosition(31.5, 66, 20.5) } });

  try {
    let settled = false;
    const running = harness.owner.run({ kind: 'navigateToBlock', target });
    void running.then(() => { settled = true; });
    await waitUntil(() => harness.pathfinder.goal !== null);
    const firstGoal = harness.pathfinder.goal;
    assert.ok(firstGoal instanceof goals.GoalBlock);

    harness.bot.emit('goal_reached', firstGoal as never);
    await waitUntil(() => harness.pathfinder.goal !== null && harness.pathfinder.goal !== firstGoal);
    assert.equal(settled, false);

    Object.assign(harness.bot, { entity: { id: 1, position: new TestPosition(31.5, 66, 21.5) } });
    harness.bot.emit('goal_reached', harness.pathfinder.goal as never);
    assert.deepEqual(await running, { kind: 'succeeded' });
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

test('opt-in path diagnostics capture bounded local movement evidence and detach cleanly', async () => {
  const harness = makeHarness();
  const block = {
    name: 'cobblestone',
    type: 1,
    stateId: 42,
    shapes: [[0, 0, 0, 1, 1, 1]],
    position: new TestPosition(31, 65, 21),
  } as NonNullable<ReturnType<Bot['blockAt']>>;
  let clientMs = 0;
  Object.assign(harness.bot, {
    entity: {
      id: 1,
      position: new TestPosition(30.68, 65, 21.46),
      velocity: new TestPosition(0.03, -0.08, 0.01),
      onGround: false,
      isCollidedHorizontally: true,
      isCollidedVertically: false,
    },
    controlState: {
      forward: true,
      back: false,
      left: false,
      right: true,
      jump: true,
      sprint: true,
      sneak: false,
    },
    blockAt: (position: TestPosition) => position.x === 31 && position.y === 65 && position.z === 21 ? block : null,
  });
  const basePhysicsListeners = harness.bot.listenerCount('physicsTick');
  const basePositionListeners = (harness.bot._client as unknown as EventEmitter).listenerCount('position');
  const ring = new PathDiagnosticRing(harness.bot, {
    clientLabel: 'ramp-seat-zero',
    clock: () => ({ clientMs: clientMs++, authorityTick: 120 }),
  });

  try {
    ring.setExternalMovementOwner('sprintCourse');
    harness.bot.emit('physicsTick');
    const handoff = ring.snapshot().find((record) => record.kind === 'physicsTick');
    assert.ok(handoff);
    assert.equal(handoff.owner, 'sprintCourse');
    assert.equal(handoff.navigationActive, false);
    assert.equal(handoff.goal, null);
    assert.equal(handoff.control.jump, true);

    const running = harness.owner.run({ kind: 'navigateToBlock', target: blockPosition(31, 66, 21) });
    await waitUntil(() => harness.pathfinder.goal !== null);
    harness.bot.emit('path_update', {
      status: 'partial',
      cost: 1,
      time: 0.75,
      visitedNodes: 4,
      generatedNodes: 7,
      path: [{
        x: 31,
        y: 65,
        z: 21,
        cost: 1,
        remainingBlocks: 0,
        toBreak: [],
        toPlace: [],
        parkour: false,
        hash: '31,65,21',
      }],
    } as never);
    harness.bot.emit('physicsTick');
    (harness.bot._client as unknown as EventEmitter).emit('position', {
      x: 31,
      y: 66,
      z: 21,
      dx: 0.12,
      dy: -0.04,
      dz: 0.08,
      yaw: 0,
      pitch: 0,
      flags: { x: false, y: false, z: false, yaw: false, pitch: false, dx: true, dy: false, dz: true, yawDelta: false },
      teleportId: 3,
    });

    const records = ring.snapshot();
    const physics = records.filter((record) => record.kind === 'physicsTick').find((record) => record.owner === 'navigateToBlock');
    assert.ok(physics);
    assert.equal(physics.clientLabel, 'ramp-seat-zero');
    assert.equal(physics.authorityTick, 120);
    assert.deepEqual(physics.position, { x: 30.68, y: 65, z: 21.46 });
    assert.deepEqual(physics.velocity, { x: 0.03, y: -0.08, z: 0.01 });
    assert.equal(physics.collidedHorizontally, true);
    assert.equal(physics.collidedVertically, false);
    assert.equal(physics.control.jump, true);
    assert.equal(physics.path?.contextTimeMs, 0.75);
    assert.equal(physics.owner, 'navigateToBlock');
    assert.equal(physics.goal?.type, 'GoalBlock');
    assert.equal(physics.blocks.length, 36);
    assert.deepEqual(
      physics.blocks.find((sample) => sample.position.x === 31 && sample.position.y === 65 && sample.position.z === 21),
      {
        position: { x: 31, y: 65, z: 21 },
        loaded: true,
        name: 'cobblestone',
        type: 1,
        stateId: 42,
        shapes: [{ values: [0, 0, 0, 1, 1, 1] }],
        shapesTruncated: false,
      },
    );
    assert.ok(records.some((record) => record.kind === 'pathSearch' && record.transition === 'acquired'));
    assert.ok(records.some((record) => record.kind === 'pathUpdate' && record.path.status === 'partial'));
    const correction = records.find((record) => record.kind === 'positionCorrection');
    assert.ok(correction);
    assert.equal(correction.packet.teleportId, 3);
    assert.deepEqual(correction.packet.delta, { x: 0.12, y: -0.04, z: 0.08 });
    assert.deepEqual(correction.packet.flags, {
      x: false,
      y: false,
      z: false,
      yaw: false,
      pitch: false,
      dx: true,
      dy: false,
      dz: true,
      yawDelta: false,
    });

    const queuedCancellation = harness.owner.cancel('shutdown');
    assert.deepEqual(await running, { kind: 'cancelled', reason: 'shutdown' });
    await queuedCancellation;
    harness.bot.emit('physicsTick');
    const afterCleanup = ring.snapshot().filter((record) => record.kind === 'physicsTick').at(-1);
    assert.ok(afterCleanup);
    assert.equal(afterCleanup.owner, 'sprintCourse');
    assert.equal(afterCleanup.navigationActive, false);
    assert.equal(afterCleanup.goal, null);
    assert.deepEqual(afterCleanup.control, {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      sneak: false,
    });
    assert.ok(ring.snapshot().some((record) => record.kind === 'pathSearch' && record.transition === 'released'));
  } finally {
    ring.close();
    const countAfterClose = ring.snapshot().length;
    assert.equal(harness.bot.listenerCount('physicsTick'), basePhysicsListeners);
    assert.equal((harness.bot._client as unknown as EventEmitter).listenerCount('position'), basePositionListeners);
    harness.bot.emit('physicsTick');
    (harness.bot._client as unknown as EventEmitter).emit('position', {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      flags: 0,
    });
    assert.equal(ring.snapshot().length, countAfterClose);
    await harness.owner.close();
    harness.observer.close();
  }
});

test('opt-in path diagnostics retain only the fixed number of newest entries', async () => {
  const harness = makeHarness();
  let clientMs = 0;
  let pathResetCount = 0;
  const ring = new PathDiagnosticRing(harness.bot, {
    clientLabel: 'bounded-ring-test',
    clock: () => ({ clientMs: clientMs++, authorityTick: null }),
    onRecord: (record) => {
      if (record.kind === 'pathReset') pathResetCount += 1;
    },
  });
  try {
    for (let index = 0; index < 520; index += 1) harness.bot.emit('path_reset', 'block_updated');
    const records = ring.snapshot();
    assert.equal(records.length, 512);
    assert.equal(records[0]?.clientMs, 8);
    assert.equal(records.at(-1)?.clientMs, 519);
    assert.equal(pathResetCount, 520);
  } finally {
    ring.close();
    await harness.owner.close();
    harness.observer.close();
  }
});

test('opt-in path diagnostics retain callback failures for snapshot callers', async () => {
  const harness = makeHarness();
  const ring = new PathDiagnosticRing(harness.bot, {
    clientLabel: 'failed-collector-test',
    clock: () => ({ clientMs: 0, authorityTick: null }),
    onRecord: () => { throw new Error('test collector failed'); },
  });
  try {
    harness.bot.emit('path_reset', 'block_updated');
    assert.throws(
      () => ring.snapshot(),
      (error) => error instanceof Error
        && error.message === 'path diagnostic capture failed'
        && error.cause instanceof Error
        && error.cause.message === 'test collector failed',
    );
  } finally {
    ring.close();
    await harness.owner.close();
    harness.observer.close();
  }
});

test('opt-in path diagnostics reject malformed position correction deltas', async () => {
  const harness = makeHarness();
  const ring = new PathDiagnosticRing(harness.bot, {
    clientLabel: 'invalid-correction-test',
    clock: () => ({ clientMs: 0, authorityTick: null }),
  });
  try {
    (harness.bot._client as unknown as EventEmitter).emit('position', {
      x: 1,
      y: 2,
      z: 3,
      dx: Number.NaN,
      dy: 0,
      dz: 0,
      yaw: 0,
      pitch: 0,
      flags: {},
      teleportId: 1,
    });
    assert.throws(() => ring.snapshot(), /path diagnostic capture failed/);
  } finally {
    ring.close();
    await harness.owner.close();
    harness.observer.close();
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
    // Simulate a selected-slot update received while the equip request is still pending.
    Object.assign(harness.bot, { quickBarSlot: 2 });
    const cancellation = harness.owner.cancel('shutdown');
    await assert.rejects(running, /client is quarantined/);
    await assert.rejects(cancellation, /client is quarantined/);
    assert.ok(harness.controlsCleared() > 0);
    assert.equal(harness.bot.quickBarSlot, 2);
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

test('successful weapon equip keeps the hotbar slot holding the weapon selected', async () => {
  const harness = makeHarness();
  const sword = { name: 'stone_sword', type: 5, metadata: 0, count: 1, slot: 43 } as NonNullable<Bot['inventory']['slots'][number]>;
  harness.bot.inventory.slots[43] = sword;
  Object.assign(harness.bot, {
    setQuickBarSlot: (slot: number) => Object.assign(harness.bot, {
      quickBarSlot: slot,
      heldItem: harness.bot.inventory.slots[36 + slot] ?? null,
    }),
    equip: async (item: NonNullable<Bot['inventory']['slots'][number]>, destination: string) => {
      assert.equal(destination, 'hand');
      harness.bot.setQuickBarSlot(item.slot - 36);
    },
  });

  try {
    assert.deepEqual(await harness.owner.run({
      kind: 'equip',
      inventorySlot: inventorySlot(43),
      equipmentSlot: 'weapon',
      rating: 2,
    }), { kind: 'succeeded' });
    assert.equal(harness.bot.quickBarSlot, 7);
    assert.equal(harness.bot.heldItem, sword);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('attack waits for tick-driven non-forced look before launching', async () => {
  const harness = makeHarness();
  const targetPosition = new TestPosition(0, 64, -2);
  const opponent = {
    id: 2,
    type: 'player',
    position: targetPosition,
    height: 1.8,
  } as Bot['entity'];
  const targetBlock = {
    name: 'stone',
    position: targetPosition,
  } as NonNullable<ReturnType<Bot['blockAt']>>;
  let lookCalls = 0;
  let attackCalls = 0;
  const lookForces: (boolean | undefined)[] = [];
  Object.assign(harness.bot, {
    entity: {
      id: 1,
      position: new TestPosition(0, 64, 0),
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
    },
    entities: { 2: opponent },
    players: { rival: { entity: opponent, gamemode: 0 } },
    blockAt: () => targetBlock,
    canSeeBlock: () => true,
    lookAt: async (_point: unknown, force?: boolean) => {
      lookCalls += 1;
      lookForces.push(force);
      if (force === true) return;
      await new Promise<void>((resolve) => harness.bot.once('physicsTick', resolve));
    },
    attack: (target: typeof opponent) => {
      attackCalls += 1;
      harness.bot.emit('entityHurt', target, harness.bot.entity);
    },
  });

  try {
    const running = harness.owner.run({ kind: 'attack', target: entityId(2) });
    await waitUntil(() => lookCalls >= 1);
    assert.equal(attackCalls, 0);
    harness.bot.emit('physicsTick');

    await waitUntil(() => lookCalls >= 2);
    assert.equal(attackCalls, 0);
    harness.bot.emit('physicsTick');

    assert.deepEqual(await running, { kind: 'succeeded' });
    assert.deepEqual(lookForces, [undefined, undefined]);
    assert.equal(attackCalls, 1);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('cancellation quarantines a look operation that never settles', async () => {
  const harness = makeHarness();
  prepareChest(harness.bot);
  let lookStarted = false;
  let activationStarted = false;
  Object.assign(harness.bot, {
    lookAt: () => {
      lookStarted = true;
      return new Promise<void>(() => undefined);
    },
    activateBlock: () => {
      activationStarted = true;
      return Promise.resolve();
    },
  });

  try {
    const running = harness.owner.run({ kind: 'containerOpen', position: blockPosition(1, 64, 0) });
    await waitUntil(() => lookStarted);
    const cancellation = harness.owner.cancel('shutdown');
    await assert.rejects(running, /client is quarantined/);
    await assert.rejects(cancellation, /client is quarantined/);
    assert.equal(activationStarted, false);
    assert.ok(harness.controlsCleared() > 0);
    await assert.rejects(
      harness.owner.run({ kind: 'hold', reason: 'agentStateUnknown' }),
      /client is quarantined/,
    );
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('close waits only for the bounded window receipt when activation never settles', async () => {
  const harness = makeHarness();
  prepareChest(harness.bot);
  let activationStarted = false;
  let finishActivation!: () => void;
  Object.assign(harness.bot, {
    lookAt: async () => undefined,
    activateBlock: () => {
      activationStarted = true;
      return new Promise<void>((resolve) => { finishActivation = resolve; });
    },
  });

  try {
    const running = harness.owner.run({ kind: 'containerOpen', position: blockPosition(1, 64, 0) });
    await waitUntil(() => activationStarted);
    const closing = harness.owner.close();
    await assert.rejects(running, /client is quarantined/);
    await assert.rejects(closing, /client is quarantined/);
    assert.equal(harness.bot.listenerCount('windowOpen'), 0);
    assert.ok(harness.controlsCleared() > 0);

    finishActivation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.bot.listenerCount('windowOpen'), 0);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('container open synchronizes each withdrawn item from the full window snapshot', async () => {
  const harness = makeHarness();
  const transfer = prepareContainerTransfer(harness, true);

  try {
    assert.deepEqual(await harness.owner.run({
      kind: 'containerOpen',
      position: blockPosition(1, 64, 0),
    }), { kind: 'succeeded' });
    assert.equal(transfer.clicks(), 2);
    assert.equal(transfer.syncs(), 2);
    assert.deepEqual(harness.bot.inventory.items().map((item) => item.name), ['bread', 'iron_sword']);
    assert.equal(transfer.window.slots[0], null);
    assert.equal(transfer.window.slots[1], null);
    assert.equal(harness.bot.currentWindow, null);
    assert.equal(harness.observer.isContainerOpened(blockPosition(1, 64, 0)), true);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('container open waits past an earlier stale full-window snapshot', async () => {
  const harness = makeHarness();
  const transfer = prepareContainerTransfer(harness, true, true);

  try {
    assert.deepEqual(await harness.owner.run({
      kind: 'containerOpen',
      position: blockPosition(1, 64, 0),
    }), { kind: 'succeeded' });
    assert.equal(transfer.clicks(), 2);
    assert.equal(transfer.syncs(), 2);
    assert.deepEqual(harness.bot.inventory.items().map((item) => item.name), ['bread', 'iron_sword']);
    assert.equal(transfer.window.slots[0], null);
    assert.equal(transfer.window.slots[1], null);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

test('container open reports noProgress after repeated stale snapshots', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = makeHarness();
  const transfer = prepareContainerTransfer(harness, false, false, 1_000, 3);

  try {
    const running = harness.owner.run({
      kind: 'containerOpen',
      position: blockPosition(1, 64, 0),
    });
    await waitUntil(() => transfer.syncs() > 0);
    for (let snapshot = 0; snapshot < 5; snapshot += 1) {
      context.mock.timers.tick(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(await running, { kind: 'failed', cause: 'noProgress' });
    assert.equal(transfer.clicks(), 1);
    assert.equal(transfer.syncs(), 1);
    assert.ok(transfer.snapshots() >= 4);
    assert.equal(transfer.window.slots[0]?.name, 'bread');
    assert.equal(harness.bot.inventory.items().length, 0);
    assert.equal(harness.bot.currentWindow, null);
  } finally {
    await harness.owner.close();
    harness.observer.close();
  }
});

function prepareContainerTransfer(
  harness: ReturnType<typeof makeHarness>,
  applyWithdrawal: boolean,
  staleFirstSnapshot = false,
  snapshotDelayMs = 0,
  additionalStaleSnapshots = 0,
) {
  prepareChest(harness.bot);
  Object.assign(harness.bot.registry.foodsByName, { bread: {} });
  type Item = NonNullable<Bot['inventory']['slots'][number]>;
  const bread = { name: 'bread', type: 3, metadata: 0, count: 1, slot: 0, stackSize: 64 } as Item;
  const sword = { name: 'iron_sword', type: 4, metadata: 0, count: 1, slot: 1, stackSize: 64 } as Item;
  const slots = new Array(63).fill(null) as (Item | null)[];
  slots[0] = bread;
  slots[1] = sword;
  const staleSlots = [...slots];
  const serverSlots = [...slots];
  const window = {
    id: 2,
    inventoryStart: 27,
    inventoryEnd: 63,
    slots,
    selectedItem: null,
    withdraw: async () => undefined,
  } as unknown as NonNullable<Bot['currentWindow']>;
  let clicks = 0;
  let syncs = 0;
  let snapshots = 0;
  Object.assign(harness.bot, {
    supportFeature: (feature: string) => feature === 'stateIdUsed',
    lookAt: async () => undefined,
    activateBlock: async () => {
      Object.assign(harness.bot, { currentWindow: window });
      harness.bot.emit('windowOpen', window as never);
    },
    clickWindow: async (sourceSlot: number, mouseButton: number, mode: number) => {
      assert.equal(mouseButton, 0);
      assert.equal(mode, 1);
      const received = serverSlots[sourceSlot];
      assert.ok(received);
      const destinationSlot = serverSlots.findIndex((item, slot) => slot >= window.inventoryStart && item === null);
      assert.notEqual(destinationSlot, -1);
      if (applyWithdrawal) {
        serverSlots[sourceSlot] = null;
        serverSlots[destinationSlot] = { ...received, slot: destinationSlot } as Item;
      }
      clicks += 1;
    },
    _syncWindow: async (receivedWindow: NonNullable<Bot['currentWindow']>) => {
      assert.equal(receivedWindow, window);
      syncs += 1;
      const applySnapshot = (snapshot: readonly (Item | null)[]) => {
        snapshots += 1;
        for (let slot = 0; slot < snapshot.length; slot += 1) {
          window.slots[slot] = snapshot[slot] ?? null;
        }
        for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
          const inventorySlot = slot - (window.inventoryStart - harness.bot.inventory.inventoryStart);
          harness.bot.inventory.slots[inventorySlot] = snapshot[slot] ?? null;
        }
        harness.bot._client.emit('window_items', { windowId: window.id, items: snapshot });
        harness.bot.emit(`setWindowItems:${window.id}` as never);
      };
      if (staleFirstSnapshot && syncs === 1) {
        applySnapshot(staleSlots);
        setImmediate(() => applySnapshot(serverSlots));
        return;
      }
      if (snapshotDelayMs > 0) {
        for (let snapshot = 1; snapshot <= additionalStaleSnapshots; snapshot += 1) {
          setTimeout(() => applySnapshot(serverSlots), snapshotDelayMs * (snapshot + 1));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, snapshotDelayMs));
      }
      applySnapshot(serverSlots);
    },
    closeWindow: async () => {
      for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
        const inventorySlot = slot - (window.inventoryStart - harness.bot.inventory.inventoryStart);
        harness.bot.inventory.slots[inventorySlot] = window.slots[slot] ?? null;
      }
      Object.assign(harness.bot, { currentWindow: null });
      harness.bot.emit('windowClose', window as never);
    },
  });
  return { window, clicks: () => clicks, syncs: () => syncs, snapshots: () => snapshots };
}

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
    clearControlStates: () => {
      controlsCleared += 1;
      const controlState = (botEmitter as unknown as { controlState?: Record<string, boolean> }).controlState;
      if (controlState !== undefined) {
        for (const control of Object.keys(controlState)) controlState[control] = false;
      }
    },
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

function prepareChest(bot: Bot): void {
  const block = {
    name: 'chest',
    position: new TestPosition(1, 64, 0),
  } as NonNullable<ReturnType<Bot['blockAt']>>;
  Object.assign(bot, {
    entity: { id: 1, position: new TestPosition(0, 64, 0) },
    blockAt: () => block,
    canSeeBlock: () => true,
  });
}

class TestPosition {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}

  floored(): TestPosition {
    return new TestPosition(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }

  offset(x: number, y: number, z: number): TestPosition {
    return new TestPosition(this.x + x, this.y + y, this.z + z);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true');
}
