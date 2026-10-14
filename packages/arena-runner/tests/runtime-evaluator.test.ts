import assert from 'node:assert/strict';
import test from 'node:test';
import { joinEvaluatorAfterOutcome } from '../src/runtime/evaluator.js';

test('evaluator can finish outcome assertions before its signal is aborted', async () => {
  const controller = new AbortController();
  let resolveOutcome!: () => void;
  const outcome = new Promise<void>((resolve) => { resolveOutcome = resolve; });
  let assertionsFinished = false;
  const evaluatorTask = (async () => {
    await outcome;
    await Promise.resolve();
    assert.equal(controller.signal.aborted, false);
    assertionsFinished = true;
  })();

  const joining = joinEvaluatorAfterOutcome({
    task: evaluatorTask,
    abort: controller,
    timeoutMs: 1_000,
    failures: [],
  });
  resolveOutcome();
  await joining;

  assert.equal(assertionsFinished, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal((controller.signal.reason as Error).message, 'match outcome received');
});

test('evaluator assertions after outcome remain the initiating failure', async () => {
  const controller = new AbortController();
  let resolveOutcome!: () => void;
  const outcome = new Promise<void>((resolve) => { resolveOutcome = resolve; });
  const assertion = new Error('expected the eliminated seat to remain spectator');
  const evaluatorTask = (async () => {
    await outcome;
    throw assertion;
  })();

  const joining = joinEvaluatorAfterOutcome({
    task: evaluatorTask,
    abort: controller,
    timeoutMs: 1_000,
    failures: [],
  });
  resolveOutcome();

  await assert.rejects(joining, (error: unknown) => error === assertion);
  assert.equal(controller.signal.reason, assertion);
});
