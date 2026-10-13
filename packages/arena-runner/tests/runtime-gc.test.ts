import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { collectOwnedRuns } from '../src/runtime/gc.js';
import { createRunDirectory, stageOwnedFile } from '../src/owned-files/index.js';
import { writeOperationalFailureArtifact } from '../src/runtime/failure-artifact.js';
import { MAX_TRACE_SEGMENT_BYTES, TRACE_SCHEMA_VERSION } from '../src/trace.js';

const repositoryRoot = process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, '.work/arena-fs/arena-fs');
let nextRunId = 0;

test('garbage collection allows removal of a validated completed winner', async (t) => {
  await mkdir(resolve(repositoryRoot, '.work/tmp'), { recursive: true });
  const rootText = await mkdtemp(join(repositoryRoot, '.work/tmp/arena-gc-success-'));
  const ownedRoot = Buffer.from(rootText, 'utf8');
  const runId = `gc-success-${process.pid}-${++nextRunId}`;
  const runDirectoryPath = Buffer.from(`.work/arena/runs/${runId}`, 'ascii');
  await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectoryPath });
  t.after(async () => await rm(rootText, { recursive: true, force: true }));
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000001.json', 'ascii')]),
    contents: winnerTraceSegment(runId),
    maxBytes: MAX_TRACE_SEGMENT_BYTES,
  });

  const result = await collectOwnedRuns({ helperPath, ownedRoot, runIds: [runId], mode: 'dry_run' });
  assert.deepEqual(result.runs, [{
    run_id: runId,
    path: `.work/arena/runs/${runId}`,
    status: 'eligible',
    reason: 'completed_success',
    evidence_path: `.work/arena/runs/${runId}/trace-v2-000001.json`,
    outcome_kind: 'winner',
  }]);

  const applied = await collectOwnedRuns({ helperPath, ownedRoot, runIds: [runId], mode: 'apply' });
  assert.equal(applied.runs[0]?.status, 'removed');
  await assert.rejects(access(join(rootText, '.work/arena/runs', runId)));
});

test('garbage collection ranks only validated failures and protects cleanup failures', async () => {
  await mkdir(resolve(repositoryRoot, '.work/tmp'), { recursive: true });
  const rootText = await mkdtemp(join(repositoryRoot, '.work/tmp/arena-gc-'));
  const ownedRoot = Buffer.from(rootText, 'utf8');
  const runIds = ['gc-failure-a', 'gc-failure-b', 'gc-failure-c', 'gc-failure-d', 'gc-failure-e'];
  try {
    for (const [index, runId] of runIds.entries()) {
      await createRunDirectory({
        helperPath,
        ownedRoot,
        relativePath: Buffer.from(`.work/arena/runs/${runId}`, 'ascii'),
      });
      await writeOperationalFailureArtifact({
        helperPath,
        ownedRoot,
        artifact: {
          schema: 1,
          run_id: runId,
          primary: {
            category: 'runtime_failure',
            resource: 'test run',
            source: { kind: 'test_failure' },
          },
          cleanup: index === 0
            ? { status: 'failed', source: { kind: 'child_reap_timeout' } }
            : { status: 'succeeded', source: null },
          trace_checkpoint_segments: [],
        },
      });
      const modified = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await utimes(
        join(rootText, '.work/arena/runs', runId, 'operational-failure-v1.json'),
        modified,
        modified,
      );
    }

    const corruptRunId = 'gc-failure-corrupt';
    await createRunDirectory({
      helperPath,
      ownedRoot,
      relativePath: Buffer.from(`.work/arena/runs/${corruptRunId}`, 'ascii'),
    });
    await writeOperationalFailureArtifact({
      helperPath,
      ownedRoot,
      artifact: {
        schema: 1,
        run_id: corruptRunId,
        primary: { category: 'runtime_failure', resource: 'test run', source: { kind: 'test_failure' } },
        cleanup: { status: 'succeeded', source: null },
        trace_checkpoint_segments: [],
      },
    });
    const corruptArtifactPath = join(rootText, '.work/arena/runs', corruptRunId, 'operational-failure-v1.json');
    const modified = new Date(Date.UTC(2026, 0, 1, 0, 0, 5));
    await utimes(corruptArtifactPath, modified, modified);
    // Replace valid JSON contents while preserving the native listing metadata.
    await writeFile(corruptArtifactPath, Buffer.from('{"schema":1}'));

    const dryRun = await collectOwnedRuns({
      helperPath,
      ownedRoot,
      runIds: [runIds[0]!, runIds[1]!, runIds[4]!, corruptRunId],
      mode: 'dry_run',
    });
    const decisions = new Map(dryRun.runs.map((run) => [run.run_id, run]));
    assert.equal(decisions.get(runIds[0]!)?.reason, 'cleanup_failed');
    assert.equal(decisions.get(runIds[1]!)?.status, 'eligible');
    assert.equal(decisions.get(runIds[4]!)?.reason, 'among_latest_three_failures');
    assert.equal(decisions.get(corruptRunId)?.status, 'protected');
    assert.equal(dryRun.retained_failure_run_ids.length, 4);
    await access(join(rootText, '.work/arena/runs', runIds[1]!));

    const applied = await collectOwnedRuns({
      helperPath,
      ownedRoot,
      runIds: [runIds[1]!],
      mode: 'apply',
    });
    assert.equal(applied.runs[0]?.status, 'removed');
    await assert.rejects(access(join(rootText, '.work/arena/runs', runIds[1]!)));
    await access(join(rootText, '.work/arena/runs', runIds[4]!));
    await access(join(rootText, '.work/arena/runs', corruptRunId));
  } finally {
    await rm(rootText, { recursive: true, force: true });
  }
});

function winnerTraceSegment(runId: string): Buffer {
  const records = [
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '2', correlation: '1', type: 'ready', payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 775 },
      plugin: { name: 'Arena', version: 'test' },
      capabilities: ['hunger_games_v1'],
    } },
    { direction: 'runner', protocol: 1, run_id: runId, sequence: '2', type: 'prepare', payload: {
      map_semantic_id: 'a'.repeat(64),
      scenario_semantic_id: 'b'.repeat(64),
      seed: '4',
      mode: 'hunger_games',
      settings: {
        match: {
          countdown_ticks: '0', grace_ticks: '0', authoritative_max_ticks: '100', respawn: false,
          block_breaking: false, block_placing: false, natural_mobs: false, natural_random_ticks: false,
        },
        border: { initial_diameter_blocks: 126, shrink_start_tick: '0', shrink_end_tick: '50', final_diameter_blocks: 16 },
      },
      roster: [0, 1].map((seat) => ({
        kind: 'bot', seat, participant_id: `bot-${seat}`, username: `ArenaBot${seat}`,
        offline_uuid: `00000000-0000-3000-8000-${String(seat + 1).padStart(12, '0')}`,
      })),
    } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '3', correlation: '2', type: 'ack', payload: {} },
    { direction: 'runner', protocol: 1, run_id: runId, sequence: '3', type: 'start', payload: {} },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '4', correlation: '3', type: 'ack', payload: {} },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '5', type: 'public_clock', payload: {
      phase: 'active', tick: { domain: 'match', value: '0' }, border_diameter_blocks: 126,
    } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '6', type: 'public_state', payload: {
      at: { domain: 'match', value: '0' }, alive_seats: [0, 1],
    } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '7', type: 'elimination', payload: {
      at: { domain: 'match', value: '8' }, eliminations: [{ seat: 1, cause: 'death' }],
    } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '8', type: 'public_state', payload: {
      at: { domain: 'match', value: '8' }, alive_seats: [0],
    } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '9', type: 'public_clock', payload: {
      phase: 'finished', tick: { domain: 'match', value: '8' }, border_diameter_blocks: 126,
    } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '10', type: 'outcome', payload: {
      kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: '8' },
    } },
  ];
  return Buffer.from(canonicalJson({
    schema: TRACE_SCHEMA_VERSION,
    run_id: runId,
    first_sequence: '1',
    last_sequence: String(records.length),
    records,
    sha256: sha256Json(records),
    trailer: { complete: true },
  }), 'utf8');
}
