import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { blockPosition } from '@arena/core';
import type { Bot } from 'mineflayer';
import { MineflayerObserver } from '../src/observer.js';
import { SkillOwner } from '../src/skills.js';

test('cancellation stops the owned path and clears client controls before settling', async () => {
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
      moving = goal !== null;
    },
    isMoving: () => moving,
    stop: () => {
      moving = false;
      pathfinder.goal = null;
      botEmitter.emit('path_stop');
    },
  };
  const names = ['chest', 'fire', 'cobweb', 'web', 'lava', 'water', 'sand', 'gravel', 'ladder', 'air'];
  // The cancellation path never expands a search node, so an empty block registry is enough here.
  const registry = {
    version: { type: 'pc', minecraftVersion: '26.1.2', '>=': () => true },
    supportFeature: () => false,
    blocksByName: Object.fromEntries(names.map((name, id) => [name, { id }])),
    blocksArray: [],
    blocksByStateId: {},
    blocks: {},
    itemsByName: { dirt: { id: 1 }, cobblestone: { id: 2 } },
  };
  Object.assign(botEmitter, {
    _client: client,
    registry,
    pathfinder,
    entity: { position: { x: 0, y: 64, z: 0 } },
    quickBarSlot: 0,
    hasPlugin: () => true,
    setQuickBarSlot: (slot: number) => Object.assign(botEmitter, { quickBarSlot: slot }),
    clearControlStates: () => { controlsCleared += 1; },
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

  try {
    const running = owner.run({ kind: 'navigate', target: blockPosition(20, 64, 0) });
    for (let attempt = 0; attempt < 20 && pathfinder.goal === null; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.notEqual(pathfinder.goal, null);

    const cancellation = owner.cancel('shutdown');
    assert.deepEqual(await running, { kind: 'cancelled', reason: 'shutdown' });
    await cancellation;
    assert.equal(pathfinder.goal, null);
    assert.ok(controlsCleared > 0);
  } finally {
    await owner.close();
    observer.close();
  }
});
