import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { blockPosition, entityId, inventorySlot } from '@arena/core';
import type { Bot } from 'mineflayer';
import { PathDiagnosticRing } from '../src/index.js';
import { MineflayerObserver } from '../src/observer.js';
import { SkillOwner } from '../src/skills.js';

const { goals, Movements } = createRequire(import.meta.url)('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');
const AStar = createRequire(import.meta.url)('mineflayer-pathfinder/lib/astar') as {
  new (...args: unknown[]): { compute(): unknown };
  prototype: {
    compute: (this: { readonly movements: { readonly bot: Bot } }) => unknown;
  };
};
const PathMove = createRequire(import.meta.url)('mineflayer-pathfinder/lib/move') as new (
  x: number,
  y: number,
  z: number,
  remainingBlocks: number,
  cost: number,
) => Bot['entity']['position'] & {
  remainingBlocks: number;
  cost: number;
  toBreak: never[];
  toPlace: never[];
  parkour: boolean;
  hash: string;
};
const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const { Vec3 } = mineflayerRequire('vec3') as {
  readonly Vec3: new (x: number, y: number, z: number) => Bot['entity']['position'];
};
const createPrismarineWorld = mineflayerRequire('prismarine-world') as (
  version: string,
) => new (chunkGenerator: null) => { readonly sync: Bot['world'] };
const minecraftData = mineflayerRequire('minecraft-data') as (version: string) => {
  readonly blocksByName: { readonly air: { readonly defaultState: number } };
};
const createPrismarineBlock = mineflayerRequire('prismarine-block') as (registry: unknown) => {
  fromStateId(stateId: number, biomeId: number): unknown;
};
const protocol = mineflayerRequire('minecraft-protocol') as {
  readonly states: { readonly PLAY: string };
  createSerializer(options: { readonly state: string; readonly isServer: boolean; readonly version: string }): {
    createPacketBuffer(packet: { readonly name: string; readonly params: unknown }): Buffer;
  };
  createDeserializer(options: { readonly state: string; readonly isServer: boolean; readonly version: string }): {
    parsePacketBuffer(buffer: Buffer): { readonly data: { readonly params: unknown } };
  };
};

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

test('eat waits for the consumed slot update after an early food update', async () => {
  const eating = prepareEating();

  try {
    await waitUntil(eating.consumeStarted);
    eating.harness.bot.food = 15;
    eating.harness.bot.emit('physicsTick');
    eating.finishConsume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(eating.isSettled(), false);

    eating.harness.bot.inventory.slots[36] = null;
    eating.harness.bot.emit('physicsTick');
    assert.deepEqual(await eating.running, { kind: 'succeeded' });
  } finally {
    await eating.harness.owner.close();
    eating.harness.observer.close();
  }
});

test('eat waits for the food update after an early consumed slot update', async () => {
  const eating = prepareEating();

  try {
    await waitUntil(eating.consumeStarted);
    eating.harness.bot.inventory.slots[36] = null;
    eating.harness.bot.emit('physicsTick');
    eating.finishConsume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(eating.isSettled(), false);

    eating.harness.bot.food = 15;
    eating.harness.bot.emit('physicsTick');
    assert.deepEqual(await eating.running, { kind: 'succeeded' });
  } finally {
    await eating.harness.owner.close();
    eating.harness.observer.close();
  }
});

test('eat accepts a consumed golden apple slot receipt at full hunger', async () => {
  const eating = prepareEating('golden_apple', 20);

  try {
    await waitUntil(eating.consumeStarted);
    eating.harness.bot.inventory.slots[36] = null;
    eating.finishConsume();
    assert.deepEqual(await eating.running, { kind: 'succeeded' });
  } finally {
    await eating.harness.owner.close();
    eating.harness.observer.close();
  }
});

test('eat cancellation stops waiting for a consumed slot update', async () => {
  const eating = prepareEating();

  try {
    await waitUntil(eating.consumeStarted);
    eating.harness.bot.food = 15;
    eating.finishConsume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(eating.isSettled(), false);

    const cancellation = eating.harness.owner.cancel('shutdown');
    assert.deepEqual(await eating.running, { kind: 'cancelled', reason: 'shutdown' });
    await cancellation;
  } finally {
    await eating.harness.owner.close();
    eating.harness.observer.close();
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

test('worker admits a fourth search while three valid paths are still being followed', async () => {
  const labels = ['seat-0', 'seat-1', 'seat-2', 'seat-3'] as const;
  const searchAggregates = new Map<string, {
    queued: number;
    acquired: number;
    released: number;
    cancelled: number;
    timedOut: number;
  }>(labels.map((label) => [label, {
    queued: 0,
    acquired: 0,
    released: 0,
    cancelled: 0,
    timedOut: 0,
  }]));
  const successfulPathUpdates = new Map<string, number>(labels.map((label) => [label, 0]));
  const originalCompute = AStar.prototype.compute;
  const computeCalls = [0, 0, 0, 0];
  let harnesses: ReturnType<typeof makeHarness>[] = [];
  const computeStub = function (this: { readonly movements: { readonly bot: Bot } }): unknown {
    const index = harnesses.findIndex((harness) => harness.bot === this.movements.bot);
    assert.notEqual(index, -1);
    computeCalls[index] = (computeCalls[index] ?? 0) + 1;
    return {
      status: 'success',
      cost: 1,
      time: 0.5,
      visitedNodes: 2,
      generatedNodes: 2,
      path: [new PathMove(8, 64, 0, 0, 1)],
    };
  };
  AStar.prototype.compute = computeStub;
  let rings: PathDiagnosticRing[] = [];
  let runs: Promise<unknown>[] = [];

  try {
    harnesses = labels.map(() => makeHarness(() => undefined, () => undefined, true));
    rings = harnesses.map((harness, index) => {
      let clientMs = 0;
      const clientLabel = labels[index];
      assert.ok(clientLabel);
      return new PathDiagnosticRing(harness.bot, {
        clientLabel,
        clock: () => ({ clientMs: clientMs++, authorityTick: null }),
        onRecord: (record) => {
          if (record.kind === 'pathSearch') {
            const aggregate = searchAggregates.get(record.clientLabel);
            if (aggregate !== undefined) aggregate[record.transition] += 1;
          } else if (record.kind === 'pathUpdate' && record.path.status === 'success') {
            const count = successfulPathUpdates.get(record.clientLabel);
            if (count !== undefined) successfulPathUpdates.set(record.clientLabel, count + 1);
          }
        },
      });
    });
    runs = harnesses.map((harness) => harness.owner.run({
      kind: 'navigate',
      target: blockPosition(20, 64, 0),
    }));

    await waitUntil(() => harnesses.every((harness) => harness.pathfinder.goal !== null));
    for (const harness of harnesses.slice(0, 3)) harness.bot.emit('physicsTick');
    await waitUntil(() => computeCalls.slice(0, 3).every((count) => count === 1));
    assert.deepEqual(labels.slice(0, 3).map((label) => successfulPathUpdates.get(label)), [1, 1, 1]);
    assert.deepEqual(harnesses.slice(0, 3).map((harness) => harness.pathfinder.isMoving()), [true, true, true]);

    harnesses[3]?.bot.emit('physicsTick');
    await waitUntil(() => computeCalls[3] === 1);
    assert.equal(successfulPathUpdates.get('seat-3'), 1);
    assert.deepEqual(labels.map((label) => searchAggregates.get(label)?.acquired), [1, 1, 1, 1]);
    assert.deepEqual(labels.map((label) => searchAggregates.get(label)?.released), [1, 1, 1, 1]);
    assert.deepEqual(harnesses.slice(0, 3).map((harness) => harness.pathfinder.isMoving()), [true, true, true]);
  } finally {
    await Promise.all(harnesses.map((harness) => harness.owner.cancel('shutdown')));
    await Promise.all(runs);
    for (const ring of rings) {
      ring.snapshot();
      ring.close();
    }
    await Promise.all(harnesses.map((harness) => harness.owner.close()));
    for (const harness of harnesses) harness.observer.close();
    assert.equal(AStar.prototype.compute, computeStub, 'the final owner restores the pathfinder compute method');
    AStar.prototype.compute = originalCompute;
  }
});

test('path worker preserves AStar frontiers and rotates registered owners fairly', async () => {
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let nowMs = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => nowMs });
  const labels = ['seat-0', 'seat-1', 'seat-2', 'seat-3', 'seat-4'] as const;
  const acquiredOrder: string[] = [];
  const transitions = new Map<string, Record<'queued' | 'acquired' | 'released' | 'cancelled' | 'timedOut', number>>(labels.map((label) => [label, {
    queued: 0,
    acquired: 0,
    released: 0,
    cancelled: 0,
    timedOut: 0,
  }]));
  const pathUpdates = new Map<string, Array<{
    status: string;
    visitedNodes: number;
    generatedNodes: number;
  }>>(labels.map((label) => [label, []]));
  const capturedContexts = new Map<string, Array<{ tickTimeout: number }>>(labels.map((label) => [label, []]));
  const expansions = [0, 0, 0, 0, 0];
  let harnesses: ReturnType<typeof makeHarness>[] = [];
  let rings: PathDiagnosticRing[] = [];
  let runs: Promise<unknown>[] = [];

  try {
    harnesses = labels.map(() => makeHarness(() => undefined, () => undefined, true));
    for (const [index, harness] of harnesses.entries()) {
      const movements = harness.pathfinder.movements;
      movements.getNeighbors = (node) => {
        expansions[index] = (expansions[index] ?? 0) + 1;
        if (index === 0 && expansions[index] === 1) nowMs += 4;
        if (node.x >= 8) return [];
        return [new PathMove(node.x + 1, node.y, node.z, 0, 1)];
      };
      const runtimePathfinder = harness.pathfinder as unknown as {
        getPathTo: (...args: unknown[]) => unknown;
      };
      const originalGetPathTo = runtimePathfinder.getPathTo;
      runtimePathfinder.getPathTo = (...args) => {
        const result = originalGetPathTo(...args) as {
          readonly context?: { readonly tickTimeout: number };
        };
        if (result.context !== undefined) capturedContexts.get(labels[index] as string)?.push(result.context);
        return result;
      };
    }
    rings = harnesses.map((harness, index) => {
      let clientMs = 0;
      const clientLabel = labels[index];
      assert.ok(clientLabel);
      return new PathDiagnosticRing(harness.bot, {
        clientLabel,
        clock: () => ({ clientMs: clientMs++, authorityTick: null }),
        onRecord: (record) => {
          if (record.kind === 'pathSearch') {
            const aggregate = transitions.get(record.clientLabel);
            if (aggregate === undefined) throw new Error(`missing path-search aggregate for ${record.clientLabel}`);
            aggregate[record.transition] = (aggregate[record.transition] ?? 0) + 1;
            if (record.transition === 'acquired') acquiredOrder.push(record.clientLabel);
          } else if (record.kind === 'pathUpdate') {
            const records = pathUpdates.get(record.clientLabel);
            if (records === undefined) throw new Error(`missing path-update aggregate for ${record.clientLabel}`);
            records.push({
              status: record.path.status,
              visitedNodes: record.path.visitedNodes,
              generatedNodes: record.path.generatedNodes,
            });
          }
        },
      });
    });
    runs = harnesses.map((harness) => harness.owner.run({
      kind: 'navigateToBlock',
      target: blockPosition(8, 64, 0),
    }));
    await waitUntil(() => harnesses.every((harness) => harness.pathfinder.goal !== null));

    for (const harness of harnesses) harness.bot.emit('physicsTick');
    await waitUntil(() => labels.every((label) => (pathUpdates.get(label)?.length ?? 0) > 0));
    assert.deepEqual(acquiredOrder, ['seat-0']);
    assert.deepEqual(expansions, [1, 0, 0, 0, 0]);
    assert.deepEqual(labels.map((label) => capturedContexts.get(label)?.[0]?.tickTimeout), [3, 3, 3, 3, 3]);
    assert.deepEqual(pathUpdates.get('seat-0')?.[0], {
      status: 'partial',
      visitedNodes: 1,
      generatedNodes: 2,
    });
    for (const label of labels.slice(1)) {
      assert.deepEqual(pathUpdates.get(label)?.[0], {
        status: 'partial',
        visitedNodes: 0,
        generatedNodes: 1,
      });
    }

    const ordinaryMovements = {
      bot: {} as Bot,
      getNeighbors: () => [],
    };
    const ordinaryContext = new AStar(
      new PathMove(0, 64, 0, 0, 0),
      ordinaryMovements,
      new goals.GoalBlock(8, 64, 0),
      1_000,
      3,
      -1,
    );
    assert.equal((ordinaryContext.compute() as { readonly status: string }).status, 'noPath');

    const firstHarness = harnesses[0];
    const secondHarness = harnesses[1];
    const clearHarness = harnesses[3];
    const lastHarness = harnesses[4];
    assert.ok(firstHarness);
    assert.ok(secondHarness);
    assert.ok(clearHarness);
    assert.ok(lastHarness);
    const unsupportedMovements = new Movements(firstHarness.bot);
    const unsupportedContext = new AStar(
      new PathMove(0, 64, 0, 0, 0),
      unsupportedMovements,
      new goals.GoalBlock(8, 64, 0),
      1_000,
      3,
      -1,
    );
    assert.throws(() => unsupportedContext.compute(), /unregistered Movements/);
    class UnsupportedAStar extends AStar {}
    const unsupportedClassContext = new UnsupportedAStar(
      new PathMove(0, 64, 0, 0, 0),
      firstHarness.pathfinder.movements,
      new goals.GoalBlock(8, 64, 0),
      1_000,
      3,
      -1,
    );
    assert.throws(() => unsupportedClassContext.compute(), /unsupported AStar context/);

    const queuedCancellation = secondHarness.owner.cancel('shutdown');
    assert.deepEqual(await runs[1], { kind: 'cancelled', reason: 'shutdown' });
    await queuedCancellation;
    assert.equal(transitions.get('seat-1')?.cancelled, 1);

    clearHarness.pathfinder.setGoal(null, false);
    assert.equal(transitions.get('seat-3')?.cancelled, 1);
    const clearedGoalCancellation = clearHarness.owner.cancel('shutdown');
    assert.deepEqual(await runs[3], { kind: 'cancelled', reason: 'shutdown' });
    await clearedGoalCancellation;

    firstHarness.pathfinder.setGoal(new goals.GoalBlock(8, 64, 0), false);
    firstHarness.bot.emit('physicsTick');
    await waitUntil(() => (pathUpdates.get('seat-0')?.length ?? 0) >= 2);
    assert.equal(expansions[0], 1, 'a reset context remains queued behind the same owner and keeps its frontier');
    assert.equal(capturedContexts.get('seat-0')?.length, 2);
    assert.notEqual(capturedContexts.get('seat-0')?.[0], capturedContexts.get('seat-0')?.[1]);
    assert.deepEqual(capturedContexts.get('seat-0')?.map((context) => context.tickTimeout), [3, 3]);
    const thirdHarness = harnesses[2];
    assert.ok(thirdHarness);
    thirdHarness.bot.emit('physicsTick');
    assert.equal(expansions[2], 0, 'later owners cannot pass the reset owner at the FIFO head');

    nowMs = 10;
    firstHarness.bot.emit('physicsTick');
    await waitUntil(() => pathUpdates.get('seat-0')?.some((record) => record.status === 'success') === true);
    thirdHarness.bot.emit('physicsTick');
    await waitUntil(() => pathUpdates.get('seat-2')?.some((record) => record.status === 'success') === true);
    assert.deepEqual(acquiredOrder, ['seat-0', 'seat-0', 'seat-2']);
    assert.deepEqual(labels.slice(0, 3).map((label) => capturedContexts.get(label)?.every((context) => context.tickTimeout === 3)), [true, true, true]);

    nowMs = 20_000;
    lastHarness.bot.emit('physicsTick');
    await waitUntil(() => transitions.get('seat-4')?.timedOut === 1);
    assert.equal(transitions.get('seat-4')?.acquired, 0);
  } finally {
    await Promise.all(harnesses.map((harness) => harness.owner.cancel('shutdown')));
    await Promise.all(runs);
    for (const ring of rings) {
      ring.snapshot();
      ring.close();
    }
    await Promise.all(harnesses.map((harness) => harness.owner.close()));
    for (const harness of harnesses) harness.observer.close();
    if (clockDescriptor === undefined) Reflect.deleteProperty(performance, 'now');
    else Object.defineProperty(performance, 'now', clockDescriptor);
  }
});

test('path worker keeps an exact goal node intact across pinned pathfinder postprocessing', async () => {
  const harness = makeHarness(() => undefined, () => undefined, true);
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let nowMs = 0;
  const ring = new PathDiagnosticRing(harness.bot, {
    clientLabel: 'partial-path-snapshot',
    clock: () => ({ clientMs: nowMs, authorityTick: 0 }),
  });

  try {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => nowMs });
    const goal = new goals.GoalBlock(31, 66, 21);
    const goalMove = new PathMove(31, 66, 21, 0, 2.414213562373095);
    const supportBlock = {
      name: 'cobblestone',
      type: 1,
      stateId: 42,
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: new PathMove(31, 65, 21, 0, 1),
    } as unknown as NonNullable<ReturnType<Bot['blockAt']>>;
    Object.assign(harness.bot.entity, { position: new PathMove(29, 65, 23, 0, 0) });
    Object.assign(harness.bot, {
      blockAt: (position: { readonly x: number; readonly y: number; readonly z: number }) => (
        position.x === 31 && position.y === 65 && position.z === 21 ? supportBlock : null
      ),
    });

    const movements = harness.pathfinder.movements as InstanceType<typeof Movements>;
    let neighborCalls = 0;
    movements.getNeighbors = () => {
      neighborCalls += 1;
      nowMs += 4;
      return [goalMove];
    };
    const pathfinder = harness.pathfinder as unknown as {
      getPathFromTo(
        movements: InstanceType<typeof Movements>,
        startPos: Bot['entity']['position'],
        goal: InstanceType<typeof goals.GoalBlock>,
        options: { readonly timeout: number; readonly tickTimeout: number },
      ): Generator<{
        readonly result: {
          readonly status: string;
          readonly path: Array<Parameters<typeof goal.isEnd>[0] & {
            readonly toBreak: unknown[];
            readonly toPlace: unknown[];
          }>;
          readonly visitedNodes: number;
          readonly generatedNodes: number;
        };
        readonly astarContext: {
          readonly bestNode: { readonly data: Parameters<typeof goal.isEnd>[0] };
          readonly openDataMap: Map<string, { readonly data: Parameters<typeof goal.isEnd>[0] }>;
          readonly tickTimeout: number;
          compute(): { readonly status: string };
        };
      }, void, unknown>;
    };
    const search = pathfinder.getPathFromTo(movements, harness.bot.entity.position, goal, {
      timeout: 1_000,
      tickTimeout: 3,
    });
    const nextYield = () => {
      const yielded = search.next();
      if (yielded.done) throw new Error('pathfinder search ended before yielding a result');
      return yielded.value;
    };
    const searchTransitions = () => ring.snapshot()
      .filter((record) => record.kind === 'pathSearch')
      .map((record) => record.transition);
    const firstYield = nextYield();

    const first = firstYield.result;
    const context = firstYield.astarContext;
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.path.map(({ x, y, z }) => ({ x, y, z })), [{ x: 31.5, y: 66, z: 21.5 }]);
    const firstFollowedGoal = first.path[0];
    assert.ok(firstFollowedGoal);
    assert.notEqual(firstFollowedGoal, goalMove);
    assert.equal(Object.getPrototypeOf(firstFollowedGoal), Object.getPrototypeOf(goalMove));
    assert.notEqual(firstFollowedGoal.toBreak, goalMove.toBreak);
    assert.notEqual(firstFollowedGoal.toPlace, goalMove.toPlace);
    assert.equal(context.tickTimeout, 3);
    const frontierGoal = context.bestNode.data;
    assert.equal(context.openDataMap.get('31,66,21')?.data, frontierGoal);
    assert.deepEqual({ x: frontierGoal.x, y: frontierGoal.y, z: frontierGoal.z }, { x: 31, y: 66, z: 21 });
    assert.equal(goal.isEnd(frontierGoal), true);
    assert.equal(neighborCalls, 1);
    assert.deepEqual(searchTransitions(), ['acquired', 'released', 'queued']);

    const deniedYield = nextYield();
    const denied = deniedYield.result;
    const deniedGoal = denied.path[0];
    assert.equal(nowMs, 4);
    assert.equal(denied.status, 'partial');
    assert.deepEqual(denied.path.map(({ x, y, z }) => ({ x, y, z })), [{ x: 31.5, y: 66, z: 21.5 }]);
    assert.ok(deniedGoal);
    assert.notEqual(deniedGoal, goalMove);
    assert.notEqual(deniedGoal, firstFollowedGoal);
    assert.equal(Object.getPrototypeOf(deniedGoal), Object.getPrototypeOf(goalMove));
    assert.notEqual(deniedGoal.toBreak, goalMove.toBreak);
    assert.notEqual(deniedGoal.toPlace, goalMove.toPlace);
    assert.notEqual(deniedGoal.toBreak, firstFollowedGoal.toBreak);
    assert.notEqual(deniedGoal.toPlace, firstFollowedGoal.toPlace);
    assert.equal(denied.visitedNodes, first.visitedNodes);
    assert.equal(denied.generatedNodes, first.generatedNodes);
    assert.equal(neighborCalls, 1);
    assert.equal(context.bestNode.data, frontierGoal);
    assert.deepEqual({ x: frontierGoal.x, y: frontierGoal.y, z: frontierGoal.z }, { x: 31, y: 66, z: 21 });
    assert.equal(goal.isEnd(frontierGoal), true);
    assert.equal(context.tickTimeout, 3);
    assert.deepEqual(searchTransitions(), ['acquired', 'released', 'queued']);

    nowMs = 10;
    const successYield = nextYield();
    assert.equal(successYield.result.status, 'success');
    assert.deepEqual(successYield.result.path.map(({ x, y, z }) => ({ x, y, z })), [{ x: 31.5, y: 66, z: 21.5 }]);
    assert.equal(context.bestNode.data, frontierGoal);
    assert.equal(goal.isEnd(frontierGoal), true);
  } finally {
    await harness.owner.close();
    harness.observer.close();
    ring.close();
    if (clockDescriptor === undefined) Reflect.deleteProperty(performance, 'now');
    else Object.defineProperty(performance, 'now', clockDescriptor);
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

    ring.setExternalMovementOwner(null);
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
      flags: { _value: 160, x: false, y: false, z: false, yaw: false, pitch: false, dx: true, dy: false, dz: true, yawDelta: false },
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
    assert.equal(afterCleanup.owner, null);
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
    assert.deepEqual(
      ring.snapshot().filter((record) => record.kind === 'externalMovementOwner').map((record) => record.owner),
      ['sprintCourse', null],
    );
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
      flags: {
        _value: 0,
        x: false,
        y: false,
        z: false,
        yaw: false,
        pitch: false,
        dx: false,
        dy: false,
        dz: false,
        yawDelta: false,
      },
      teleportId: 1,
    });
    assert.throws(() => ring.snapshot(), /path diagnostic capture failed/);
  } finally {
    ring.close();
    await harness.owner.close();
    harness.observer.close();
  }
});

test('opt-in path diagnostics accept position flags decoded from the 26.1 packet', async () => {
  const harness = makeHarness();
  Object.assign(harness.bot, {
    entity: {
      id: 1,
      position: new TestPosition(0, 64, 0),
      velocity: new TestPosition(0, 0, 0),
      onGround: true,
    },
  });
  const ring = new PathDiagnosticRing(harness.bot, {
    clientLabel: 'decoded-correction-test',
    clock: () => ({ clientMs: 0, authorityTick: null }),
  });

  try {
    const packet = decodePositionPacket();
    assert.deepEqual(packet.flags, {
      _value: 9,
      x: true,
      y: false,
      z: false,
      yaw: true,
      pitch: false,
      dx: false,
      dy: false,
      dz: false,
      yawDelta: false,
    });
    (harness.bot._client as unknown as EventEmitter).emit('position', packet);
    const correction = ring.snapshot().find((record) => record.kind === 'positionCorrection');
    assert.ok(correction);
    assert.deepEqual(correction.packet.flags, {
      x: true,
      y: false,
      z: false,
      yaw: true,
      pitch: false,
      dx: false,
      dy: false,
      dz: false,
      yawDelta: false,
    });
  } finally {
    ring.close();
    await harness.owner.close();
    harness.observer.close();
  }
});

test('opt-in path diagnostics require the complete 26.1 position correction flags', async () => {
  const completeFlags = {
    _value: 0,
    x: false,
    y: false,
    z: false,
    yaw: false,
    pitch: false,
    dx: false,
    dy: false,
    dz: false,
    yawDelta: false,
  };
  const missingFlag: Record<string, unknown> = { ...completeFlags };
  delete missingFlag.yawDelta;
  const invalidFlags: readonly unknown[] = [
    missingFlag,
    { ...completeFlags, dx: 0 },
    { ...completeFlags, futureFlag: false },
    { ...completeFlags, _value: 1 },
    { ...completeFlags, _value: 512 },
    { ...completeFlags, _value: -1 },
    { ...completeFlags, _value: 1.5 },
    0,
  ];

  for (const flags of invalidFlags) {
    const harness = makeHarness();
    const ring = new PathDiagnosticRing(harness.bot, {
      clientLabel: 'invalid-flags-test',
      clock: () => ({ clientMs: 0, authorityTick: null }),
    });
    try {
      (harness.bot._client as unknown as EventEmitter).emit('position', {
        x: 1,
        y: 2,
        z: 3,
        dx: 0,
        dy: 0,
        dz: 0,
        yaw: 0,
        pitch: 0,
        flags,
        teleportId: 1,
      });
      assert.throws(() => ring.snapshot(), /path diagnostic capture failed/);
    } finally {
      ring.close();
      await harness.owner.close();
      harness.observer.close();
    }
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

function prepareEating(name = 'bread', food = 10) {
  const harness = makeHarness();
  type Item = NonNullable<Bot['inventory']['slots'][number]>;
  const foodItem = { name, type: 3, metadata: 0, count: 1, slot: 9 } as Item;
  Object.assign(harness.bot.registry.foodsByName, { [name]: {} });
  Object.assign(harness.bot, { food });
  harness.bot.inventory.slots[9] = foodItem;
  let consumeStarted = false;
  let finishConsume!: () => void;
  Object.assign(harness.bot, {
    equip: async (item: Item, destination: string) => {
      assert.equal(item, foodItem);
      assert.equal(destination, 'hand');
      harness.bot.inventory.slots[9] = null;
      const heldFood = { ...foodItem, slot: 36 } as Item;
      harness.bot.inventory.slots[36] = heldFood;
      Object.assign(harness.bot, { quickBarSlot: 0, heldItem: heldFood });
    },
    consume: () => {
      consumeStarted = true;
      return new Promise<void>((resolve) => { finishConsume = resolve; });
    },
  });
  const running = harness.owner.run({ kind: 'eat', inventorySlot: inventorySlot(9) });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  return {
    harness,
    running,
    consumeStarted: () => consumeStarted,
    finishConsume: () => finishConsume(),
    isSettled: () => settled,
  };
}

function makeHarness(
  onPathStarted: () => void = () => undefined,
  onPathStopped: () => void = () => undefined,
  useRealPathfinder = false,
) {
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
  const names = ['chest', 'fire', 'cobweb', 'web', 'lava', 'water', 'sand', 'gravel', 'ladder', 'vine', 'air'];
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
    world: makeSkillWorld(),
    health: 20,
    food: 10,
    quickBarSlot: 0,
    currentWindow: null,
    heldItem: null,
    usingHeldItem: false,
    hasPlugin: () => !useRealPathfinder,
    loadPlugin: (plugin: unknown) => {
      if (!useRealPathfinder || typeof plugin !== 'function') throw new Error('unexpected plugin load in fake pathfinder harness');
      (plugin as (bot: Bot) => void)(botEmitter as unknown as Bot);
    },
    blockAt: () => null,
    look: () => undefined,
    setControlState: (control: keyof Bot['controlState'], state: boolean) => {
      const controlState = (botEmitter as unknown as { controlState?: Bot['controlState'] }).controlState;
      if (controlState !== undefined) controlState[control] = state;
    },
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
  if (useRealPathfinder) {
    Object.assign(bot, {
      version: '26.1.2',
      entity: {
        id: 1,
        position: new PathMove(0, 64, 0, 0, 0),
        velocity: new PathMove(0, 0, 0, 0, 0),
        onGround: true,
        isInWater: false,
        isInLava: false,
        isInWeb: false,
        isCollidedHorizontally: false,
        isCollidedVertically: false,
        elytraFlying: false,
        effects: {},
        attributes: {},
        yaw: 0,
        pitch: 0,
      },
      controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
      entities: {},
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      physics: { simulatePlayer: (state: unknown) => state },
    });
  }
  const observer = new MineflayerObserver(bot);
  client.emit('initialize_world_border', {
    x: 0,
    z: 0,
    oldDiameter: 100,
    newDiameter: 100,
    speed: 0,
  });
  const owner = new SkillOwner(bot, observer);
  return { bot, observer, owner, pathfinder: bot.pathfinder, controlsCleared: () => controlsCleared };
}

function prepareChest(bot: Bot): void {
  const block = {
    name: 'chest',
    position: new TestPosition(1, 64, 0),
  } as NonNullable<ReturnType<Bot['blockAt']>>;
  Object.assign(bot, {
    entity: {
      id: 1,
      position: new TestPosition(0, 64, 0),
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
    },
    blockAt: () => block,
  });
}

function makeSkillWorld(): Bot['world'] {
  const World = createPrismarineWorld('26.1.2');
  const world = new World(null);
  const registry = minecraftData('26.1.2');
  const blockFactory = createPrismarineBlock(registry);
  const airState = registry.blocksByName.air.defaultState;
  const setColumn = (world.sync as unknown as {
    setColumn(
      chunkX: number,
      chunkZ: number,
      column: { getBlock(position: Bot['entity']['position']): unknown },
    ): void;
  }).setColumn.bind(world.sync);

  for (let chunkX = -1; chunkX <= 0; chunkX += 1) {
    for (let chunkZ = -1; chunkZ <= 0; chunkZ += 1) {
      setColumn(chunkX, chunkZ, {
        getBlock: () => blockFactory.fromStateId(airState, 0),
      });
    }
  }

  return world.sync;
}

class TestPosition extends Vec3 {}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true');
}

function decodePositionPacket(): Record<string, unknown> {
  const options = { state: protocol.states.PLAY, version: '26.1' };
  const serializer = protocol.createSerializer({ ...options, isServer: true });
  const deserializer = protocol.createDeserializer({ ...options, isServer: false });
  const encoded = serializer.createPacketBuffer({
    name: 'position',
    params: {
      teleportId: 1,
      x: 1,
      y: 2,
      z: 3,
      dx: 0.25,
      dy: 0,
      dz: -0.25,
      yaw: 45,
      pitch: 10,
      flags: {
        _value: 0,
        x: true,
        y: false,
        z: false,
        yaw: true,
        pitch: false,
        dx: false,
        dy: false,
        dz: false,
        yawDelta: false,
      },
    },
  });
  return deserializer.parsePacketBuffer(encoded).data.params as Record<string, unknown>;
}
