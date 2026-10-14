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
import { decideRuntimePolicy, isStrategyDecisionTick } from '../src/runtime/policy-decision.js';

test('strategy decision cadence uses exact bigint ticks and intervals', () => {
  assert.equal(isStrategyDecisionTick(0n, 4n), true);
  assert.equal(isStrategyDecisionTick(3n, 4n), false);
  assert.equal(isStrategyDecisionTick(4n, 4n), true);

  const interval = 9_007_199_254_740_993n;
  assert.equal(isStrategyDecisionTick(9_007_199_254_740_992n, interval), false);
  assert.equal(isStrategyDecisionTick(interval, interval), true);
});

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
  if (replay.schema !== 'policy-input-v4') throw new Error('expected v4 input');
  const replayedDecision = decide(replay.observation, replay.memory, replay.params, replay.random);

  assert.deepEqual(step.decision.goal, { kind: 'explore' });
  assert.notEqual(BigInt(step.input.rng_state), step.rngStateAfter);
  assert.deepEqual(replayedDecision, step.decision);
  assert.equal(replay.random.snapshotState(), step.rngStateAfter);
});
