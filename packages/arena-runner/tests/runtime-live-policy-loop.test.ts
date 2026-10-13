import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import {
  agentObservation, agentState, blockPosition, currentKnowledge, emptyEquipment,
  observationSequence, PolicyParams, tick, unknownKnowledge, worldBorder,
  visibleOpponent, entityId, type SkillOutcome,
} from '@arena/core';
import type { MineflayerArenaClient } from '@arena/bots';
import { LivePolicyLoop, type PolicyActivityEvent } from '../src/runtime/live-policy-loop.js';
import type { PolicyEffectRecordV1, PolicyReplayRecord } from '../src/policy-replay.js';

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function competitor(seat: number, run: MineflayerArenaClient['run'], hold = false, x = 99) {
  const bot = Object.assign(new EventEmitter(), { health: 20, game: { gameMode: 'survival' } }) as unknown as Bot;
  const client: MineflayerArenaClient = {
    observe: (value) => agentObservation({
      tick: tick(value), sequence: observationSequence(value + 1),
      agent: hold ? unknownKnowledge() : currentKnowledge(agentState({
        position: blockPosition(x, 64, 0), healthHalfHearts: 40, hungerPoints: 20,
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

function fixture(competitors: ReturnType<typeof competitor>[], onActivity?: (event: PolicyActivityEvent) => void) {
  const decisions: PolicyReplayRecord[] = [];
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
    ...(onActivity === undefined ? {} : { onActivity }),
    recordPolicy: true, competitors: () => competitors, fail: (error) => failures.push(error),
  });
  return { loop, decisions, effects, checkpoints, failures };
}

test('live policy checkpoints recorded decisions at 199/200/201 and 399/400/401 while effects settle out of order', async () => {
  const slow = pending<SkillOutcome>();
  const fast = competitor(1, async () => ({ kind: 'succeeded' }));
  const state = fixture([competitor(0, () => slow.promise), fast, competitor(2, async () => ({ kind: 'succeeded' }))]);
  for (let value = 0; value < 134; value += 1) {
    state.loop.onTick(value);
    await settle();
    const count = state.decisions.length;
    if ([199, 200, 201, 399, 400, 401].includes(count)) {
      assert.deepEqual(state.checkpoints.map((entry) => entry.count),
        count < 200 ? [] : count < 400 ? [200] : [200, 400]);
    }
  }
  assert.equal(state.decisions.length, 402);
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
  for (let value = 0; value < 100; value += 1) {
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
  await assert.rejects(state.loop.stopAndJoin(), (error: unknown) => error instanceof Error && error.cause === failure);
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

test('live policy accepts a border preemption on the next cadence before cleanup settles', async () => {
  const skill = pending<SkillOutcome>();
  const cleanup = pending<void>();
  const intents: string[] = [];
  const seat = competitor(0, async (intent) => {
    intents.push(intent.kind);
    return intents.length === 1 ? skill.promise : { kind: 'succeeded' };
  }, false, 0);
  const initialObserve = seat.client.observe;
  const urgentObserve = competitor(0, async () => ({ kind: 'succeeded' })).client.observe;
  let urgent = false;
  seat.client.observe = (value) => urgent ? urgentObserve(value) : initialObserve(value);
  seat.client.cancel = async (reason) => {
    await cleanup.promise;
    skill.resolve({ kind: 'cancelled', reason });
  };
  const state = fixture([seat]);
  state.loop.onTick(0);
  await settle();
  assert.equal(intents.length, 1);
  urgent = true;
  state.loop.onTick(1);
  await settle();
  const accepted = state.decisions[1]!;
  assert.equal(accepted.schema, 'policy-replay-v2');
  if (accepted.schema !== 'policy-replay-v2') throw new Error('expected v2');
  assert.deepEqual(accepted.disposition, { kind: 'replace', action_sequence: '2', replaces_action_sequence: '1', reason: 'higherPriority' });
  assert.equal(intents.length, 1);
  assert.equal(state.effects.length, 0);
  state.loop.onTick(2);
  await settle();
  const reserved = state.decisions[2]!;
  if (reserved.schema !== 'policy-replay-v2') throw new Error('expected v2');
  assert.deepEqual(reserved.disposition, { kind: 'defer', action_sequence: '2', reason: 'cleanupPending' });
  cleanup.resolve();
  await settle();
  assert.equal(intents.length, 2);
  assert.deepEqual(state.effects.map((effect) => effect.skill), [
    { kind: 'cancelled', reason: 'replaced' }, { kind: 'succeeded' },
  ]);
  await state.loop.stopAndJoin();
});

test('live policy keeps a stable active intent and defers lower priority observations', async () => {
  const skill = pending<SkillOutcome>();
  let starts = 0;
  let cancellations = 0;
  const seat = competitor(0, () => { starts += 1; return skill.promise; });
  const escapeObserve = seat.client.observe;
  const exploreObserve = competitor(0, async () => ({ kind: 'succeeded' }), false, 0).client.observe;
  let explore = false;
  seat.client.observe = (value) => explore ? exploreObserve(value) : escapeObserve(value);
  seat.client.cancel = async (reason) => { cancellations += 1; skill.resolve({ kind: 'cancelled', reason }); };
  const state = fixture([seat]);
  state.loop.onTick(0);
  await settle();
  state.loop.onTick(1);
  await settle();
  explore = true;
  state.loop.onTick(2);
  await settle();
  const stable = state.decisions[1]!;
  const lower = state.decisions[2]!;
  if (stable.schema !== 'policy-replay-v2' || lower.schema !== 'policy-replay-v2') throw new Error('expected v2');
  assert.deepEqual(stable.disposition, { kind: 'continue', action_sequence: '1' });
  assert.deepEqual(lower.disposition, { kind: 'defer', action_sequence: '1', reason: 'lowerPriority' });
  assert.equal(starts, 1);
  assert.equal(cancellations, 0);
  await state.loop.stopAndJoin();
  assert.equal(cancellations, 1);
});

test('live policy quarantines a seat when replacement cleanup fails', async () => {
  const skill = pending<SkillOutcome>();
  let starts = 0;
  const seat = competitor(0, () => { starts += 1; return skill.promise; }, false, 0);
  const initialObserve = seat.client.observe;
  const urgentObserve = competitor(0, async () => ({ kind: 'succeeded' })).client.observe;
  seat.client.observe = (value) => value === 0 ? initialObserve(value) : urgentObserve(value);
  const failure = new Error('control cleanup failed');
  seat.client.cancel = async () => { throw failure; };
  const state = fixture([seat]);
  state.loop.onTick(0);
  await settle();
  state.loop.onTick(1);
  await settle();
  assert.equal(starts, 1);
  assert.deepEqual(state.failures, [failure]);
  state.loop.onTick(2);
  assert.equal(state.decisions.length, 2);
  skill.resolve({ kind: 'cancelled', reason: 'shutdown' });
  await settle();
  await assert.rejects(state.loop.stopAndJoin(), (error: unknown) => error instanceof Error && error.cause === failure);
  assert.equal(starts, 1);
  assert.equal(seat.bot.listenerCount('path_update'), 0);
});

test('live policy diagnostic decision timing precedes action settlement and sink errors fail the run', async () => {
  const events: PolicyActivityEvent[] = [];
  const skill = pending<SkillOutcome>();
  const seat = competitor(0, () => skill.promise);
  seat.client.cancel = async (reason) => { skill.resolve({ kind: 'cancelled', reason }); };
  const state = fixture([seat], (event) => events.push(event));
  const received = process.hrtime.bigint();
  state.loop.onTick(0, received);
  await settle();
  assert.equal(events.length, 1);
  const accepted = events[0]!;
  if (accepted.kind !== 'decision') throw new Error('expected decision');
  assert.equal(accepted.tickReceivedAtNs, received);
  assert.ok(accepted.decisionStartedAtNs >= received);
  assert.ok(accepted.acceptedAtNs >= accepted.decisionStartedAtNs);
  await state.loop.stopAndJoin();
  const action = events[1]!;
  if (action.kind !== 'action') throw new Error('expected action');
  assert.equal(action.actionSequence, accepted.sequence);
  assert.ok(action.startedAtNs !== null && action.settledAtNs >= action.startedAtNs);
  assert.equal(action.cleanupIncluded, true);

  const failure = new Error('diagnostic sink failed');
  const rejected = fixture([competitor(0, async () => ({ kind: 'succeeded' }))], () => { throw failure; });
  rejected.loop.onTick(0);
  await settle();
  assert.deepEqual(rejected.failures, [failure]);
  rejected.loop.onTick(1);
  assert.equal(rejected.decisions.length, 1);
  await assert.rejects(rejected.loop.stopAndJoin(), (error: unknown) => error instanceof Error && error.cause === failure);
});

test('live policy feeds a failed action its initiating permitted observation before the next decision', async () => {
  const seat = competitor(0, async () => ({ kind: 'failed', cause: 'noProgress' }), false, 0);
  const state = fixture([seat]);
  state.loop.onTick(0);
  await settle();
  state.loop.onTick(1);
  await settle();
  const next = state.decisions[1]!;
  if (next.schema !== 'policy-replay-v2') throw new Error('expected v2');
  assert.equal(next.input.feedback.length, 1);
  assert.equal(next.input.feedback[0]?.kind, 'failed');
  assert.equal(next.decision.memory.failedTargets.length, 1);
  assert.notDeepEqual(next.decision.intent, state.decisions[0]!.decision.intent);
  await state.loop.stopAndJoin();
});

test('live policy reobserves an active skill on the next configured tick', async () => {
  const skill = pending<SkillOutcome>();
  const seat = competitor(0, () => skill.promise);
  let observations = 0;
  const observe = seat.client.observe;
  seat.client.observe = (value) => { observations += 1; return observe(value); };
  seat.client.cancel = async () => { skill.resolve({ kind: 'cancelled', reason: 'shutdown' }); };
  const state = fixture([seat]);
  try {
    state.loop.onTick(0);
    await settle();
    state.loop.onTick(1);
    await settle();
    assert.equal(observations, 2);
    assert.equal(state.effects.length, 0);
  } finally { await state.loop.stopAndJoin(); }
});

test('live policy cancels superseded reservations without starting them while one owner cleans up', async () => {
  const skill = pending<SkillOutcome>();
  const cleanup = pending<void>();
  const activity: PolicyActivityEvent[] = [];
  let starts = 0;
  const seat = competitor(0, () => { starts += 1; return starts === 1 ? skill.promise : Promise.resolve({ kind: 'succeeded' }); }, false, 0);
  const initialObserve = seat.client.observe;
  const borderObserve = competitor(0, async () => ({ kind: 'succeeded' })).client.observe;
  seat.client.observe = (value) => value === 0 ? initialObserve(value) : value >= 2 ? borderObserve(value) : agentObservation({
    tick: tick(value), sequence: observationSequence(value + 1),
    agent: currentKnowledge(agentState({ position: blockPosition(0, 64, 0), healthHalfHearts: 4, hungerPoints: 20,
      foodStacks: [], equipped: emptyEquipment(), upgrades: [] })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([visibleOpponent(entityId(1), blockPosition(1, 64, 0), false)]), loot: unknownKnowledge(),
  });
  seat.client.cancel = async (reason) => { await cleanup.promise; skill.resolve({ kind: 'cancelled', reason }); };
  const state = fixture([seat], (event) => activity.push(event));
  for (let value = 0; value < 3; value += 1) { state.loop.onTick(value); await settle(); }
  assert.equal(starts, 1);
  const reservedEffect = state.effects.find((effect) => effect.decision_sequence === '2');
  assert.deepEqual(reservedEffect?.skill, { kind: 'cancelled', reason: 'replaced' });
  const reservedTiming = activity.find((event) => event.kind === 'action' && event.actionSequence === '2');
  assert.equal(reservedTiming?.kind === 'action' ? reservedTiming.startedAtNs : undefined, null);
  cleanup.resolve();
  await settle();
  assert.equal(starts, 2);
  assert.equal(state.effects.find((effect) => effect.decision_sequence === '3')?.skill.kind, 'succeeded');
  await state.loop.stopAndJoin();
});

test('live policy joins elimination cancellation and removes every owned listener', async () => {
  const skill = pending<SkillOutcome>();
  const seat = competitor(0, () => skill.promise);
  seat.client.cancel = async (reason) => { skill.resolve({ kind: 'cancelled', reason }); };
  const state = fixture([seat]);
  state.loop.onTick(0);
  await settle();
  seat.bot.emit('death');
  await settle();
  state.loop.onTick(1);
  assert.equal(state.decisions.length, 1);
  assert.deepEqual(state.effects[0]?.skill, { kind: 'cancelled', reason: 'agentEliminated' });
  await state.loop.stopAndJoin();
  assert.equal(seat.bot.listenerCount('death'), 0);
  assert.equal(seat.bot.listenerCount('game'), 0);
  assert.equal(seat.bot.listenerCount('path_update'), 0);
});

test('live policy releases a settled action before its effect persistence finishes', async () => {
  const persistence = pending<void>();
  const decisions: PolicyReplayRecord[] = [];
  const effects: PolicyEffectRecordV1[] = [];
  const failures: unknown[] = [];
  const seat = competitor(0, async () => ({ kind: 'succeeded' }));
  const loop = new LivePolicyLoop({
    trace: {
      recordPolicyDecision: async (record) => { decisions.push(record); },
      recordPolicyEffect: async (record) => { effects.push(record); await persistence.promise; },
      checkpoint: async () => {},
    },
    params: PolicyParams.baseline(), seed: 1n, strategyIntervalTicks: 1n, recordPolicy: true,
    competitors: () => [seat], fail: (error) => failures.push(error),
  });
  loop.onTick(0);
  await settle();
  assert.equal(effects.length, 1);
  assert.equal(seat.bot.listenerCount('path_update'), 0);
  loop.onTick(1);
  await settle();
  const next = decisions[1]!;
  if (next.schema !== 'policy-replay-v2') throw new Error('expected v2');
  assert.deepEqual(next.disposition, { kind: 'start', action_sequence: '2' });
  persistence.resolve();
  await loop.stopAndJoin();
  assert.deepEqual(failures, []);
});

test('live policy bounds equal priority target hysteresis to two strategy intervals', async () => {
  const skill = pending<SkillOutcome>();
  let starts = 0;
  const seat = competitor(0, () => { starts += 1; return starts === 1 ? skill.promise : Promise.resolve({ kind: 'succeeded' }); }, false, 0);
  seat.client.observe = (value) => agentObservation({
    tick: tick(value), sequence: observationSequence(value + 1),
    agent: currentKnowledge(agentState({ position: blockPosition(0, 64, 0), healthHalfHearts: 40, hungerPoints: 20,
      foodStacks: [], equipped: emptyEquipment(), upgrades: [] })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([visibleOpponent(entityId(value + 1), blockPosition(1, 64, 0), false)]), loot: unknownKnowledge(),
  });
  seat.client.cancel = async (reason) => { skill.resolve({ kind: 'cancelled', reason }); };
  const state = fixture([seat]);
  for (let value = 0; value < 3; value += 1) { state.loop.onTick(value); await settle(); }
  const first = state.decisions[1]!;
  const second = state.decisions[2]!;
  if (first.schema !== 'policy-replay-v2' || second.schema !== 'policy-replay-v2') throw new Error('expected v2');
  assert.deepEqual(first.disposition, { kind: 'defer', action_sequence: '1', reason: 'hysteresis' });
  assert.deepEqual(second.disposition, { kind: 'replace', action_sequence: '3', replaces_action_sequence: '1', reason: 'targetChanged' });
  assert.equal(starts, 2);
  await state.loop.stopAndJoin();
});
