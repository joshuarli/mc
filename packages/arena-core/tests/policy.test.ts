import { deepStrictEqual, equal, notDeepStrictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  decide,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  foodStack,
  inventorySlot,
  InvalidPolicyParamsError,
  PolicyParams,
  policyMemory,
  RandomStream,
  DeterministicRandom,
  observationSequence,
  staleKnowledge,
  seatId,
  tick,
  unknownKnowledge,
  visibleDrop,
  visibleOpponent,
  unopenedContainer,
  worldBorder,
  type AgentObservationInput,
  type AgentObservation,
  type EquipmentUpgrade,
  type LootOpportunity,
} from '../src/index.js';

const policyRandom = () => DeterministicRandom.forStream(481_516n, RandomStream.search(seatId(0)));

const makeAgent = (options: {
  readonly position?: ReturnType<typeof blockPosition>;
  readonly healthHalfHearts?: number;
  readonly hungerPoints?: number;
  readonly foodStacks?: readonly ReturnType<typeof foodStack>[];
  readonly equipped?: ReturnType<typeof emptyEquipment>;
  readonly upgrades?: readonly EquipmentUpgrade[];
} = {}) => agentState({
  position: options.position ?? blockPosition(0, 64, 0),
  healthHalfHearts: options.healthHalfHearts ?? 40,
  hungerPoints: options.hungerPoints ?? 20,
  foodStacks: options.foodStacks ?? [],
  equipped: options.equipped ?? emptyEquipment(),
  upgrades: options.upgrades ?? [],
});

const makeObservation = (options: {
  readonly at?: number;
  readonly agent?: AgentObservationInput['agent'];
  readonly border?: AgentObservationInput['border'];
  readonly opponents?: AgentObservationInput['opponents'];
  readonly loot?: AgentObservationInput['loot'];
} = {}) => agentObservation({
  tick: tick(options.at ?? 10),
  sequence: observationSequence((options.at ?? 10) + 1),
  agent: options.agent ?? currentKnowledge(makeAgent()),
  border: options.border ?? currentKnowledge(worldBorder(0, 0, 100)),
  opponents: options.opponents ?? currentKnowledge([]),
  loot: options.loot ?? currentKnowledge([]),
});

const params = () => PolicyParams.baseline();

test('baseline exits the border before eating', () => {
  const observation = makeObservation({
    agent: currentKnowledge(makeAgent({
      position: blockPosition(99, 64, 0),
      hungerPoints: 2,
      foodStacks: [foodStack(9, 2)],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
  });
  const decision = decide(observation, emptyPolicyMemory(), params(), policyRandom());

  deepStrictEqual(decision.goal, { kind: 'escapeBorder' });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(0, 64, 0) });
});

test('unknown or stale self and border state hold without inventing values', () => {
  const inputs: readonly [AgentObservationInput['agent'], AgentObservationInput['border'], string][] = [
    [unknownKnowledge(), currentKnowledge(worldBorder(0, 0, 100)), 'agentStateUnknown'],
    [staleKnowledge(makeAgent(), tick(9)), currentKnowledge(worldBorder(0, 0, 100)), 'agentStateStale'],
    [currentKnowledge(makeAgent()), unknownKnowledge(), 'borderUnknown'],
    [currentKnowledge(makeAgent()), staleKnowledge(worldBorder(0, 0, 100), tick(9)), 'borderStale'],
  ];

  for (const [agent, border, reason] of inputs) {
    const decision = decide(makeObservation({ agent, border }), emptyPolicyMemory(), params(), policyRandom());
    deepStrictEqual(decision.intent, { kind: 'hold', reason });
  }
});

test('decide rejects structurally forged observations that bypass validation', () => {
  const valid = makeObservation();
  const forged = {
    ...valid,
    opponents: staleKnowledge(
      [visibleOpponent(entityId(7), blockPosition(1, 64, 0), true)],
      tick(valid.tick),
    ),
  } as unknown as AgentObservation;

  throws(
    () => decide(forged, emptyPolicyMemory(), params(), policyRandom()),
    /AgentObservation created by agentObservation/,
  );
});

test('low health retreats from a visible nearby opponent before eating', () => {
  const target = entityId(7);
  const observation = makeObservation({
    agent: currentKnowledge(makeAgent({
      healthHalfHearts: 6,
      hungerPoints: 2,
      foodStacks: [foodStack(9, 2)],
    })),
    opponents: currentKnowledge([visibleOpponent(target, blockPosition(2, 64, 0), false)]),
  });
  const decision = decide(observation, emptyPolicyMemory(), params(), policyRandom());

  deepStrictEqual(decision.goal, { kind: 'retreatFromOpponent', target });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(-4, 64, 0) });
});

test('eating requires current empty visibility and no recent nearby remembered threat', () => {
  const safe = makeObservation({
    agent: currentKnowledge(makeAgent({
      hungerPoints: 4,
      foodStacks: [foodStack(8, 1), foodStack(3, 2)],
    })),
    opponents: currentKnowledge([]),
  });
  const unknown = makeObservation({
    agent: currentKnowledge(makeAgent({
      hungerPoints: 4,
      foodStacks: [foodStack(8, 1), foodStack(3, 2)],
    })),
    opponents: unknownKnowledge(),
  });

  equal(decide(safe, emptyPolicyMemory(), params(), policyRandom()).goal.kind, 'recoverHunger');
  notDeepStrictEqual(decide(unknown, emptyPolicyMemory(), params(), policyRandom()).goal, { kind: 'recoverHunger' });
  deepStrictEqual(decide(safe, emptyPolicyMemory(), params(), policyRandom()).intent, { kind: 'eat', inventorySlot: 3 });
});

test('a recent remembered opponent prevents eating after visibility becomes empty', () => {
  const spotted = makeObservation({
    at: 10,
    opponents: currentKnowledge([visibleOpponent(entityId(8), blockPosition(2, 64, 0), false)]),
  });
  const memory = decide(spotted, emptyPolicyMemory(), params(), policyRandom()).memory;
  const next = makeObservation({
    at: 11,
    agent: currentKnowledge(makeAgent({ hungerPoints: 4, foodStacks: [foodStack(4, 1)] })),
    opponents: currentKnowledge([]),
  });
  const decision = decide(next, memory, params(), policyRandom());

  notDeepStrictEqual(decision.goal, { kind: 'recoverHunger' });
  deepStrictEqual(decision.goal, { kind: 'searchLastKnown', target: entityId(8) });
});

test('equipment upgrades compare confirmed armor by slot and select the exact inventory slot', () => {
  const upgrades: readonly EquipmentUpgrade[] = [
    { inventorySlot: inventorySlot(12), equipmentSlot: 'helmet', rating: 2 },
    { inventorySlot: inventorySlot(13), equipmentSlot: 'leggings', rating: 5 },
    { inventorySlot: inventorySlot(14), equipmentSlot: 'boots', rating: 1 },
  ];
  const observation = makeObservation({
    agent: currentKnowledge(makeAgent({
      equipped: { ...emptyEquipment(), helmet: 1, leggings: 6 },
      upgrades,
    })),
    opponents: currentKnowledge([visibleOpponent(entityId(9), blockPosition(1, 64, 0), false)]),
  });
  const decision = decide(observation, emptyPolicyMemory(), params(), policyRandom());

  deepStrictEqual(decision.goal, { kind: 'improveEquipment', inventorySlot: 12, equipmentSlot: 'helmet', rating: 2 });
  deepStrictEqual(decision.intent, { kind: 'equip', inventorySlot: 12, equipmentSlot: 'helmet', rating: 2 });
});

test('visible opponents are attacked at melee reach and approached before it', () => {
  const target = entityId(11);
  const close = makeObservation({
    opponents: currentKnowledge([visibleOpponent(target, blockPosition(3, 64, 0), false)]),
  });
  const far = makeObservation({
    opponents: currentKnowledge([visibleOpponent(target, blockPosition(4, 64, 0), false)]),
  });

  deepStrictEqual(decide(close, emptyPolicyMemory(), params(), policyRandom()).intent, { kind: 'attack', target });
  deepStrictEqual(decide(far, emptyPolicyMemory(), params(), policyRandom()).intent, { kind: 'approach', target });
});

test('opponent ordering is independent of input vector order', () => {
  const first = visibleOpponent(entityId(13), blockPosition(2, 64, 0), false);
  const second = visibleOpponent(entityId(12), blockPosition(-2, 64, 0), false);
  const forward = makeObservation({ opponents: currentKnowledge([first, second]) });
  const reverse = makeObservation({ opponents: currentKnowledge([second, first]) });

  deepStrictEqual(
    decide(forward, emptyPolicyMemory(), params(), policyRandom()).goal,
    decide(reverse, emptyPolicyMemory(), params(), policyRandom()).goal,
  );
});

test('loot utility, stable ordering, hysteresis, and target kinds are observable', () => {
  const container: LootOpportunity = { kind: 'unopenedContainer', position: blockPosition(4, 64, 0) };
  const food = visibleDrop(entityId(31), blockPosition(5, 64, 0), { kind: 'food' });
  const first = makeObservation({ loot: currentKnowledge([container, food]) });
  const reverse = makeObservation({ loot: currentKnowledge([food, container]) });
  const firstDecision = decide(first, emptyPolicyMemory(), params(), policyRandom());

  deepStrictEqual(firstDecision.goal, { kind: 'loot', target: { kind: 'drop', entityId: entityId(31) } });
  deepStrictEqual(firstDecision.intent, { kind: 'navigate', target: blockPosition(5, 64, 0) });
  deepStrictEqual(
    decide(reverse, emptyPolicyMemory(), params(), policyRandom()).goal,
    firstDecision.goal,
  );

  const nearTie = makeObservation({ at: 11, loot: currentKnowledge([
    visibleDrop(entityId(31), blockPosition(5, 64, 0), { kind: 'food' }),
    visibleDrop(entityId(32), blockPosition(4, 64, 0), { kind: 'food' }),
  ]) });
  const memory = policyMemory({
    ...emptyPolicyMemory(),
    lastGoal: { kind: 'loot', target: { kind: 'drop', entityId: entityId(31) } },
  });
  deepStrictEqual(decide(nearTie, memory, params(), policyRandom()).goal, memory.lastGoal);

  const chest = makeObservation({
    loot: currentKnowledge([unopenedContainer(blockPosition(1, 64, 0))]),
  });
  deepStrictEqual(decide(chest, emptyPolicyMemory(), params(), policyRandom()).goal, {
    kind: 'loot',
    target: { kind: 'container', position: blockPosition(1, 64, 0) },
  });
  deepStrictEqual(decide(chest, emptyPolicyMemory(), params(), policyRandom()).intent, {
    kind: 'containerOpen',
    position: blockPosition(1, 64, 0),
  });
});

test('stale opponents guide bounded search but never start combat', () => {
  const observation = makeObservation({
    opponents: staleKnowledge([visibleOpponent(entityId(15), blockPosition(12, 64, 0), false)], tick(9)),
  });
  const decision = decide(observation, emptyPolicyMemory(), params(), policyRandom());

  deepStrictEqual(decision.goal, { kind: 'searchLastKnown', target: entityId(15) });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(12, 64, 0) });
});

test('unrepresentable retreat and exploration positions return an explicit hold', () => {
  const retreat = makeObservation({
    agent: currentKnowledge(makeAgent({
      position: blockPosition(Number.MIN_SAFE_INTEGER, 64, 0),
      healthHalfHearts: 4,
    })),
    border: currentKnowledge(worldBorder(Number.MIN_SAFE_INTEGER, 0, 100)),
    opponents: currentKnowledge([visibleOpponent(entityId(7), blockPosition(Number.MIN_SAFE_INTEGER + 2, 64, 0), false)]),
  });
  const exploration = makeObservation({
    agent: currentKnowledge(makeAgent({ position: blockPosition(Number.MAX_SAFE_INTEGER, 64, 0) })),
    border: currentKnowledge(worldBorder(Number.MAX_SAFE_INTEGER, 0, 100)),
  });

  deepStrictEqual(decide(retreat, emptyPolicyMemory(), params(), policyRandom()).intent, {
    kind: 'hold',
    reason: 'unrepresentableTarget',
  });
  const random = new DeterministicRandom(0n);
  const decision = decide(exploration, emptyPolicyMemory(), params(), random);
  deepStrictEqual(decision.intent, { kind: 'hold', reason: 'unrepresentableTarget' });
});

test('policy parameter values reject numbers outside the versioned bounds', () => {
  const values = PolicyParams.baseline().values;

  equal(PolicyParams.create(values).values.opponentMemoryTicks, 100);
  throws(
    () => PolicyParams.create({ ...values, opponentMemoryTicks: 101 }),
    (error) => error instanceof InvalidPolicyParamsError && error.code === 'opponent-memory-out-of-range',
  );
  throws(
    () => PolicyParams.create({ ...values, eatAtHungerOrBelow: 0 }),
    (error) => error instanceof InvalidPolicyParamsError && error.code === 'hunger-threshold-out-of-range',
  );
});

test('future remembered positions are not treated as last-seen information', () => {
  const observation = makeObservation({ at: 10, opponents: currentKnowledge([]) });
  const memory = policyMemory({
    lastGoal: null,
    lastOpponent: {
      id: entityId(16),
      position: blockPosition(12, 64, 0),
      observedAt: tick(11),
    },
  });

  notDeepStrictEqual(decide(observation, memory, params(), policyRandom()).goal, {
    kind: 'searchLastKnown',
    target: entityId(16),
  });
});

test('fallback exploration uses the supplied deterministic search stream', () => {
  const observation = makeObservation({
    opponents: currentKnowledge([]),
    loot: currentKnowledge([]),
  });
  const first = decide(observation, emptyPolicyMemory(), params(), new DeterministicRandom(0n));
  const replay = decide(observation, emptyPolicyMemory(), params(), new DeterministicRandom(0n));

  deepStrictEqual(first.goal, { kind: 'explore' });
  deepStrictEqual(first.intent, { kind: 'navigate', target: blockPosition(4, 64, -8) });
  deepStrictEqual(replay, first);
});
