import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deepStrictEqual, equal, notDeepStrictEqual, ok } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  compileCandidate,
  currentKnowledge,
  decisionDiff,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  foodStack,
  observationSequence,
  openingPolicyState,
  policyMemory,
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
  readonly foods?: number;
  readonly opponents?: readonly { readonly id: number; readonly at: readonly [number, number, number]; readonly attacking?: boolean }[];
  readonly containers?: readonly (readonly [number, number, number])[];
  readonly directions?: readonly DirectionSupport[];
  readonly border?: readonly [number, number, number];
}

const pos = (value: readonly [number, number, number]) => blockPosition(value[0], value[1], value[2]);

function situation(setup: Setup): AgentObservation {
  const border = setup.border ?? [440, 610, 90];
  return agentObservation({
    tick: tick(setup.tick ?? 150),
    sequence: observationSequence((setup.tick ?? 150) + 1),
    agent: currentKnowledge(agentState({
      position: pos(setup.at ?? [425, 70, 620]),
      healthHalfHearts: setup.health ?? 40,
      hungerPoints: 20,
      foodStacks: setup.foods === undefined ? [] : [foodStack(9, setup.foods)],
      equipped: { ...emptyEquipment(), weapon: setup.weapon === undefined ? null : setup.weapon },
      upgrades: [],
      ...(setup.directions === undefined ? {} : { directions: setup.directions }),
    })),
    border: currentKnowledge(worldBorder(border[0], border[1], border[2])),
    opponents: currentKnowledge((setup.opponents ?? []).map((opponent) => (
      visibleOpponent(entityId(opponent.id), pos(opponent.at), opponent.attacking ?? false)
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
  equal(decision.goal.kind, 'loot');
  deepStrictEqual(decision.intent, { kind: 'navigate', target: pos([437, 70, 600]) });
  equal(explanation.reason, 'cacheResumedOutOfSight');
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
  deepStrictEqual(decision.intent, { kind: 'approach', target: 5 });
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
