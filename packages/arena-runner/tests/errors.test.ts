import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';

test('owner conflicts and operator cancellation have distinct process statuses', () => {
  assert.equal(new RunnerError('owner_conflict', 'run lease', { kind: 'owner_conflict' }).exitCode(), 4);
  assert.equal(new RunnerError('cancelled', 'arena run', { kind: 'operator_signal' }).exitCode(), 130);
});

test('runtime failures preserve their primary and cleanup causes', () => {
  const error = new RunnerError('runtime_failure', 'arena run', {
    kind: 'runtime_timeout',
    cleanup_kind: 'server_stop_failed',
    cleanup_os_code: 9,
  });
  assert.equal(error.exitCode(), 6);
  assert.deepEqual(JSON.parse(error.toJson()), {
    error: {
      category: 'runtime_failure',
      resource: 'arena run',
      source: {
        cleanup_kind: 'server_stop_failed',
        cleanup_os_code: 9,
        kind: 'runtime_timeout',
      },
    },
  });
});
