import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot, GameMode } from 'mineflayer';
import { PolicyCompetitorGate } from '../src/runtime/policy-gate.js';

class PolicyBotEvents extends EventEmitter {
  game = { gameMode: 'survival' as GameMode };
  health = 20;
}

test('policy gate disables a spectator seat on Mineflayer game-state change', () => {
  const events = new PolicyBotEvents();
  const bot = events as unknown as Bot;
  let disabled = 0;
  const gate = new PolicyCompetitorGate(bot, () => { disabled += 1; });

  assert.equal(gate.active, true);
  events.game.gameMode = 'spectator';
  events.emit('game');

  assert.equal(gate.active, false);
  assert.equal(disabled, 1);

  events.game.gameMode = 'survival';
  events.emit('game');
  assert.equal(gate.active, false);
  assert.equal(disabled, 1);

  gate.close();
  assert.equal(events.listenerCount('game'), 0);
  assert.equal(events.listenerCount('death'), 0);
});

test('policy gate disables on Mineflayer death even when health was not changed', () => {
  const events = new PolicyBotEvents();
  const bot = events as unknown as Bot;
  let disabled = 0;
  const gate = new PolicyCompetitorGate(bot, () => { disabled += 1; });

  events.emit('death');

  assert.equal(gate.active, false);
  assert.equal(disabled, 1);
});

test('policy gate permits survival and adventure, but closes on other modes', () => {
  const events = new PolicyBotEvents();
  const bot = events as unknown as Bot;
  let disabled = 0;
  const gate = new PolicyCompetitorGate(bot, () => { disabled += 1; });

  events.game.gameMode = 'adventure';
  events.emit('game');
  assert.equal(gate.active, true);
  events.game.gameMode = 'creative';
  events.emit('game');
  assert.equal(gate.active, false);
  assert.equal(disabled, 1);
});
