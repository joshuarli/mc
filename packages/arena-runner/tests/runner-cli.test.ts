import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/index.js';

const repositoryRoot = process.cwd();
const replayFixtures = join(repositoryRoot, 'tests/fixtures/replay-report');
const temporaryRoot = resolve(repositoryRoot, '.work/tmp');

function output(result: Awaited<ReturnType<typeof runCli>>): Record<string, unknown> {
  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') throw new Error('command failed');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('doctor describes preparation and offline evidence capabilities', async () => {
  const result = output(await runCli(['doctor']));
  assert.equal(result.mode, 'offline_prepare_and_evidence');
  assert.deepEqual(result.capabilities, {
    trace_validation: 'available',
    ordered_record_reconstruction: 'available',
    generic_record_comparison: 'available',
    policy_replay: 'parked_missing_recorded_input_and_policy_contracts',
    authoritative_result_reporting: 'parked_missing_j1_event_contract',
    process_supervision_and_world_reset: 'parked_missing_live_prerequisites',
    scenario_compilation: 'available',
    world_plan_staging: 'available',
    safe_owned_path_staging: 'available',
  });
});

test('prepare requires both the scenario path and run id options', async () => {
  const result = await runCli(['prepare']);
  assert.equal(result.kind, 'failure');
  if (result.kind !== 'failure') return;
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, '{"error":{"category":"invalid_input","resource":"command line arguments","source":{"kind":"prepare_requires_scenario_and_run_id"}}}');
});

test('prepare rejects scenario paths outside the repository root', async () => {
  const result = await runCli(['prepare', '--scenario', '../scenarios/hunger-six.toml', '--run-id', 'smoke-001']);
  assert.equal(result.kind, 'failure');
  if (result.kind !== 'failure') return;
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, '{"error":{"category":"invalid_input","resource":"scenario path","source":{"kind":"outside_repository"}}}');
});

test('report CLI orders segments and compare ignores only the run id', async () => {
  const report = output(await runCli([
    'report',
    join(replayFixtures, 'segment-0002.json'),
    join(replayFixtures, 'segment-0001.json'),
  ]));
  assert.deepEqual(report.records, [{ a: 1 }, { b: 2 }]);
  assert.equal(report.outcome, null);

  const comparison = output(await runCli([
    'compare',
    join(replayFixtures, 'segment-0001.json'),
    join(replayFixtures, 'segment-0001-other-run.json'),
  ]));
  assert.equal(comparison.equal, true);
  assert.equal(comparison.run_ids_compared, false);
});

test('incomplete evidence returns a structured corrupt-evidence error', async () => {
  const result = await runCli(['inspect', join(replayFixtures, 'incomplete-segment.json')]);
  assert.equal(result.kind, 'failure');
  if (result.kind !== 'failure') return;
  assert.equal(result.exitCode, 5);
  const error = JSON.parse(result.stderr) as { error: { category: string; source: { kind: string; argument: number } } };
  assert.equal(error.error.category, 'corrupt_evidence');
  assert.equal(error.error.source.kind, 'invalid_completion_trailer');
  assert.equal(error.error.source.argument, 1);
  assert.equal(result.stderr, '{"error":{"category":"corrupt_evidence","resource":"trace segment argument 1","source":{"argument":1,"kind":"invalid_completion_trailer"}}}');
});

test('missing input maps to prerequisite exit code with structured source details', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(join(temporaryRoot, 'runner-cli-'));
  try {
    const result = await runCli(['inspect', join(scratch, 'missing.json')]);
    assert.equal(result.kind, 'failure');
    if (result.kind !== 'failure') return;
    assert.equal(result.exitCode, 3);
    const error = JSON.parse(result.stderr) as { error: { category: string; source: { kind: string; argument: number } } };
    assert.equal(error.error.category, 'missing_prerequisite');
    assert.equal(error.error.source.kind, 'io');
    assert.equal(error.error.source.argument, 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('read-only trace input follows a selected symlink and rejects a directory', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(join(temporaryRoot, 'runner-path-'));
  try {
    const linked = join(scratch, 'selected.json');
    const fixture = join(replayFixtures, 'segment-0001.json');
    await symlink(fixture, linked);
    assert.equal(output(await runCli(['inspect', linked])).run_id, 'fixture-run');

    const result = await runCli(['inspect', scratch]);
    assert.equal(result.kind, 'failure');
    if (result.kind !== 'failure') return;
    assert.equal(result.exitCode, 5);
    const error = JSON.parse(result.stderr) as { error: { source: { kind: string } } };
    assert.equal(error.error.source.kind, 'not_a_regular_file');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('rejects a segment larger than eight MiB before JSON parsing', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(join(temporaryRoot, 'runner-size-'));
  try {
    const oversized = join(scratch, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));
    const result = await runCli(['inspect', oversized]);
    assert.equal(result.kind, 'failure');
    if (result.kind !== 'failure') return;
    assert.equal(result.exitCode, 5);
    const error = JSON.parse(result.stderr) as { error: { source: { kind: string } } };
    assert.equal(error.error.source.kind, 'segment_too_large');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
