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
  DUEL_POOL_IDS,
  DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS,
  duelPoolMember,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  observationSequence,
  seatId,
  tick,
  DeterministicRandom,
  RandomStream,
  visibleOpponent,
  worldBorder,
} from '../src/index.js';

test('duel pool partners emit distinct intents on one observation', () => {
  const observation = agentObservation({
    tick: tick(300),
    sequence: observationSequence(301),
    agent: currentKnowledge(agentState({
      position: blockPosition(0, 64, 0),
      healthHalfHearts: DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS + 1,
      hungerPoints: 20,
      foodStacks: [],
      equipped: emptyEquipment(),
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([
      visibleOpponent(entityId(7), blockPosition(0, 64, 6), false),
    ]),
    loot: currentKnowledge([]),
  });
  const intent = (id: typeof DUEL_POOL_IDS[number]) => duelPoolMember(id).decide(observation);
  const stationary = intent('stationary-dummy');
  const strafer = intent('strafer');
  const rusher = intent('aggressive-rusher');
  const kiter = intent('bow-kiter');
  const shield = intent('shield-user');
  const baseline = intent('baseline');
  deepStrictEqual(stationary, { kind: 'navigate', target: { x: 0, y: 64, z: 0 } });
  deepStrictEqual(strafer, { kind: 'navigate', target: { x: 3, y: 64, z: 6 } });
  deepStrictEqual(rusher, { kind: 'approach', target: 7 });
  deepStrictEqual(kiter, { kind: 'navigate', target: { x: 0, y: 64, z: -1 } });
  deepStrictEqual(shield, { kind: 'attack', target: 7 });
  const compiled = compileCandidate('baseline').decide(
    observation,
    emptyPolicyMemory(),
    DeterministicRandom.forStream(0n, RandomStream.policy(seatId(0))),
  );
  deepStrictEqual(baseline, compiled.intent);
  equal(duelPoolMember('baseline').semanticId, candidateSemanticId('baseline', candidateDefaults('baseline')));
  const emitted = [stationary, strafer, rusher, kiter, shield, baseline];
  equal(new Set(emitted.map((entry) => JSON.stringify(entry))).size, emitted.length);
  for (const id of DUEL_POOL_IDS) {
    equal((CANDIDATE_IDS as readonly string[]).includes(id), id === 'baseline');
  }
  notDeepStrictEqual(baseline, stationary);
});
