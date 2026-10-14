import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPolicyMemory, type Decision, type PolicyMemory } from '@arena/core';
import { createCombatArena, type CombatArena } from './combat-arena.js';

type RunnableIntent = Parameters<CombatArena['runIntent']>[0];

interface LoopStep {
  readonly intent: string;
  readonly goal: string;
  readonly outcome: string;
  readonly ticks: number;
}

async function decideAndRun(arena: CombatArena, iterations: number, onTick?: (tick: number) => void): Promise<LoopStep[]> {
  const steps: LoopStep[] = [];
  let memory: PolicyMemory = emptyPolicyMemory();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const decision: Decision = arena.decide(memory);
    memory = decision.memory;
    if (decision.intent.kind === 'hold') {
      steps.push({ intent: 'hold', goal: decision.goal.kind, outcome: 'hold', ticks: 0 });
      continue;
    }
    const result = await arena.runIntent(decision.intent as RunnableIntent, onTick);
    steps.push({
      intent: decision.intent.kind,
      goal: decision.goal.kind,
      outcome: result.outcome.kind === 'failed' ? `failed:${result.outcome.cause}` : result.outcome.kind,
      ticks: result.ticks,
    });
  }
  return steps;
}

test('curriculum 1: fractional reach boundary never alternates attack and rejection', async () => {
  const arena = createCombatArena({
    self: { x: 0.2, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.2, y: 1, z: -2.9 }],
  });
  try {
    const steps = await decideAndRun(arena, 4);
    const rejectedAttacks = steps.filter((step) => step.intent === 'attack' && step.outcome === 'failed:preconditionsNotMet');
    assert.deepEqual(rejectedAttacks, [], JSON.stringify(steps));
    assert.equal(steps[0]?.intent, 'approach');
    assert.ok(arena.attacks.some((attack) => attack.damaged), 'a swing inside real reach must land');
    assert.ok(arena.attacks.every((attack) => attack.withinServerReach), 'no swing may be issued outside server reach');
  } finally {
    await arena.close();
  }
});

test('curriculum 2: eligible swings against a static target produce attributable damage', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -1 }],
  });
  try {
    const steps = await decideAndRun(arena, 4);
    assert.deepEqual(steps.map((step) => step.outcome), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    assert.equal(arena.attacks.length, 4);
    assert.ok(arena.attacks.every((attack) => attack.damaged), JSON.stringify(arena.attacks));
    assert.equal(arena.opponents.get(2)?.health, 16);
    assert.deepEqual(arena.funnel.map((record) => record.kind), ['reached', 'reached', 'reached', 'reached']);
    assert.ok(arena.funnel.every((record) => record.kind === 'reached' && record.stage === 'clientResponse'));
  } finally {
    await arena.close();
  }
});

test('curriculum 3: a knocked-back target is pursued with bounded waiting', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -3.4 }],
  });
  arena.bot.on('entityHurt', (target) => {
    const record = arena.opponents.get(target.id);
    if (record !== undefined) arena.setOpponent(target.id, { x: record.x, y: record.y, z: record.z - 2.5 });
  });
  try {
    const steps = await decideAndRun(arena, 6);
    const failures = steps.filter((step) => step.outcome.startsWith('failed'));
    assert.deepEqual(failures, [], JSON.stringify(steps));
    assert.ok(arena.attacks.filter((attack) => attack.damaged).length >= 3, JSON.stringify(arena.attacks));
    assert.ok(arena.goals.length >= 3, `knockback must trigger renewed pursuit ${JSON.stringify(steps)} ${JSON.stringify(arena.goals)}`);
    assert.ok(steps.every((step) => step.ticks <= 30), JSON.stringify(steps));
  } finally {
    await arena.close();
  }
});

test('curriculum 4: an occluding obstacle is never hit through and is not engaged as visible', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -2 }],
  });
  for (const x of [-1, 0, 1]) {
    for (const y of [1, 2]) arena.placeSolid(x, y, -1);
  }
  try {
    const observation = arena.observe();
    assert.deepEqual(observation.opponents, { kind: 'current', value: [] });
    const decision = arena.decide();
    assert.notEqual(decision.goal.kind, 'engageVisibleOpponent');
    assert.notEqual(decision.intent.kind, 'attack');

    const forced = await arena.runIntent({ kind: 'attack', target: 2 as never });
    assert.deepEqual(forced.outcome, { kind: 'failed', cause: 'preconditionsNotMet' });
    assert.equal(arena.attacks.length, 0);
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'stopped' && record.reason === 'blockedLineOfSight', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});

test('curriculum 5: a target that despawns during the swing retires the action without corrupting the next goal', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -1 }],
  });
  Object.assign(arena.bot, {
    attack: (target: { readonly id: number }) => arena.removeOpponent(target.id),
  });
  try {
    const decision = arena.decide();
    assert.equal(decision.intent.kind, 'attack');
    const result = await arena.runIntent(decision.intent as RunnableIntent);
    assert.deepEqual(result.outcome, { kind: 'failed', cause: 'noProgress' });
    assert.ok(result.ticks <= 2, `retired after ${result.ticks} ticks`);
    const record = arena.funnel.at(-1);
    assert.ok(
      record?.kind === 'stopped' && record.reason === 'targetDespawnedOrEliminated' && record.lastPassed === 'issued',
      JSON.stringify(record),
    );

    const next = arena.decide(decision.memory);
    assert.notEqual(next.goal.kind, 'engageVisibleOpponent');
    assert.notEqual(next.intent.kind, 'attack');
  } finally {
    await arena.close();
  }
});

test('curriculum 6: with several opponents the swing goes to the one attacking this client', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [
      { id: 5, x: 0.5, y: 1, z: -1.5 },
      { id: 9, x: 1.8, y: 1, z: -2 },
    ],
  });
  try {
    const attacker = arena.opponents.get(9)?.entity;
    assert.ok(attacker !== undefined);
    arena.bot.emit('entityHurt', arena.bot.entity, attacker);
    const steps = await decideAndRun(arena, 1);
    assert.deepEqual(steps.map((step) => `${step.goal}:${step.intent}:${step.outcome}`), [
      'engageVisibleOpponent:attack:succeeded',
    ]);
    assert.equal(arena.attacks[0]?.targetId, 9);
  } finally {
    await arena.close();
  }
});

test('cancelling a pursuit stops pathing and clears controls before the next owner starts', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -3.5 }],
  });
  try {
    const running = arena.client.run({ kind: 'approach', target: 2 as never });
    await arena.client.cancel('replaced');
    assert.deepEqual(await running, { kind: 'cancelled', reason: 'replaced' });
    assert.equal(arena.bot.pathfinder.goal, null);
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'stopped' && record.reason === 'ownershipDeferred', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});
