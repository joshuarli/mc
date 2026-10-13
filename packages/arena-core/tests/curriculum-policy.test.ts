import { deepStrictEqual, equal, ok, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  decide,
  DeterministicRandom,
  emptyPolicyMemory,
  entityId,
  equipmentUpgrade,
  foodStack,
  observationSequence,
  PolicyParams,
  policyMemory,
  RandomStream,
  seatId,
  staleKnowledge,
  tick,
  unknownKnowledge,
  unopenedContainer,
  visibleOpponent,
  worldBorder,
  type AgentObservationInput,
  type AgentState,
  type EquipmentSlot,
  type EquipmentSnapshot,
  type Knowledge,
  type LootOpportunity,
  type VisibleOpponent,
} from '../src/index.js';

type PositionTuple = readonly [number, number, number];

interface CurriculumScenario {
  readonly tick: number;
  readonly position: PositionTuple;
  readonly healthHalfHearts: number;
  readonly hungerPoints: number;
  readonly foodStacks: readonly (readonly [number, number])[];
  readonly equipped: EquipmentSnapshot;
  readonly upgrades: readonly (readonly [number, EquipmentSlot, number])[];
  readonly border: {
    readonly centerX: number;
    readonly centerZ: number;
    readonly radiusBlocks: number;
  };
  readonly opponents: readonly {
    readonly id: number;
    readonly position: PositionTuple;
    readonly attackingAgent: boolean;
  }[];
  readonly loot: readonly {
    readonly kind: 'unopenedContainer';
    readonly position: PositionTuple;
  }[];
  readonly randomSeed: string;
}

const scenarioNames = [
  'initialSearch',
  'containerContention',
  'equipmentUnderdog',
  'equipmentAhead',
  'lowHealthThreat',
  'eatingThreat',
  'lostTarget',
  'twoVisibleTargets',
  'afterKnockback',
  'nearHysteresis',
  'farHysteresis',
  'explorationOverflow',
] as const;

type ScenarioName = typeof scenarioNames[number];

const scenarios = JSON.parse(readFileSync(
  resolve(process.cwd(), 'fixtures/policy-curriculum/observations.json'),
  'utf8',
)) as Partial<Record<ScenarioName, CurriculumScenario>>;

function scenario(name: ScenarioName): CurriculumScenario {
  const value = scenarios[name];
  if (value === undefined) {
    throw new RangeError(`missing curriculum scenario: ${name}`);
  }
  return value;
}

function position(value: PositionTuple) {
  return blockPosition(value[0], value[1], value[2]);
}

function observation(
  name: ScenarioName,
  options: {
    readonly at?: number;
    readonly agent?: Knowledge<AgentState>;
    readonly opponents?: Knowledge<readonly VisibleOpponent[]>;
    readonly loot?: Knowledge<readonly LootOpportunity[]>;
  } = {},
) {
  const fixture = scenario(name);
  const observationTick = options.at ?? fixture.tick;
  return agentObservation({
    tick: tick(observationTick),
    sequence: observationSequence(observationTick + 1),
    agent: options.agent ?? currentKnowledge(agentState({
      position: position(fixture.position),
      healthHalfHearts: fixture.healthHalfHearts,
      hungerPoints: fixture.hungerPoints,
      foodStacks: fixture.foodStacks.map(([slot, count]) => foodStack(slot, count)),
      equipped: fixture.equipped,
      upgrades: fixture.upgrades.map(([slot, equipmentSlot, rating]) =>
        equipmentUpgrade(slot, equipmentSlot, rating)),
    })),
    border: currentKnowledge(worldBorder(
      fixture.border.centerX,
      fixture.border.centerZ,
      fixture.border.radiusBlocks,
    )),
    opponents: options.opponents ?? currentKnowledge(fixture.opponents.map((opponent) =>
      visibleOpponent(entityId(opponent.id), position(opponent.position), opponent.attackingAgent))),
    loot: options.loot ?? currentKnowledge(fixture.loot.map((opportunity) =>
      unopenedContainer(position(opportunity.position)))),
  });
}

const params = PolicyParams.baseline();

test('initial search navigates to a bounded replayable target', () => {
  const input = observation('initialSearch');
  const seed = BigInt(scenario('initialSearch').randomSeed);
  const first = decide(input, emptyPolicyMemory(), params, new DeterministicRandom(seed));
  const replay = decide(input, emptyPolicyMemory(), params, new DeterministicRandom(seed));

  deepStrictEqual(first.goal, { kind: 'explore' });
  deepStrictEqual(first.intent, { kind: 'navigate', target: blockPosition(4, 64, -8) });
  deepStrictEqual([replay.goal, replay.intent], [first.goal, first.intent]);
  ok(first.intent.kind === 'navigate');
  const [originX, , originZ] = scenario('initialSearch').position;
  ok(Math.abs(first.intent.target.x - originX) <= params.values.searchRadiusBlocks);
  ok(Math.abs(first.intent.target.z - originZ) <= params.values.searchRadiusBlocks);
});

test('identical local views choose the same unopened container without shared reservations', () => {
  const firstView = observation('containerContention');
  const secondView = observation('containerContention');
  const first = decide(firstView, emptyPolicyMemory(), params, new DeterministicRandom(0n));
  const second = decide(secondView, emptyPolicyMemory(), params, new DeterministicRandom(0n));
  const target = blockPosition(2, 64, 0);

  deepStrictEqual(first.goal, { kind: 'loot', target: { kind: 'container', position: target } });
  deepStrictEqual(first.intent, { kind: 'containerOpen', position: target });
  deepStrictEqual([second.goal, second.intent], [first.goal, first.intent]);
});

test('equipment choices use this agent’s confirmed rating and inventory slot', () => {
  const underdog = decide(
    observation('equipmentUnderdog'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );
  const alreadyEquipped = decide(
    observation('equipmentAhead'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(underdog.goal, {
    kind: 'improveEquipment',
    inventorySlot: 17,
    equipmentSlot: 'weapon',
    rating: 2,
  });
  deepStrictEqual(underdog.intent, {
    kind: 'equip',
    inventorySlot: 17,
    equipmentSlot: 'weapon',
    rating: 2,
  });
  deepStrictEqual(alreadyEquipped.goal, { kind: 'explore' });
});

test('low health retreats from an attacking target before eating and favors that threat', () => {
  const decision = decide(
    observation('lowHealthThreat'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(decision.goal, { kind: 'retreatFromOpponent', target: entityId(8) });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(-4, 64, 0) });
});

test('visible combat threat takes priority over eating under hunger', () => {
  const decision = decide(
    observation('eatingThreat'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(decision.goal, { kind: 'engageVisibleOpponent', target: entityId(19) });
  deepStrictEqual(decision.intent, { kind: 'attack', target: entityId(19) });

  const unknownOpponents = decide(
    observation('eatingThreat', { opponents: unknownKnowledge<readonly VisibleOpponent[]>() }),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );
  deepStrictEqual(unknownOpponents.goal, { kind: 'explore' });
});

test('a lost or stale target guides bounded search but never starts combat', () => {
  const first = decide(
    observation('lostTarget'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );
  const noLongerVisible = decide(
    observation('lostTarget', { at: scenario('lostTarget').tick + 1, opponents: currentKnowledge([]) }),
    first.memory,
    params,
    new DeterministicRandom(0n),
  );
  const staleSighting = decide(
    observation('lostTarget', {
      opponents: staleKnowledge(
        [visibleOpponent(entityId(41), blockPosition(5, 64, 0), false)],
        tick(scenario('lostTarget').tick - 1),
      ),
    }),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(first.goal, { kind: 'searchLastKnown', target: entityId(41) });
  deepStrictEqual(noLongerVisible.goal, { kind: 'searchLastKnown', target: entityId(41) });
  deepStrictEqual(noLongerVisible.intent, { kind: 'navigate', target: blockPosition(5, 64, 0) });
  deepStrictEqual(staleSighting.goal, { kind: 'searchLastKnown', target: entityId(41) });
  deepStrictEqual(staleSighting.intent, { kind: 'navigate', target: blockPosition(5, 64, 0) });
});

test('two visible targets select the nearest target regardless of input order', () => {
  const fixture = scenario('twoVisibleTargets');
  const forward = decide(
    observation('twoVisibleTargets'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );
  const reversed = decide(
    observation('twoVisibleTargets', {
      opponents: currentKnowledge([...fixture.opponents].reverse().map((opponent) =>
        visibleOpponent(entityId(opponent.id), position(opponent.position), opponent.attackingAgent))),
    }),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(forward.goal, { kind: 'engageVisibleOpponent', target: entityId(30) });
  deepStrictEqual(forward.intent, { kind: 'attack', target: entityId(30) });
  deepStrictEqual([reversed.goal, reversed.intent], [forward.goal, forward.intent]);
});

test('an observed post-knockback border position escapes before combat or loot', () => {
  const decision = decide(
    observation('afterKnockback'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(decision.goal, { kind: 'escapeBorder' });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(0, 64, 0) });
});

test('loot hysteresis keeps a near-equal container and switches outside its margin', () => {
  const previousNear = policyMemory({
    lastGoal: { kind: 'loot', target: { kind: 'container', position: blockPosition(5, 64, 0) } },
    lastOpponent: null,
  });
  const previousFar = policyMemory({
    lastGoal: { kind: 'loot', target: { kind: 'container', position: blockPosition(7, 64, 0) } },
    lastOpponent: null,
  });
  const near = decide(
    observation('nearHysteresis'),
    previousNear,
    params,
    new DeterministicRandom(0n),
  );
  const far = decide(
    observation('farHysteresis'),
    previousFar,
    params,
    new DeterministicRandom(0n),
  );

  deepStrictEqual(near.goal, {
    kind: 'loot',
    target: { kind: 'container', position: blockPosition(5, 64, 0) },
  });
  deepStrictEqual(far.goal, {
    kind: 'loot',
    target: { kind: 'container', position: blockPosition(4, 64, 0) },
  });
});

test('seat 255 has a replayable search stream and seat 256 is rejected', () => {
  const seat = seatId(255);
  const input = observation('initialSearch');
  const stream = RandomStream.search(seat);
  const first = decide(
    input,
    emptyPolicyMemory(),
    params,
    DeterministicRandom.forStream(481_516n, stream),
  );
  const replay = decide(
    input,
    emptyPolicyMemory(),
    params,
    DeterministicRandom.forStream(481_516n, stream),
  );

  equal(seat, 255);
  deepStrictEqual([replay.goal, replay.intent], [first.goal, first.intent]);
  equal(first.goal.kind, 'explore');
  ok(first.intent.kind === 'navigate');
  const [originX, , originZ] = scenario('initialSearch').position;
  ok(Math.abs(first.intent.target.x - originX) <= params.values.searchRadiusBlocks);
  ok(Math.abs(first.intent.target.z - originZ) <= params.values.searchRadiusBlocks);
  throws(() => seatId(256), RangeError);
});

test('coordinate overflow returns an explicit hold at a safe border-center position', () => {
  const fixture = scenario('explorationOverflow');
  const decision = decide(
    observation('explorationOverflow'),
    emptyPolicyMemory(),
    params,
    new DeterministicRandom(BigInt(fixture.randomSeed)),
  );

  deepStrictEqual(decision.goal, { kind: 'wait', reason: 'unrepresentableTarget' });
  deepStrictEqual(decision.intent, { kind: 'hold', reason: 'unrepresentableTarget' });
});

test('observation validation rejects opponent health, inventory, and evaluator-only fields', () => {
  const validObservation = observation('twoVisibleTargets');
  const opponentWithHiddenState = {
    id: entityId(99),
    position: blockPosition(1, 64, 0),
    attackingAgent: false,
    healthHalfHearts: 2,
    inventory: [{ item: 'diamond', count: 64 }],
  };
  const hiddenOpponentInput = {
    ...validObservation,
    opponents: currentKnowledge([opponentWithHiddenState]),
  } as unknown as AgentObservationInput;
  const evaluatorFactsInput = {
    ...validObservation,
    evaluatorFacts: { healthHalfHearts: 2, inventories: [{ seat: 9, items: ['diamond'] }] },
  } as unknown as AgentObservationInput;

  throws(() => agentObservation(hiddenOpponentInput), TypeError);
  throws(() => agentObservation(evaluatorFactsInput), TypeError);
});
