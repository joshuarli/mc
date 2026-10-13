import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import {
  agentObservation, agentState, blockPosition, currentKnowledge, emptyEquipment,
  observationSequence, PolicyParams, tick, unknownKnowledge, worldBorder,
  type SkillOutcome,
} from '@arena/core';
import type { MineflayerArenaClient } from '@arena/bots';
import { LivePolicyLoop } from '../src/runtime/live-policy-loop.js';
import type { PolicyEffectRecordV1, PolicyReplayRecordV1 } from '../src/policy-replay.js';

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function competitor(seat: number, run: MineflayerArenaClient['run'], hold = false) {
  const bot = Object.assign(new EventEmitter(), { health: 20, game: { gameMode: 'survival' } }) as unknown as Bot;
  const client: MineflayerArenaClient = {
    observe: (value) => agentObservation({
      tick: tick(value), sequence: observationSequence(value + 1),
      agent: hold ? unknownKnowledge() : currentKnowledge(agentState({
        position: blockPosition(0, 64, 0), healthHalfHearts: 40, hungerPoints: 20,
        foodStacks: [], equipped: emptyEquipment(), upgrades: [],
      })),
      border: currentKnowledge(worldBorder(0, 0, 100)),
      opponents: currentKnowledge([]), loot: unknownKnowledge(),
    }),
    run,
    cancel: async () => {},
    close: async () => {},
  };
  return { seat, bot, client };
}

async function settle() {
  // Drain the bounded promise chain used by one decision, effect, and checkpoint.
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function fixture(competitors: ReturnType<typeof competitor>[]) {
  const decisions: PolicyReplayRecordV1[] = [];
  const effects: PolicyEffectRecordV1[] = [];
  const checkpoints: { count: number; decisions: number; effects: number }[] = [];
  const failures: unknown[] = [];
  const loop = new LivePolicyLoop({
    trace: {
      recordPolicyDecision: async (record) => { decisions.push(record); },
      recordPolicyEffect: async (record) => { effects.push(record); },
      checkpoint: async (count) => { checkpoints.push({ count, decisions: decisions.length, effects: effects.length }); },
    },
    params: PolicyParams.baseline(), seed: 1n, strategyIntervalTicks: 1n,
    recordPolicy: true, competitors: () => competitors, fail: (error) => failures.push(error),
  });
  return { loop, decisions, effects, checkpoints, failures };
}

test('live policy checkpoints recorded decisions at 199/200/201 and 399/400/401 while effects settle out of order', async () => {
  const slow = pending<SkillOutcome>();
  const fast = competitor(1, async () => ({ kind: 'succeeded' }));
  const state = fixture([competitor(0, () => slow.promise), fast, competitor(2, async () => ({ kind: 'succeeded' }))]);
  for (let value = 0; value < 200; value += 1) {
    state.loop.onTick(value);
    await settle();
    const count = state.decisions.length;
    if ([199, 200, 201, 399, 400, 401].includes(count)) {
      assert.deepEqual(state.checkpoints.map((entry) => entry.count),
        count < 200 ? [] : count < 400 ? [200] : [200, 400]);
    }
  }
  assert.equal(state.decisions.length, 401);
  assert.deepEqual(state.checkpoints.map((entry) => entry.decisions), [200, 400]);
  assert.equal(state.effects.some((effect) => effect.decision_sequence === '1'), false);
  slow.resolve({ kind: 'cancelled', reason: 'shutdown' });
  await settle();
  await state.loop.stopAndJoin();
  assert.deepEqual(state.checkpoints.map((entry) => entry.count), [200, 400]);
  assert.equal(state.effects.at(-1)?.decision_sequence, '1');
  assert.deepEqual(state.failures, []);
});

test('live policy checkpoint does not invent effects for hold or rejected skills', async () => {
  const slow = pending<SkillOutcome>();
  const state = fixture([competitor(0, () => slow.promise), competitor(1, async () => ({ kind: 'succeeded' }), true)]);
  for (let value = 0; value < 200; value += 1) {
    state.loop.onTick(value);
    await settle();
  }
  assert.deepEqual(state.checkpoints.map((entry) => entry.count), [200]);
  assert.equal(state.effects.length, 0);
  const failure = new Error('skill rejected');
  slow.reject(failure);
  await settle();
  assert.deepEqual(state.failures, [failure]);
  assert.equal(state.effects.length, 0);
  await state.loop.stopAndJoin();
});

test('live policy shutdown stops new decisions and records only the joined cancellation effect', async () => {
  const slow = pending<SkillOutcome>();
  const seat = competitor(0, () => slow.promise);
  seat.client.cancel = async () => { slow.resolve({ kind: 'cancelled', reason: 'shutdown' }); };
  const state = fixture([seat]);
  state.loop.onTick(0);
  await settle();
  state.loop.stopLaunching();
  state.loop.onTick(1);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.effects.length, 0);
  await state.loop.stopAndJoin();
  assert.deepEqual(state.effects.map((effect) => effect.skill), [{ kind: 'cancelled', reason: 'shutdown' }]);
  assert.equal(seat.bot.listenerCount('path_update'), 0);
  assert.equal(seat.bot.listenerCount('death'), 0);
});
