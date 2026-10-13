import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  decide,
  decidePolicyReplayV1,
  type PolicyReplayInputV1,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  normalizePolicyReplayInput,
  observationSequence,
  PolicyParams,
  rehydratePolicyReplayInput,
  tick,
  unknownKnowledge,
  worldBorder,
} from '@arena/core';
import { makePolicyEffectRecord, makePolicyReplayRecord, replayPolicyJson } from '../src/policy-replay.js';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { runCli } from '../src/index.js';
import { TraceError, type TraceRecord } from '../src/trace.js';
import type { Evidence } from '../src/evidence.js';

const MAX_U64 = (1n << 64n) - 1n;
const runId = 'policy-replay-test';
const temporaryRoot = resolve(process.cwd(), '.work/tmp');

function evidence(records: readonly object[]): Evidence {
  return {
    run_id: runId,
    first_sequence: '1',
    last_sequence: String(records.length),
    segments: [],
    records: records as readonly TraceRecord[],
  };
}

function policyRecord(sequence = 1n, randomState = MAX_U64) {
  const observation = agentObservation({
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
  const memory = emptyPolicyMemory();
  const params = PolicyParams.baseline();
  const normalized = normalizePolicyReplayInput({
    observation,
    memory,
    feedback: [],
    params,
    random: DeterministicRandom.fromState(randomState),
  });
  const input: PolicyReplayInputV1 = { schema: 'policy-input-v1', observation: normalized.observation,
    memory: { lastGoal: normalized.memory.lastGoal, lastOpponent: normalized.memory.lastOpponent },
    params: normalized.params, rng_state: normalized.rng_state };
  const restored = rehydratePolicyReplayInput(input);
  if (restored.schema !== 'policy-input-v1') throw new Error('expected legacy input');
  const decision = decidePolicyReplayV1(restored.observation, restored.memory, restored.params, restored.random);
  return { schema: 'policy-replay-v1' as const, sequence: sequence.toString(), seat: 255, input, decision, rng_state_after: restored.random.snapshotState().toString() };
}

test('replays exact core decisions and verifies full-u64 policy sequences and RNG states', () => {
  const frame = policyRecord(MAX_U64, MAX_U64);
  const effect = makePolicyEffectRecord(MAX_U64, { kind: 'succeeded' }, [{
    status: 'success',
    path: [{ x: 1, y: 64, z: -2 }],
  }]);

  assert.deepEqual(replayPolicyJson(evidence([frame, effect])), {
    schema: 1,
    run_id: runId,
    verified: true,
    decision_count: 1,
    policy_sequence_range: { first: MAX_U64.toString(), last: MAX_U64.toString() },
    effect_count: 1,
    path_update_count: 1,
  });

  assert.equal(replayPolicyJson(evidence([policyRecord(1n, 0n)])).verified, true);
});

test('replay-policy CLI preserves fractional Pathfinder positions in trace effects', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(join(temporaryRoot, 'policy-replay-'));
  try {
    const frame = policyRecord();
    const effect = makePolicyEffectRecord(1n, { kind: 'succeeded' }, [{
      status: 'success',
      path: [{ x: 0.5, y: 64, z: 0.5 }],
    }]);
    const records = [frame, effect];
    const segment = canonicalJson({
      schema: 2,
      run_id: runId,
      first_sequence: '1',
      last_sequence: '2',
      records,
      sha256: sha256Json(records),
      trailer: { complete: true },
    });
    const path = join(scratch, 'policy-trace.json');
    await writeFile(path, segment);

    const result = await runCli(['replay-policy', path]);
    assert.equal(result.kind, 'success');
    if (result.kind !== 'success') return;
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 1,
      run_id: runId,
      verified: true,
      decision_count: 1,
      policy_sequence_range: { first: '1', last: '1' },
      effect_count: 1,
      path_update_count: 1,
    });

    const inspection = await runCli(['inspect', path]);
    assert.equal(inspection.kind, 'success');
    if (inspection.kind !== 'success') return;
    const inspectedRecords = JSON.parse(inspection.stdout).records as readonly TraceRecord[];
    assert.deepEqual(inspectedRecords[1]?.path_updates, [{
      status: 'success',
      path: [{ x: 0.5, y: 64, z: 0.5 }],
    }]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('rejects a decision that does not match the rehydrated policy input', () => {
  const frame = { ...policyRecord(), decision: { kind: 'forged' } };

  assert.throws(() => replayPolicyJson(evidence([frame])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'policy_decision_mismatch');
    assert.equal(error.source.field, 'decision');
    return true;
  });
});

test('rejects corrupt RNG results and malformed policy input', () => {
  const frame = policyRecord();
  assert.throws(() => replayPolicyJson(evidence([{ ...frame, rng_state_after: '0' }])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'policy_rng_state_mismatch');
    return true;
  });

  const malformedInput = { ...frame.input, extra: true };
  assert.throws(() => replayPolicyJson(evidence([{ ...frame, input: malformedInput }])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'invalid_policy_input');
    return true;
  });
});

test('requires increasing policy sequences and effects correlated to one decision', () => {
  const first = policyRecord(1n);
  const second = policyRecord(1n);
  assert.throws(() => replayPolicyJson(evidence([first, second])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'policy_sequence_not_increasing');
    return true;
  });

  const unmatched = makePolicyEffectRecord(2n, { kind: 'failed', cause: 'noProgress' }, []);
  assert.throws(() => replayPolicyJson(evidence([first, unmatched])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'unmatched_policy_effect');
    return true;
  });

  const effect = makePolicyEffectRecord(1n, { kind: 'failed', cause: 'noProgress' }, []);
  assert.throws(() => replayPolicyJson(evidence([first, effect, effect])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'duplicate_policy_effect');
    return true;
  });
});

test('checks policy seats against the prepared roster when the trace includes it', () => {
  const prepare = {
    direction: 'runner',
    protocol: 1,
    run_id: runId,
    sequence: '1',
    type: 'prepare',
    payload: {
      map_semantic_id: 'a'.repeat(64),
      scenario_semantic_id: 'b'.repeat(64),
      seed: '1',
      mode: 'hunger_games',
      settings: {
        match: {
          countdown_ticks: '0',
          grace_ticks: '0',
          authoritative_max_ticks: '10',
          respawn: false,
          block_breaking: false,
          block_placing: false,
          natural_mobs: false,
          natural_random_ticks: false,
        },
        border: {
          initial_diameter_blocks: 126,
          shrink_start_tick: '0',
          shrink_end_tick: '9',
          final_diameter_blocks: 16,
        },
      },
      roster: [{
        kind: 'bot',
        seat: 0,
        participant_id: 'bot-0',
        username: 'bot_0',
        offline_uuid: '00000000-0000-0000-0000-000000000001',
      }],
    },
  };

  assert.throws(() => replayPolicyJson(evidence([prepare, policyRecord()])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'policy_seat_not_in_roster');
    return true;
  });
});

test('rejects fabricated or malformed path results in effect evidence', () => {
  assert.throws(() => makePolicyEffectRecord(1n, { kind: 'succeeded' }, [
    { status: 'success', path: [{ x: Number.NaN, y: 64, z: 0 }] },
  ]));
  assert.throws(() => makePolicyEffectRecord(1n, { kind: 'succeeded' }, [
    { status: 'success', path: [{ x: Number.POSITIVE_INFINITY, y: 64, z: 0 }] },
  ]));
  assert.throws(() => makePolicyEffectRecord(1n, { kind: 'succeeded' }, [
    { status: 'success', path: [{ x: Number.MAX_SAFE_INTEGER + 1, y: 64, z: 0 }] },
  ]));
  assert.throws(() => makePolicyEffectRecord(1n, { kind: 'succeeded' }, [
    { status: 'unknown' as 'success', path: [] },
    { status: 'success', path: [] },
  ]));

  const oversizedCoordinate = {
    schema: 'policy-effect-v1',
    decision_sequence: '1',
    skill: { kind: 'succeeded' },
    path_updates: [{ status: 'success', path: [{ x: Number.MAX_SAFE_INTEGER + 1, y: 64, z: 0 }] }],
  };
  assert.throws(() => replayPolicyJson(evidence([policyRecord(), oversizedCoordinate])), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'invalid_policy_path_position');
    return true;
  });
});

function actionRecord(sequence: bigint, disposition: import('../src/policy-replay.js').PolicyDisposition, seat = 255) {
  const frame = policyRecord(sequence);
  return { ...frame, schema: 'policy-replay-v2' as const, seat, disposition,
    input: { ...frame.input, schema: 'policy-input-v2' as const, memory: { ...frame.input.memory, failedTargets: [] }, feedback: [] },
    decision: { ...frame.decision, memory: { ...frame.decision.memory, failedTargets: [] } },
  };
}

test('policy replay v2 verifies continued actions and replacement effects by their initiating identity', () => {
  const first = actionRecord(1n, { kind: 'start', action_sequence: '1' });
  const continued = actionRecord(2n, { kind: 'continue', action_sequence: '1' });
  const replacement = actionRecord(3n, { kind: 'replace', action_sequence: '3', replaces_action_sequence: '1', reason: 'higherPriority' });
  const summary = replayPolicyJson(evidence([first, continued, replacement,
    makePolicyEffectRecord(1n, { kind: 'cancelled', reason: 'replaced' }, []),
    actionRecord(4n, { kind: 'defer', action_sequence: '3', reason: 'cleanupPending' }),
    makePolicyEffectRecord(3n, { kind: 'succeeded' }, []),
  ]));
  assert.equal(summary.decision_count, 4);
  assert.equal(summary.effect_count, 2);
});

test('policy replay v2 rejects unknown reasons unmatched and cross-seat actions and duplicate effects', () => {
  const first = actionRecord(1n, { kind: 'start', action_sequence: '1' });
  for (const records of [
    [first, actionRecord(2n, { kind: 'defer', action_sequence: '1', reason: 'mystery' as 'hysteresis' })],
    [first, actionRecord(2n, { kind: 'continue', action_sequence: '99' })],
    [first, actionRecord(2n, { kind: 'continue', action_sequence: '1' }, 254)],
    [first, makePolicyEffectRecord(1n, { kind: 'succeeded' }, []), actionRecord(2n, { kind: 'continue', action_sequence: '1' })],
    [first, makePolicyEffectRecord(1n, { kind: 'succeeded' }, []), makePolicyEffectRecord(1n, { kind: 'succeeded' }, [])],
    [first, actionRecord(2n, { kind: 'continue', action_sequence: '1' }), makePolicyEffectRecord(2n, { kind: 'succeeded' }, [])],
    [first, makePolicyEffectRecord(1n, { kind: 'pending' }, [])],
  ]) assert.throws(() => replayPolicyJson(evidence(records)), TraceError);
});

test('policy replay v2 producer rejects invalid action identities and disposition reasons', () => {
  const frame = actionRecord(1n, { kind: 'start', action_sequence: '1' });
  const source = { sequence: 1n, seat: frame.seat, input: frame.input, decision: frame.decision,
    rngStateAfter: BigInt(frame.rng_state_after), disposition: frame.disposition };
  assert.equal(makePolicyReplayRecord(source).schema, 'policy-replay-v2');
  assert.throws(() => makePolicyReplayRecord({ ...source, disposition: { kind: 'start', action_sequence: '2' } }), TypeError);
  assert.throws(() => makePolicyReplayRecord({ ...source,
    disposition: { kind: 'defer', action_sequence: '1', reason: 'unknown' as 'hysteresis' } }), TypeError);
});

test('policy replay v2 accepts goal persistence without claiming another action effect', () => {
  const first = actionRecord(1n, { kind: 'start', action_sequence: '1' });
  const deferred = actionRecord(2n, { kind: 'defer', action_sequence: '1', reason: 'goalPersistence' });
  const summary = replayPolicyJson(evidence([first, deferred, makePolicyEffectRecord(1n, { kind: 'succeeded' }, [])]));
  assert.equal(summary.decision_count, 2);
  assert.equal(summary.effect_count, 1);
  const produced = makePolicyReplayRecord({ sequence: 2n, seat: deferred.seat, input: deferred.input,
    decision: deferred.decision, rngStateAfter: BigInt(deferred.rng_state_after), disposition: deferred.disposition });
  assert.deepEqual(produced.disposition, { kind: 'defer', action_sequence: '1', reason: 'goalPersistence' });
});
