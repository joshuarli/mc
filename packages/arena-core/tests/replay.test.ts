import { deepStrictEqual, equal, throws } from 'node:assert/strict';
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
  PolicyParams,
  PolicyReplayInputError,
  normalizePolicyReplayInput,
  observationSequence,
  rehydratePolicyReplayInput,
  tick,
  unknownKnowledge,
  worldBorder,
} from '../src/index.js';

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function makeObservation() {
  return agentObservation({
    tick: tick(10),
    sequence: observationSequence(1),
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
}

function serializedInput(): Record<string, unknown> {
  const observation = makeObservation();
  const input = normalizePolicyReplayInput({
    observation,
    memory: emptyPolicyMemory(),
    params: PolicyParams.baseline(),
    random: DeterministicRandom.fromState(MAX_U64),
  });
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

test('policy replay input rehydrates validated state and preserves the full u64 RNG state', () => {
  const observation = makeObservation();
  const memory = emptyPolicyMemory();
  const params = PolicyParams.baseline();
  const random = DeterministicRandom.fromState(MAX_U64);
  const wire = normalizePolicyReplayInput({ observation, memory, params, random });

  equal(wire.schema, 'policy-input-v1');
  equal(wire.rng_state, MAX_U64.toString());

  const restored = rehydratePolicyReplayInput(JSON.parse(JSON.stringify(wire)) as unknown);
  const expected = decide(observation, memory, params, random);
  const actual = decide(restored.observation, restored.memory, restored.params, restored.random);

  deepStrictEqual(actual, expected);
  equal(restored.random.snapshotState(), random.snapshotState());
});

test('policy replay input rejects unknown fields and invalid RNG state encodings', () => {
  const unknownField = serializedInput();
  unknownField.extra = true;
  throws(
    () => rehydratePolicyReplayInput(unknownField),
    (error) => error instanceof PolicyReplayInputError && error.code === 'invalid-shape',
  );

  for (const rngState of ['01', '-1', '18446744073709551616', 7]) {
    const malformed = serializedInput();
    malformed.rng_state = rngState;
    throws(
      () => rehydratePolicyReplayInput(malformed),
      (error) => error instanceof PolicyReplayInputError && error.code === 'invalid-rng-state',
    );
  }
});

test('policy replay input reconstructs the observation brand and rejects stale samples at the current tick', () => {
  const malformed = serializedInput();
  const observation = malformed.observation as Record<string, unknown>;
  observation.opponents = {
    kind: 'stale',
    value: [],
    observedAt: observation.tick,
  };

  throws(
    () => rehydratePolicyReplayInput(malformed),
    (error) => error instanceof PolicyReplayInputError
      && error.code === 'invalid-observation'
      && error.field === 'observation',
  );
});

test('policy replay input rejects unsafe integers and unpaired surrogate strings', () => {
  const unsafeInteger = serializedInput();
  const observation = unsafeInteger.observation as Record<string, unknown>;
  observation.tick = Number.MAX_SAFE_INTEGER + 1;
  throws(
    () => rehydratePolicyReplayInput(unsafeInteger),
    (error) => error instanceof PolicyReplayInputError && error.code === 'unsafe-number',
  );

  const unpairedSurrogate = serializedInput();
  unpairedSurrogate['\ud800'] = true;
  throws(
    () => rehydratePolicyReplayInput(unpairedSurrogate),
    (error) => error instanceof PolicyReplayInputError && error.code === 'invalid-unicode',
  );
});
