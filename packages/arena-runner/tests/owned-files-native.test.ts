import assert from 'node:assert/strict';
import { constants as osConstants } from 'node:os';
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import {
  createRunDirectory,
  OwnedFilesError,
  readOwnedFile,
  removeCreatedDirectory,
  removeCreatedFile,
  stageWorldPlan,
} from '../src/owned-files/index.js';
import type { FileIdentity } from '../src/owned-files/index.js';
import { decodeRawArgvChannel, rawArgumentText, RawArgvError } from '../src/owned-files/raw-argv.js';

const packageDirectory = basename(process.cwd()) === 'arena-runner';
const repoRoot = packageDirectory ? resolve(process.cwd(), '../..') : process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repoRoot, '.work/arena-fs/arena-fs');

async function withOwnedRoot(run: (root: Buffer, rootText: string) => Promise<void>): Promise<void> {
  const prefix = join(repoRoot, '.work/tmp/arena-owned-files-');
  const rootText = await mkdtemp(prefix);
  const root = Buffer.from(rootText);
  try {
    await run(root, rootText);
  } finally {
    await rm(rootText, { recursive: true, force: true });
  }
}

function nativeFailure(category: string, relativePath?: Buffer): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof OwnedFilesError && error.category === category &&
    (relativePath === undefined || error.relativePath?.equals(relativePath) === true);
}

test('creates a fresh run, stages without overwrite, reads, and removes by identity', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runPath = Buffer.from('runs/session-one');
    const runIdentity = await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const planPath = Buffer.from('runs/session-one/world-plan.json');
    const contents = Buffer.from('{"schema":1,"seed":4}');
    const planIdentity = await stageWorldPlan({
      helperPath, ownedRoot: root, destinationRelativePath: planPath, contents, maxBytes: 1024,
    });

    assert.deepEqual(await readOwnedFile({ helperPath, ownedRoot: root, relativePath: planPath, maxBytes: 1024 }), contents);
    await assert.rejects(stageWorldPlan({
      helperPath, ownedRoot: root, destinationRelativePath: planPath,
      contents: Buffer.from('replacement'), maxBytes: 1024,
    }),
                         nativeFailure('conflict'));
    assert.deepEqual(await readFile(Buffer.concat([root, Buffer.from('/'), planPath])), contents);

    await assert.rejects(removeCreatedFile({
      helperPath, ownedRoot: root, relativePath: planPath,
      identity: { device: planIdentity.device, inode: '0' },
    }),
                         nativeFailure('conflict'));
    assert.deepEqual(await readOwnedFile({ helperPath, ownedRoot: root, relativePath: planPath, maxBytes: 1024 }), contents);

    await removeCreatedFile({ helperPath, ownedRoot: root, relativePath: planPath, identity: planIdentity });
    await removeCreatedDirectory({ helperPath, ownedRoot: root, relativePath: runPath, identity: runIdentity });
    await assert.rejects(access(join(rootText, 'runs/session-one')));
  });
});

test('rejects traversal, symlink components, and reads beyond the bound', async () => {
  await withOwnedRoot(async (root, rootText) => {
    await assert.rejects(createRunDirectory({
      helperPath, ownedRoot: root, relativePath: Buffer.from('../outside/run'),
    }),
                         nativeFailure('invalid_path'));

    const outsideText = join(rootText, 'outside');
    await mkdir(outsideText);
    await symlink(outsideText, join(rootText, 'link'));
    const symlinkPath = Buffer.from('link/escaped');
    await assert.rejects(createRunDirectory({
      helperPath, ownedRoot: root, relativePath: symlinkPath,
    }),
                         nativeFailure('symlink_rejected', symlinkPath));
    await assert.rejects(access(join(outsideText, 'escaped')));

    await mkdir(join(rootText, 'source'));
    await writeFile(join(rootText, 'source/oversize.toml'), Buffer.from('12345'));
    await assert.rejects(readOwnedFile({
      helperPath, ownedRoot: root, relativePath: Buffer.from('source/oversize.toml'), maxBytes: 4,
    }),
                         nativeFailure('too_large'));
  });
});

test('does not follow a parent changed into a symlink while operations run', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const outsideText = join(rootText, '..', `arena-owned-outside-${randomBytes(6).toString('hex')}`);
    const switchText = join(rootText, 'switch');
    const heldText = join(rootText, 'switch-held');
    await mkdir(outsideText);
    await mkdir(switchText);
    let finished = false;
    const swapper = (async () => {
      while (!finished) {
        try {
          await rename(switchText, heldText);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) ||
              (error.code !== 'ENOENT' && error.code !== 'EEXIST' && error.code !== 'ENOTDIR')) throw error;
        }
        try {
          await symlink(outsideText, switchText);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) ||
              (error.code !== 'EEXIST' && error.code !== 'ENOENT')) throw error;
        }
        try {
          await unlink(switchText);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        try {
          await rename(heldText, switchText);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) ||
              (error.code !== 'ENOENT' && error.code !== 'EEXIST' && error.code !== 'ENOTDIR')) throw error;
        }
        await nextTurn();
      }
    })();
    try {
      const operations = Array.from({ length: 20 }, (_, index) =>
        stageWorldPlan({
          helperPath, ownedRoot: root, destinationRelativePath: Buffer.from(`switch/plan-${index}`),
          contents: Buffer.from('plan'), maxBytes: 16,
        })
          .catch((error: unknown) => {
          if (!(error instanceof OwnedFilesError) ||
              (error.category !== 'symlink_rejected' && error.category !== 'not_found' &&
               error.category !== 'conflict' && error.category !== 'invalid_path')) throw error;
          }));
      await Promise.all(operations);
    } finally {
      finished = true;
      await swapper;
    }
    assert.deepEqual(await readdir(outsideText).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }), []);
    await rm(outsideText, { recursive: true, force: true });
  });
});

test('preserves non-UTF-8 path bytes where the host filesystem accepts them', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const rawName = Buffer.concat([Buffer.from('raw-'), Buffer.from([0xff])]);
    const rawRun = Buffer.concat([Buffer.from('raw/'), rawName]);
    let identity: FileIdentity;
    try {
      identity = await createRunDirectory({ helperPath, ownedRoot: root, relativePath: rawRun });
    } catch (error) {
      if (process.platform === 'darwin' && error instanceof OwnedFilesError &&
          error.errno === osConstants.errno.EILSEQ) return;
      throw error;
    }

    const rawFile = Buffer.concat([rawRun, Buffer.from('/data.bin')]);
    const contents = Buffer.from([0, 1, 255, 0x61]);
    const fileIdentity = await stageWorldPlan({
      helperPath, ownedRoot: root, destinationRelativePath: rawFile, contents, maxBytes: 16,
    });
    assert.deepEqual(await readOwnedFile({ helperPath, ownedRoot: root, relativePath: rawFile, maxBytes: 16 }), contents);
    const rawAbsolute = Buffer.concat([root, Buffer.from('/'), rawFile]);
    assert.deepEqual(await readFile(rawAbsolute), contents);
    await removeCreatedFile({ helperPath, ownedRoot: root, relativePath: rawFile, identity: fileIdentity });
    await removeCreatedDirectory({ helperPath, ownedRoot: root, relativePath: rawRun, identity });
    await assert.rejects(lstat(Buffer.concat([root, Buffer.from('/'), rawRun])));
  });
});

test('cancellation removes a staged artifact using its captured identity', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runPath = Buffer.from('runs/cancelled');
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const controller = new AbortController();
    const staging = stageWorldPlan({
      helperPath, ownedRoot: root, destinationRelativePath: Buffer.from('runs/cancelled/world-plan.json'),
      contents: Buffer.alloc(32 * 1024 * 1024, 0x61), maxBytes: 32 * 1024 * 1024,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(staging, nativeFailure('cancelled'));
    assert.deepEqual(await readdir(join(rootText, 'runs/cancelled')), []);
  });
});

test('decodes the launch channel without losing raw argument bytes or accepting mismatches', () => {
  const original = [Buffer.from('--scenario'), Buffer.from([0x66, 0x80, 0x6f])];
  const channel = `v1;${original.length};${original.map((argument) =>
    `${argument.length}:${argument.toString('base64')};`).join('')}`;
  const decoded = decodeRawArgvChannel(channel, original.map((argument) => argument.toString('utf8')));
  assert.deepEqual(decoded, original);
  assert.throws(() => rawArgumentText(original[1]!, 1), RawArgvError);
  assert.throws(() => decodeRawArgvChannel(channel, ['--scenario']), RawArgvError);
});
