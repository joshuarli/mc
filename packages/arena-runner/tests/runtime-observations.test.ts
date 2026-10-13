import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RunnerError } from '../src/errors.js';
import { createOwnedDirectory, createRunDirectory, stageOwnedFile } from '../src/owned-files/index.js';
import { readStoppedPlayerStats, type PlayerIdentity } from '../src/runtime/observations.js';

const repositoryRoot = process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, '.work/arena-fs/arena-fs');
const bot: PlayerIdentity = Object.freeze({
  username: 'ArenaBot0',
  offlineUuid: '00000000-0000-3000-8000-000000000000',
});
const spectator: PlayerIdentity = Object.freeze({
  username: 'ArenaSpec0',
  offlineUuid: '00000000-0000-3000-8000-000000000001',
});
const invalidBot: PlayerIdentity = Object.freeze({
  username: 'ArenaBotInvalid',
  offlineUuid: '00000000-0000-3000-8000-000000000002',
});

test('stopped stats distinguish absent files from present counters', async (t) => {
  const ownedRoot = await createOwnedRoot(t);
  const runDirectoryPath = Buffer.from('run', 'ascii');
  await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectoryPath });
  await createOwnedDirectory({
    helperPath,
    ownedRoot,
    relativePath: Buffer.from('run/server/world/players/stats', 'ascii'),
  });
  await stageStats(ownedRoot, bot, '{"stats":{"minecraft:custom":{"minecraft:deaths":2,"minecraft:player_kills":1}}}');

  const stats = await readStoppedPlayerStats({
    helperPath,
    ownedRoot,
    runDirectoryPath,
    players: [bot, spectator],
  });
  assert.deepEqual(stats, [
    { ...bot, status: 'present', deaths: 2, playerKills: 1 },
    { ...spectator, status: 'absent', deaths: null, playerKills: null },
  ]);
});

test('stopped stats treat missing counters as zero and reject negative counters', async (t) => {
  const ownedRoot = await createOwnedRoot(t);
  const runDirectoryPath = Buffer.from('run', 'ascii');
  await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectoryPath });
  await createOwnedDirectory({
    helperPath,
    ownedRoot,
    relativePath: Buffer.from('run/server/world/players/stats', 'ascii'),
  });
  await stageStats(ownedRoot, bot, '{"stats":{}}');
  const [stats] = await readStoppedPlayerStats({
    helperPath,
    ownedRoot,
    runDirectoryPath,
    players: [bot],
  });
  assert.deepEqual(stats, { ...bot, status: 'present', deaths: 0, playerKills: 0 });

  await stageStats(ownedRoot, invalidBot, '{"stats":{"minecraft:custom":{"minecraft:deaths":-1}}}');
  await assert.rejects(
    readStoppedPlayerStats({ helperPath, ownedRoot, runDirectoryPath, players: [invalidBot] }),
    (error: unknown) => error instanceof RunnerError
      && error.category === 'corrupt_evidence'
      && error.source.kind === 'invalid_counter',
  );
});

async function createOwnedRoot(t: TestContext): Promise<Buffer> {
  const scratch = join(repositoryRoot, '.work/tmp');
  await mkdir(scratch, { recursive: true });
  const path = await mkdtemp(join(scratch, 'runtime-observations-'));
  t.after(async () => await rm(path, { recursive: true, force: true }));
  return Buffer.from(path, 'utf8');
}

async function stageStats(ownedRoot: Buffer, player: PlayerIdentity, contents: string): Promise<void> {
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: Buffer.from(`run/server/world/players/stats/${player.offlineUuid}.json`, 'ascii'),
    contents: Buffer.from(contents, 'utf8'),
    maxBytes: 1024,
  });
}
