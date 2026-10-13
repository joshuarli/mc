import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedRun } from '../src/prepare.js';
import { paperArguments, type RuntimeServerInputs } from '../src/runtime/server.js';

test('Paper starts with the required bounded heap', () => {
  const inputs: RuntimeServerInputs = {
    preparedRun: {
      runId: 'runtime-server-test',
      worldPlanPath: Buffer.from('runs/runtime-server-test/world-plan.json', 'ascii'),
    } as PreparedRun,
    helperPath: '/repo/.work/arena-fs/arena-fs',
    ownedRoot: Buffer.from('/repo', 'utf8'),
    javaExecutable: '/usr/bin/java',
    paperJarPath: '/repo/.work/paper.jar',
    pluginJarPath: '/repo/.work/arena-plugin.jar',
    javaTmpDir: '/repo/.work/tmp',
  };

  const args = paperArguments(inputs, 43_217, inputs.preparedRun.runId);
  assert.deepEqual(args.slice(0, 2), ['-Xms512m', '-Xmx2g']);
});
