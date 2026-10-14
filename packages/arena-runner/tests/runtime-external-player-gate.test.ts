import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot, Player } from 'mineflayer';
import { RunnerError } from '../src/errors.js';
import { waitForExternalPlayer } from '../src/runtime/external-player-gate.js';
import type { PlayerIdentity } from '../src/runtime/observations.js';

const alex: PlayerIdentity = { username: 'Alex_9', offlineUuid: '3f38a359-bcf8-3c78-b7ca-9e6b091f278d' };

function fakePlayer(username: string, uuid = `uuid-${username}`): Player {
  return { username, uuid } as Player;
}

function fakeBot(players: Record<string, object> = {}): Bot {
  return Object.assign(new EventEmitter(), { players }) as unknown as Bot;
}

function spectatorAdmission(...names: string[]) {
  return { kind: 'spectator' as const, runtimeUsernames: new Set(names) };
}

function competitorAdmission(runtime: readonly string[], ...identities: PlayerIdentity[]) {
  return { kind: 'competitors' as const, identities, runtimeUsernames: new Set(runtime) };
}

test('waits for one player outside the runtime roster and releases every listener', async () => {
  const first = fakeBot();
  const second = fakeBot();
  const controller = new AbortController();
  const waiting = waitForExternalPlayer({
    observers: [first, second],
    admission: spectatorAdmission('ArenaBot0', 'ArenaSpec0'),
    signal: controller.signal,
  });
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
  await waitForExternalPlayer({
    observers: [bot],
    admission: spectatorAdmission('ArenaBot0'),
    signal: new AbortController().signal,
  });
  assert.equal(bot.listenerCount('playerJoined'), 0);
});

test('cancellation removes player-join listeners and preserves its reason', async () => {
  const bot = fakeBot();
  const controller = new AbortController();
  const reason = new Error('operator cancelled');
  const waiting = waitForExternalPlayer({
    observers: [bot],
    admission: spectatorAdmission('ArenaBot0'),
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  assert.equal(bot.listenerCount('playerJoined'), 1);
  controller.abort(reason);
  await assert.rejects(waiting, (error: unknown) => error === reason);
  assert.equal(bot.listenerCount('playerJoined'), 0);
  assert.equal(bot.listenerCount('end'), 0);
});

test('fails and removes listeners when every observer disconnects', async () => {
  const first = fakeBot();
  const second = fakeBot();
  const waiting = waitForExternalPlayer({
    observers: [first, second],
    admission: spectatorAdmission('ArenaBot0'),
    signal: new AbortController().signal,
  });
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

test('competitor admission is not satisfied by a different identity', async () => {
  const bot = fakeBot();
  const unexpected: string[] = [];
  const waiting = waitForExternalPlayer({
    observers: [bot],
    admission: competitorAdmission(['ArenaBot1'], alex),
    signal: new AbortController().signal,
    timeoutMs: 40,
    onUnexpectedPlayer: (username) => unexpected.push(username),
  });
  bot.players.Josh = fakePlayer('Josh');
  bot.emit('playerJoined', fakePlayer('Josh'));
  bot.players.alex_9 = fakePlayer('alex_9');
  bot.emit('playerJoined', fakePlayer('alex_9'));
  bot.players.ArenaBot1 = fakePlayer('ArenaBot1');
  bot.emit('playerJoined', fakePlayer('ArenaBot1'));
  await assert.rejects(waiting, (error: unknown) => error instanceof RunnerError
    && error.category === 'runtime_failure'
    && error.source.kind === 'external_join_timeout'
    && error.source.field === 'Alex_9');
  assert.deepEqual(unexpected, ['Josh', 'alex_9']);
  assert.equal(bot.listenerCount('playerJoined'), 0);
  assert.equal(bot.listenerCount('end'), 0);
});

test('competitor admission requires the reserved offline UUID as well as the username', async () => {
  const bot = fakeBot();
  const waiting = waitForExternalPlayer({
    observers: [bot],
    admission: competitorAdmission([], alex),
    signal: new AbortController().signal,
    timeoutMs: 40,
  });
  bot.players.Alex_9 = fakePlayer('Alex_9', 'ffffffff-ffff-3fff-bfff-ffffffffffff');
  bot.emit('playerJoined', fakePlayer('Alex_9', 'ffffffff-ffff-3fff-bfff-ffffffffffff'));
  await assert.rejects(waiting, (error: unknown) => error instanceof RunnerError
    && error.source.kind === 'external_join_timeout');
});

test('competitor admission releases once every reserved identity is present', async () => {
  const bot = fakeBot();
  const other: PlayerIdentity = { username: 'Steve_2', offlineUuid: '11111111-1111-3111-8111-111111111111' };
  const admitted: string[] = [];
  const waiting = waitForExternalPlayer({
    observers: [bot],
    admission: competitorAdmission(['ArenaBot1'], alex, other),
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    onAdmitted: (username) => admitted.push(username),
  });
  let released = false;
  void waiting.then(() => { released = true; });
  bot.players.Alex_9 = fakePlayer('Alex_9', alex.offlineUuid);
  bot.emit('playerJoined', fakePlayer('Alex_9', alex.offlineUuid));
  await Promise.resolve();
  assert.equal(released, false);
  bot.players.Steve_2 = fakePlayer('Steve_2', other.offlineUuid);
  bot.emit('playerJoined', fakePlayer('Steve_2', other.offlineUuid));
  await waiting;
  assert.deepEqual(admitted, ['Alex_9', 'Steve_2']);
  assert.equal(bot.listenerCount('playerJoined'), 0);
});

test('cancelling a competitor admission wait cleans up before the timeout fires', async () => {
  const bot = fakeBot();
  const controller = new AbortController();
  const waiting = waitForExternalPlayer({
    observers: [bot],
    admission: competitorAdmission([], alex),
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  controller.abort(new RunnerError('cancelled', 'arena run', { kind: 'cancelled' }));
  await assert.rejects(waiting, (error: unknown) => error instanceof RunnerError && error.category === 'cancelled');
  assert.equal(bot.listenerCount('playerJoined'), 0);
});
