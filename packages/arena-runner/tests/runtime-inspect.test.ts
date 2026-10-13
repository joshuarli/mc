import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { runCli } from '../src/cli.js';
import {
  acquireOwnedRunLease,
  createOwnedDirectory,
  createRunDirectory,
  stageOwnedFile,
} from '../src/owned-files/index.js';
import { MAX_TRACE_SEGMENT_BYTES, TRACE_SCHEMA_VERSION } from '../src/trace.js';

const repositoryRoot = process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, '.work/arena-fs/arena-fs');
const FIRST_UUID = '00000000-0000-3000-8000-000000000001';
const SECOND_UUID = '00000000-0000-3000-8000-000000000002';
let nextRunId = 0;

test('inspect derives outcome and reads stopped stats by prepared offline UUID', async (t) => {
  const { runDirectoryPath, runId } = await createOwnedRun(t);
  await stageOwnedFile({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, 'utf8'),
    relativePath: Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000001.json', 'ascii')]),
    contents: traceSegment(runId),
    maxBytes: MAX_TRACE_SEGMENT_BYTES,
  });
  await prepareStatsDirectory(runDirectoryPath);
  await stageStats(runDirectoryPath, FIRST_UUID, { 'minecraft:deaths': 1 });
  await stageStats(runDirectoryPath, SECOND_UUID, { 'minecraft:player_kills': 0 });

  setHelperEnvironment(t);

  const result = await runCli(['inspect', '--run-id', runId]);
  assert.equal(result.kind, 'success', result.kind === 'failure' ? result.stderr : undefined);
  if (result.kind !== 'success') return;
  const inspection = JSON.parse(result.stdout);
  assert.deepEqual(inspection, {
    schema: 1,
    run_id: runId,
    report: {
      outcome: { kind: 'winner', winner_seat: 0, survivors: [0], at: { domain: 'match', value: '8' } },
      outcome_status: 'reconstructed_from_authoritative_events',
      statistics: {
        competitor_count: 2,
        elimination_count: 1,
        death_count: 1,
        disconnect_count: 0,
        survivor_seats: [0],
      },
    },
    stats: [
      { username: 'ArenaBot0', offlineUuid: FIRST_UUID, status: 'present', deaths: 1, playerKills: 0 },
      { username: 'ArenaBot1', offlineUuid: SECOND_UUID, status: 'present', deaths: 0, playerKills: 0 },
    ],
  });
});

test('inspect rejects active runs while holding the owned run lease', async (t) => {
  const { runDirectoryPath, runId } = await createOwnedRun(t);
  const lease = await acquireOwnedRunLease({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, 'utf8'),
    relativePath: runDirectoryPath,
  });
  t.after(async () => await lease.release());

  setHelperEnvironment(t);

  const result = await runCli(['inspect', '--run-id', runId]);
  assert.equal(result.kind, 'failure');
  if (result.kind !== 'failure') return;
  const error = JSON.parse(result.stderr);
  assert.equal(error.error.resource, 'run lease');
  assert.equal(error.error.source.kind, 'conflict');
});

test('inspect marks missing stats files absent with explicit null counters', async (t) => {
  const { runDirectoryPath, runId } = await createOwnedRun(t);
  await stageOwnedFile({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, 'utf8'),
    relativePath: Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000001.json', 'ascii')]),
    contents: traceSegment(runId),
    maxBytes: MAX_TRACE_SEGMENT_BYTES,
  });
  setHelperEnvironment(t);

  const result = await runCli(['inspect', '--run-id', runId]);
  assert.equal(result.kind, 'success', result.kind === 'failure' ? result.stderr : undefined);
  if (result.kind !== 'success') return;
  const inspection = JSON.parse(result.stdout);
  assert.deepEqual(inspection.stats, [
    { username: 'ArenaBot0', offlineUuid: FIRST_UUID, status: 'absent', deaths: null, playerKills: null },
    { username: 'ArenaBot1', offlineUuid: SECOND_UUID, status: 'absent', deaths: null, playerKills: null },
  ]);
});

async function createOwnedRun(t: import('node:test').TestContext): Promise<Readonly<{
  runId: string;
  runDirectoryPath: Buffer;
}>> {
  const runId = `inspect-${process.pid}-${++nextRunId}`;
  const runDirectoryPath = Buffer.from(`.work/arena/runs/${runId}`, 'utf8');
  await createRunDirectory({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, 'utf8'),
    relativePath: runDirectoryPath,
  });
  t.after(async () => await rm(resolve(repositoryRoot, runDirectoryPath.toString('utf8')), {
    recursive: true,
    force: true,
  }));
  return Object.freeze({ runId, runDirectoryPath });
}

function setHelperEnvironment(t: import('node:test').TestContext): void {
  const previousHelper = process.env.ARENA_FS_HELPER;
  process.env.ARENA_FS_HELPER = helperPath;
  t.after(() => {
    if (previousHelper === undefined) delete process.env.ARENA_FS_HELPER;
    else process.env.ARENA_FS_HELPER = previousHelper;
  });
}

async function prepareStatsDirectory(runDirectoryPath: Buffer): Promise<void> {
  const ownedRoot = Buffer.from(repositoryRoot, 'utf8');
  for (const suffix of ['/server', '/server/world', '/server/world/stats']) {
    await createOwnedDirectory({
      helperPath,
      ownedRoot,
      relativePath: Buffer.concat([runDirectoryPath, Buffer.from(suffix, 'ascii')]),
    });
  }
}

async function stageStats(
  runDirectoryPath: Buffer,
  uuid: string,
  counters: Readonly<Record<string, number>>,
): Promise<void> {
  const contents = Buffer.from(canonicalJson({ stats: { 'minecraft:custom': counters } }), 'utf8');
  await stageOwnedFile({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, 'utf8'),
    relativePath: Buffer.concat([
      runDirectoryPath,
      Buffer.from(`/server/world/stats/${uuid}.json`, 'ascii'),
    ]),
    contents,
    maxBytes: 1024 * 1024,
  });
}

function traceSegment(runId: string): Buffer {
  const records = [
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '2', correlation: '1', type: 'ready', payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 775 },
      plugin: { name: 'Arena', version: 'test' },
      capabilities: ['hunger_games_v1'],
    } },
    { direction: 'runner', protocol: 1, run_id: runId, sequence: '2', type: 'prepare', payload: preparePayload() },
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

function preparePayload(): object {
  return {
    map_semantic_id: 'a'.repeat(64),
    scenario_semantic_id: 'b'.repeat(64),
    seed: '4',
    mode: 'hunger_games',
    settings: {
      match: {
        countdown_ticks: '0',
        grace_ticks: '0',
        authoritative_max_ticks: '100',
        respawn: false,
        block_breaking: false,
        block_placing: false,
        natural_mobs: false,
        natural_random_ticks: false,
      },
      border: {
        initial_diameter_blocks: 126,
        shrink_start_tick: '0',
        shrink_end_tick: '50',
        final_diameter_blocks: 16,
      },
    },
    roster: [0, 1].map((seat) => ({
      kind: 'bot',
      seat,
      participant_id: `bot-${seat}`,
      username: `ArenaBot${seat}`,
      offline_uuid: seat === 0 ? FIRST_UUID : SECOND_UUID,
    })),
  };
}
