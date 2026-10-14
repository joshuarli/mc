import { deepStrictEqual, equal, notDeepStrictEqual, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  createPolicyFeedback,
  decide,
  decideOpening,
  decidePolicyReplayV1,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  foodStack,
  inventorySlot,
  InvalidPolicyParamsError,
  legacyAgentObservation,
  lootTarget,
  manhattanDistance,
  PolicyParams,
  policyMemory,
  policyFeedbackBatch,
  openingPolicyState,
  openingStyleForSeat,
  openingStyleCycle,
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

test('opening styles rotate every fixed seat through the configured three-style cycle', () => {
  const cycle = openingStyleCycle(['explorer', 'scavenger', 'hunter']);
  for (let seat = 0; seat < 6; seat += 1) {
    const styles = [0n, 1n, 2n].map((seed) => openingStyleForSeat(seed, seat, cycle)).sort();
    deepStrictEqual(styles, ['explorer', 'hunter', 'scavenger']);
  }
  deepStrictEqual(openingStyleForSeat(2n, 1, cycle), 'explorer');
  throws(() => openingStyleCycle(['explorer', 'explorer', 'hunter'] as unknown as readonly ['explorer', 'scavenger', 'hunter']));
});

test('explorer passes observed loot opportunities and chooses exploration', () => {
  const observation = makeObservation({ loot: currentKnowledge([
    unopenedContainer(blockPosition(1, 64, 0)),
    visibleDrop(entityId(41), blockPosition(2, 64, 0), { kind: 'weapon', rating: 1 }),
  ]) });
  const decision = decideOpening(observation, emptyPolicyMemory(), params(), policyRandom(), [], {
    style: 'explorer', state: openingPolicyState({ cacheTakenAt: null }),
  });

  deepStrictEqual(decision.goal, { kind: 'explore' });
  ok(decision.intent.kind === 'navigate');
});

test('scavenger opens one useful cache and navigates out of its local area', () => {
  const cache = unopenedContainer(blockPosition(1, 64, 0));
  const otherCache = unopenedContainer(blockPosition(2, 64, 0));
  const initiatingObservation = makeObservation({ loot: currentKnowledge([cache]) });
  const first = decideOpening(initiatingObservation, emptyPolicyMemory(), params(), policyRandom(), [], {
    style: 'scavenger', state: openingPolicyState({ cacheTakenAt: null }),
  });
  deepStrictEqual(first.goal, { kind: 'loot', target: { kind: 'container', position: cache.position } });
  deepStrictEqual(first.intent, { kind: 'containerOpen', position: cache.position });
  const feedback = createPolicyFeedback({ initiatingObservation, goal: first.goal, intent: first.intent,
    outcome: { kind: 'succeeded' } });
  ok(feedback !== null);
  const departureRandom = policyRandom();
  const departureRandomState = departureRandom.snapshotState();
  const next = decideOpening(makeObservation({ at: 11, loot: currentKnowledge([cache, otherCache]) }), first.memory,
    params(), departureRandom, policyFeedbackBatch([feedback]), {
      style: 'scavenger', state: first.openingState,
    });

  deepStrictEqual(next.openingState.cacheTakenAt, cache.position);
  deepStrictEqual(next.goal, { kind: 'explore' });
  ok(next.intent.kind === 'navigate');
  ok(manhattanDistance(next.intent.target, cache.position) >= 8n);
  equal(departureRandom.snapshotState(), departureRandomState);

  const stillNear = decideOpening(makeObservation({ at: 12, loot: currentKnowledge([cache, otherCache]) }), next.memory,
    params(), departureRandom, [], {
      style: 'scavenger', state: next.openingState,
    });
  deepStrictEqual(stillNear.intent, next.intent);
  equal(departureRandom.snapshotState(), departureRandomState);

  const movedAway = makeObservation({
    at: 13,
    agent: currentKnowledge(makeAgent({ position: next.intent.target })),
    loot: currentKnowledge([cache, otherCache]),
  });
  const later = decideOpening(movedAway, stillNear.memory, params(), departureRandom, [], {
    style: 'scavenger', state: stillNear.openingState,
  });
  ok(later.intent.kind === 'navigate');
  ok(Math.max(Math.abs(later.intent.target.x - next.intent.target.x), Math.abs(later.intent.target.z - next.intent.target.z))
    <= params().values.searchRadiusBlocks);
  notDeepStrictEqual(later.intent, next.intent);
  ok(departureRandom.snapshotState() !== departureRandomState);
});

test('hunter approaches a visible isolated opponent before observed caches', () => {
  const target = entityId(42);
  const observation = makeObservation({
    agent: currentKnowledge(makeAgent({ equipped: { ...emptyEquipment(), weapon: 1 } })),
    opponents: currentKnowledge([visibleOpponent(target, blockPosition(10, 64, 0), false)]),
    loot: currentKnowledge([unopenedContainer(blockPosition(1, 64, 0))]),
  });
  const decision = decideOpening(observation, emptyPolicyMemory(), params(), policyRandom(), [], {
    style: 'hunter', state: openingPolicyState({ cacheTakenAt: null }),
  });

  deepStrictEqual(decision.goal, { kind: 'engageVisibleOpponent', target });
  deepStrictEqual(decision.intent, { kind: 'approach', target });
});

test('an unarmed hunter does not charge a visible opponent and a crowd turns it away', () => {
  const target = entityId(42);
  const unarmed = makeObservation({
    opponents: currentKnowledge([visibleOpponent(target, blockPosition(10, 64, 0), false)]),
    loot: currentKnowledge([unopenedContainer(blockPosition(1, 64, 0))]),
  });
  const context = { style: 'hunter' as const, state: openingPolicyState({ cacheTakenAt: null }) };
  const cautious = decideOpening(unarmed, emptyPolicyMemory(), params(), policyRandom(), [], context);
  notDeepStrictEqual(cautious.goal, { kind: 'engageVisibleOpponent', target });
  deepStrictEqual(cautious.goal.kind, 'loot');

  const armedCrowd = makeObservation({
    agent: currentKnowledge(makeAgent({ equipped: { ...emptyEquipment(), weapon: 1 } })),
    opponents: currentKnowledge([
      visibleOpponent(target, blockPosition(10, 64, 0), false),
      visibleOpponent(entityId(43), blockPosition(-10, 64, 0), false),
    ]),
  });
  const wary = decideOpening(armedCrowd, emptyPolicyMemory(), params(), policyRandom(), [], context);
  notDeepStrictEqual(wary.goal.kind, 'engageVisibleOpponent');
});

test('an unequipped explorer acquires loot once the opening phase has passed', () => {
  const drop = unopenedContainer(blockPosition(3, 64, 0));
  const context = { style: 'explorer' as const, state: openingPolicyState({ cacheTakenAt: null }) };
  const early = decideOpening(
    makeObservation({ at: 10, loot: currentKnowledge([drop]) }),
    emptyPolicyMemory(), params(), policyRandom(), [], context,
  );
  deepStrictEqual(early.goal, { kind: 'explore' });
  const late = decideOpening(
    makeObservation({ at: 400, loot: currentKnowledge([drop]) }),
    emptyPolicyMemory(), params(), policyRandom(), [], context,
  );
  deepStrictEqual(late.goal.kind, 'loot');
});

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

test('failed loot is skipped until that exact candidate changes', () => {
  const drop = visibleDrop(entityId(33), blockPosition(5, 64, 0), { kind: 'food' });
  const chest = unopenedContainer(blockPosition(8, 64, 0));
  const initiatingObservation = makeObservation({ loot: currentKnowledge([drop, chest]) });
  const first = decide(initiatingObservation, emptyPolicyMemory(), params(), policyRandom());
  deepStrictEqual(first.goal, { kind: 'loot', target: { kind: 'drop', entityId: entityId(33) } });

  const feedback = createPolicyFeedback({
    initiatingObservation,
    goal: first.goal,
    intent: first.intent,
    outcome: { kind: 'failed', cause: 'noProgress' },
  });
  ok(feedback !== null);
  const unchanged = makeObservation({ at: 11, loot: currentKnowledge([drop, chest]) });
  const skipped = decide(
    unchanged,
    first.memory,
    params(),
    policyRandom(),
    policyFeedbackBatch([feedback]),
  );
  deepStrictEqual(skipped.goal, { kind: 'loot', target: { kind: 'container', position: chest.position } });
  equal(skipped.memory.failedTargets.length, 1);

  const succeededFeedback = createPolicyFeedback({
    initiatingObservation,
    goal: first.goal,
    intent: first.intent,
    outcome: { kind: 'succeeded' },
  });
  ok(succeededFeedback !== null);
  const resumed = decide(
    unchanged,
    skipped.memory,
    params(),
    policyRandom(),
    policyFeedbackBatch([succeededFeedback]),
  );
  deepStrictEqual(resumed.goal, first.goal);
  equal(resumed.memory.failedTargets.length, 0);

  equal(createPolicyFeedback({
    initiatingObservation,
    goal: first.goal,
    intent: first.intent,
    outcome: { kind: 'cancelled', reason: 'replaced' },
  }), null);

  const changedDrop = visibleDrop(entityId(33), drop.position, { kind: 'weapon', rating: 1 });
  const changed = decide(
    makeObservation({ at: 12, loot: currentKnowledge([changedDrop, chest]) }),
    skipped.memory,
    params(),
    policyRandom(),
  );
  deepStrictEqual(changed.goal, { kind: 'loot', target: { kind: 'drop', entityId: entityId(33) } });
  equal(changed.memory.failedTargets.length, 0);
});

test('failed-target memory stays isolated between policy seats', () => {
  const drop = visibleDrop(entityId(36), blockPosition(5, 64, 0), { kind: 'food' });
  const chest = unopenedContainer(blockPosition(8, 64, 0));
  const observation = makeObservation({ loot: currentKnowledge([drop, chest]) });
  const seatA = decide(observation, emptyPolicyMemory(), params(), policyRandom());
  const failed = createPolicyFeedback({
    initiatingObservation: observation,
    goal: seatA.goal,
    intent: seatA.intent,
    outcome: { kind: 'failed', cause: 'noProgress' },
  });
  ok(failed !== null);

  const seatAAfterFailure = decide(
    observation,
    seatA.memory,
    params(),
    policyRandom(),
    policyFeedbackBatch([failed]),
  );
  const seatB = decide(observation, emptyPolicyMemory(), params(), policyRandom());

  deepStrictEqual(seatAAfterFailure.goal, { kind: 'loot', target: { kind: 'container', position: chest.position } });
  deepStrictEqual(seatB.goal, seatA.goal);
  equal(seatB.memory.failedTargets.length, 0);
});

test('failed exploration retries after sufficient movement, not unrelated evidence changes', () => {
  const initiatingObservation = makeObservation();
  const first = decide(initiatingObservation, emptyPolicyMemory(), params(), new DeterministicRandom(0n));
  ok(first.goal.kind === 'explore');
  ok(first.intent.kind === 'navigate');
  const feedback = createPolicyFeedback({
    initiatingObservation,
    goal: first.goal,
    intent: first.intent,
    outcome: { kind: 'failed', cause: 'timedOut' },
  });
  ok(feedback !== null);

  const lostVisibility = decide(
    makeObservation({ at: 11, loot: unknownKnowledge(), opponents: unknownKnowledge() }),
    first.memory,
    params(),
    new DeterministicRandom(0n),
    policyFeedbackBatch([feedback]),
  );
  equal(lostVisibility.memory.failedTargets.length, 1);

  const moved = decide(
    makeObservation({
      at: 11,
      agent: currentKnowledge(makeAgent({ position: blockPosition(8, 64, 0) })),
    }),
    first.memory,
    params(),
    new DeterministicRandom(0n),
    policyFeedbackBatch([feedback]),
  );
  equal(moved.memory.failedTargets.length, 0);

  const evidenceChanged = decide(
    makeObservation({
      at: 12,
      loot: currentKnowledge([visibleDrop(entityId(34), blockPosition(40, 64, 0), { kind: 'food' })]),
      opponents: currentKnowledge([visibleOpponent(entityId(37), blockPosition(45, 64, 0), false)]),
    }),
    first.memory,
    params(),
    new DeterministicRandom(0n),
    policyFeedbackBatch([feedback]),
  );
  equal(evidenceChanged.memory.failedTargets.length, 1);
});

test('failed exploration targets retry the oldest failure while historical inputs hold, and remembered searches reopen on movement', () => {
  const explorationObservation = makeObservation();
  const random = new DeterministicRandom(0n);
  let explorationDecision = decide(explorationObservation, emptyPolicyMemory(), params(), random);
  for (let index = 0; index < 8; index += 1) {
    const feedback = createPolicyFeedback({
      initiatingObservation: explorationObservation,
      goal: explorationDecision.goal,
      intent: explorationDecision.intent,
      outcome: { kind: 'failed', cause: 'noProgress' },
    });
    ok(feedback !== null);
    explorationDecision = decide(
      explorationObservation,
      explorationDecision.memory,
      params(),
      random,
      policyFeedbackBatch([feedback]),
    );
  }
  deepStrictEqual(explorationDecision.goal, { kind: 'explore' });
  equal(explorationDecision.memory.failedTargets.length, 8);
  const historical = decide(
    legacyAgentObservation({
      tick: explorationObservation.tick,
      sequence: explorationObservation.sequence,
      agent: explorationObservation.agent,
      border: explorationObservation.border,
      opponents: explorationObservation.opponents,
      loot: explorationObservation.loot,
    }),
    explorationDecision.memory,
    params(),
    random,
  );
  deepStrictEqual(historical.goal, { kind: 'wait', reason: 'failedTargetsExhausted' });

  const target = entityId(35);
  const searchObservation = makeObservation({
    at: 20,
    opponents: currentKnowledge([visibleOpponent(target, blockPosition(12, 64, 0), false)]),
  });
  const search = decide(searchObservation, emptyPolicyMemory(), params(), policyRandom());
  deepStrictEqual(search.goal, { kind: 'searchLastKnown', target });
  const feedback = createPolicyFeedback({
    initiatingObservation: searchObservation,
    goal: search.goal,
    intent: search.intent,
    outcome: { kind: 'failed', cause: 'serverRejected' },
  });
  ok(feedback !== null);
  const unchanged = decide(
    makeObservation({
      at: 21,
      opponents: currentKnowledge([visibleOpponent(target, blockPosition(12, 64, 0), false)]),
    }),
    search.memory,
    params(),
    policyRandom(),
    policyFeedbackBatch([feedback]),
  );
  equal(unchanged.memory.failedTargets.length, 1);
  const unknown = decide(
    makeObservation({ at: 22, opponents: unknownKnowledge() }),
    unchanged.memory,
    params(),
    policyRandom(),
  );
  equal(unknown.memory.failedTargets.length, 1);
  const moved = decide(
    makeObservation({
      at: 23,
      opponents: currentKnowledge([visibleOpponent(target, blockPosition(13, 64, 0), false)]),
    }),
    unchanged.memory,
    params(),
    policyRandom(),
  );
  deepStrictEqual(moved.goal, { kind: 'searchLastKnown', target });
  equal(moved.memory.failedTargets.length, 0);
});

test('failed-target memory evicts the oldest failure after its fixed capacity', () => {
  const opportunities = Array.from({ length: 17 }, (_, index) => visibleDrop(
    entityId(40 + index),
    blockPosition(20 + index, 64, 0),
    { kind: 'food' },
  ));
  const observation = makeObservation({ loot: currentKnowledge(opportunities) });
  let memory = emptyPolicyMemory();
  const random = policyRandom();

  for (let index = 0; index < opportunities.length; index += 2) {
    const feedback = opportunities.slice(index, index + 2).map((opportunity) => {
      const target = lootTarget(opportunity);
      const event = createPolicyFeedback({
        initiatingObservation: observation,
        goal: { kind: 'loot', target },
        intent: { kind: 'navigate', target: opportunity.position },
        outcome: { kind: 'failed', cause: 'noProgress' },
      });
      ok(event !== null);
      return event;
    });
    memory = decide(observation, memory, params(), random, policyFeedbackBatch(feedback)).memory;
  }

  equal(memory.failedTargets.length, 16);
  const oldestRetained = memory.failedTargets[0];
  ok(oldestRetained?.kind === 'loot' && oldestRetained.target.kind === 'drop');
  equal(oldestRetained.target.entityId, entityId(41));
});

test('v2 chooses a representable exploration direction while v1 holds on its sampled overflow', () => {
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
  deepStrictEqual(decision.goal, { kind: 'explore' });
  deepStrictEqual(decision.intent, {
    kind: 'navigate',
    target: blockPosition(Number.MAX_SAFE_INTEGER, 64, 8),
  });

  const legacyRandom = new DeterministicRandom(0n);
  const expectedLegacyRandom = new DeterministicRandom(0n);
  equal(expectedLegacyRandom.nextEightWay(), 7);
  deepStrictEqual(decidePolicyReplayV1(
    exploration,
    { lastGoal: null, lastOpponent: null },
    params(),
    legacyRandom,
  ), {
    goal: { kind: 'wait', reason: 'unrepresentableTarget' },
    intent: { kind: 'hold', reason: 'unrepresentableTarget' },
    memory: { lastGoal: null, lastOpponent: null },
  });
  equal(legacyRandom.snapshotState(), expectedLegacyRandom.snapshotState());
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
    ...emptyPolicyMemory(),
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
