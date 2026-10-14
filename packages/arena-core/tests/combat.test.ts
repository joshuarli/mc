import { deepStrictEqual, equal, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  combatBody,
  combatSelfBody,
  currentKnowledge,
  decide,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  eyeToBodyDistance,
  FIXED_UNITS_PER_BLOCK,
  isCrosshairOnBody,
  isWithinMeleeReach,
  normalizePolicyReplayInput,
  policyMemory,
  observationSequence,
  PolicyParams,
  RandomStream,
  rehydratePolicyReplayInput,
  seatId,
  stoppedActionFunnelRecord,
  tick,
  unknownKnowledge,
  visibleOpponent,
  worldBorder,
  type CombatBody,
  type CombatSelfBody,
} from '../src/index.js';

const SELF_HEIGHT = 1.8;
const SELF_EYE = 1.62;
const WIDTH = 0.6;

const selfAt = (x: number, y: number, z: number, yaw = 0, pitch = 0): CombatSelfBody => combatSelfBody({
  position: { x, y, z },
  velocity: { x: 0, y: 0, z: 0 },
  yaw,
  pitch,
  width: WIDTH,
  height: SELF_HEIGHT,
  eyeHeight: SELF_EYE,
});

const bodyAt = (x: number, y: number, z: number, width = WIDTH): CombatBody => combatBody({
  position: { x, y, z },
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  width,
  height: SELF_HEIGHT,
});

const floorBlock = (value: number) => Math.floor(value);

const observationOf = (
  self: CombatSelfBody,
  opponents: readonly { readonly id: number; readonly body: CombatBody; readonly attacking?: boolean }[],
  health = 40,
  extras: { readonly ranged?: { readonly arrows: number }; readonly terrainChanges?: readonly ReturnType<typeof blockPosition>[]; readonly border?: ReturnType<typeof worldBorder> } = {},
) => agentObservation({
  tick: tick(10),
  sequence: observationSequence(11),
  agent: currentKnowledge(agentState({
    position: blockPosition(
      floorBlock(self.position.x / FIXED_UNITS_PER_BLOCK),
      floorBlock(self.position.y / FIXED_UNITS_PER_BLOCK),
      floorBlock(self.position.z / FIXED_UNITS_PER_BLOCK),
    ),
    combat: self,
    ...(extras.ranged === undefined ? {} : { ranged: extras.ranged }),
    ...(extras.terrainChanges === undefined ? {} : { terrainChanges: extras.terrainChanges }),
    healthHalfHearts: health,
    hungerPoints: 20,
    foodStacks: [],
    equipped: emptyEquipment(),
    upgrades: [],
  })),
  border: currentKnowledge(extras.border ?? worldBorder(0, 0, 100)),
  opponents: currentKnowledge(opponents.map(({ id, body, attacking }) => visibleOpponent(
    entityId(id),
    blockPosition(
      floorBlock(body.position.x / FIXED_UNITS_PER_BLOCK),
      floorBlock(body.position.y / FIXED_UNITS_PER_BLOCK),
      floorBlock(body.position.z / FIXED_UNITS_PER_BLOCK),
    ),
    attacking ?? false,
    body,
  ))),
  loot: unknownKnowledge(),
});

const decideOn = (
  observation: ReturnType<typeof observationOf>,
  memory = emptyPolicyMemory(),
) => decide(
  observation,
  memory,
  PolicyParams.baseline(),
  DeterministicRandom.forStream(1n, RandomStream.search(seatId(0))),
);

test('combat views reject nonfinite measurements and block positions that disagree with the fractional position', () => {
  throws(() => selfAt(Number.NaN, 1, 0), RangeError);
  throws(() => selfAt(0, Number.POSITIVE_INFINITY, 0), RangeError);
  throws(() => combatBody({
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: Number.NaN, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    width: WIDTH,
    height: SELF_HEIGHT,
  }), RangeError);
  throws(() => agentState({
    position: blockPosition(0, 1, 0),
    combat: selfAt(1.5, 1, 0.5),
    healthHalfHearts: 40,
    hungerPoints: 20,
    foodStacks: [],
    equipped: emptyEquipment(),
    upgrades: [],
  }), /floor of its fractional combat position/);
});

test('melee reach is measured from the eye to the target bounding box at exactly the named reach', () => {
  const self = selfAt(0.5, 1, 0.5);
  const reachEdgeZ = 0.5 - 3 - 0.25;
  ok(isWithinMeleeReach(self, bodyAt(0.5, 1, reachEdgeZ, 0.5)));
  ok(!isWithinMeleeReach(self, bodyAt(0.5, 1, reachEdgeZ - 0.01, 0.5)));
  equal(eyeToBodyDistance(self, bodyAt(0.5, 1, reachEdgeZ, 0.5)), 3 * FIXED_UNITS_PER_BLOCK);
});

test('crosshair aim requires the look ray to cross the target body within reach', () => {
  const self = selfAt(0.5, 1, 0.5);
  ok(isCrosshairOnBody(self, bodyAt(0.5, 1, -1.5)));
  ok(!isCrosshairOnBody(selfAt(0.5, 1, 0.5, Math.PI / 2), bodyAt(0.5, 1, -1.5)));
  ok(!isCrosshairOnBody(self, bodyAt(0.5, 1, -5)));
});

test('a target in the same integer cell column but outside fractional reach is approached, never attacked', () => {
  const self = selfAt(0.2, 1, 0.5);
  const target = bodyAt(0.2, 1, -2.9);
  const decision = decideOn(observationOf(self, [{ id: 7, body: target }]));
  deepStrictEqual(decision.intent, { kind: 'approach', target: 7 });
});

test('a target inside fractional reach is attacked even when its block cell is four blocks away', () => {
  const self = selfAt(0.99, 1, 0.5);
  const target = bodyAt(0.99, 1, -2.4);
  ok(isWithinMeleeReach(self, target));
  const decision = decideOn(observationOf(self, [{ id: 7, body: target }]));
  deepStrictEqual(decision.intent, { kind: 'attack', target: 7 });
});

test('with several opponents the policy engages the one attacking it, not simply the nearest', () => {
  const self = selfAt(0.5, 1, 0.5);
  const near = bodyAt(0.5, 1, -1.5);
  const attacker = bodyAt(2.4, 1, 0.5);
  const decision = decideOn(observationOf(self, [
    { id: 5, body: near },
    { id: 9, body: attacker, attacking: true },
  ]));
  deepStrictEqual(decision.goal, { kind: 'engageVisibleOpponent', target: 9 });
});

test('a wounded agent outnumbered inside fight range retreats instead of engaging', () => {
  const self = selfAt(0.5, 1, 0.5);
  const observation = observationOf(self, [
    { id: 5, body: bodyAt(0.5, 1, -1.5) },
    { id: 9, body: bodyAt(2.4, 1, 0.5) },
  ], 14);
  equal(decideOn(observation).goal.kind, 'retreatFromOpponent');
  const healthy = observationOf(self, [
    { id: 5, body: bodyAt(0.5, 1, -1.5) },
    { id: 9, body: bodyAt(2.4, 1, 0.5) },
  ], 40);
  equal(decideOn(healthy).goal.kind, 'engageVisibleOpponent');
});

test('fractional combat views survive the strict replay encoding unchanged', () => {
  const self = selfAt(0.2, 1, 0.5, -0.0001, 0.3);
  const observation = observationOf(self, [{ id: 7, body: bodyAt(0.2, 1, -2.9) }]);
  const wire = normalizePolicyReplayInput({
    observation,
    memory: emptyPolicyMemory(),
    feedback: [],
    params: PolicyParams.baseline(),
    random: DeterministicRandom.forStream(1n, RandomStream.search(seatId(0))),
  });
  const restored = rehydratePolicyReplayInput(JSON.parse(JSON.stringify(wire)) as unknown);
  deepStrictEqual(restored.observation, observation);
});

test('funnel records require a missing transition after the last passed stage', () => {
  throws(() => stoppedActionFunnelRecord({
    action: 'attack',
    target: entityId(2),
    lastPassed: 'confirmedEffect',
    reason: 'timeout',
  }), RangeError);
  throws(() => stoppedActionFunnelRecord({
    action: 'attack',
    target: entityId(2),
    lastPassed: 'issued',
    reason: 'notAReason' as never,
  }), TypeError);
  deepStrictEqual(stoppedActionFunnelRecord({
    action: 'attack',
    target: entityId(2),
    lastPassed: 'localValidation',
    reason: 'outOfGeometricReach',
    eyeToBodyUnits: 3100,
  }), {
    kind: 'stopped',
    action: 'attack',
    target: 2,
    lastPassed: 'localValidation',
    reason: 'outOfGeometricReach',
    eyeToBodyUnits: 3100,
  });
});

const EXPLORE_OFFSETS = [[8, 0], [8, 4], [0, 8], [-4, 8], [-8, 0], [-8, -4], [0, -8], [4, -8]] as const;

const exhaustedMemory = (origin: ReturnType<typeof blockPosition>) => policyMemory({
  lastGoal: null,
  lastOpponent: null,
  failedTargets: EXPLORE_OFFSETS.map(([dx, dz]) => ({
    kind: 'explore' as const,
    target: blockPosition(origin.x + dx, origin.y, origin.z + dz),
    origin,
  })),
});

test('curriculum 14: exhausted exploration memory retries the oldest failure instead of idling', () => {
  const self = selfAt(0.5, 64, 0.5);
  const origin = blockPosition(0, 64, 0);
  const decision = decideOn(observationOf(self, []), exhaustedMemory(origin));
  equal(decision.goal.kind, 'explore');
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(8, 64, 0) });
});

test('curriculum 13: a changed block invalidates only the failed route it touches', () => {
  const self = selfAt(0.5, 64, 0.5);
  const origin = blockPosition(0, 64, 0);
  const memory = policyMemory({
    lastGoal: null,
    lastOpponent: null,
    failedTargets: [
      { kind: 'explore', target: blockPosition(8, 64, 0), origin },
      { kind: 'explore', target: blockPosition(-8, 64, 0), origin },
    ],
  });
  const decision = decideOn(observationOf(self, [], 40, { terrainChanges: [blockPosition(4, 64, 0)] }), memory);
  equal(decision.goal.kind, 'explore');
  const kept = decision.memory.failedTargets.map((entry) => entry.kind === 'explore' ? entry.target.x : null);
  deepStrictEqual(kept, [-8]);
});

test('curriculum 8: an archer engages a visible opponent beyond fight range and others explore', () => {
  const self = selfAt(0.5, 64, 0.5);
  const far = bodyAt(0.5, 64, -10.5);
  const armed = decideOn(observationOf(self, [{ id: 3, body: far }], 40, { ranged: { arrows: 12 } }));
  deepStrictEqual(armed.goal, { kind: 'engageVisibleOpponent', target: 3 });
  deepStrictEqual(armed.intent, { kind: 'approach', target: 3 });
  const unarmed = decideOn(observationOf(self, [{ id: 3, body: far }]));
  notEqualGoal(unarmed.goal.kind);
});

test('curriculum 10: border escape preempts engagement even with an attacker in reach', () => {
  const self = selfAt(99.5, 64, 0.5);
  const attacker = bodyAt(98.5, 64, 0.5);
  const decision = decideOn(observationOf(self, [{ id: 4, body: attacker, attacking: true }], 40, {
    border: worldBorder(0, 0, 100),
  }));
  equal(decision.goal.kind, 'escapeBorder');
  deepStrictEqual(decision.intent, { kind: 'navigate', target: blockPosition(0, 64, 0) });
});

function notEqualGoal(kind: string): void {
  ok(kind !== 'engageVisibleOpponent', `unexpected goal ${kind}`);
}
