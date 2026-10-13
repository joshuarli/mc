import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';
import { failureCleanup, mapRuntimeFailure, withCleanupFailure } from '../src/runtime/failures.js';

test('joining the evaluator primary error records successful cleanup', () => {
  const evaluatorError = new Error('expected a ready client state');
  evaluatorError.name = 'AssertionError';
  const primary = mapRuntimeFailure(evaluatorError);

  assert.strictEqual(primary.cause, evaluatorError);
  assert.deepEqual(primary.source, {
    kind: 'AssertionError',
    reason: 'expected a ready client state',
  });
  assert.deepEqual(failureCleanup(evaluatorError, primary), {
    status: 'succeeded',
    source: null,
  });
});

test('a distinct cleanup assertion stays failed when its name and message match', () => {
  const evaluatorError = new Error('expected a ready client state');
  evaluatorError.name = 'AssertionError';
  const primary = mapRuntimeFailure(evaluatorError);
  const cleanupError = new Error(evaluatorError.message);
  cleanupError.name = evaluatorError.name;

  assert.notStrictEqual(cleanupError, evaluatorError);
  assert.deepEqual(failureCleanup(cleanupError, primary), {
    status: 'failed',
    source: {
      kind: 'AssertionError',
      reason: 'expected a ready client state',
    },
  });
});

test('cleanup cause walks terminate when error causes form a cycle', () => {
  const first = new Error('first');
  const second = new Error('second');
  Object.defineProperty(first, 'cause', { value: second });
  Object.defineProperty(second, 'cause', { value: first });

  const primary = mapRuntimeFailure(new Error('unrelated primary'));
  assert.deepEqual(failureCleanup(first, primary), {
    status: 'failed',
    source: { kind: 'Error', reason: 'first' },
  });
});

test('an independent cleanup failure preserves a cancelled primary category', () => {
  const primary = new RunnerError('cancelled', 'arena run', { kind: 'cancelled' });
  const cleanup = new RunnerError('runtime_failure', 'control session', { kind: 'socket_close_failed' });

  const failure = withCleanupFailure(primary, cleanup);

  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.exitCode(), 130);
  assert.equal(failure.cause, primary);
  assert.deepEqual(failure.source, {
    kind: 'cancelled',
    cleanup_kind: 'socket_close_failed',
  });
});
