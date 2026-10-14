import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { agentObservation, decide, DeterministicRandom, emptyPolicyMemory, normalizePolicyReplayInput, observationSequence, PolicyParams, tick, unknownKnowledge } from '@arena/core';
import { makePolicyReplayRecord, replayPolicyJson } from '../src/policy-replay.js';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { inspectJson, reconstruct, reconstructRunEvidence, reportJson } from '../src/evidence.js';
import { parseSegment, readSegment, TraceError } from '../src/trace.js';

const repositoryRoot = process.cwd();
const replayFixtures = join(repositoryRoot, 'tests/fixtures/replay-report-v2');

test('reconstructs generic segments for inspection and requires typed events for result reporting', async () => {
  const second = await readSegment(join(replayFixtures, 'segment-0002.json'), 1);
  const first = await readSegment(join(replayFixtures, 'segment-0001.json'), 2);
  const evidence = reconstruct([second, first]);
  const inspection = inspectJson(evidence);

  assert.deepEqual(JSON.parse(JSON.stringify(inspection)), {
    schema: 1,
    run_id: 'fixture-run',
    sequence_range: { first: '1', last: '2' },
    segments: [
      { first_sequence: '1', last_sequence: '1', record_count: 1, sha256: first.sha256 },
      { first_sequence: '2', last_sequence: '2', record_count: 1, sha256: second.sha256 },
    ],
    record_count: 2,
    records: [{ a: 1 }, { b: 2 }],
  });
  assert.throws(() => reportJson(evidence), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'invalid_event_direction');
    return true;
  });
});

test('rejects duplicate object names at every depth before checksum validation', async () => {
  const fixture = await readFile(join(replayFixtures, 'segment-0001.json'), 'utf8');
  const duplicate = fixture.replace(/"a"\s*:\s*1/, '"outer":{"key":1,"key":2}');
  assert.notEqual(duplicate, fixture, 'the malformed fixture must contain the duplicate nested keys');

  assert.throws(() => parseSegment(duplicate), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'invalid_json');
    return true;
  });
});

test('rejects trace-v1 without a compatibility fallback', async () => {
  const historical = await readFile(join(repositoryRoot, 'tests/fixtures/replay-report/segment-0001.json'), 'utf8');
  assert.throws(() => parseSegment(historical), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'unsupported_schema');
    return true;
  });
});

test('reads historical trace-v2 and current trace-v3 while keeping v2 policy records strict', async () => {
  const historical = await readSegment(join(repositoryRoot, 'tests/fixtures/operator-abort/trace-v2-000001.json'), 1);
  assert.equal(historical.schema, 2);

  const records = [{ schema: 'policy-replay-v3' }];
  const current = parseSegment(canonicalJson({ schema: 3, run_id: 'current', first_sequence: '1', last_sequence: '1',
    records, sha256: sha256Json(records), trailer: { complete: true } }));
  assert.equal(current.schema, 3);

  const invalidHistorical = canonicalJson({ schema: 2, run_id: 'legacy', first_sequence: '1', last_sequence: '1',
    records, sha256: sha256Json(records), trailer: { complete: true } });
  assert.throws(() => parseSegment(invalidHistorical), rejectsEvidence('unsupported_policy_schema'));
  const unsupported = canonicalJson({ schema: 4, run_id: 'future', first_sequence: '1', last_sequence: '1',
    records: [{ a: 1 }], sha256: sha256Json([{ a: 1 }]), trailer: { complete: true } });
  assert.throws(() => parseSegment(unsupported), rejectsEvidence('unsupported_schema'));
});

test('hashes nested records with the TypeScript canonical key ordering', () => {
  const records = '[{"z":0,"a":{"y":2,"x":1}}]';
  const canonicalRecords = '[{"a":{"x":1,"y":2},"z":0}]';
  const digest = createHash('sha256').update(canonicalRecords, 'utf8').digest('hex');
  const input = `{"schema":2,"run_id":"ordered","first_sequence":"7","last_sequence":"7","records":${records},"sha256":"${digest}","trailer":{"complete":true}}`;

  const segment = parseSegment(input);

  assert.equal(segment.sha256, digest);
  assert.equal(canonicalJson(segment.records), canonicalRecords);
});

test('preserves full u64 sequence values as decimal strings', () => {
  const maximum = '18446744073709551615';
  const digest = createHash('sha256').update('[{"a":1}]', 'utf8').digest('hex');
  const input = `{"schema":2,"run_id":"max-sequence","first_sequence":"${maximum}","last_sequence":"${maximum}","records":[{"a":1}],"sha256":"${digest}","trailer":{"complete":true}}`;

  const segment = parseSegment(input);

  assert.equal(segment.firstSequence.toString(), maximum);
  assert.equal(segment.lastSequence.toString(), maximum);
});

test('rejects malformed sequence strings, unsafe record integers, and excessive nesting', () => {
  const digest = createHash('sha256').update('[{"a":1}]', 'utf8').digest('hex');
  const base = `"schema":2,"run_id":"bad","first_sequence":"1","last_sequence":"1","records":[{"a":1}],"sha256":"${digest}","trailer":{"complete":true}`;
  for (const invalidSequence of ['"01"', '"-1"', '"18446744073709551616"']) {
    assert.throws(() => parseSegment(`{${base.replace('"first_sequence":"1"', `"first_sequence":${invalidSequence}`)}}`));
  }
  assert.throws(() => parseSegment(`{${base.replace('{"a":1}', '{"a":9007199254740992}')}}`));

  const deepRecords = `[ {"nested":${'['.repeat(30)}0${']'.repeat(30)}} ]`;
  const deep = `{"schema":2,"run_id":"deep","first_sequence":"1","last_sequence":"1","records":${deepRecords},"sha256":"${digest}","trailer":{"complete":true}}`;
  assert.throws(() => parseSegment(deep), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'nesting_limit_exceeded');
    return true;
  });
});

test('rejects gaps, overlaps, and run changes when reconstructing segments', async () => {
  const first = await readSegment(join(replayFixtures, 'segment-0001.json'), 1);
  const second = await readSegment(join(replayFixtures, 'segment-0002.json'), 2);
  assert.equal(reconstruct([second, first]).first_sequence, '1');

  const gapSource = await readFile(join(replayFixtures, 'segment-0002.json'), 'utf8');
  const gapText = gapSource
    .replace(/("first_sequence"\s*:\s*)"2"/, '$1"3"')
    .replace(/("last_sequence"\s*:\s*)"2"/, '$1"3"');
  assert.notEqual(gapText, gapSource, 'the malformed fixture must move the sequence range');
  const gap = parseSegment(gapText);
  assert.throws(() => reconstruct([first, gap]), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'sequence_discontinuity');
    return true;
  });

  const otherRun = await readSegment(join(replayFixtures, 'segment-0001-other-run.json'), 1);
  assert.throws(() => reconstruct([first, otherRun]), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'run_id_mismatch');
    return true;
  });
});

test('reconstructs authoritative evidence with v2 policy decisions while rejecting unknown policy schemas', async () => {
  const complete = await readSegment(join(repositoryRoot, 'tests/fixtures/operator-abort/trace-v2-000001.json'), 1);
  const original = reconstruct([complete]);
  const observation = agentObservation({ tick: tick(0), sequence: observationSequence(1),
    agent: unknownKnowledge(), border: unknownKnowledge(), opponents: unknownKnowledge(), loot: unknownKnowledge() });
  const memory = emptyPolicyMemory();
  const params = PolicyParams.baseline();
  const random = DeterministicRandom.fromState(1n);
  const input = normalizePolicyReplayInput({ observation, memory, params, random, feedback: [] });
  const decision = decide(observation, memory, params, random);
  const policy = makePolicyReplayRecord({ sequence: 1n, seat: 0, input, decision,
    rngStateAfter: random.snapshotState(), disposition: { kind: 'hold' } });
  const withPolicy = (record: object) => {
    const records = [...complete.records.slice(0, 8), record, ...complete.records.slice(8)];
    return reconstruct([parseSegment(canonicalJson({ schema: 3, run_id: complete.runId,
      first_sequence: '1', last_sequence: String(records.length), records, sha256: sha256Json(records), trailer: { complete: true } }))]);
  };
  const current = withPolicy(policy);
  assert.deepEqual(reconstructRunEvidence(current), reconstructRunEvidence(original));
  assert.equal(replayPolicyJson(current).decision_count, 1);
  const unsupported = withPolicy({ ...policy, schema: 'policy-replay-v4' });
  assert.throws(() => reconstructRunEvidence(unsupported), (error: unknown) =>
    error instanceof TraceError && error.source.kind === 'invalid_event_direction');
  assert.throws(() => replayPolicyJson(unsupported), TraceError);
  assert.throws(() => replayPolicyJson(withPolicy({ ...policy, unexpected: true })), TraceError);
});


test('reconstructs an archived active clock in flight while abort awaits acknowledgment', async () => {
  const segment = await readSegment(join(repositoryRoot, 'tests/fixtures/pending-abort/trace-v2-000001.json'), 1);
  assert.equal(segment.records.length, 13);
  const result = reconstructRunEvidence(reconstruct([segment]));
  assert.deepEqual(result.report.outcome, {
    kind: 'abort', reason: 'protocol_error', survivors: [0, 1],
    at: { domain: 'match', value: '1379' },
  });
  assert.equal(result.report.statistics.elimination_count, 0);
});


async function pendingAbortFixture() {
  return await readSegment(join(repositoryRoot, 'tests/fixtures/pending-abort/trace-v2-000001.json'), 1);
}

function evidenceWithRecords(segment: Awaited<ReturnType<typeof pendingAbortFixture>>, records: readonly object[]) {
  return reconstruct([parseSegment(canonicalJson({ schema: 2, run_id: segment.runId,
    first_sequence: '1', last_sequence: String(records.length), records,
    sha256: sha256Json(records), trailer: { complete: true },
  }))]);
}

function rejectsEvidence(kind: string) {
  return (error: unknown) => error instanceof TraceError && error.source.kind === kind;
}

test('pending abort preserves in-flight public state at the active clock tick', async () => {
  const segment = await pendingAbortFixture();
  const records = [...segment.records];
  records.splice(10, 0, { direction: 'plugin', protocol: 1, run_id: segment.runId,
    sequence: '1558', type: 'public_state',
    payload: { at: { domain: 'match', value: '1376' }, alive_seats: [0, 1] },
  });
  const result = reconstructRunEvidence(evidenceWithRecords(segment, records));
  assert.deepEqual(result.report.statistics.survivor_seats, [0, 1]);
});

test('pending abort preserves an in-flight elimination and its matching public state', async () => {
  const segment = await pendingAbortFixture();
  const records = [...segment.records];
  records.splice(10, 0, { direction: 'plugin', protocol: 1, run_id: segment.runId,
    sequence: '1558', type: 'elimination',
    payload: { at: { domain: 'match', value: '1376' }, eliminations: [{ seat: 1, cause: 'death' }] },
  }, { direction: 'plugin', protocol: 1, run_id: segment.runId, sequence: '1559', type: 'public_state',
    payload: { at: { domain: 'match', value: '1376' }, alive_seats: [0] },
  });
  const outcome = records[records.length - 1]!;
  records[records.length - 1] = { ...outcome, payload: { kind: 'abort', reason: 'protocol_error',
    survivors: [0], at: { domain: 'match', value: '1379' },
  } };
  const result = reconstructRunEvidence(evidenceWithRecords(segment, records));
  assert.equal(result.report.statistics.death_count, 1);
  assert.deepEqual(result.report.statistics.survivor_seats, [0]);
});

test('pending abort requires the exact acknowledgment and retains an absent acknowledgment failure', async () => {
  const segment = await pendingAbortFixture();
  const wrongAck = [...segment.records];
  wrongAck[10] = { ...wrongAck[10], correlation: '5' };
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, wrongAck)),
    rejectsEvidence('invalid_command_acknowledgment'));
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, segment.records.slice(0, 10))),
    rejectsEvidence('unacknowledged_runner_command'));
});

test('pending abort rejects terminal clock and outcome effects before acknowledgment', async () => {
  const segment = await pendingAbortFixture();
  const records = segment.records;
  for (const terminal of [records[11]!, records[12]!]) {
    const earlyTerminal = [...records.slice(0, 10), terminal, ...records.slice(10)];
    assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, earlyTerminal)),
      rejectsEvidence('event_before_command_acknowledgment'));
  }
  const finished = { ...records[11], payload: { phase: 'finished',
    tick: { domain: 'match', value: '1379' }, border_diameter_blocks: 60.28458333333333,
  } };
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, [...records.slice(0, 10), finished, ...records.slice(10)])),
    rejectsEvidence('event_before_command_acknowledgment'));
});

test('abort acknowledgment does not allow authority after the terminal outcome', async () => {
  const segment = await pendingAbortFixture();
  const records = [...segment.records, { direction: 'plugin', protocol: 1, run_id: segment.runId,
    sequence: '1564', type: 'public_state',
    payload: { at: { domain: 'match', value: '1379' }, alive_seats: [0, 1] },
  }];
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, records)), rejectsEvidence('event_after_outcome'));
});

test('prepare and start still reject authority before their acknowledgment', async () => {
  const segment = await pendingAbortFixture();
  const records = segment.records;
  const waitingClock = records[3]!;
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment,
    [...records.slice(0, 2), waitingClock, ...records.slice(2)])), rejectsEvidence('event_before_command_acknowledgment'));
  const countdownClock = records[6]!;
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment,
    [...records.slice(0, 5), countdownClock, ...records.slice(5)])), rejectsEvidence('event_before_command_acknowledgment'));
});


test('pending abort retains plugin sequence and public state invariants', async () => {
  const segment = await pendingAbortFixture();
  const regressed = [...segment.records];
  regressed[9] = { ...regressed[9], sequence: '7' };
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, regressed)),
    rejectsEvidence('event_sequence_not_increasing'));
  const mismatchedState = [...segment.records];
  mismatchedState.splice(10, 0, { direction: 'plugin', protocol: 1, run_id: segment.runId,
    sequence: '1558', type: 'public_state',
    payload: { at: { domain: 'match', value: '1376' }, alive_seats: [0] },
  });
  assert.throws(() => reconstructRunEvidence(evidenceWithRecords(segment, mismatchedState)),
    rejectsEvidence('public_state_mismatch'));
});
