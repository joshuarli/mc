import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot, Player } from 'mineflayer';
import { RunnerError } from '../src/errors.js';
import { waitForExternalPlayer } from '../src/runtime/external-player-gate.js';

function fakePlayer(username: string): Player {
  return { username } as Player;
}

function fakeBot(players: Record<string, object> = {}): Bot {
  return Object.assign(new EventEmitter(), { players }) as unknown as Bot;
}

test('waits for one player outside the runtime roster and releases every listener', async () => {
  const first = fakeBot();
  const second = fakeBot();
  const controller = new AbortController();
  const waiting = waitForExternalPlayer([first, second], new Set(['ArenaBot0', 'ArenaSpec0']), controller.signal);
  first.players.ArenaBot0 = fakePlayer('ArenaBot0');
  first.emit('playerJoined', fakePlayer('ArenaBot0'));
  second.players.ArenaSpec0 = fakePlayer('ArenaSpec0');
  second.emit('playerJoined', fakePlayer('ArenaSpec0'));
  let released = false;
  void waiting.then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);

  second.players.Josh = fakePlayer('Josh');
  second.emit('playerJoined', fakePlayer('Josh'));
  await waiting;
  assert.equal(first.listenerCount('playerJoined'), 0);
  assert.equal(second.listenerCount('playerJoined'), 0);
  assert.equal(first.listenerCount('end'), 0);
  assert.equal(second.listenerCount('end'), 0);
});

test('recognizes an external player already present before the wait begins', async () => {
  const bot = fakeBot({ Josh: fakePlayer('Josh') });
  await waitForExternalPlayer([bot], new Set(['ArenaBot0']), new AbortController().signal);
  assert.equal(bot.listenerCount('playerJoined'), 0);
});

test('cancellation removes player-join listeners and preserves its reason', async () => {
  const bot = fakeBot();
  const controller = new AbortController();
  const reason = new Error('operator cancelled');
  const waiting = waitForExternalPlayer([bot], new Set(['ArenaBot0']), controller.signal);
  assert.equal(bot.listenerCount('playerJoined'), 1);
  controller.abort(reason);
  await assert.rejects(waiting, (error: unknown) => error === reason);
  assert.equal(bot.listenerCount('playerJoined'), 0);
  assert.equal(bot.listenerCount('end'), 0);
});

test('fails and removes listeners when every observer disconnects', async () => {
  const first = fakeBot();
  const second = fakeBot();
  const waiting = waitForExternalPlayer([first, second], new Set(['ArenaBot0']), new AbortController().signal);
  first.emit('end', 'closed');
  second.emit('end', 'closed');
  await assert.rejects(waiting, (error: unknown) => error instanceof RunnerError
    && error.category === 'runtime_failure'
    && error.source.kind === 'all_observer_clients_disconnected');
  assert.equal(first.listenerCount('playerJoined'), 0);
  assert.equal(second.listenerCount('playerJoined'), 0);
  assert.equal(first.listenerCount('end'), 0);
  assert.equal(second.listenerCount('end'), 0);
});
