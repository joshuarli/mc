import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { leadAimPoint, observedVelocity } from '../src/ballistics.js';
import { createCombatArena, type CombatArena } from './combat-arena.js';

type RunnableIntent = Parameters<CombatArena['runIntent']>[0];
const inventoryArrows = (arena: CombatArena): number => arena.bot.inventory.items()
  .filter((item) => item.name === 'arrow')
  .reduce((total, item) => total + item.count, 0);

test('curriculum 8: a bow shot leads a moving target from observed motion and accounts for the arrow', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: -1.5, y: 1, z: -10 }],
    inventory: [{ slot: 36, name: 'bow', count: 1 }, { slot: 37, name: 'arrow', count: 8 }],
    heldSlot: 36,
  });
  try {
    const decision = arena.decide();
    assert.deepEqual(decision.goal, { kind: 'engageVisibleOpponent', target: 2 });
    assert.deepEqual(decision.intent, { kind: 'approach', target: 2 });
    const result = await arena.runIntent(decision.intent as RunnableIntent, () => {
      const target = arena.opponents.get(2);
      if (target !== undefined) arena.setOpponent(2, { x: target.x + 0.2, y: target.y, z: target.z });
    });
    assert.deepEqual(result.outcome, { kind: 'succeeded' }, JSON.stringify([arena.funnel, arena.arrows]));
    assert.equal(arena.arrows.length, 1);
    assert.equal(arena.arrows[0]?.hitTargetId, 2);
    assert.equal(inventoryArrows(arena), 7);
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'reached' && record.action === 'shoot' && record.stage === 'clientResponse', JSON.stringify(record));
    assert.equal(arena.bot.heldItem?.name, 'bow');
  } finally {
    await arena.close();
  }
});

test('curriculum 8: lead comes only from observed positions and is bounded', () => {
  const eye = { x: 0, y: 1.62, z: 0 };
  const still = leadAimPoint(eye, { x: 0, y: 1, z: -10 }, observedVelocity([{ x: 0, y: 1, z: -10 }, { x: 0, y: 1, z: -10 }]));
  assert.equal(still.point.x, 0);
  const moving = observedVelocity([{ x: 0, y: 1, z: -10 }, { x: 1, y: 1, z: -10 }, { x: 2, y: 1, z: -10 }]);
  assert.equal(moving.x, 1);
  const bounded = observedVelocity([{ x: 0, y: 1, z: 0 }, { x: 50, y: 1, z: 0 }]);
  assert.equal(bounded.x, 1);
  assert.equal(observedVelocity([{ x: 3, y: 1, z: 3 }]).x, 0);
  const led = leadAimPoint(eye, { x: 0, y: 1, z: -10 }, moving);
  assert.ok(led.point.x > 3 && led.flightTicks <= 30);
});

test('curriculum 8: no arrow is fired through cover', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -9 }],
    inventory: [{ slot: 36, name: 'bow', count: 1 }, { slot: 37, name: 'arrow', count: 8 }],
    heldSlot: 36,
  });
  for (const x of [-1, 0, 1]) for (const y of [1, 2, 3]) arena.placeSolid(x, y, -3);
  try {
    assert.notEqual(arena.decide().goal.kind, 'engageVisibleOpponent');
    const forced = await arena.runIntent({ kind: 'approach', target: 2 as never });
    assert.equal(forced.outcome.kind, 'failed');
    assert.equal(arena.arrows.length, 0);
    assert.equal(inventoryArrows(arena), 8);
    assert.ok(!arena.itemUse.includes('activate'));
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'stopped' && record.reason === 'blockedLineOfSight', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});

test('curriculum 8: without ammunition the archer closes distance instead of drawing', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -9 }],
    inventory: [{ slot: 36, name: 'bow', count: 1 }],
    heldSlot: 36,
  });
  try {
    const result = await arena.runIntent({ kind: 'approach', target: 2 as never });
    assert.deepEqual(result.outcome, { kind: 'succeeded' });
    assert.ok(!arena.itemUse.includes('activate'));
    assert.ok(arena.goals.length > 0);
  } finally {
    await arena.close();
  }
});

test('curriculum 9: eating is abandoned and the item released when a threat appears', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [],
    inventory: [{ slot: 36, name: 'apple', count: 3 }],
    heldSlot: 36,
  });
  (arena.bot as unknown as { food: number }).food = 6;
  try {
    const result = await arena.runIntent({ kind: 'eat', inventorySlot: 36 as never }, (tick) => {
      if (tick === 6) arena.addOpponent({ id: 4, x: 0.5, y: 1, z: -5 });
    });
    assert.deepEqual(result.outcome, { kind: 'failed', cause: 'preconditionsNotMet' });
    assert.ok(result.ticks <= 10, `ticks ${result.ticks}`);
    assert.ok(arena.itemUse.includes('deactivate'));
    assert.equal(arena.bot.inventory.slots[36]?.count, 3);
    const record = arena.funnel.at(-1);
    assert.ok(record?.kind === 'stopped' && record.reason === 'abortedUnderThreat' && record.action === 'eat', JSON.stringify(record));
  } finally {
    await arena.close();
  }
});

test('curriculum 9: eating does not start with a visible opponent nearby and completes when safe', async () => {
  const threatened = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 4, x: 0.5, y: 1, z: -5 }],
    inventory: [{ slot: 36, name: 'apple', count: 3 }],
    heldSlot: 36,
  });
  try {
    const refused = await threatened.runIntent({ kind: 'eat', inventorySlot: 36 as never });
    assert.deepEqual(refused.outcome, { kind: 'failed', cause: 'preconditionsNotMet' });
    assert.ok(!threatened.itemUse.includes('consume'));
  } finally {
    await threatened.close();
  }
  const safe = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [],
    inventory: [{ slot: 36, name: 'apple', count: 3 }],
    heldSlot: 36,
  });
  (safe.bot as unknown as { food: number }).food = 6;
  try {
    const eaten = await safe.runIntent({ kind: 'eat', inventorySlot: 36 as never });
    assert.deepEqual(eaten.outcome, { kind: 'succeeded' });
    assert.equal(safe.bot.inventory.slots[36]?.count, 2);
  } finally {
    await safe.close();
  }
});

test('curriculum 7: a shield stays raised through the weapon cooldown and is lowered before the swing', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -1 }],
    inventory: [{ slot: 36, name: 'iron_sword', count: 1 }, { slot: 45, name: 'shield', count: 1 }],
    heldSlot: 36,
  });
  try {
    for (let swing = 0; swing < 2; swing += 1) {
      const result = await arena.runIntent({ kind: 'attack', target: 2 as never });
      assert.deepEqual(result.outcome, { kind: 'succeeded' });
    }
    assert.deepEqual(arena.itemUse, ['activate:offhand', 'deactivate']);
    assert.equal((arena.bot as unknown as { usingHeldItem: boolean }).usingHeldItem, false);
    assert.ok(arena.attacks.every((attack) => attack.damaged));
  } finally {
    await arena.close();
  }
});

test('curriculum 7: cancelling a raised shield releases it', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -1 }],
    inventory: [{ slot: 36, name: 'iron_sword', count: 1 }, { slot: 45, name: 'shield', count: 1 }],
    heldSlot: 36,
  });
  try {
    await arena.runIntent({ kind: 'attack', target: 2 as never });
    const running = arena.client.run({ kind: 'attack', target: 2 as never });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await arena.client.cancel('replaced');
    assert.deepEqual(await running, { kind: 'cancelled', reason: 'replaced' });
    assert.equal((arena.bot as unknown as { usingHeldItem: boolean }).usingHeldItem, false);
  } finally {
    await arena.close();
  }
});

test('curriculum 12: a drop collected by another player is not attributed to this client', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 6.5, y: 1, z: 6.5 }],
  });
  try {
    const drop = arena.addDrop(7, { x: 0.5, y: 1, z: -4.5 }, 'apple');
    const other = arena.opponents.get(2)?.entity as Bot['entity'];
    const running = arena.client.run({ kind: 'dropCollect', entityId: 7 as never });
    await new Promise<void>((resolve) => setImmediate(resolve));
    arena.bot.emit('playerCollect', other, drop);
    delete (arena.bot.entities as Record<string, unknown>)['7'];
    const outcome = await running;
    assert.notDeepEqual(outcome, { kind: 'succeeded' });
    assert.equal(outcome.kind, 'failed');
  } finally {
    await arena.close();
  }
});

test('curriculum 12: a drop this client collects is attributed to it', async () => {
  const arena = createCombatArena({ self: { x: 0.5, y: 1, z: 0.5 }, opponents: [] });
  try {
    const drop = arena.addDrop(7, { x: 0.5, y: 1, z: -3.5 }, 'apple');
    const running = arena.client.run({ kind: 'dropCollect', entityId: 7 as never });
    await new Promise<void>((resolve) => setImmediate(resolve));
    arena.bot.emit('playerCollect', arena.bot.entity, drop);
    assert.deepEqual(await running, { kind: 'succeeded' });
  } finally {
    await arena.close();
  }
});

test('curriculum 10: a seat knocked outside the border recovers toward the center instead of fighting', async () => {
  const arena = createCombatArena({
    self: { x: 22.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 21.5, y: 1, z: 0.5, yaw: 0 }],
    border: { x: 0, z: 0, diameter: 40 },
  });
  try {
    const attacker = arena.opponents.get(2)?.entity as Bot['entity'];
    arena.bot.emit('entityHurt', arena.bot.entity, attacker);
    const decision = arena.decide();
    assert.equal(decision.goal.kind, 'escapeBorder');
    assert.equal(decision.intent.kind, 'navigate');
    const result = await arena.runIntent(decision.intent as RunnableIntent);
    assert.deepEqual(result.outcome, { kind: 'succeeded' });
    assert.ok(arena.self.x < 20);
  } finally {
    await arena.close();
  }
});
