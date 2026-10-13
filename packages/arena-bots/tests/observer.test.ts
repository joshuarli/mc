import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { MineflayerObserver } from '../src/observer.js';

test('reports only client-received border state before the client has complete self state', () => {
  const bot = new EventEmitter() as EventEmitter & { _client: EventEmitter };
  bot._client = new EventEmitter();
  const observer = new MineflayerObserver(bot as unknown as Bot, () => 10);

  const beforeBorder = observer.observe(0);
  assert.equal(beforeBorder.agent.kind, 'unknown');
  assert.equal(beforeBorder.border.kind, 'unknown');
  assert.equal(beforeBorder.opponents.kind, 'unknown');
  assert.equal(beforeBorder.loot.kind, 'unknown');

  bot._client.emit('initialize_world_border', {
    x: 8,
    z: -4,
    oldDiameter: 80,
    newDiameter: 80,
    speed: 0,
  });
  const afterBorder = observer.observe(1);
  assert.deepEqual(afterBorder.border, {
    kind: 'current',
    value: { centerX: 8, centerZ: -4, radiusBlocks: 40 },
  });
  assert.equal(afterBorder.agent.kind, 'unknown');

  observer.close();
  assert.equal(bot.listenerCount('spawn'), 0);
  assert.equal(bot._client.listenerCount('initialize_world_border'), 0);
  assert.throws(() => observer.observe(2), /closed/);
});

test('ignores damage events without a client-tracked attacker', () => {
  const bot = new EventEmitter() as EventEmitter & { _client: EventEmitter; entity: { id: number } };
  bot._client = new EventEmitter();
  bot.entity = { id: 17 };
  const observer = new MineflayerObserver(bot as unknown as Bot);

  assert.doesNotThrow(() => bot.emit('entityHurt', bot.entity));
  assert.doesNotThrow(() => bot.emit('entityHurt', bot.entity, undefined));

  observer.close();
});
