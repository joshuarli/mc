import { TraceError } from '../src/trace.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentObservation, agentState, blockPosition, civilizationObservation, civilizationPolicyContext,
  civilizationPolicyFeedbackBatch, civilizationOutpostCells, outpostCell, type CivilizationObservationInput,
  createPolicyFeedback, currentKnowledge, decideCivilization, DeterministicRandom, emptyEquipment, emptyCivilizationPolicyMemory,
  materialStack, observationSequence, PolicyParams, tick, worldBorder,
} from '@arena/core';
import {
  makeCivilizationPolicyEffectRecord, makeCivilizationPolicyReplayRecord,
  normalizeCivilizationPolicyReplayInput, replayPolicyJson,
} from '../src/policy-replay.js';
import type { Evidence } from '../src/evidence.js';
import type { TraceRecord } from '../src/trace.js';

function sample(kind: 'mineBlock' | 'craft' | 'containerTransfer' | 'placeBlock' | 'navigate' = 'craft', withFeedback = false, withActionFeedback = false) {
  const seat = kind === 'placeBlock' ? 1 : kind === 'navigate' ? 2 : 0;
  const context = civilizationPolicyContext({ seat, faction: 'ember', role: seat === 1 ? 'builder' : seat === 2 ? 'defender_scout' : 'gatherer_crafter', objective: {
    captureBox: { min: blockPosition(10, 64, 10), max: blockPosition(12, 66, 12) },
    outpost: { blueprintId: 'oak-outpost-v1', anchor: blockPosition(30, 64, 30), rotationDegrees: 0 },
  } });
  const base = agentObservation({ tick: tick(20), sequence: observationSequence(1),
    agent: currentKnowledge(agentState({ position: kind === 'placeBlock' ? blockPosition(30, 64, 30) : blockPosition(0, 64, 0), healthHalfHearts: 40,
      hungerPoints: 20, foodStacks: [], equipped: emptyEquipment(), upgrades: [] })),
    border: currentKnowledge(worldBorder(0, 0, 96)), opponents: currentKnowledge([]), loot: currentKnowledge([]),
  });
  const materials = kind === 'craft' ? [materialStack(9, 'oak_log', 4)]
    : kind === 'placeBlock' || kind === 'containerTransfer' ? [materialStack(9, 'oak_planks', 16)] : [];
  const resources: CivilizationObservationInput['observedResources'] = kind === 'mineBlock'
    ? currentKnowledge([{ kind: 'logBlock', position: blockPosition(2, 64, 0) }])
    : kind === 'containerTransfer'
      ? currentKnowledge([{ kind: 'container', position: blockPosition(1, 64, 0), contents: currentKnowledge([]) }])
      : kind === 'placeBlock'
        ? currentKnowledge(civilizationOutpostCells(context.objective.outpost.anchor, 0).map((cell) => outpostCell(cell.position, 'air', 'solid')))
        : currentKnowledge([]);
  const observation = civilizationObservation({ base, ownMaterials: currentKnowledge(materials),
    observedResources: resources, teamMessages: [] }, context);
  const memory = emptyCivilizationPolicyMemory();
  const params = PolicyParams.baseline();
  const random = DeterministicRandom.fromState(123n);
  const completed = createPolicyFeedback({ initiatingObservation: base, goal: { kind: 'explore' },
    intent: { kind: 'navigate', target: blockPosition(7, 64, 0) }, outcome: { kind: 'failed', cause: 'noProgress' } });
  if (completed === null) throw new Error('exploration must produce target feedback');
  const feedback = civilizationPolicyFeedbackBatch({ shared: withFeedback ? [completed] : [], actions: withActionFeedback ? [{
    goal: { kind: 'craftMaterial', item: 'oak_planks', resultCount: 16 },
    intent: { kind: 'craft', output: 'oak_planks', resultCount: 16, table: null },
    outcome: { kind: 'failed', cause: 'noProgress' }, startedAt: tick(20), completedAt: tick(20),
  }] : [] });
  const input = normalizeCivilizationPolicyReplayInput({ context, observation, memory, feedback, params, random });
  const decision = decideCivilization(context, observation, memory, params, random, feedback);
  return makeCivilizationPolicyReplayRecord({ sequence: 1n, seat, input, decision,
    rngStateAfter: random.snapshotState(), disposition: decision.intent.kind === 'hold' ? { kind: 'hold' } : { kind: 'start', action_sequence: '1' } });
}

function evidence(records: readonly object[]): Evidence {
  return { run_id: 'civ-replay', first_sequence: '1', last_sequence: String(records.length), segments: [],
    records: records as readonly TraceRecord[] };
}

test('civilization craft replay retains its closed namespace and cancellation settlement', () => {
  const record = sample();
  assert.equal(record.decision.intent.kind, 'craft');
  assert.equal(record.input.schema, 'civilization-policy-input-v1');
  const effect = makeCivilizationPolicyEffectRecord(1n, { kind: 'cancelled', reason: 'shutdown' }, []);
  assert.equal(replayPolicyJson(evidence([record, effect])).effect_count, 1);
});

test('civilization replay rejects unknown versions, altered decisions and cross-namespace effects', () => {
  const record = sample();
  assert.throws(() => replayPolicyJson(evidence([{ ...record, schema: 'civilization-policy-replay-v2' }])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'unsupported_policy_schema');
  assert.throws(() => replayPolicyJson(evidence([{ ...record, decision: { ...record.decision, intent: { kind: 'hold' } } }])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'policy_decision_mismatch');
  const effect = makeCivilizationPolicyEffectRecord(1n, { kind: 'succeeded' }, []);
  assert.throws(() => replayPolicyJson(evidence([record, { ...effect, schema: 'policy-effect-v1' }])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'policy_effect_namespace_mismatch');
});

test('civilization replay refuses unjoined effects at a terminal control outcome', () => {
  assert.throws(() => replayPolicyJson(evidence([sample(), { direction: 'plugin', type: 'outcome' }])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'policy_skill_result_pending');
});

for (const intent of ['mineBlock', 'craft', 'containerTransfer', 'placeBlock', 'navigate'] as const) {
  test(`civilization replay preserves ${intent} decisions`, () => {
    const record = sample(intent);
    assert.equal(record.decision.intent.kind, intent);
    const effect = makeCivilizationPolicyEffectRecord(1n, { kind: 'succeeded' }, []);
    assert.equal(replayPolicyJson(evidence([record, effect])).decision_count, 1);
  });
}

test('civilization replay rejects an unknown input version and unknown fields', () => {
  const record = sample();
  for (const input of [{ ...record.input, schema: 'civilization-policy-input-v2' }, { ...record.input, extra: true }]) {
    assert.throws(() => replayPolicyJson(evidence([{ ...record, input }])), (error: unknown) => error instanceof TraceError);
  }
});

test('civilization replay retains replaced actions until their own cancellation joins', () => {
  const first = sample();
  const second = { ...first, sequence: '2', disposition: { kind: 'replace', action_sequence: '2',
    replaces_action_sequence: '1', reason: 'higherPriority' } };
  const secondEffect = makeCivilizationPolicyEffectRecord(2n, { kind: 'succeeded' }, []);
  const outcome = { direction: 'plugin', type: 'outcome' };
  assert.throws(() => replayPolicyJson(evidence([first, second, secondEffect, outcome])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'policy_skill_result_pending');
  const cancelled = makeCivilizationPolicyEffectRecord(1n, { kind: 'cancelled', reason: 'replaced' }, []);
  assert.equal(replayPolicyJson(evidence([first, second, secondEffect, outcome, cancelled])).effect_count, 2);
});

test('civilization replay rejects nonterminal effects', () => {
  const pending = makeCivilizationPolicyEffectRecord(1n, { kind: 'pending' }, []);
  assert.throws(() => replayPolicyJson(evidence([sample(), pending])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'nonterminal_policy_effect');
});

test('civilization replay preserves current feedback and its resulting memory', () => {
  const record = sample('craft', true);
  assert.equal(record.input.feedback.shared.length, 1);
  assert.equal(record.decision.memory.policy.failedTargets.length, 1);
  assert.equal(replayPolicyJson(evidence([record])).verified, true);
});

test('civilization replay refuses decisions after the terminal control outcome', () => {
  assert.throws(() => replayPolicyJson(evidence([{ direction: 'plugin', type: 'outcome' }, sample()])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'policy_decision_after_outcome');
});

test('civilization replay preserves material action feedback and failed-target memory', () => {
  const record = sample('craft', false, true);
  assert.equal(record.input.feedback.actions.length, 1);
  assert.equal(record.decision.memory.failedMaterialTargets.length, 1);
  assert.equal(replayPolicyJson(evidence([record])).verified, true);
  const modified = { ...record, input: { ...record.input, feedback: { ...record.input.feedback, actions: [] } } };
  assert.throws(() => replayPolicyJson(evidence([modified])),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'policy_decision_mismatch');
});
