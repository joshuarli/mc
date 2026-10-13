import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  boundedErrorReason,
  MAX_ERROR_REASON_CODE_POINTS,
  RunnerError,
} from '../src/errors.js';
import { createRunDirectory } from '../src/owned-files/index.js';
import {
  parseOperationalFailureArtifact,
  readOperationalFailureArtifact,
} from '../src/runtime/failure-artifact.js';
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
  const evaluatorError = Object.assign(new Error('expected a ready client state'), {
    causeOnlySentinel: 'must not enter failure JSON',
  });
  const primary = new RunnerError('runtime_failure', 'Paper server', {
    kind: 'AssertionError',
    reason: boundedErrorReason(evaluatorError)!,
  }, {
    cause: evaluatorError,
  });
  const runnerErrorJson = JSON.parse(primary.toJson());
  assert.strictEqual(primary.cause, evaluatorError);
  assert.equal(Object.hasOwn(runnerErrorJson.error, 'cause'), false);
  assert.equal(JSON.stringify(runnerErrorJson).includes('causeOnlySentinel'), false);

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
    source: { kind: 'AssertionError', reason: 'expected a ready client state' },
  });
  assert.equal(JSON.stringify(readBack).includes('causeOnlySentinel'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(readBack.cleanup)), {
    status: 'failed',
    source: { kind: 'child_reap_timeout' },
  });
  assert.deepEqual(readBack.trace_checkpoint_segments, []);
});

test('failure artifact error reasons are capped by Unicode code point', () => {
  const oversizedMessage = '😀'.repeat(MAX_ERROR_REASON_CODE_POINTS + 1);
  const boundedReason = boundedErrorReason(new Error(oversizedMessage));
  assert.equal(boundedReason, '😀'.repeat(MAX_ERROR_REASON_CODE_POINTS));
  assert.throws(() => new RunnerError('runtime_failure', 'evaluator', {
    kind: 'AssertionError',
    reason: oversizedMessage,
  }), RangeError);

  assert.throws(() => parseOperationalFailureArtifact(JSON.stringify({
    schema: 1,
    run_id: runId,
    primary: {
      category: 'runtime_failure',
      resource: 'evaluator',
      source: { kind: 'AssertionError', reason: oversizedMessage },
    },
    cleanup: { status: 'succeeded', source: null },
    trace_checkpoint_segments: [],
  }), runId), (error: unknown) => error instanceof RunnerError
    && error.category === 'corrupt_evidence'
    && error.source.kind === 'invalid_operational_failure_artifact'
    && error.source.field === 'invalid_source');
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
