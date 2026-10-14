import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { collectOwnedRuns } from '../src/runtime/gc.js';
import { RunnerError } from '../src/errors.js';
import { createOwnedDirectory, createRunDirectory, stageOwnedFile } from '../src/owned-files/index.js';
import { writeOperationalFailureArtifact } from '../src/runtime/failure-artifact.js';
import { archiveDirectoryPath, inspectStoppedRun } from '../src/runtime/inspect.js';
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

test('garbage collection archives exact trace and present roster stats before removal', async (t) => {
  await mkdir(resolve(repositoryRoot, '.work/tmp'), { recursive: true });
  const rootText = await mkdtemp(join(repositoryRoot, '.work/tmp/arena-gc-archive-'));
  const ownedRoot = Buffer.from(rootText, 'utf8');
  const runId = `gc-archive-${process.pid}-${++nextRunId}`;
  const runDirectoryPath = Buffer.from(`.work/arena/runs/${runId}`, 'ascii');
  await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectoryPath });
  t.after(async () => await rm(rootText, { recursive: true, force: true }));

  const traces = twoPartWinnerTraceSegments(runId);
  for (const [index, trace] of traces.entries()) {
    const tracePath = Buffer.concat([
      runDirectoryPath,
      Buffer.from(`/trace-v2-${String(index + 1).padStart(6, '0')}.json`, 'ascii'),
    ]);
    await stageOwnedFile({ helperPath, ownedRoot, relativePath: tracePath, contents: trace, maxBytes: MAX_TRACE_SEGMENT_BYTES });
  }
  const statsDirectory = Buffer.concat([
    runDirectoryPath,
    Buffer.from('/server/world/players/stats', 'ascii'),
  ]);
  await createOwnedDirectory({ helperPath, ownedRoot, relativePath: statsDirectory });
  const stats = Buffer.from(canonicalJson({
    stats: { 'minecraft:custom': { 'minecraft:deaths': 3, 'minecraft:player_kills': 1 } },
  }), 'utf8');
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.concat([statsDirectory, Buffer.from('/00000000-0000-3000-8000-000000000001.json', 'ascii')]),
    contents: stats,
    maxBytes: 1024 * 1024,
  });

  const result = await collectOwnedRuns({ helperPath, ownedRoot, runIds: [runId], mode: 'apply' });
  const archiveDirectory = archiveDirectoryPath(runId);
  assert.equal(result.runs[0]?.status, 'removed');
  assert.equal(result.runs[0]?.evidence_path, `${archiveDirectory.toString('ascii')}/trace-v2-000002.json`);
  for (const [index, trace] of traces.entries()) {
    assert.deepEqual(
      await readFile(join(rootText, archiveDirectory.toString('utf8'), `trace-v2-${String(index + 1).padStart(6, '0')}.json`)),
      trace,
    );
  }
  assert.deepEqual(
    await readFile(join(rootText, archiveDirectory.toString('utf8'), 'server/world/players/stats/00000000-0000-3000-8000-000000000001.json')),
    stats,
  );
  await assert.rejects(access(join(rootText, '.work/arena/runs', runId)));

  const inspection = await inspectStoppedRun({ helperPath, ownedRoot, runId });
  assert.equal(inspection.report.outcome.kind, 'winner');
  assert.deepEqual(inspection.stats, [
    { username: 'ArenaBot0', offlineUuid: '00000000-0000-3000-8000-000000000001', status: 'present', deaths: 3, playerKills: 1 },
    { username: 'ArenaBot1', offlineUuid: '00000000-0000-3000-8000-000000000002', status: 'absent', deaths: null, playerKills: null },
  ]);
});

test('garbage collection archives an older authoritative abort before removal', async (t) => {
  await mkdir(resolve(repositoryRoot, '.work/tmp'), { recursive: true });
  const rootText = await mkdtemp(join(repositoryRoot, '.work/tmp/arena-gc-abort-archive-'));
  const ownedRoot = Buffer.from(rootText, 'utf8');
  const runIds = ['gc-abort-old', 'gc-abort-new-a', 'gc-abort-new-b', 'gc-abort-new-c'];
  t.after(async () => await rm(rootText, { recursive: true, force: true }));

  for (const [index, runId] of runIds.entries()) {
    const runDirectory = Buffer.from(`.work/arena/runs/${runId}`, 'ascii');
    await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectory });
    const tracePath = Buffer.concat([runDirectory, Buffer.from('/trace-v2-000001.json', 'ascii')]);
    await stageOwnedFile({
      helperPath,
      ownedRoot,
      relativePath: tracePath,
      contents: abortTraceSegment(runId),
      maxBytes: MAX_TRACE_SEGMENT_BYTES,
    });
    const modified = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    await utimes(join(rootText, tracePath.toString('utf8')), modified, modified);
  }

  const result = await collectOwnedRuns({ helperPath, ownedRoot, runIds: [runIds[0]!], mode: 'apply' });
  const archiveDirectory = archiveDirectoryPath(runIds[0]!);
  assert.deepEqual(result.runs[0], {
    run_id: runIds[0],
    path: `.work/arena/runs/${runIds[0]}`,
    status: 'removed',
    reason: 'older_than_latest_three_failures',
    evidence_path: `${archiveDirectory.toString('ascii')}/trace-v2-000001.json`,
    failure_type: 'authority_abort',
  });
  await assert.rejects(access(join(rootText, '.work/arena/runs', runIds[0]!)));
  const inspection = await inspectStoppedRun({ helperPath, ownedRoot, runId: runIds[0]! });
  assert.equal(inspection.report.outcome.kind, 'abort');
});

test('garbage collection resumes an exact partial archive and preserves the source on mismatch', async (t) => {
  await mkdir(resolve(repositoryRoot, '.work/tmp'), { recursive: true });
  const rootText = await mkdtemp(join(repositoryRoot, '.work/tmp/arena-gc-archive-resume-'));
  const ownedRoot = Buffer.from(rootText, 'utf8');
  const runId = `gc-archive-resume-${process.pid}-${++nextRunId}`;
  const runDirectoryPath = Buffer.from(`.work/arena/runs/${runId}`, 'ascii');
  await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectoryPath });
  t.after(async () => await rm(rootText, { recursive: true, force: true }));
  const trace = winnerTraceSegment(runId);
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000001.json', 'ascii')]),
    contents: trace,
    maxBytes: MAX_TRACE_SEGMENT_BYTES,
  });
  const archiveDirectory = archiveDirectoryPath(runId);
  await createOwnedDirectory({ helperPath, ownedRoot, relativePath: archiveDirectory });
  const archiveTracePath = Buffer.concat([archiveDirectory, Buffer.from('/trace-v2-000001.json', 'ascii')]);
  await stageOwnedFile({ helperPath, ownedRoot, relativePath: archiveTracePath, contents: trace, maxBytes: MAX_TRACE_SEGMENT_BYTES });

  const resumed = await collectOwnedRuns({ helperPath, ownedRoot, runIds: [runId], mode: 'apply' });
  assert.equal(resumed.runs[0]?.status, 'removed');

  const mismatchRunId = `gc-archive-mismatch-${process.pid}-${++nextRunId}`;
  const mismatchRunPath = Buffer.from(`.work/arena/runs/${mismatchRunId}`, 'ascii');
  await createRunDirectory({ helperPath, ownedRoot, relativePath: mismatchRunPath });
  const mismatchTrace = winnerTraceSegment(mismatchRunId);
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.concat([mismatchRunPath, Buffer.from('/trace-v2-000001.json', 'ascii')]),
    contents: mismatchTrace,
    maxBytes: MAX_TRACE_SEGMENT_BYTES,
  });
  const mismatchSourceStatsDirectory = Buffer.concat([
    mismatchRunPath,
    Buffer.from('/server/world/players/stats', 'ascii'),
  ]);
  await createOwnedDirectory({ helperPath, ownedRoot, relativePath: mismatchSourceStatsDirectory });
  const expectedStats = Buffer.from(canonicalJson({
    stats: { 'minecraft:custom': { 'minecraft:deaths': 1 } },
  }), 'utf8');
  const mismatchStatsPath = Buffer.from('/00000000-0000-3000-8000-000000000001.json', 'ascii');
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.concat([mismatchSourceStatsDirectory, mismatchStatsPath]),
    contents: expectedStats,
    maxBytes: 1024 * 1024,
  });
  const mismatchArchive = archiveDirectoryPath(mismatchRunId);
  await createOwnedDirectory({ helperPath, ownedRoot, relativePath: mismatchArchive });
  const mismatchArchiveStatsDirectory = Buffer.concat([
    mismatchArchive,
    Buffer.from('/server/world/players/stats', 'ascii'),
  ]);
  await createOwnedDirectory({ helperPath, ownedRoot, relativePath: mismatchArchiveStatsDirectory });
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.concat([mismatchArchiveStatsDirectory, mismatchStatsPath]),
    contents: Buffer.from('different stats bytes'),
    maxBytes: 1024 * 1024,
  });

  await assert.rejects(
    collectOwnedRuns({ helperPath, ownedRoot, runIds: [mismatchRunId], mode: 'apply' }),
    (error: unknown) => error instanceof RunnerError
      && error.category === 'corrupt_evidence'
      && error.resource === 'run archive'
      && error.source.kind === 'archive_file_mismatch',
  );
  await access(join(rootText, '.work/arena/runs', mismatchRunId));
  await assert.rejects(access(join(rootText, mismatchArchive.toString('utf8'), 'trace-v2-000001.json')));
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

function twoPartWinnerTraceSegments(runId: string): readonly Buffer[] {
  const records = (JSON.parse(winnerTraceSegment(runId).toString('utf8')) as {
    records: readonly Readonly<Record<string, unknown>>[];
  }).records;
  const splitIndex = 5;
  return [
    encodeTraceSegment(runId, 1, records.slice(0, splitIndex)),
    encodeTraceSegment(runId, splitIndex + 1, records.slice(splitIndex)),
  ];
}

function abortTraceSegment(runId: string): Buffer {
  const records = (JSON.parse(winnerTraceSegment(runId).toString('utf8')) as {
    records: {
      type: string;
      payload: Record<string, unknown>;
      [key: string]: unknown;
    }[];
  }).records;
  const terminalClock = records.find((record) => record.type === 'public_clock'
    && record.payload.phase === 'finished');
  const terminalOutcome = records.at(-1);
  if (terminalClock === undefined || terminalOutcome?.type !== 'outcome') {
    throw new Error('winner trace fixture has no terminal records');
  }
  terminalClock.payload.phase = 'aborted';
  terminalOutcome.payload = {
    kind: 'abort',
    reason: 'operator',
    survivors: [0],
    at: { domain: 'match', value: '8' },
  };
  return encodeTraceSegment(runId, 1, records);
}

function encodeTraceSegment(
  runId: string,
  firstSequence: number,
  records: readonly Readonly<Record<string, unknown>>[],
): Buffer {
  return Buffer.from(canonicalJson({
    schema: TRACE_SCHEMA_VERSION,
    run_id: runId,
    first_sequence: String(firstSequence),
    last_sequence: String(firstSequence + records.length - 1),
    records,
    sha256: sha256Json(records),
    trailer: { complete: true },
  }), 'utf8');
}
