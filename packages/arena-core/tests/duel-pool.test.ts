import { deepStrictEqual, equal, notDeepStrictEqual } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  CANDIDATE_IDS,
  candidateDefaults,
  candidateSemanticId,
  compileCandidate,
  currentKnowledge,
  decideDuelPool,
  DUEL_POOL_IDS,
  DUEL_POOL_SCORING_CANDIDATES,
  DUEL_POOL_VERSION,
  DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS,
  duelPoolMember,
  duelPoolQualificationReport,
  duelPoolScoringMembers,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  identifiedFoodStack,
  observationSequence,
  seatId,
  tick,
  DeterministicRandom,
  RandomStream,
  visibleOpponent,
  worldBorder,
} from '../src/index.js';

function seenOpponent(
  opponentZ: number,
  state: { readonly health?: number; readonly foodStacks?: ReturnType<typeof identifiedFoodStack>[] } = {},
) {
  return agentObservation({
    tick: tick(300),
    sequence: observationSequence(301),
    agent: currentKnowledge(agentState({
      position: blockPosition(0, 64, 0),
      healthHalfHearts: state.health ?? DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS + 1,
      hungerPoints: 20,
      foodStacks: state.foodStacks ?? [],
      equipped: emptyEquipment(),
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([
      visibleOpponent(entityId(7), blockPosition(0, 64, opponentZ), false),
    ]),
    loot: currentKnowledge([]),
  });
}

test('duel pool partners emit distinct intents on one observation', () => {
  const observation = seenOpponent(12);
  const intent = (id: typeof DUEL_POOL_IDS[number]) => duelPoolMember(id).decide(observation);
  const stationary = intent('stationary-dummy');
  const strafer = intent('strafer');
  const rusher = intent('aggressive-rusher');
  const kiter = intent('bow-kiter');
  const shield = intent('shield-user');
  const baseline = intent('baseline');
  deepStrictEqual(stationary, { kind: 'navigate', target: { x: 0, y: 64, z: 0 } });
  deepStrictEqual(strafer, { kind: 'navigate', target: { x: 3, y: 64, z: 12 } });
  deepStrictEqual(rusher, { kind: 'approach', target: 7 });
  deepStrictEqual(kiter, { kind: 'shoot', target: 7 });
  deepStrictEqual(decideDuelPool(
    'bow-kiter',
    observation,
    emptyPolicyMemory(),
    DeterministicRandom.forStream(0n, RandomStream.policy(seatId(1))),
  ).intent, { kind: 'shoot', target: 7 });
  deepStrictEqual(shield, { kind: 'attack', target: 7 });
  const compiled = compileCandidate('baseline').decide(
    observation,
    emptyPolicyMemory(),
    DeterministicRandom.forStream(0n, RandomStream.policy(seatId(0))),
  );
  deepStrictEqual(baseline, compiled.intent);
  equal(duelPoolMember('baseline').semanticId, candidateSemanticId('baseline', candidateDefaults('baseline')));
  const close = seenOpponent(2);
  const closeKiter = duelPoolMember('bow-kiter').decide(close);
  deepStrictEqual(closeKiter, { kind: 'navigate', target: { x: 0, y: 64, z: -4 } });
  deepStrictEqual(duelPoolMember('stationary-dummy').decide(close), { kind: 'attack', target: 7 });
  const emitted = [stationary, strafer, rusher, shield, baseline, closeKiter];
  equal(new Set(emitted.map((entry) => JSON.stringify(entry))).size, emitted.length);
  for (const id of DUEL_POOL_IDS) {
    equal((CANDIDATE_IDS as readonly string[]).includes(id), id === 'baseline');
  }
  equal((DUEL_POOL_SCORING_CANDIDATES as readonly string[]).includes('stationary-dummy'), false);
  notDeepStrictEqual(baseline, stationary);
});

test('duel pool qualification requires matching client and server receipts', () => {
  const report = duelPoolQualificationReport([
    { member: 'bow-kiter', action: 'arrowReleased', client: true, server: false },
    { member: 'shield-user', action: 'shieldRaised', client: true, server: true },
    { member: 'shield-user', action: 'shieldLowered', client: true, server: true },
    { member: 'strafer', action: 'lateralMovement', client: true, server: true },
    { member: 'aggressive-rusher', action: 'contactStarted', client: true, server: true },
    { member: 'shield-user', action: 'healedWithPermittedItem', client: true, server: true },
  ]);

  equal(DUEL_POOL_VERSION, 2);
  equal(report.find((entry) => entry.member === 'bow-kiter')?.status, 'unqualified');
  equal(report.find((entry) => entry.member === 'bow-kiter')?.reason, 'missing server receipt: arrowReleased');
  equal(report.find((entry) => entry.member === 'shield-user')?.status, 'qualified');
  equal(report.find((entry) => entry.member === 'strafer')?.status, 'qualified');
  equal(report.find((entry) => entry.member === 'aggressive-rusher')?.status, 'qualified');
  deepStrictEqual(duelPoolScoringMembers(report), ['strafer', 'aggressive-rusher', 'shield-user']);
  equal(report.find((entry) => entry.member === 'stationary-dummy')?.status, 'diagnostic');
});

test('shield user heals with golden apples and does not mistake hunger food for healing', () => {
  const apple = seenOpponent(12, {
    health: 24,
    foodStacks: [identifiedFoodStack(8, 1, 'goldenApple', 4)],
  });
  const food = seenOpponent(12, {
    health: 24,
    foodStacks: [identifiedFoodStack(4, 3, 'hungerFood', 8)],
  });

  deepStrictEqual(duelPoolMember('shield-user').decide(apple), { kind: 'eat', inventorySlot: 8 });
  deepStrictEqual(duelPoolMember('shield-user').decide(food), { kind: 'attack', target: 7 });
});
