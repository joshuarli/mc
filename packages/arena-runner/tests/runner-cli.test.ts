import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/index.js';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { encodeControlEnvelope } from '../src/control/index.js';
import { assertPrepareResourceCapacity } from '../src/prepare.js';
import type { ControlMessage } from '../src/control/types.js';

const repositoryRoot = process.cwd();
const replayFixtures = join(repositoryRoot, 'tests/fixtures/replay-report-v2');
const temporaryRoot = resolve(repositoryRoot, '.work/tmp');

function output(result: Awaited<ReturnType<typeof runCli>>): Record<string, unknown> {
  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') throw new Error('command failed');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('doctor describes runner, runtime, and evidence capabilities', async () => {
  const result = output(await runCli(['doctor']));
  assert.equal(result.mode, 'headless_runtime_and_evidence');
  assert.deepEqual(result.capabilities, {
    trace_validation: 'available',
    ordered_record_reconstruction: 'available',
    generic_record_comparison: 'available',
    policy_replay: 'available_for_recorded_policy_frames',
    authoritative_result_reporting: 'available_from_typed_event_stream',
    process_supervision_and_world_reset: 'available',
    scenario_compilation: 'available',
    world_plan_staging: 'available',
    safe_owned_path_staging: 'available',
    stopped_run_inspection: 'available',
  });
});

test('help documents the stable conflict and cancellation exit codes', async () => {
  const result = output(await runCli(['help']));
  assert.deepEqual(result.errors, {
    2: 'invalid input or configuration',
    3: 'missing prerequisite or resource',
    4: 'owned resource or port conflict',
    5: 'corrupt or incomplete evidence',
    6: 'runtime failure',
    130: 'cancelled by the operator',
  });
});

test('validate compiles a scenario, map, and policy without preparing a run', async () => {
  const helperPath = resolve(repositoryRoot, '.work/arena-fs/arena-fs');
  const previousHelper = process.env.ARENA_FS_HELPER;
  process.env.ARENA_FS_HELPER = helperPath;
  try {
    const result = output(await runCli(['validate', '--scenario', 'scenarios/hunger-six.toml']));
    assert.equal(result.schema, 1);
    assert.equal(typeof (result.scenario as Record<string, unknown>).semantic_id, 'string');
    assert.equal(typeof (result.map as Record<string, unknown>).semantic_id, 'string');
    assert.equal(typeof (result.policy as Record<string, unknown>).semantic_id, 'string');
    assert.deepEqual(result.roster, { competitors: 6, spectator_capacity: '4' });
  } finally {
    if (previousHelper === undefined) delete process.env.ARENA_FS_HELPER;
    else process.env.ARENA_FS_HELPER = previousHelper;
  }
});

test('prepare capacity limits accept their boundaries and reject excess resources', () => {
  const gibibyte = 1024n * 1024n * 1024n;
  const atLimits = {
    freeBytes: 4n * gibibyte,
    workBytes: 16n * gibibyte,
    dependencyBytes: 8n * gibibyte,
    runCount: 9,
  };
  assert.doesNotThrow(() => assertPrepareResourceCapacity(atLimits));

  for (const [field, resources] of [
    ['free_bytes', { ...atLimits, freeBytes: atLimits.freeBytes - 1n }],
    ['work_bytes', { ...atLimits, workBytes: atLimits.workBytes + 1n }],
    ['dependency_bytes', { ...atLimits, dependencyBytes: atLimits.dependencyBytes + 1n }],
    ['run_count', { ...atLimits, runCount: 10 }],
  ] as const) {
    assert.throws(() => assertPrepareResourceCapacity(resources), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { category?: string }).category, 'runtime_failure');
      assert.equal((error as { source?: { kind?: string; field?: string } }).source?.kind, 'resource_limit_exceeded');
      assert.equal((error as { source?: { kind?: string; field?: string } }).source?.field, field);
      return true;
    });
  }
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

test('prepare rejects a non-ASCII run id before reading scenario sources', async () => {
  const result = await runCli(['prepare', '--scenario', 'scenarios/hunger-six.toml', '--run-id', 'é-run']);
  assert.equal(result.kind, 'failure');
  if (result.kind !== 'failure') return;
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).error.source.kind, 'invalid_run_id');
});

test('inspect and compare work with generic traces while report requires typed lifecycle events', async () => {
  const inspection = output(await runCli([
    'inspect',
    join(replayFixtures, 'segment-0002.json'),
    join(replayFixtures, 'segment-0001.json'),
  ]));
  assert.deepEqual(inspection.records, [{ a: 1 }, { b: 2 }]);

  const comparison = output(await runCli([
    'compare',
    join(replayFixtures, 'segment-0001.json'),
    join(replayFixtures, 'segment-0001-other-run.json'),
  ]));
  assert.equal(comparison.equal, true);
  assert.equal(comparison.run_ids_compared, false);

  const report = await runCli(['report', join(replayFixtures, 'segment-0001.json')]);
  assert.equal(report.kind, 'failure');
  if (report.kind !== 'failure') return;
  assert.equal(report.exitCode, 5);
  assert.equal(JSON.parse(report.stderr).error.source.kind, 'invalid_event_direction');
});

test('report derives the terminal result from prepared competitors and typed events', async () => {
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(join(temporaryRoot, 'runner-report-'));
  try {
    const runId = 'cli-event-report';
    const event = (direction: 'runner' | 'plugin', message: ControlMessage) => ({
      direction,
      ...(JSON.parse(Buffer.from(encodeControlEnvelope(message)).toString('utf8')) as Record<string, unknown>),
    });
    const prepare: ControlMessage = {
      protocol: 1,
      run_id: runId,
      sequence: 2n,
      type: 'prepare',
      payload: {
        map_semantic_id: 'a'.repeat(64),
        scenario_semantic_id: 'b'.repeat(64),
        seed: 1n,
        mode: 'hunger_games',
        settings: {
          match: {
            countdown_ticks: 0n,
            grace_ticks: 0n,
            authoritative_max_ticks: 10n,
            respawn: false,
            block_breaking: false,
            block_placing: false,
            natural_mobs: false,
            natural_random_ticks: false,
          },
          border: {
            initial_diameter_blocks: 126,
            shrink_start_tick: 0n,
            shrink_end_tick: 9n,
            final_diameter_blocks: 16,
          },
        },
        roster: [0, 1].map((seat) => ({
          kind: 'bot' as const,
          seat,
          participant_id: `bot-${seat}`,
          username: `bot_${seat}`,
          offline_uuid: `00000000-0000-0000-0000-${String(seat + 1).padStart(12, '0')}`,
        })),
      },
    };
    const at = (value: bigint) => ({ domain: 'match' as const, value });
    const messages: readonly ['runner' | 'plugin', ControlMessage][] = [
      ['plugin', {
        protocol: 1,
        run_id: runId,
        sequence: 2n,
        correlation: 1n,
        type: 'ready',
        payload: {
          server: { name: 'Paper', version: '26.2', minecraft_version: '1.21.11', protocol_version: 776 },
          plugin: { name: 'ArenaFoundation', version: '0.1.0' },
          capabilities: ['hunger_games_v1'],
        },
      }],
      ['runner', prepare],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 3n, correlation: 2n, type: 'ack', payload: {},
      }],
      ['runner', {
        protocol: 1, run_id: runId, sequence: 3n, type: 'start', payload: {},
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 4n, correlation: 3n, type: 'ack', payload: {},
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 5n, type: 'public_clock',
        payload: { phase: 'active', tick: at(0n), border_diameter_blocks: 126 },
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 6n, type: 'public_state',
        payload: { at: at(0n), alive_seats: [0, 1] },
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 7n, type: 'elimination',
        payload: { at: at(8n), eliminations: [{ seat: 1, cause: 'death' }] },
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 8n, type: 'public_state',
        payload: { at: at(8n), alive_seats: [0] },
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 9n, type: 'public_clock',
        payload: { phase: 'finished', tick: at(8n), border_diameter_blocks: 126 },
      }],
      ['plugin', {
        protocol: 1, run_id: runId, sequence: 10n, type: 'outcome',
        payload: { kind: 'winner', winner_seat: 0, survivors: [0], at: at(8n) },
      }],
    ];
    const records = messages.map(([direction, message]) => event(direction, message));
    const bytes = canonicalJson({
      schema: 2,
      run_id: runId,
      first_sequence: '1',
      last_sequence: String(records.length),
      records,
      sha256: sha256Json(records),
      trailer: { complete: true },
    });
    const segmentPath = join(scratch, 'report.json');
    await writeFile(segmentPath, bytes);

    const report = output(await runCli(['report', segmentPath]));
    assert.deepEqual(report.outcome, {
      kind: 'winner',
      winner_seat: 0,
      survivors: [0],
      at: { domain: 'match', value: '8' },
    });
    assert.deepEqual(report.statistics, {
      competitor_count: 2,
      elimination_count: 1,
      death_count: 1,
      disconnect_count: 0,
      survivor_seats: [0],
    });
    assert.equal(report.outcome_status, 'reconstructed_from_authoritative_events');

    const withoutStart = messages
      .filter(([, message]) => message.type !== 'start'
        && !(message.type === 'ack' && message.correlation === 3n))
      .map(([direction, message]) => event(direction, message));
    await writeFile(segmentPath, canonicalJson({
      schema: 2,
      run_id: runId,
      first_sequence: '1',
      last_sequence: String(withoutStart.length),
      records: withoutStart,
      sha256: sha256Json(withoutStart),
      trailer: { complete: true },
    }));
    const invalidReport = await runCli(['report', segmentPath]);
    assert.equal(invalidReport.kind, 'failure');
    if (invalidReport.kind !== 'failure') return;
    assert.equal(JSON.parse(invalidReport.stderr).error.source.kind, 'event_before_start');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
