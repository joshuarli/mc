import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { compileScenario } from '@arena/spec';
import { runPreparedRun, type RunPreparedRunOptions } from '../src/runtime/run.js';
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


for (const [scenarioName, wallClockMs] of [['duel', 600_000], ['civilization-six', 1_200_000]] as const) {
  test(`runtime run wires the ${scenarioName} wall deadline before preparation and clears it on cancellation`, async (t) => {
    const scenario = compileScenario(readFileSync(`scenarios/${scenarioName}.toml`, 'utf8'),
      readFileSync(`maps/${scenarioName}.toml`, 'utf8'));
    const parent = new AbortController();
    parent.abort();
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const identity = { device: '1', inode: '1' };
    const options: RunPreparedRunOptions = {
      preparedRun: { runId: 'wall-deadline-test', scenario,
        scenarioPath: Buffer.from(`scenarios/${scenarioName}.toml`),
        runDirectoryPath: Buffer.from('.work/arena/runs/wall-deadline-test'),
        worldPlanPath: Buffer.from('.work/arena/runs/wall-deadline-test/world-plan.json'),
        runDirectoryIdentity: identity, worldPlanIdentity: identity,
      },
      helperPath: '.work/arena-fs/arena-fs', ownedRoot: Buffer.from(process.cwd()),
      javaExecutable: 'java', paperJarPath: '.work/paper.jar', pluginJarPath: '.work/plugin.jar',
      acceptMinecraftEula: true, signal: parent.signal,
    };
    await assert.rejects(runPreparedRun(options), (error: unknown) => error instanceof RunnerError
      && error.category === 'cancelled' && error.source.kind === 'cancelled');
    assert.deepEqual(scheduled.mock.calls.map((call) => call.arguments[1]), [180_000, wallClockMs]);
    assert.equal(cleared.mock.calls.length, 2);
    for (const call of scheduled.mock.calls) {
      assert.ok(cleared.mock.calls.some((clear) => clear.arguments[0] === call.result));
    }
    scheduled.mock.resetCalls();
    cleared.mock.resetCalls();
    const timedOut = new AbortController();
    const timeout = new RunnerError('runtime_failure', 'arena run', { kind: 'runtime_timeout', field: 'wall_clock' });
    timedOut.abort(timeout);
    await assert.rejects(runPreparedRun({ ...options, signal: timedOut.signal }), (error: unknown) => error === timeout);
    assert.deepEqual(scheduled.mock.calls.map((call) => call.arguments[1]), [180_000, wallClockMs]);
    assert.equal(cleared.mock.calls.length, 2);
  });
}

test('wall deadline expires at its configured duration with the operational timeout reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const deadline = armRuntimeDeadline(controller, 'wall_clock', 1_200_000);
  t.mock.timers.tick(1_199_999);
  assert.equal(controller.signal.aborted, false);
  assert.equal(deadline.error, undefined);
  t.mock.timers.tick(1);
  await assert.rejects(deadline.failure, (error: unknown) => error instanceof RunnerError
    && error.category === 'runtime_failure' && error.source.kind === 'runtime_timeout'
    && error.source.field === 'wall_clock');
  assert.equal(controller.signal.reason, deadline.error);
  deadline.clear();
});
