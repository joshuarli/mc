import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';
import { armRuntimeDeadline } from '../src/runtime/deadline.js';

test('runtime deadline aborts with a structured timeout reason', async () => {
  const controller = new AbortController();
  const deadline = armRuntimeDeadline(controller, 'cold_start', 5);

  await assert.rejects(deadline.failure, (error: unknown) => error instanceof RunnerError
    && error.category === 'runtime_failure'
    && error.source.kind === 'runtime_timeout'
    && error.source.field === 'cold_start');
  assert.equal(controller.signal.aborted, true);
  assert.ok(deadline.error instanceof RunnerError);
  deadline.clear();
});
