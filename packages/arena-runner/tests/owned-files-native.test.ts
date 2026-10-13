import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { randomBytes } from 'node:crypto';
import { access, link as linkFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import {
  acquireOwnedRunLease,
  assertOwnedRunLeaseMatches,
  cloneOwnedTree,
  createOwnedDirectory,
  createRunDirectory,
  inspectOwnedResources,
  listOwnedRuns,
  MAX_OWNED_FILE_BYTES,
  MAX_OWNED_TREE_BYTES,
  MAX_OWNED_TREE_FILES,
  OwnedFilesError,
  readOwnedFile,
  readOwnedFileWithIdentity,
  removeCreatedDirectory,
  removeCreatedFile,
  removeOwnedRun,
  stageOwnedFile,
  stageWorldPlan,
} from '../src/owned-files/index.js';
import type { FileIdentity, OwnedRunLease } from '../src/owned-files/index.js';
import { decodeRawArgvChannel, rawArgumentText, RawArgvError } from '../src/owned-files/raw-argv.js';

const packageDirectory = basename(process.cwd()) === 'arena-runner';
const repoRoot = packageDirectory ? resolve(process.cwd(), '../..') : process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repoRoot, '.work/arena-fs/arena-fs');
const unlinkRaceHelperPath = process.env.ARENA_FS_RACE_HELPER ??
  resolve(repoRoot, '.work/arena-fs/arena-fs-race-helper');
const cloneRaceHelperPath = process.env.ARENA_FS_CLONE_RACE_HELPER ??
  resolve(repoRoot, '.work/arena-fs/arena-fs-clone-race-helper');

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

function nativeFailure(category: string, relativePath?: Buffer,
                       sourceRelativePath?: Buffer): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof OwnedFilesError && error.category === category &&
    (relativePath === undefined || error.relativePath?.equals(relativePath) === true) &&
    (sourceRelativePath === undefined || error.sourceRelativePath?.equals(sourceRelativePath) === true);
}

test('inspects owned resource bytes without following links and counts retained run directories', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const arenaRoot = join(rootText, '.work/arena');
    const runsRoot = join(arenaRoot, 'runs');
    await mkdir(join(arenaRoot, 'bootstrap'), { recursive: true });
    await mkdir(join(arenaRoot, 'traces'), { recursive: true });
    await mkdir(join(arenaRoot, 'npm-workspace/node_modules/.bin'), { recursive: true });
    await mkdir(join(runsRoot, 'run-one'), { recursive: true });
    await mkdir(join(runsRoot, 'run-two'));
    await writeFile(join(arenaRoot, 'download.bin'), Buffer.alloc(7));
    await writeFile(join(arenaRoot, 'bootstrap/template.zip'), Buffer.alloc(11));
    await writeFile(join(arenaRoot, 'traces/history.jsonl'), Buffer.alloc(13));
    await writeFile(join(runsRoot, 'run-one/world.dat'), Buffer.alloc(17));
    await writeFile(join(runsRoot, 'run-two/result.json'), Buffer.alloc(19));
    await writeFile(join(runsRoot, 'not-a-run'), Buffer.alloc(23));

    const externalFile = join(rootText, 'large-outside-file');
    const externalDirectory = join(rootText, 'large-outside-directory');
    await writeFile(externalFile, Buffer.alloc(4096));
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, 'large'), Buffer.alloc(8192));
    const dependencyLink = join(arenaRoot, 'npm-workspace/node_modules/.bin/runner');
    const externalLink = join(arenaRoot, 'external-directory');
    const runLink = join(runsRoot, 'linked-run');
    await symlink(externalFile, dependencyLink);
    await symlink(externalDirectory, externalLink, 'dir');
    await symlink(externalDirectory, runLink, 'dir');

    const dependencyLinkBytes = BigInt((await lstat(dependencyLink)).size);
    const externalLinkBytes = BigInt((await lstat(externalLink)).size);
    const runLinkBytes = BigInt((await lstat(runLink)).size);
    const usage = await inspectOwnedResources({ helperPath, ownedRoot: root });

    assert.equal(usage.workBytes,
      7n + 11n + 13n + 17n + 19n + 23n + dependencyLinkBytes + externalLinkBytes + runLinkBytes);
    assert.equal(usage.dependencyBytes, 7n + 11n + dependencyLinkBytes + externalLinkBytes);
    assert.equal(usage.runCount, 2);
    assert.equal(typeof usage.freeBytes, 'bigint');
    assert.equal(usage.freeBytes > 0n, true);
  });
});

test('reports zero owned usage when the optional arena root is missing', async () => {
  await withOwnedRoot(async (root) => {
    const usage = await inspectOwnedResources({ helperPath, ownedRoot: root });
    assert.equal(usage.workBytes, 0n);
    assert.equal(usage.dependencyBytes, 0n);
    assert.equal(usage.runCount, 0);
    assert.equal(usage.freeBytes > 0n, true);
  });
});

test('fails the owned resource scan when its depth or byte bound is exceeded', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const arenaRoot = join(rootText, '.work/arena');
    const nestedPath = Array.from({ length: 65 }, (_, index) => `depth-${index}`).join('/');
    await mkdir(join(arenaRoot, nestedPath), { recursive: true });
    await assert.rejects(inspectOwnedResources({ helperPath, ownedRoot: root }), nativeFailure('too_large'));
  });

  await withOwnedRoot(async (root, rootText) => {
    const arenaRoot = join(rootText, '.work/arena');
    await mkdir(arenaRoot, { recursive: true });
    const sparsePath = join(arenaRoot, 'sparse-overflow.bin');
    await writeFile(sparsePath, Buffer.alloc(0));
    await truncate(sparsePath, 64 * 1024 * 1024 * 1024 + 1);
    await assert.rejects(inspectOwnedResources({ helperPath, ownedRoot: root }), nativeFailure('too_large'));
  });
});

test('rejects a symlink in the fixed work-root path', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const externalDirectory = join(rootText, 'external-work');
    await mkdir(externalDirectory);
    await symlink(externalDirectory, join(rootText, '.work'), 'dir');
    await assert.rejects(inspectOwnedResources({ helperPath, ownedRoot: root }), nativeFailure('symlink_rejected'));
  });
});

test('lists owned runs in ASCII order without modifying the run tree', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runsRoot = join(rootText, '.work/arena/runs');
    const zPath = Buffer.from('.work/arena/runs/run-z');
    const aPath = Buffer.from('.work/arena/runs/run-a');
    const zIdentity = await createRunDirectory({ helperPath, ownedRoot: root, relativePath: zPath });
    const aIdentity = await createRunDirectory({ helperPath, ownedRoot: root, relativePath: aPath });
    const failurePath = join(rootText, '.work/arena/runs/run-a/operational-failure-v1.json');
    const firstTracePath = join(rootText, '.work/arena/runs/run-a/trace-v2-000001.json');
    const terminalTracePath = join(rootText, '.work/arena/runs/run-a/trace-v2-000002.json');
    await writeFile(failurePath, Buffer.from('{"schema":1}'));
    await writeFile(firstTracePath, Buffer.from('first'));
    await writeFile(terminalTracePath, Buffer.from('terminal'));
    const failureTime = (await lstat(failurePath, { bigint: true })).mtimeNs;
    const terminalTraceTime = (await lstat(terminalTracePath, { bigint: true })).mtimeNs;
    const runEntriesBefore = await readdir(runsRoot);
    const aEntriesBefore = await readdir(join(runsRoot, 'run-a'));

    const runs = await listOwnedRuns({ helperPath, ownedRoot: root });

    assert.deepEqual(runs.map((run) => run.runId), ['run-a', 'run-z']);
    assert.deepEqual(runs[0]!.identity, aIdentity);
    assert.deepEqual(runs[1]!.identity, zIdentity);
    assert.equal(runs[0]!.failureArtifactModifiedTimeNs, failureTime);
    assert.equal(runs[0]!.terminalTraceSequence, 2);
    assert.equal(runs[0]!.terminalTraceModifiedTimeNs, terminalTraceTime);
    assert.equal(runs[0]!.modifiedTimeNs >= 0n, true);
    assert.deepEqual(await readdir(runsRoot), runEntriesBefore);
    assert.deepEqual(await readdir(join(runsRoot, 'run-a')), aEntriesBefore);
  });
});

test('creates at most ten immediate owned runs under concurrent creation', async () => {
  await withOwnedRoot(async (root) => {
    for (let index = 0; index < 9; index++) {
      await createRunDirectory({
        helperPath,
        ownedRoot: root,
        relativePath: Buffer.from(`.work/arena/runs/retained-${index}`),
      });
    }
    const results = await Promise.allSettled([
      createRunDirectory({
        helperPath,
        ownedRoot: root,
        relativePath: Buffer.from('.work/arena/runs/concurrent-a'),
      }),
      createRunDirectory({
        helperPath,
        ownedRoot: root,
        relativePath: Buffer.from('.work/arena/runs/concurrent-b'),
      }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failure = results.find((result) => result.status === 'rejected');
    assert.equal(failure?.status, 'rejected');
    if (failure?.status !== 'rejected') throw new Error('one concurrent creation must fail at capacity');
    assert.equal(failure.reason instanceof OwnedFilesError, true);
    assert.equal((failure.reason as OwnedFilesError).category, 'too_large');
    assert.equal((await listOwnedRuns({ helperPath, ownedRoot: root })).length, 10);
  });
});

test('reserves archived run ids while allowing a different fresh id', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const archivedId = 'archived-run-id';
    const archivePath = join(rootText, '.work/arena/traces', archivedId);
    await createOwnedDirectory({
      helperPath,
      ownedRoot: root,
      relativePath: Buffer.from(`.work/arena/traces/${archivedId}`),
    });
    await writeFile(join(archivePath, 'partial-trace.json'),
      Buffer.from('{"partial":true}'));
    await writeFile(join(rootText, '.work/arena/traces', 'file-archive-id'), Buffer.from('partial'));
    await symlink('missing-archive-target', join(rootText, '.work/arena/traces', 'symlink-archive-id'));

    for (const runId of [archivedId, 'file-archive-id', 'symlink-archive-id']) {
      await assert.rejects(createRunDirectory({
        helperPath,
        ownedRoot: root,
        relativePath: Buffer.from(`.work/arena/runs/${runId}`),
      }), nativeFailure('conflict'));
    }
    await assert.rejects(access(join(rootText, '.work/arena/runs')));

    const freshId = 'fresh-run-id';
    await createRunDirectory({
      helperPath,
      ownedRoot: root,
      relativePath: Buffer.from(`.work/arena/runs/${freshId}`),
    });
    assert.deepEqual(await readdir(join(rootText, '.work/arena/runs')), [freshId]);
  });
});

test('removes only the leased run tree and unlinks nested symlinks without following them', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runId = 'remove-nested-link';
    const runPath = Buffer.from(`.work/arena/runs/${runId}`);
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const externalDirectory = join(rootText, 'external');
    const nestedDirectory = join(rootText, '.work/arena/runs', runId, 'nested');
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, 'keep.txt'), Buffer.from('outside the run'));
    await mkdir(nestedDirectory);
    await writeFile(join(nestedDirectory, 'remove.txt'), Buffer.from('inside the run'));
    const linkPath = join(nestedDirectory, 'external-link');
    await symlink(externalDirectory, linkPath, 'dir');
    const run = (await listOwnedRuns({ helperPath, ownedRoot: root }))[0]!;
    const lease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: runPath });

    await removeOwnedRun({ helperPath, ownedRoot: root, runId, identity: run.identity, lease });
    await lease.release();

    await assert.rejects(access(join(rootText, '.work/arena/runs', runId)));
    await assert.rejects(lstat(linkPath));
    assert.deepEqual(await readFile(join(externalDirectory, 'keep.txt')), Buffer.from('outside the run'));
  });
});

test('asserts that a held lease matches the owned run identity', async () => {
  await withOwnedRoot(async (root) => {
    const runId = 'lease-identity-check';
    const runPath = Buffer.from(`.work/arena/runs/${runId}`);
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const run = (await listOwnedRuns({ helperPath, ownedRoot: root }))[0]!;
    const lease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: runPath });
    try {
      assert.doesNotThrow(() => assertOwnedRunLeaseMatches({
        lease, ownedRoot: root, runId, identity: run.identity,
      }));
      assert.throws(() => assertOwnedRunLeaseMatches({
        lease, ownedRoot: root, runId, identity: { device: '0', inode: '0' },
      }), nativeFailure('conflict'));
      assert.throws(() => assertOwnedRunLeaseMatches({
        lease, ownedRoot: Buffer.from(`${root.toString()}/other-root`), runId, identity: run.identity,
      }), nativeFailure('conflict'));

      await lease.release();
      assert.throws(() => assertOwnedRunLeaseMatches({
        lease, ownedRoot: root, runId, identity: run.identity,
      }), nativeFailure('conflict'));
    } finally {
      await lease.release();
    }
  });
});

test('rejects run removal for swapped names, forged leases, released leases, or mismatched identity', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runId = 'remove-swap-check';
    const runPath = Buffer.from(`.work/arena/runs/${runId}`);
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const run = (await listOwnedRuns({ helperPath, ownedRoot: root }))[0]!;
    const lease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: runPath });
    const otherRunPath = Buffer.from('.work/arena/runs/remove-other');
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: otherRunPath });
    const otherLease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: otherRunPath });
    const forgedLease = {
      identity: lease.identity,
      closed: Promise.resolve({ kind: 'released' as const }),
      release: async () => {},
    } as OwnedRunLease;
    try {
      await assert.rejects(removeOwnedRun({
        helperPath, ownedRoot: root, runId, identity: run.identity, lease: forgedLease,
      }), nativeFailure('conflict'));
      await assert.rejects(removeOwnedRun({
        helperPath,
        ownedRoot: root,
        runId,
        identity: otherLease.identity,
        lease,
      }), nativeFailure('conflict'));
      await assert.rejects(removeOwnedRun({
        helperPath,
        ownedRoot: root,
        runId,
        identity: run.identity,
        lease: otherLease,
      }), nativeFailure('conflict'));

      const externalDirectory = join(rootText, 'external-swap-target');
      await mkdir(externalDirectory);
      await writeFile(join(externalDirectory, 'keep.txt'), Buffer.from('must survive'));
      const runDirectory = join(rootText, '.work/arena/runs', runId);
      await rename(runDirectory, join(rootText, 'moved-run'));
      await symlink(externalDirectory, runDirectory, 'dir');
      await assert.rejects(removeOwnedRun({
        helperPath, ownedRoot: root, runId, identity: run.identity, lease,
      }), nativeFailure('symlink_rejected'));
      assert.deepEqual(await readFile(join(externalDirectory, 'keep.txt')), Buffer.from('must survive'));

      await lease.release();
      await assert.rejects(removeOwnedRun({
        helperPath, ownedRoot: root, runId, identity: run.identity, lease,
      }), nativeFailure('conflict'));
    } finally {
      await Promise.all([lease.release(), otherLease.release()]);
    }
  });
});

test('creates a fresh run, stages without overwrite, reads, and removes by identity', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runPath = Buffer.from('runs/session-one');
    const runIdentity = await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const planPath = Buffer.from('runs/session-one/world-plan.json');
    const contents = Buffer.from('{"schema":1,"seed":4}');
    const planIdentity = await stageWorldPlan({
      helperPath, ownedRoot: root, destinationRelativePath: planPath, contents, maxBytes: 1024,
    });

    const read = await readOwnedFileWithIdentity({
      helperPath, ownedRoot: root, relativePath: planPath, maxBytes: 1024,
    });
    assert.deepEqual(read.contents, contents);
    assert.deepEqual(read.identity, planIdentity);
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

test('preserves a replacement installed at a file leaf during identity removal', async () => {
  await withOwnedRoot(async (root, rootText) => {
    if (process.env.ARENA_FS_RACE_HELPER === undefined) {
      const build = spawnSync('make', ['-C', join(repoRoot, 'native/arena-fs'), 'race-helper'], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: join(repoRoot, '.work/tmp') },
      });
      assert.equal(build.status, 0, build.stderr);
    }

    const parentPath = Buffer.from('run');
    const targetPath = Buffer.from('run/owned.txt');
    const backupPath = join(rootText, 'run/original-moved-by-mutator');
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: parentPath });
    const identity = await stageOwnedFile({
      helperPath, ownedRoot: root, relativePath: targetPath,
      contents: Buffer.from('identity-owned file'), maxBytes: 128,
    });
    const unlinkResult = spawnSync(unlinkRaceHelperPath, [
      'unlink-created-file', root.toString('base64'), targetPath.toString('base64'),
      identity.device, identity.inode,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ARENA_TEST_UNLINK_LEAF: 'owned.txt',
        ARENA_TEST_UNLINK_BACKUP: 'original-moved-by-mutator',
      },
    });
    assert.equal(unlinkResult.status, 0, unlinkResult.stderr);
    assert.deepEqual(await readFile(join(rootText, 'run/owned.txt')), Buffer.from('replacement survives'));
    await assert.rejects(access(backupPath));
  });
});

test('stages runtime files, creates private plugin directories, and locks a run exclusively', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const runPath = Buffer.from('server/run');
    const runIdentity = await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const pluginDirectory = Buffer.from('server/plugins');
    const pluginDirectoryIdentity = await createOwnedDirectory({
      helperPath, ownedRoot: root, relativePath: pluginDirectory,
    });
    assert.equal((await lstat(join(rootText, 'server/plugins'))).mode & 0o777, 0o700);
    assert.equal(pluginDirectoryIdentity.inode.length > 0, true);

    const configPath = Buffer.from('server/run/server.properties');
    const config = Buffer.from('server-port=25565\n');
    const configIdentity = await stageOwnedFile({
      helperPath, ownedRoot: root, relativePath: configPath, contents: config, maxBytes: 128,
    });
    const eulaPath = Buffer.from('server/run/eula.txt');
    const eulaIdentity = await stageOwnedFile({
      helperPath, ownedRoot: root, relativePath: eulaPath,
      contents: Buffer.from('eula=true\n'), maxBytes: 32,
    });
    const pluginPath = Buffer.from('server/plugins/ArenaFoundation.jar');
    const pluginBytes = Buffer.alloc(1024, 0x4a);
    const pluginIdentity = await stageOwnedFile({
      helperPath, ownedRoot: root, relativePath: pluginPath,
      contents: pluginBytes, maxBytes: MAX_OWNED_FILE_BYTES,
    });
    assert.deepEqual(await readOwnedFile({
      helperPath, ownedRoot: root, relativePath: configPath, maxBytes: 128,
    }), config);
    assert.deepEqual(await readOwnedFile({
      helperPath, ownedRoot: root, relativePath: eulaPath, maxBytes: 32,
    }), Buffer.from('eula=true\n'));
    assert.deepEqual(await readOwnedFile({
      helperPath, ownedRoot: root, relativePath: pluginPath, maxBytes: 2048,
    }), pluginBytes);
    await assert.rejects(stageOwnedFile({
      helperPath, ownedRoot: root, relativePath: configPath,
      contents: Buffer.from('replacement'), maxBytes: 128,
    }), nativeFailure('conflict', configPath));

    const lease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: runPath });
    assert.equal(lease.identity.inode.length > 0, true);
    await assert.rejects(acquireOwnedRunLease({
      helperPath, ownedRoot: root, relativePath: runPath,
    }), nativeFailure('conflict', runPath));
    await lease.release();
    assert.deepEqual(await lease.closed, { kind: 'released' });
    const nextLease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: runPath });
    await nextLease.release();

    await removeCreatedFile({ helperPath, ownedRoot: root, relativePath: configPath, identity: configIdentity });
    await removeCreatedFile({ helperPath, ownedRoot: root, relativePath: eulaPath, identity: eulaIdentity });
    await removeCreatedFile({ helperPath, ownedRoot: root, relativePath: pluginPath, identity: pluginIdentity });
    await removeCreatedDirectory({
      helperPath, ownedRoot: root, relativePath: pluginDirectory, identity: pluginDirectoryIdentity,
    });
    assert.deepEqual(await readFile(join(rootText, 'server/run/.arena-run.lock')), Buffer.alloc(0));
    assert.equal(runIdentity.inode.length > 0, true);
  });
});

test('does not publish a replacement swapped into a staged temporary name', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const parentPath = Buffer.from('server/run');
    const destinationPath = Buffer.from('server/run/server.properties');
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: parentPath });
    const replacementPath = join(rootText, 'replacement');
    await writeFile(replacementPath, Buffer.from('attacker replacement'));

    const child = spawn(helperPath, [
      'stage-owned-file', root.toString('base64'), destinationPath.toString('base64'), '1024',
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = Buffer.alloc(0);
    let firstLineResolve!: (line: Buffer) => void;
    const firstLine = new Promise<Buffer>((resolveLine) => { firstLineResolve = resolveLine; });
    let firstLineSeen = false;
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      const newline = output.indexOf(0x0a);
      if (!firstLineSeen && newline >= 0) {
        firstLineSeen = true;
        firstLineResolve(Buffer.from(output.subarray(0, newline)));
      }
    });
    child.stderr.resume();
    const closed = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('close', (exitCode, exitSignal) => resolveClose({ exitCode, exitSignal }));
    });

    const event = JSON.parse((await firstLine).toString('ascii')) as { event: string; path: string };
    assert.equal(event.event, 'staged-file');
    const temporaryPath = join(rootText, Buffer.from(event.path, 'base64').toString('utf8'));
    await unlink(temporaryPath);
    await symlink(replacementPath, temporaryPath);
    child.stdin.end(Buffer.from('expected staged contents'));

    const { exitCode, exitSignal } = await closed;
    assert.equal(exitSignal, null);
    assert.equal(exitCode, 1);
    const records = output.toString('ascii').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.at(-1).ok, false);
    await assert.rejects(access(join(rootText, 'server/run/server.properties')));
    assert.equal(await readlink(temporaryPath), replacementPath);
    assert.deepEqual(await readFile(replacementPath), Buffer.from('attacker replacement'));
  });
});

test('does not publish a replacement swapped into a clone staging name', async () => {
  await withOwnedRoot(async (root, rootText) => {
    if (process.env.ARENA_FS_CLONE_RACE_HELPER === undefined) {
      const build = spawnSync('make', ['-C', join(repoRoot, 'native/arena-fs'), 'clone-race-helper'], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: join(repoRoot, '.work/tmp') },
      });
      assert.equal(build.status, 0, build.stderr);
    }
    const sourcePath = Buffer.from('snapshot/world');
    const destinationParent = Buffer.from('runs/session');
    const destinationPath = Buffer.from('runs/session/world');
    await mkdir(join(rootText, 'snapshot/world'), { recursive: true });
    await writeFile(join(rootText, 'snapshot/world/level.dat'), Buffer.from('pristine'));
    await createOwnedDirectory({ helperPath, ownedRoot: root, relativePath: destinationParent });
    const child = spawn(cloneRaceHelperPath, [
      'clone-owned-tree', root.toString('base64'), sourcePath.toString('base64'),
      destinationPath.toString('base64'), String(MAX_OWNED_TREE_FILES), String(MAX_OWNED_TREE_BYTES),
    ], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ARENA_TEST_CLONE_PARENT: join(rootText, 'runs/session') },
    });
    let output = Buffer.alloc(0);
    let firstLineResolve!: (line: Buffer) => void;
    const firstLine = new Promise<Buffer>((resolveLine) => { firstLineResolve = resolveLine; });
    let firstLineSeen = false;
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      const newline = output.indexOf(0x0a);
      if (!firstLineSeen && newline >= 0) {
        firstLineSeen = true;
        firstLineResolve(Buffer.from(output.subarray(0, newline)));
      }
    });
    child.stderr.resume();
    const closed = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('close', (exitCode, exitSignal) => resolveClose({ exitCode, exitSignal }));
    });

    const event = JSON.parse((await firstLine).toString('ascii')) as { event: string; path: string };
    assert.equal(event.event, 'created-directory');
    const temporaryPath = join(rootText, Buffer.from(event.path, 'base64').toString('utf8'));
    child.stdin.end();

    const { exitCode, exitSignal } = await closed;
    assert.equal(exitSignal, null);
    assert.equal(exitCode, 1);
    const records = output.toString('ascii').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.at(-1).ok, false);
    assert.equal(records.some((record) => record.event === 'clone-published'), false);
    await assert.rejects(access(join(rootText, 'runs/session/world')));
    await rm(`${temporaryPath}.displaced`, { recursive: true, force: true });
    const sentinel = await readFile(join(temporaryPath, 'attacker-sentinel')).catch(() => undefined);
    assert.deepEqual(sentinel, Buffer.from('replacement directory'), output.toString('ascii'));
  });
});

test('releases a run lease when its owning process exits', async () => {
  await withOwnedRoot(async (root) => {
    const runPath = Buffer.from('server/run');
    await createRunDirectory({ helperPath, ownedRoot: root, relativePath: runPath });
    const moduleUrl = new URL('../src/owned-files/index.js', import.meta.url).href;
    const childCode = [
      `import { acquireOwnedRunLease } from ${JSON.stringify(moduleUrl)};`,
      `await acquireOwnedRunLease({ helperPath: ${JSON.stringify(helperPath)}, ` +
        `ownedRoot: Buffer.from(${JSON.stringify(root.toString('base64'))}, 'base64'), ` +
        `relativePath: Buffer.from('server/run') });`,
      "process.stdout.write('lease-held\\n');",
    ].join('\n');
    const owner = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: repoRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    let output = Buffer.alloc(0);
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readySignal = new Promise<void>((resolveReadySignal, rejectReadySignal) => {
      resolveReady = resolveReadySignal;
      rejectReady = rejectReadySignal;
    });
    const closed = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolveClose) => {
      owner.once('close', (exitCode, exitSignal) => {
        resolveClose({ exitCode, exitSignal });
        if (!ready) rejectReady(new Error('lease owner exited before acquiring the lease'));
      });
    });
    owner.once('error', rejectReady);
    owner.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (!output.includes(0x0a)) return;
      ready = true;
      resolveReady();
    });

    try {
      await readySignal;
      assert.equal(output.toString('utf8').trim(), 'lease-held');
      owner.kill('SIGKILL');
      const ownerExit = await closed;
      assert.equal(ownerExit.exitSignal, 'SIGKILL');

      let lease: Awaited<ReturnType<typeof acquireOwnedRunLease>> | undefined;
      for (let attempt = 0; attempt < 32 && lease === undefined; attempt++) {
        try {
          lease = await acquireOwnedRunLease({ helperPath, ownedRoot: root, relativePath: runPath });
        } catch (error) {
          if (!(error instanceof OwnedFilesError) || error.category !== 'conflict') throw error;
          await nextTurn();
        }
      }
      assert.ok(lease, 'the owner process closing its pipe must release the run lock');
      await lease.release();
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await closed;
    }
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

test('copies a stopped tree into a fresh directory without carrying source hard links', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const sourcePath = Buffer.from('pristine/world');
    await mkdir(join(rootText, 'pristine/world/region'), { recursive: true });
    const sourceFile = join(rootText, 'pristine/world/level.dat');
    const aliasFile = join(rootText, 'pristine/world/level-copy.dat');
    const regionFile = join(rootText, 'pristine/world/region/chunk.dat');
    const levelBytes = Buffer.from([0, 0x41, 0xff, 0x7f]);
    await writeFile(sourceFile, levelBytes);
    await linkFile(sourceFile, aliasFile);
    await writeFile(regionFile, Buffer.from('chunk data'));

    const targetParent = Buffer.from('runs/session');
    await createOwnedDirectory({ helperPath, ownedRoot: root, relativePath: targetParent });
    const destinationPath = Buffer.from('runs/session/world');
    const identity = await cloneOwnedTree({
      helperPath, ownedRoot: root, sourceRelativePath: sourcePath,
      destinationRelativePath: destinationPath,
      maxFiles: MAX_OWNED_TREE_FILES, maxBytes: MAX_OWNED_TREE_BYTES,
    });
    const destinationRoot = join(rootText, 'runs/session/world');
    const destinationStatus = await lstat(destinationRoot);
    assert.equal(String(destinationStatus.dev), identity.device);
    assert.equal(String(destinationStatus.ino), identity.inode);
    assert.deepEqual(await readFile(join(destinationRoot, 'level.dat')), levelBytes);
    assert.deepEqual(await readFile(join(destinationRoot, 'region/chunk.dat')), Buffer.from('chunk data'));

    const firstCopy = await lstat(join(destinationRoot, 'level.dat'));
    const secondCopy = await lstat(join(destinationRoot, 'level-copy.dat'));
    const original = await lstat(sourceFile);
    assert.equal(firstCopy.nlink, 1);
    assert.equal(secondCopy.nlink, 1);
    assert.notEqual(firstCopy.ino, secondCopy.ino);
    assert.notEqual(firstCopy.ino, original.ino);

    await assert.rejects(cloneOwnedTree({
      helperPath, ownedRoot: root, sourceRelativePath: sourcePath,
      destinationRelativePath: destinationPath,
      maxFiles: MAX_OWNED_TREE_FILES, maxBytes: MAX_OWNED_TREE_BYTES,
    }), nativeFailure('conflict', destinationPath, sourcePath));
  });
});

test('rejects symlinks and over-limit trees without publishing a clone', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const sourcePath = Buffer.from('snapshot/world');
    const destinationParent = Buffer.from('runs/session');
    const symlinkDestination = Buffer.from('runs/session/symlink-copy');
    const fileLimitDestination = Buffer.from('runs/session/file-limit-copy');
    const limitedDestination = Buffer.from('runs/session/limited-copy');
    await mkdir(join(rootText, 'snapshot/world'), { recursive: true });
    await createOwnedDirectory({ helperPath, ownedRoot: root, relativePath: destinationParent });
    await writeFile(join(rootText, 'snapshot/world/large.dat'), Buffer.from('five!'));
    await symlink(join(rootText, 'outside'), join(rootText, 'snapshot/world/linked'));

    await assert.rejects(cloneOwnedTree({
      helperPath, ownedRoot: root, sourceRelativePath: sourcePath,
      destinationRelativePath: symlinkDestination, maxFiles: 4, maxBytes: 128,
    }), nativeFailure('symlink_rejected', symlinkDestination, sourcePath));
    await assert.rejects(access(join(rootText, 'runs/session/symlink-copy')));

    await unlink(join(rootText, 'snapshot/world/linked'));
    await assert.rejects(cloneOwnedTree({
      helperPath, ownedRoot: root, sourceRelativePath: sourcePath,
      destinationRelativePath: fileLimitDestination, maxFiles: 0, maxBytes: 128,
    }), nativeFailure('too_large', fileLimitDestination, sourcePath));
    await assert.rejects(access(join(rootText, 'runs/session/file-limit-copy')));
    await assert.rejects(cloneOwnedTree({
      helperPath, ownedRoot: root, sourceRelativePath: sourcePath,
      destinationRelativePath: limitedDestination, maxFiles: 4, maxBytes: 4,
    }), (error: unknown) => error instanceof OwnedFilesError && error.category === 'too_large' &&
      error.relativePath?.equals(limitedDestination) === true &&
      error.sourceRelativePath?.equals(sourcePath) === true && error.clonePublication === 'absent');
    await assert.rejects(access(join(rootText, 'runs/session/limited-copy')));
    await assert.rejects(cloneOwnedTree({
      helperPath, ownedRoot: root, sourceRelativePath: sourcePath,
      destinationRelativePath: Buffer.from('snapshot/world/copy'), maxFiles: 4, maxBytes: 128,
    }), nativeFailure('invalid_path', Buffer.from('snapshot/world/copy'), sourcePath));
    assert.deepEqual(await readdir(join(rootText, 'runs/session')), []);
  });
});

test('a signalled clone removes its identity-owned staging directory before publication', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const sourcePath = Buffer.from('snapshot/world');
    const destinationParent = Buffer.from('runs/session');
    const destinationPath = Buffer.from('runs/session/world');
    await mkdir(join(rootText, 'snapshot/world'), { recursive: true });
    await createOwnedDirectory({ helperPath, ownedRoot: root, relativePath: destinationParent });
    const child = spawn(helperPath, [
      'clone-owned-tree', root.toString('base64'), sourcePath.toString('base64'),
      destinationPath.toString('base64'), String(MAX_OWNED_TREE_FILES), String(MAX_OWNED_TREE_BYTES),
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = Buffer.alloc(0);
    let signalled = false;
    const closed = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('close', (exitCode, exitSignal) => resolveClose({ exitCode, exitSignal }));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (signalled) return;
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      const first = JSON.parse(output.subarray(0, newline).toString('ascii')) as { event?: string };
      if (first.event === 'created-directory') {
        signalled = true;
        child.kill('SIGTERM');
      }
    });
    const { exitCode, exitSignal } = await closed;
    child.stdin.destroy();
    assert.equal(signalled, true);
    assert.equal(exitCode, 1);
    assert.equal(exitSignal, null);
    const records = output.toString('ascii').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records[0].event, 'created-directory');
    assert.equal(records.at(-1).category, 'cancelled');
    await assert.rejects(access(join(rootText, 'runs/session/world')));
    assert.deepEqual(await readdir(join(rootText, 'runs/session')), []);
  });
});

test('a clone cancelled before helper startup reports no publication', async () => {
  await withOwnedRoot(async (root, rootText) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(cloneOwnedTree({
      helperPath,
      ownedRoot: root,
      sourceRelativePath: Buffer.from('snapshot/world'),
      destinationRelativePath: Buffer.from('runs/world'),
      maxFiles: MAX_OWNED_TREE_FILES,
      maxBytes: MAX_OWNED_TREE_BYTES,
      signal: controller.signal,
    }), (error: unknown) => error instanceof OwnedFilesError && error.clonePublication === 'absent');
    await assert.rejects(access(join(rootText, 'runs')));
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
