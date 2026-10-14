import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  decide,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  foodStack,
  MAX_TRAIL_POSITIONS,
  MAX_VISITED_REGIONS,
  observationSequence,
  PolicyParams,
  policyMemory,
  RandomStream,
  seatId,
  tick,
  unknownKnowledge,
  visibleDrop,
  worldBorder,
  type DirectionSupport,
  type FoodStack,
  type LootOpportunity,
  type PolicyMemory,
} from '../src/index.js';

const supported = (x: number, z: number, hazard = false): DirectionSupport => ({
  kind: 'supported',
  support: blockPosition(x, 64, z),
  hazard,
});
const blocked: DirectionSupport = { kind: 'blocked' };
const unloaded: DirectionSupport = { kind: 'unloaded' };

const RING = [[8, 0], [8, 4], [0, 8], [-4, 8], [-8, 0], [-8, -4], [0, -8], [4, -8]] as const;

const observationAt = (options: {
  readonly x?: number;
  readonly z?: number;
  readonly at?: number;
  readonly directions?: readonly DirectionSupport[];
  readonly hunger?: number;
  readonly foods?: readonly FoodStack[];
  readonly ranged?: { readonly arrows: number };
  readonly loot?: readonly LootOpportunity[];
}) => agentObservation({
  tick: tick(options.at ?? 10),
  sequence: observationSequence((options.at ?? 10) + 1),
  agent: currentKnowledge(agentState({
    position: blockPosition(options.x ?? 0, 64, options.z ?? 0),
    ...(options.directions === undefined ? {} : { directions: options.directions }),
    ...(options.ranged === undefined ? {} : { ranged: options.ranged }),
    healthHalfHearts: 40,
    hungerPoints: options.hunger ?? 20,
    foodStacks: options.foods ?? [],
    equipped: emptyEquipment(),
    upgrades: [],
  })),
  border: currentKnowledge(worldBorder(0, 0, 200)),
  opponents: currentKnowledge([]),
  loot: options.loot === undefined ? unknownKnowledge() : currentKnowledge(options.loot),
});

const random = () => DeterministicRandom.forStream(3n, RandomStream.search(seatId(0)));
const run = (observation: ReturnType<typeof observationAt>, memory: PolicyMemory = emptyPolicyMemory()) => decide(
  observation, memory, PolicyParams.baseline(), random(),
);

test('exploration targets observed support and skips cliffs and hazards', () => {
  const directions = RING.map(([dx, dz], index) => (index === 3 ? supported(dx, dz) : index === 5 ? supported(dx, dz, true) : blocked));
  const decision = run(observationAt({ directions }));
  deepStrictEqual(decision.goal, { kind: 'explore' });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(-4, 64, 8) });
});

test('exploration prefers an unvisited region over a visited one', () => {
  const directions = RING.map(([dx, dz]) => supported(dx, dz));
  const memory = policyMemory({
    lastGoal: null,
    lastOpponent: null,
    failedTargets: [],
    knowledge: {
      visitedRegions: RING.slice(0, 7).map(([dx, dz]) => ({ x: Math.floor(dx / 16), z: Math.floor(dz / 16) })),
      trail: [],
    },
  });
  const decision = run(observationAt({ x: 20, z: 20, directions: directions.map((d, index) => (
    d.kind === 'supported' ? supported(20 + RING[index]![0], 20 + RING[index]![1]) : d
  )) }), memory);
  equal(decision.goal.kind, 'explore');
});

test('saturated failures backtrack along the trail, then retry, then say why they wait', () => {
  const directions = RING.map(([dx, dz]) => supported(dx, dz));
  const failedTargets = RING.map(([dx, dz]) => ({
    kind: 'explore' as const,
    target: blockPosition(dx, 64, dz),
    origin: blockPosition(0, 64, 0),
  }));
  const withTrail = policyMemory({
    lastGoal: null,
    lastOpponent: null,
    failedTargets,
    knowledge: { visitedRegions: [{ x: 0, z: 0 }], trail: [blockPosition(-30, 64, -30), blockPosition(0, 64, 0)] },
  });
  const back = run(observationAt({ directions }), withTrail);
  deepStrictEqual(back.intent, { kind: 'navigate', target: blockPosition(-30, 64, -30) });

  const noTrail = policyMemory({ lastGoal: null, lastOpponent: null, failedTargets });
  const retry = run(observationAt({ directions }), noTrail);
  equal(retry.goal.kind, 'explore');

  const boxedIn = run(observationAt({ directions: RING.map(() => blocked) }));
  deepStrictEqual(boxedIn.goal, { kind: 'wait', reason: 'noReachableFrontier' });

  const unknownTerrain = run(observationAt({ directions: RING.map(() => unloaded) }));
  equal(unknownTerrain.goal.kind, 'explore');
});

test('region and trail memory stay within their documented caps', () => {
  let memory: PolicyMemory = emptyPolicyMemory();
  for (let step = 0; step < 300; step += 1) {
    memory = decide(
      observationAt({ x: step * 16, z: step * 9, at: step + 1 }),
      memory,
      PolicyParams.baseline(),
      random(),
    ).memory;
  }
  equal(memory.knowledge?.visitedRegions.length, MAX_VISITED_REGIONS);
  equal(memory.knowledge?.trail.length, MAX_TRAIL_POSITIONS);
});

test('food choice wastes the least hunger restoration and prefers known stacks', () => {
  const foods = [foodStack(9, 2, 8), foodStack(10, 3, 4), foodStack(11, 1)];
  const slight = decide(observationAt({ hunger: 6, foods }), emptyPolicyMemory(), PolicyParams.baseline(), random());
  deepStrictEqual(slight.intent, { kind: 'eat', inventorySlot: 9 });
  const small = decide(observationAt({ hunger: 7, foods: [foodStack(9, 2, 8), foodStack(10, 3, 4)] }), emptyPolicyMemory(), PolicyParams.baseline(), random());
  deepStrictEqual(small.intent, { kind: 'eat', inventorySlot: 9 });
  const nearlyFull = decide(
    observationAt({ hunger: 8, foods: [foodStack(9, 2, 8), foodStack(10, 3, 4)] }),
    emptyPolicyMemory(), PolicyParams.baseline(), random(),
  );
  deepStrictEqual(nearlyFull.intent, { kind: 'eat', inventorySlot: 9 });
  const unknown = decide(
    observationAt({ hunger: 4, foods: [foodStack(12, 1), foodStack(11, 1)] }),
    emptyPolicyMemory(), PolicyParams.baseline(), random(),
  );
  deepStrictEqual(unknown.intent, { kind: 'eat', inventorySlot: 11 });
});

test('ammunition drops matter only to an archer running low', () => {
  const arrows = visibleDrop(entityId(80), blockPosition(3, 64, 0), { kind: 'ammunition' });
  const archer = run(observationAt({ ranged: { arrows: 2 }, loot: [arrows] }));
  equal(archer.goal.kind, 'loot');
  const stocked = run(observationAt({ ranged: { arrows: 40 }, loot: [arrows] }));
  ok(stocked.goal.kind !== 'loot');
  const noBow = run(observationAt({ loot: [arrows] }));
  ok(noBow.goal.kind !== 'loot');
});
