import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/canonical.js';
import { inspectJson, reconstruct, reportJson } from '../src/evidence.js';
import { parseSegment, readSegment, TraceError } from '../src/trace.js';

const repositoryRoot = process.cwd();
const replayFixtures = join(repositoryRoot, 'tests/fixtures/replay-report');

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
  const duplicate = fixture.replace('{"a":1}', '{"outer":{"key":1,"key":2}}');

  assert.throws(() => parseSegment(duplicate), (error: unknown) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.source.kind, 'invalid_json');
    return true;
  });
});

test('hashes nested records with the TypeScript canonical key ordering', () => {
  const records = '[{"z":0,"a":{"y":2,"x":1}}]';
  const canonicalRecords = '[{"a":{"x":1,"y":2},"z":0}]';
  const digest = createHash('sha256').update(canonicalRecords, 'utf8').digest('hex');
  const input = `{"schema":1,"run_id":"ordered","first_sequence":"7","last_sequence":"7","records":${records},"sha256":"${digest}","trailer":{"complete":true}}`;

  const segment = parseSegment(input);

  assert.equal(segment.sha256, digest);
  assert.equal(canonicalJson(segment.records), canonicalRecords);
});

test('preserves full u64 sequence values as decimal strings', () => {
  const maximum = '18446744073709551615';
  const digest = createHash('sha256').update('[{"a":1}]', 'utf8').digest('hex');
  const input = `{"schema":1,"run_id":"max-sequence","first_sequence":"${maximum}","last_sequence":"${maximum}","records":[{"a":1}],"sha256":"${digest}","trailer":{"complete":true}}`;

  const segment = parseSegment(input);

  assert.equal(segment.firstSequence.toString(), maximum);
  assert.equal(segment.lastSequence.toString(), maximum);
});

test('rejects malformed sequence strings, unsafe record integers, and excessive nesting', () => {
  const digest = createHash('sha256').update('[{"a":1}]', 'utf8').digest('hex');
  const base = `"schema":1,"run_id":"bad","first_sequence":"1","last_sequence":"1","records":[{"a":1}],"sha256":"${digest}","trailer":{"complete":true}`;
  for (const invalidSequence of ['"01"', '"-1"', '"18446744073709551616"']) {
    assert.throws(() => parseSegment(`{${base.replace('"first_sequence":"1"', `"first_sequence":${invalidSequence}`)}}`));
  }
  assert.throws(() => parseSegment(`{${base.replace('{"a":1}', '{"a":9007199254740992}')}}`));

  const deepRecords = `[ {"nested":${'['.repeat(30)}0${']'.repeat(30)}} ]`;
  const deep = `{"schema":1,"run_id":"deep","first_sequence":"1","last_sequence":"1","records":${deepRecords},"sha256":"${digest}","trailer":{"complete":true}}`;
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

  const gap = parseSegment((await readFile(join(replayFixtures, 'segment-0002.json'), 'utf8'))
    .replace('"first_sequence":"2"', '"first_sequence":"3"')
    .replace('"last_sequence":"2"', '"last_sequence":"3"'));
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
