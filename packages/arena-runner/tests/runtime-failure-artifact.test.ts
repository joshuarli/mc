import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RunnerError } from '../src/errors.js';
import { createRunDirectory } from '../src/owned-files/index.js';
import { readOperationalFailureArtifact } from '../src/runtime/failure-artifact.js';
import { RuntimeTraceBuilder } from '../src/runtime/trace.js';

const repositoryRoot = process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, '.work/arena-fs/arena-fs');
const runId = `runtime-failure-${randomUUID()}`;
const runDirectoryPath = Buffer.from(`.work/arena/runs/${runId}`, 'utf8');

test('runtime failure evidence records the primary error and cleanup result', async (t) => {
  const ownedRoot = await createOwnedRoot(t);
  const trace = new RuntimeTraceBuilder({
    runId,
    helperPath,
    ownedRoot,
    preparedRun: { runId, runDirectoryPath },
  });
  const primary = new RunnerError('runtime_failure', 'Paper server', {
    kind: 'runtime_timeout',
    field: 'cold_start',
  });

  const saved = await trace.persistFailurePartial(
    { category: primary.category, resource: primary.resource, source: primary.source },
    { status: 'failed', source: { kind: 'child_reap_timeout' } },
  );
  const readBack = await readOperationalFailureArtifact({ helperPath, ownedRoot, runId });

  assert.deepEqual(JSON.parse(JSON.stringify(saved.artifact)), JSON.parse(JSON.stringify(readBack)));
  assert.equal(saved.artifactPath.toString('utf8'), `${runDirectoryPath.toString('utf8')}/operational-failure-v1.json`);
  assert.deepEqual(JSON.parse(JSON.stringify(readBack.primary)), {
    category: 'runtime_failure',
    resource: 'Paper server',
    source: { kind: 'runtime_timeout', field: 'cold_start' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(readBack.cleanup)), {
    status: 'failed',
    source: { kind: 'child_reap_timeout' },
  });
  assert.deepEqual(readBack.trace_checkpoint_segments, []);
});

async function createOwnedRoot(t: TestContext): Promise<Buffer> {
  await mkdir(resolve(repositoryRoot, '.work/arena/runs'), { recursive: true });
  await createRunDirectory({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, 'utf8'),
    relativePath: runDirectoryPath,
  });
  t.after(async () => await rm(resolve(repositoryRoot, runDirectoryPath.toString('utf8')), {
    recursive: true,
    force: true,
  }));
  return Buffer.from(repositoryRoot, 'utf8');
}
