import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import {
  agentObservation, agentState, blockPosition, currentKnowledge, emptyEquipment, observationSequence, PolicyParams,
  tick, unknownKnowledge, worldBorder,
} from '@arena/core';
import type { MineflayerArenaClient } from '@arena/bots';
import { decodeCheckpoint } from '../src/control/checkpoint.js';
import { RunnerError } from '../src/errors.js';
import { persistCheckpoint, loadCheckpoint } from '../src/checkpoint/persist.js';
import { parseCheckpointManifest, sha256Hex } from '../src/checkpoint/manifest.js';
import { publishSaveResult, readSaveRequest, readSaveResult, requestSave } from '../src/checkpoint/save-request.js';
import { LivePolicyLoop } from '../src/runtime/live-policy-loop.js';
import { reconstruct, reconstructRunEvidence } from '../src/evidence.js';
import { parseSegment, readSegment } from '../src/trace.js';
import { canonicalJson, sha256Json } from '../src/canonical.js';
import { createOwnedDirectory } from '../src/owned-files/index.js';

const repositoryRoot = process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, '.work/arena-fs/arena-fs');
const fixture = join(repositoryRoot, 'fixtures/checkpoint/checkpoint-v1.ckpt');

async function sandbox(t: test.TestContext): Promise<{ ownedRoot: Buffer; root: string }> {
  const root = await mkdtemp(join(repositoryRoot, '.work/tmp/checkpoint-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { ownedRoot: Buffer.from(root), root };
}

async function stageRunDirectory(root: string, runId: string, checkpointId: string, recordBytes: Buffer): Promise<void> {
  const plugin = join(root, 'run/server/plugins/ArenaFoundation/checkpoints');
  await mkdir(plugin, { recursive: true });
  await mkdir(join(root, 'run/server/world/region'), { recursive: true });
  await writeFile(join(plugin, `${checkpointId}.json`), recordBytes);
  await writeFile(join(root, 'run/server/world/level.dat'), 'level');
  await writeFile(join(root, 'run/server/world/region/r.0.0.mca'), 'region');
  void runId;
}

async function fixtureRecord() {
  const bytes = await readFile(fixture);
  return { bytes, decoded: decodeCheckpoint(bytes) };
}

function persistOptions(root: string, ownedRoot: Buffer, decoded: ReturnType<typeof decodeCheckpoint>) {
  return {
    helperPath,
    ownedRoot,
    runDirectoryPath: Buffer.from('run'),
    runId: decoded.record.run_id,
    checkpointId: decoded.record.checkpoint_id,
    epoch: decoded.record.epoch,
    written: {
      checkpoint_id: decoded.record.checkpoint_id, epoch: decoded.record.epoch, match_tick: decoded.record.match_tick,
      digest: decoded.digest, byte_length: decoded.byteLength,
    },
    botState: { schema: 1, seats: [] },
    scenario: { path: 'scenarios/hunger-12.toml', semantic_id: 'a'.repeat(64), external_seat: null },
    root,
  };
}

test('a checkpoint is persisted with the manifest last and loads back with verified digests', async (t) => {
  const { root, ownedRoot } = await sandbox(t);
  const { bytes, decoded } = await fixtureRecord();
  await stageRunDirectory(root, decoded.record.run_id, decoded.record.checkpoint_id, bytes);
  const options = persistOptions(root, ownedRoot, decoded);
  const manifest = await persistCheckpoint(options);
  assert.equal(manifest.record.digest, decoded.digest);
  assert.equal(manifest.record.body_bytes, decoded.byteLength);
  assert.equal(manifest.record.file_sha256, sha256Hex(bytes));
  const loaded = await loadCheckpoint({ helperPath, ownedRoot, checkpointId: decoded.record.checkpoint_id });
  assert.equal(loaded.record.match_tick, decoded.record.match_tick);
  assert.deepEqual(parseCheckpointManifest(await readFile(join(root, '.work/arena/checkpoints',
    decoded.record.checkpoint_id, 'manifest.json'))), manifest);
  assert.equal(await readFile(join(root, '.work/arena/checkpoints', decoded.record.checkpoint_id, 'world/level.dat'), 'utf8'), 'level');
  await assert.rejects(persistCheckpoint(options), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'checkpoint_exists');
});

test('a checkpoint with a wrong digest, truncated record, or stale epoch is refused before anything is published', async (t) => {
  const { root, ownedRoot } = await sandbox(t);
  const { bytes, decoded } = await fixtureRecord();
  const id = decoded.record.checkpoint_id;
  await stageRunDirectory(root, decoded.record.run_id, id, bytes);
  const base = persistOptions(root, ownedRoot, decoded);
  const refused = async (override: Partial<typeof base>, kind: string): Promise<void> => {
    await assert.rejects(persistCheckpoint({ ...base, ...override }), (error: unknown) =>
      error instanceof RunnerError && error.source.kind === kind);
  };
  await refused({ written: { ...base.written, digest: 'e'.repeat(64) } }, 'checkpoint_digest_mismatch');
  await refused({ written: { ...base.written, byte_length: decoded.byteLength + 1 } }, 'checkpoint_digest_mismatch');
  await refused({ epoch: decoded.record.epoch + 1, written: { ...base.written, epoch: decoded.record.epoch + 1 } },
    'checkpoint_record_identity_mismatch');
  await writeFile(join(root, `run/server/plugins/ArenaFoundation/checkpoints/${id}.json`), bytes.subarray(0, bytes.length - 20));
  await refused({}, 'checkpoint_record_incomplete');
  await assert.rejects(loadCheckpoint({ helperPath, ownedRoot, checkpointId: id }), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'checkpoint_not_found_or_incomplete');
});

test('a tampered checkpoint file or bot state fails verification at resume', async (t) => {
  const { root, ownedRoot } = await sandbox(t);
  const { bytes, decoded } = await fixtureRecord();
  const id = decoded.record.checkpoint_id;
  await stageRunDirectory(root, decoded.record.run_id, id, bytes);
  await persistCheckpoint(persistOptions(root, ownedRoot, decoded));
  const directory = join(root, '.work/arena/checkpoints', id);
  await writeFile(join(directory, 'bots.json'), '{"schema":1,"seats":[{"seat":0}]}\n');
  await assert.rejects(loadCheckpoint({ helperPath, ownedRoot, checkpointId: id }), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'bot_state_mismatch');
});

test('save requests are exclusive and results round trip through the run directory', async (t) => {
  const { ownedRoot } = await sandbox(t);
  await createOwnedDirectory({ helperPath, ownedRoot, relativePath: Buffer.from('run') });
  const files = { helperPath, ownedRoot, runDirectoryPath: Buffer.from('run') };
  assert.equal(await readSaveRequest(files), undefined);
  await requestSave(files, 'save-1');
  assert.equal(await readSaveRequest(files), 'save-1');
  await assert.rejects(requestSave(files, 'save-2'), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'save_already_requested');
  assert.equal(await readSaveResult(files), undefined);
  await publishSaveResult(files, { schema: 1, status: 'failed', checkpoint_id: 'save-1', run_id: 'run', reason: 'invalid_state' });
  assert.deepEqual(await readSaveResult(files), {
    schema: 1, status: 'failed', checkpoint_id: 'save-1', run_id: 'run', reason: 'invalid_state',
  });
  await assert.rejects(requestSave(files, 'bad id'), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'invalid_checkpoint_id');
});

function loopClient(seatX: number): MineflayerArenaClient {
  return {
    observe: (value) => agentObservation({
      tick: tick(value), sequence: observationSequence(value + 1),
      agent: currentKnowledge(agentState({
        position: blockPosition(seatX, 64, value % 5), healthHalfHearts: 40, hungerPoints: 20, foodStacks: [],
        equipped: emptyEquipment(), upgrades: [],
      })),
      border: currentKnowledge(worldBorder(0, 0, 100)), opponents: currentKnowledge([]), loot: unknownKnowledge(),
    }),
    run: async () => ({ kind: 'succeeded' as const }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}

test('policy loop state exports by seat and restores to the same exported state', async () => {
  const trace = {
    recordPolicyDecision: async () => undefined,
    recordPolicyEffect: async () => undefined,
    checkpoint: async () => undefined,
  };
  const seat = (value: number) => ({
    seat: value,
    bot: Object.assign(new EventEmitter(), { health: 20, game: { gameMode: 'survival' }, entities: {} }) as unknown as Bot,
    gameplay: { mode: 'hunger_games' as const, client: loopClient(value * 9) },
  });
  const competitors = [seat(0), seat(1)];
  const make = (restore?: ConstructorParameters<typeof LivePolicyLoop>[0]['restore']) => new LivePolicyLoop({
    trace, params: PolicyParams.baseline(), seed: 7n, strategyIntervalTicks: 1n, recordPolicy: false,
    competitors: () => competitors, fail: (error) => { throw error; },
    ...(restore === undefined ? {} : { restore }),
  });
  const first = make();
  for (let value = 0; value < 6; value += 1) first.onTick(value);
  await new Promise((resolve) => setImmediate(resolve));
  const exported = first.exportState();
  assert.deepEqual([...exported.keys()], [0, 1]);
  const serialized = JSON.parse(JSON.stringify([...exported.entries()])) as [number, unknown][];
  assert.ok(Object.values(serialized[0]![1] as object).length === 3);
  await first.stopAndJoin();
  const second = make(new Map(serialized as never));
  assert.equal(canonicalJson([...second.exportState().entries()]), canonicalJson([...exported.entries()]));
  await second.stopAndJoin();
});

test('a checkpointed trace reconstructs without an outcome and names its status', async () => {
  const segment = await readSegment(join(repositoryRoot, 'tests/fixtures/pending-abort/trace-v2-000001.json'), 1);
  const head = segment.records.slice(0, 8);
  const runId = segment.runId;
  const records = [
    ...head,
    { direction: 'runner', protocol: 1, run_id: runId, sequence: '4', type: 'checkpoint',
      payload: { checkpoint_id: 'cp-1', epoch: 0 } },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '9', correlation: '4', type: 'ack', payload: {} },
    { direction: 'plugin', protocol: 1, run_id: runId, sequence: '10', type: 'checkpoint_written',
      payload: { checkpoint_id: 'cp-1', epoch: 0, match_tick: '5', digest: 'f'.repeat(64), byte_length: 100 } },
  ];
  const parsed = parseSegment(canonicalJson({ schema: 3, run_id: runId, first_sequence: '1',
    last_sequence: String(records.length), records, sha256: sha256Json(records), trailer: { complete: true } }));
  const result = reconstructRunEvidence(reconstruct([parsed]));
  assert.equal(result.report.outcome_status, 'checkpointed_without_outcome');
  assert.deepEqual(result.report.outcome, { kind: 'checkpointed' });
  assert.deepEqual(result.report.statistics.survivor_seats, [0, 1]);
});
