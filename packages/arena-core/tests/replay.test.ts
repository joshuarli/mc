import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  decide,
  decidePolicyReplayV1,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  PolicyParams,
  PolicyReplayInputError,
  normalizeOpeningPolicyReplayInput,
  normalizePolicyReplayInput,
  openingPolicyState,
  openingStyleForSeat,
  observationSequence,
  rehydratePolicyReplayInput,
  tick,
  unknownKnowledge,
  worldBorder,
  type OpeningStyleCycle,
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
    feedback: [],
    params: PolicyParams.baseline(),
    random: DeterministicRandom.fromState(MAX_U64),
  });
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function serializedOpeningInput(): Record<string, unknown> {
  const observation = makeObservation();
  const seed = 5n;
  const cycle: OpeningStyleCycle = ['explorer', 'scavenger', 'hunter'];
  const input = normalizeOpeningPolicyReplayInput({
    observation,
    memory: emptyPolicyMemory(),
    feedback: [],
    params: PolicyParams.baseline(),
    random: DeterministicRandom.fromState(MAX_U64),
    opening: {
      seed,
      style: openingStyleForSeat(seed, 1, cycle),
      cycle,
      state: openingPolicyState({ cacheTakenAt: null }),
    },
  });
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

test('policy replay input rehydrates validated state and preserves the full u64 RNG state', () => {
  const observation = makeObservation();
  const memory = emptyPolicyMemory();
  const params = PolicyParams.baseline();
  const random = DeterministicRandom.fromState(MAX_U64);
  const wire = normalizePolicyReplayInput({ observation, memory, feedback: [], params, random });

  equal(wire.schema, 'policy-input-v2');
  equal(wire.rng_state, MAX_U64.toString());

  const restored = rehydratePolicyReplayInput(JSON.parse(JSON.stringify(wire)) as unknown);
  if (restored.schema !== 'policy-input-v2') throw new Error('normalization must create policy-input-v2');
  const expected = decide(observation, memory, params, random, []);
  const actual = decide(restored.observation, restored.memory, restored.params, restored.random, restored.feedback);

  deepStrictEqual(actual, expected);
  equal(restored.random.snapshotState(), random.snapshotState());
  deepStrictEqual(JSON.parse(JSON.stringify(normalizePolicyReplayInput({
    observation: restored.observation,
    memory: restored.memory,
    feedback: restored.feedback,
    params: restored.params,
    random: DeterministicRandom.fromState(MAX_U64),
  }))), wire);
});

test('policy-input-v3 preserves opening assignment and rejects unknown styles and versions', () => {
  const wire = serializedOpeningInput();
  equal(wire.schema, 'policy-input-v3');
  const restored = rehydratePolicyReplayInput(wire);
  if (restored.schema !== 'policy-input-v3') throw new Error('opening input must rehydrate as policy-input-v3');
  equal(restored.opening.seed, 5n);
  equal(restored.opening.style, 'explorer');
  deepStrictEqual(restored.opening.cycle, ['explorer', 'scavenger', 'hunter']);
  deepStrictEqual(restored.opening.state, { cacheTakenAt: null });

  const unknownStyle = serializedOpeningInput();
  const opening = unknownStyle.opening as Record<string, unknown>;
  opening.style = 'stalker';
  throws(() => rehydratePolicyReplayInput(unknownStyle), (error) => error instanceof PolicyReplayInputError
    && error.code === 'invalid-opening' && error.field === 'opening.style');

  const unknownVersion = serializedOpeningInput();
  unknownVersion.schema = 'policy-input-v4';
  throws(() => rehydratePolicyReplayInput(unknownVersion), (error) => error instanceof PolicyReplayInputError
    && error.code === 'unsupported-schema');
});

test('policy-input-v1 preserves historical memory and decision semantics', () => {
  const legacy = serializedInput();
  legacy.schema = 'policy-input-v1';
  delete legacy.feedback;
  legacy.memory = { lastGoal: null, lastOpponent: null };
  const restored = rehydratePolicyReplayInput(legacy);
  if (restored.schema !== 'policy-input-v1') throw new Error('legacy input must remain policy-input-v1');

  const actual = decidePolicyReplayV1(
    restored.observation,
    restored.memory,
    restored.params,
    restored.random,
  );
  equal(actual.goal.kind, 'explore');
  deepStrictEqual(actual.memory, { lastGoal: actual.goal, lastOpponent: null });
});

test('policy-input-v1 keeps the sampled overflow hold at the integer edge', () => {
  const observation = agentObservation({
    tick: tick(10),
    sequence: observationSequence(1),
    agent: currentKnowledge(agentState({
      position: blockPosition(Number.MAX_SAFE_INTEGER, 64, 0),
      healthHalfHearts: 40,
      hungerPoints: 20,
      foodStacks: [],
      equipped: emptyEquipment(),
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(Number.MAX_SAFE_INTEGER, 0, 100)),
    opponents: unknownKnowledge(),
    loot: unknownKnowledge(),
  });
  const v2 = normalizePolicyReplayInput({
    observation,
    memory: emptyPolicyMemory(),
    feedback: [],
    params: PolicyParams.baseline(),
    random: new DeterministicRandom(0n),
  });
  const restored = rehydratePolicyReplayInput({
    schema: 'policy-input-v1',
    observation: v2.observation,
    memory: { lastGoal: null, lastOpponent: null },
    params: v2.params,
    rng_state: v2.rng_state,
  });
  if (restored.schema !== 'policy-input-v1') throw new Error('legacy input must remain policy-input-v1');

  const expectedRandom = new DeterministicRandom(0n);
  equal(expectedRandom.nextEightWay(), 7);
  const actual = decidePolicyReplayV1(
    restored.observation,
    restored.memory,
    restored.params,
    restored.random,
  );
  deepStrictEqual(actual, {
    goal: { kind: 'wait', reason: 'unrepresentableTarget' },
    intent: { kind: 'hold', reason: 'unrepresentableTarget' },
    memory: { lastGoal: null, lastOpponent: null },
  });
  equal(restored.random.snapshotState(), expectedRandom.snapshotState());
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

  const invalidFeedback = serializedInput();
  invalidFeedback.feedback = [{ kind: 'failed', target: {} }];
  throws(
    () => rehydratePolicyReplayInput(invalidFeedback),
    (error) => error instanceof PolicyReplayInputError
      && error.code === 'invalid-feedback'
      && error.field === 'feedback',
  );
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
