import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  PolicyParams,
  RandomStream,
  rehydratePolicyReplayInput,
  seatId,
  tick,
  observationSequence,
  unknownKnowledge,
  worldBorder,
  decide,
} from '@arena/core';
import { decideRuntimePolicy } from '../src/runtime/policy-decision.js';

test('runtime policy replay captures the RNG state before an exploration draw', () => {
  const observation = agentObservation({
    tick: tick(10),
    sequence: observationSequence(11),
    agent: currentKnowledge(agentState({
      position: blockPosition(0, 64, 0),
      healthHalfHearts: 40,
      hungerPoints: 20,
      foodStacks: [],
      equipped: emptyEquipment(),
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([]),
    loot: unknownKnowledge(),
  });
  const memory = emptyPolicyMemory();
  const params = PolicyParams.baseline();
  const random = DeterministicRandom.forStream(481_516n, RandomStream.policy(seatId(0)));

  const step = decideRuntimePolicy(observation, memory, params, random);
  const replay = rehydratePolicyReplayInput(step.input);
  const replayedDecision = decide(replay.observation, replay.memory, replay.params, replay.random);

  assert.deepEqual(step.decision.goal, { kind: 'explore' });
  assert.notEqual(BigInt(step.input.rng_state), step.rngStateAfter);
  assert.deepEqual(replayedDecision, step.decision);
  assert.equal(replay.random.snapshotState(), step.rngStateAfter);
});
