import assert from 'node:assert/strict';
import test from 'node:test';
import { createCombatArena, Vec3, type CombatArena, type CombatArenaOptions } from './combat-arena.js';

const BASE: CombatArenaOptions = { self: { x: 0.5, y: 1, z: 0.5 }, opponents: [] };

function wall(arena: CombatArena): void {
  for (const x of [-2, -1, 0, 1, 2]) for (const y of [1, 2, 3]) arena.placeSolid(x, y, -3);
}

async function observationAndDecision(arena: CombatArena): Promise<string> {
  const decision = arena.decide();
  return JSON.stringify({ observation: arena.observe(), decision: { goal: decision.goal, intent: decision.intent } });
}

async function pair(
  prepareA: (arena: CombatArena) => void,
  prepareB: (arena: CombatArena) => void,
  options: CombatArenaOptions = BASE,
): Promise<readonly [string, string]> {
  const first = createCombatArena(options);
  const second = createCombatArena(options);
  try {
    prepareA(first);
    prepareB(second);
    return [await observationAndDecision(first), await observationAndDecision(second)];
  } finally {
    await first.close();
    await second.close();
  }
}

test('a hidden enemy behind cover changes neither the observation nor the decision', async () => {
  const [absent, present] = await pair(
    wall,
    (arena) => {
      wall(arena);
      arena.addOpponent({ id: 9, x: 0.5, y: 1, z: -9 });
    },
  );
  assert.equal(present, absent);
});

test('a closed chest behind cover is not part of the permitted observation', async () => {
  const chest = (arena: CombatArena): void => {
    arena.bot.world.setBlockStateId(new Vec3(1, 1, -8), arena.bot.registry.blocksByName.chest!.minStateId!);
  };
  const [absent, present] = await pair(wall, (arena) => {
    wall(arena);
    chest(arena);
  });
  assert.equal(present, absent);
});

test('a buried resource beneath the surface does not reach the policy', async () => {
  const [absent, present] = await pair(
    () => undefined,
    (arena) => arena.bot.world.setBlockStateId(new Vec3(0, 0, 0), arena.bot.registry.blocksByName.diamond_ore!.minStateId!),
  );
  assert.equal(present, absent);
});

test('another client in the same process cannot change this client decisions or terrain memory', async () => {
  const alone = createCombatArena(BASE);
  const neighbor = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [{ id: 2, x: 0.5, y: 1, z: -1 }],
  });
  const witness = createCombatArena(BASE);
  try {
    const expected = await observationAndDecision(alone);
    neighbor.placeSolid(1, 1, 0);
    neighbor.bot.emit('blockUpdate', null, { position: new Vec3(1, 1, 0), stateId: 1, name: 'stone' } as never);
    await neighbor.runIntent({ kind: 'attack', target: 2 as never });
    const observed = await observationAndDecision(witness);
    assert.equal(observed, expected);
  } finally {
    await alone.close();
    await neighbor.close();
    await witness.close();
  }
});

test('an opponent that leaves perception is dropped instead of tracked through hidden positions', async () => {
  const arena = createCombatArena({ self: BASE.self, opponents: [{ id: 2, x: 0.5, y: 1, z: -3 }] });
  try {
    const seen = arena.observe();
    assert.equal(seen.opponents.kind, 'current');
    arena.setOpponent(2, { x: 0.5, y: 1, z: -45 });
    arena.bot.emit('physicsTick');
    const after = arena.observe();
    assert.equal(after.opponents.kind, 'current');
    assert.deepEqual(after.opponents, { kind: 'current', value: [] });
  } finally {
    await arena.close();
  }
});
