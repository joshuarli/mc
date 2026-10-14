import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deepStrictEqual, equal, notDeepStrictEqual, ok } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  combatBody,
  combatSelfBody,
  compileCandidate,
  currentKnowledge,
  decisionDiff,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  foodStack,
  isOutsideBorder,
  observationSequence,
  openingPolicyState,
  policyMemory,
  createPolicyFeedback,
  rehydratePolicyReplayInput,
  RandomStream,
  seatId,
  tick,
  unopenedContainer,
  visibleOpponent,
  worldBorder,
  type AgentObservation,
  type DirectionSupport,
  type Goal,
  type PolicyMemory,
} from '../src/index.js';

interface Setup {
  readonly at?: readonly [number, number, number];
  readonly tick?: number;
  readonly weapon?: number | null;
  readonly health?: number;
  readonly hunger?: number;
  readonly foods?: number;
  readonly foodStacks?: readonly { readonly slot: number; readonly count: number; readonly restores?: number }[];
  readonly views?: boolean;
  readonly opponents?: readonly { readonly id: number; readonly at: readonly [number, number, number]; readonly attacking?: boolean }[];
  readonly containers?: readonly (readonly [number, number, number])[];
  readonly directions?: readonly DirectionSupport[];
  readonly border?: readonly [number, number, number];
}

const pos = (value: readonly [number, number, number]) => blockPosition(value[0], value[1], value[2]);

function viewMeasurement(at: readonly [number, number, number]) {
  return {
    position: { x: at[0], y: at[1], z: at[2] },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    width: 0.6,
    height: 1.8,
  };
}

function situation(setup: Setup): AgentObservation {
  const border = setup.border ?? [440, 610, 90];
  const at = setup.at ?? [425, 70, 620];
  const stacks = setup.foodStacks === undefined
    ? (setup.foods === undefined ? [] : [foodStack(9, setup.foods)])
    : setup.foodStacks.map((stack) => (
      stack.restores === undefined ? foodStack(stack.slot, stack.count) : foodStack(stack.slot, stack.count, stack.restores)
    ));
  return agentObservation({
    tick: tick(setup.tick ?? 150),
    sequence: observationSequence((setup.tick ?? 150) + 1),
    agent: currentKnowledge(agentState({
      position: pos(at),
      ...(setup.views === true ? { combat: combatSelfBody({ ...viewMeasurement(at), eyeHeight: 1.62 }) } : {}),
      healthHalfHearts: setup.health ?? 40,
      hungerPoints: setup.hunger ?? 20,
      foodStacks: stacks,
      equipped: { ...emptyEquipment(), weapon: setup.weapon === undefined ? null : setup.weapon },
      upgrades: [],
      ...(setup.directions === undefined ? {} : { directions: setup.directions }),
    })),
    border: currentKnowledge(worldBorder(border[0], border[1], border[2])),
    opponents: currentKnowledge((setup.opponents ?? []).map((opponent) => (
      visibleOpponent(
        entityId(opponent.id),
        pos(opponent.at),
        opponent.attacking ?? false,
        setup.views === true ? combatBody(viewMeasurement(opponent.at)) : undefined,
      )
    ))),
    loot: currentKnowledge((setup.containers ?? []).map((container) => unopenedContainer(pos(container)))),
  });
}

const stream = (seed = 7n) => DeterministicRandom.forStream(seed, RandomStream.policy(seatId(0)));
const improved = compileCandidate('improved');
const baseline = compileCandidate('baseline');

function lootMemory(position: readonly [number, number, number]): PolicyMemory {
  const goal: Goal = { kind: 'loot', target: { kind: 'container', position: pos(position) } };
  return policyMemory({ ...emptyPolicyMemory(), lastGoal: goal });
}

test('an unarmed seat with no known goal travels toward the border center where the caches are, not a random ring point', () => {
  const observation = situation({ at: [380, 70, 649] });
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(decision.goal.kind, 'explore');
  equal(decision.intent.kind, 'navigate');
  const target = (decision.intent as { target: { x: number; z: number } }).target;
  ok(target.x > 380 && target.z < 649, 'moves toward (440,610)');
  equal(explanation.reason, 'travelToBorderCenter');
  ok(explanation.borderCenterBlocks !== null && explanation.borderCenterBlocks > 50);
});

test('a seat whose eight directions all read blocked still travels instead of idling', () => {
  const blocked = Array.from({ length: 8 }, () => ({ kind: 'blocked' as const }));
  const observation = situation({ directions: blocked });
  const baselineDecision = baseline.decide(observation, emptyPolicyMemory(), stream());
  equal(baselineDecision.goal.kind, 'wait');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(decision.goal.kind, 'explore');
  equal(explanation.reason, 'directionsBlockedTravelToCenter');
});

test('a seat near the center orbits it to look for caches and opponents, rotating over time', () => {
  const first = improved.explain(situation({ at: [440, 70, 610], tick: 100 }), emptyPolicyMemory(), stream());
  equal(first.explanation.reason, 'orbitBorderCenter');
  const later = improved.explain(situation({ at: [440, 70, 610], tick: 400 }), emptyPolicyMemory(), stream());
  notDeepStrictEqual(first.decision.intent, later.decision.intent);
});

test('a cache that left the field of view is still pursued until reached', () => {
  const observation = situation({ at: [425, 70, 600] });
  const memory = lootMemory([437, 70, 600]);
  const { decision, explanation } = improved.explain(observation, memory, stream());
  equal(decision.goal.kind, 'explore');
  deepStrictEqual(decision.intent, { kind: 'navigate', target: pos([437, 70, 600]) });
  deepStrictEqual(decision.memory.lastGoal, memory.lastGoal);
  equal(explanation.reason, 'cacheResumedOutOfSight');
  for (const outcome of [{ kind: 'failed', cause: 'noProgress' }, { kind: 'succeeded' }] as const) {
    ok(createPolicyFeedback({ initiatingObservation: observation, goal: decision.goal, intent: decision.intent, outcome }) !== null);
  }
  const baselineDecision = baseline.decide(observation, memory, stream());
  notDeepStrictEqual(baselineDecision.goal.kind, 'loot');
});

test('an unarmed seat takes a visible cache before a fight with a bystander it cannot win', () => {
  const observation = situation({
    at: [430, 70, 610],
    opponents: [{ id: 5, at: [434, 70, 610] }],
    containers: [[430, 70, 616]],
  });
  equal(baseline.decide(observation, emptyPolicyMemory(), stream()).goal.kind, 'engageVisibleOpponent');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(decision.goal.kind, 'loot');
  equal(explanation.reason, 'lootBeforeUnarmedFight');
  const attacked = situation({
    at: [430, 70, 610],
    opponents: [{ id: 5, at: [434, 70, 610], attacking: true }],
    containers: [[430, 70, 616]],
  });
  equal(improved.decide(attacked, emptyPolicyMemory(), stream()).goal.kind, 'engageVisibleOpponent');
});

test('an armed healthy seat hunts a lone visible opponent beyond the baseline fight range', () => {
  const observation = situation({
    at: [430, 70, 610],
    weapon: 4,
    foods: 2,
    opponents: [{ id: 5, at: [440, 70, 610] }],
  });
  notDeepStrictEqual(baseline.decide(observation, emptyPolicyMemory(), stream()).goal.kind, 'engageVisibleOpponent');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  deepStrictEqual(decision.intent, { kind: 'attack', target: 5 });
  equal(explanation.reason, 'huntVisibleOpponentArmed');
  equal(explanation.alternatives[0]!.goal, 'engageVisibleOpponent');
  equal(explanation.alternatives[0]!.condition, 'chosen');
});

test('explanations are bounded and decision diffs list both reasons', () => {
  const quiet = situation({ at: [380, 70, 649] });
  const cached = situation({ at: [425, 70, 600], containers: [[437, 70, 600]] });
  const { explanation } = improved.explain(cached, emptyPolicyMemory(), stream());
  ok(explanation.alternatives.length <= 4);
  const diff = decisionDiff(baseline, improved, [
    { label: 'spawn', observation: quiet, memory: emptyPolicyMemory(), random: () => stream() },
    { label: 'cache', observation: cached, memory: emptyPolicyMemory(), random: () => stream() },
  ]);
  equal(diff.compared, 2);
  equal(diff.entries.length, 1);
  equal(diff.entries[0]!.label, 'spawn');
  equal(diff.entries[0]!.baseline.reason, 'delegatedBaselineRules');
  equal(diff.entries[0]!.improved.reason, 'travelToBorderCenter');
});

test('improved keeps border escape, retreat and eating ahead of every new behavior', () => {
  const outside = situation({ at: [535, 70, 610], opponents: [{ id: 5, at: [500, 70, 610], attacking: true }] });
  equal(improved.decide(outside, emptyPolicyMemory(), stream()).goal.kind, 'escapeBorder');
  const hurt = situation({ health: 6, weapon: 4, opponents: [{ id: 5, at: [427, 70, 620], attacking: true }] });
  equal(improved.decide(hurt, emptyPolicyMemory(), stream()).goal.kind, 'retreatFromOpponent');
  const opening = improved.decideOpening(situation({}), emptyPolicyMemory(), stream(), [], {
    style: 'explorer',
    state: openingPolicyState({ cacheTakenAt: null }),
  });
  equal(opening.goal.kind, 'explore');
});

test('a seat that has not left a 16-block pocket for hundreds of ticks probes far targets in rotating directions', () => {
  const pocket = policyMemory({
    ...emptyPolicyMemory(),
    knowledge: { visitedRegions: [{ x: 29, z: 36 }, { x: 30, z: 37 }], trail: [] },
  });
  const first = improved.explain(situation({ at: [483, 62, 596], tick: 480 }), pocket, stream());
  equal(first.explanation.reason, 'confinedProbeFarTarget');
  const later = improved.explain(situation({ at: [483, 62, 596], tick: 720 }), pocket, stream());
  equal(later.explanation.reason, 'confinedProbeFarTarget');
  notDeepStrictEqual(first.decision.intent, later.decision.intent);
  const target = (first.decision.intent as { target: { x: number; z: number } }).target;
  ok(Math.max(Math.abs(target.x - 483), Math.abs(target.z - 596)) >= 24);
  const early = improved.explain(situation({ at: [483, 62, 596], tick: 100 }), pocket, stream());
  equal(early.explanation.reason, 'travelToBorderCenter');
});

test('improved overrides the baseline on inputs recorded from a live match', () => {
  const recorded = JSON.parse(readFileSync(
    resolve(process.cwd(), 'fixtures/policy-curriculum/live-inputs-v5.json'),
    'utf8',
  )) as Record<string, { input: unknown }>;
  for (const [reason, { input }] of Object.entries(recorded)) {
    const restored = rehydratePolicyReplayInput(input);
    if (restored.schema !== 'policy-input-v4' || restored.opening === null) throw new Error('unexpected fixture shape');
    const explained = improved.explainOpening(
      restored.observation, restored.memory, restored.random, restored.feedback,
      { style: restored.opening.style, state: restored.opening.state },
    );
    equal(explained.explanation.reason, reason);
  }
});

test('a wounded seat with food eats instead of leaving, and without food disengages inside the border', () => {
  const observation = situation({
    health: 8,
    at: [430, 70, 610],
    weapon: 4,
    foodStacks: [{ slot: 9, count: 1, restores: 6 }],
    opponents: [{ id: 5, at: [432, 70, 610] }],
  });
  equal(baseline.explain(observation, emptyPolicyMemory(), stream()).explanation.reason, 'delegatedBaselineRules');
  equal(baseline.decide(observation, emptyPolicyMemory(), stream()).goal.kind, 'retreatFromOpponent');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(explanation.reason, 'eatUnderPressure');
  deepStrictEqual(decision.goal, { kind: 'recoverHunger' });
  deepStrictEqual(decision.intent, { kind: 'eat', inventorySlot: 9 });
  const above = situation({
    health: 9,
    at: [430, 70, 610],
    weapon: 4,
    foods: 2,
    opponents: [{ id: 5, at: [434, 70, 610], attacking: true }],
  });
  const fighting = improved.explain(above, emptyPolicyMemory(), stream());
  equal(fighting.explanation.reason, 'steadyMeleeEngagement');
  deepStrictEqual(fighting.decision.intent, { kind: 'attack', target: 5 });
  const edged = situation({
    health: 6,
    at: [467, 70, 610],
    border: [440, 610, 30],
    opponents: [{ id: 5, at: [466, 70, 610] }],
  });
  const border = worldBorder(440, 610, 30);
  const baselineEdge = baseline.decide(edged, emptyPolicyMemory(), stream());
  ok(baselineEdge.intent.kind === 'navigate' && isOutsideBorder(border, baselineEdge.intent.target));
  const edge = improved.explain(edged, emptyPolicyMemory(), stream());
  equal(edge.explanation.reason, 'disengageWhenBehind');
  deepStrictEqual(edge.decision.intent, { kind: 'navigate', target: pos([467, 70, 610]) });
  ok(edge.decision.intent.kind === 'navigate' && !isOutsideBorder(border, edge.decision.intent.target));
});

test('a wounded seat with no food disengages from a visible opponent', () => {
  const observation = situation({
    health: 8,
    at: [430, 70, 610],
    weapon: 4,
    opponents: [{ id: 5, at: [432, 70, 610] }],
  });
  equal(baseline.decide(observation, emptyPolicyMemory(), stream()).goal.kind, 'retreatFromOpponent');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(explanation.reason, 'disengageWhenBehind');
  deepStrictEqual(decision.goal, { kind: 'retreatFromOpponent', target: 5 });
  deepStrictEqual(decision.intent, { kind: 'navigate', target: pos([426, 70, 610]) });
});

test('a pressured seat eats the food stack that restores the most', () => {
  const observation = situation({
    hunger: 8,
    health: 20,
    at: [430, 70, 610],
    weapon: 4,
    foodStacks: [
      { slot: 10, count: 1, restores: 2 },
      { slot: 8, count: 1, restores: 6 },
      { slot: 4, count: 1 },
      { slot: 12, count: 1, restores: 6 },
    ],
    opponents: [{ id: 5, at: [432, 70, 610], attacking: true }],
  });
  equal(baseline.decide(observation, emptyPolicyMemory(), stream()).intent.kind, 'attack');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(explanation.reason, 'eatUnderPressure');
  deepStrictEqual(decision.goal, { kind: 'recoverHunger' });
  deepStrictEqual(decision.intent, { kind: 'eat', inventorySlot: 8 });
  const wounded = situation({
    health: 8,
    hunger: 20,
    at: [430, 70, 610],
    foodStacks: [
      { slot: 3, count: 2 },
      { slot: 6, count: 1, restores: 4 },
    ],
  });
  notDeepStrictEqual(baseline.decide(wounded, emptyPolicyMemory(), stream()).intent.kind, 'eat');
  const healing = improved.explain(wounded, emptyPolicyMemory(), stream());
  equal(healing.explanation.reason, 'eatUnderPressure');
  deepStrictEqual(healing.decision.intent, { kind: 'eat', inventorySlot: 6 });
});

test('an engaged seat outside melee reach keeps attacking instead of navigating away', () => {
  const observation = situation({
    at: [430, 70, 610],
    weapon: 4,
    foods: 2,
    views: true,
    opponents: [{ id: 5, at: [434, 70, 610], attacking: true }],
  });
  equal(baseline.decide(observation, emptyPolicyMemory(), stream()).intent.kind, 'approach');
  const { decision, explanation } = improved.explain(observation, emptyPolicyMemory(), stream());
  equal(explanation.reason, 'steadyMeleeEngagement');
  deepStrictEqual(decision.intent, { kind: 'attack', target: 5 });
  notDeepStrictEqual(decision.intent.kind, 'navigate');
});

test('a melee engagement keeps one attack intent across the reach boundary so knockback cannot cancel the strike', () => {
  const inReach = situation({ at: [430, 70, 610], weapon: 4, foods: 2, opponents: [{ id: 5, at: [431, 70, 610], attacking: true }] });
  const justOut = situation({ at: [430, 70, 610], weapon: 4, foods: 2, opponents: [{ id: 5, at: [434, 70, 610], attacking: true }] });
  equal(baseline.decide(inReach, emptyPolicyMemory(), stream()).intent.kind, 'attack');
  equal(baseline.decide(justOut, emptyPolicyMemory(), stream()).intent.kind, 'approach');
  const a = improved.explain(inReach, emptyPolicyMemory(), stream());
  const b = improved.explain(justOut, emptyPolicyMemory(), stream());
  deepStrictEqual(a.decision.intent, { kind: 'attack', target: 5 });
  deepStrictEqual(b.decision.intent, a.decision.intent);
  equal(b.explanation.reason, 'steadyMeleeEngagement');
});

test('every improved decision on every recorded live input yields a legal feedback target', () => {
  const files = [
    'live-inputs-v5.json',
    'live-resume-inputs-v5.json',
  ];
  let checked = 0;
  for (const file of files) {
    const recorded = JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures/policy-curriculum', file), 'utf8')) as
      Record<string, { input: unknown }>;
    for (const [name, { input }] of Object.entries(recorded)) {
      const restored = rehydratePolicyReplayInput(input);
      if (restored.schema !== 'policy-input-v4' || restored.opening === null) throw new Error('unexpected fixture shape');
      const explained = improved.explainOpening(
        restored.observation, restored.memory, restored.random, restored.feedback,
        { style: restored.opening.style, state: restored.opening.state },
      );
      for (const outcome of [{ kind: 'failed', cause: 'noProgress' }, { kind: 'succeeded' }] as const) {
        createPolicyFeedback({
          initiatingObservation: restored.observation,
          goal: explained.decision.goal,
          intent: explained.decision.intent,
          outcome,
        });
      }
      checked += 1;
      ok(name.length > 0);
    }
  }
  equal(checked, 6);
});

test('travel targets are observed standable support points and prefer level ground over a drop toward the center', () => {
  const ring = [[8, 0], [8, 4], [0, 8], [-4, 8], [-8, 0], [-8, -4], [0, -8], [4, -8]] as const;
  const at = [380, 70, 600] as const;
  const directions: DirectionSupport[] = ring.map(([dx, dz], index) => (
    index === 0
      ? { kind: 'supported', support: pos([at[0] + dx, 66, at[2] + dz]), hazard: false }
      : index === 1
        ? { kind: 'supported', support: pos([at[0] + dx, 70, at[2] + dz]), hazard: false }
        : index === 4
          ? { kind: 'supported', support: pos([at[0] + dx, 70, at[2] + dz]), hazard: true }
          : { kind: 'blocked' }
  ));
  const { decision } = improved.explain(situation({ at, directions }), emptyPolicyMemory(), stream());
  deepStrictEqual(decision.intent, { kind: 'navigate', target: pos([388, 70, 604]) });
});

test('travel keeps the highest level seen instead of ratcheting down into a pit', () => {
  const memory = policyMemory({
    ...emptyPolicyMemory(),
    knowledge: { visitedRegions: [{ x: 26, z: 37 }], trail: [pos([405, 68, 600]), pos([400, 62, 602])] },
  });
  const { decision } = improved.explain(situation({ at: [398, 62, 602], tick: 150 }), memory, stream());
  equal((decision.intent as { target: { y: number } }).target.y, 68);
});
