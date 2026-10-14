import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compileScenario } from '@arena/spec';
import type { PreparedRun } from '../src/prepare.js';
import { paperArguments, stageServerDirectory, type RuntimeServerInputs } from '../src/runtime/server.js';

const repositoryRoot = process.cwd();

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
  assert.ok(args.includes('-Dterminal.jline=false'));
  assert.ok(args.includes('-Dterminal.ansi=false'));
});

test('natural server staging uses Java signed seed and omits the custom generator file', async () => {
  const plannedScenario = await readFile(join(repositoryRoot, 'scenarios/duel.toml'), 'utf8');
  const plannedMap = await readFile(join(repositoryRoot, 'maps/duel.toml'), 'utf8');
  const naturalScenario = plannedScenario
    .replace('schema = 1', 'schema = 2')
    .replace('seed = 88172645463325252', 'seed = 88172645463325252\nopening_styles = ["explorer", "scavenger", "hunter"]');
  const naturalMap = `
schema = 2
name = "fixture"
terrain = "vanilla"
dimensions = { width = 1024, depth = 1024 }
operations = [
  { kind = "spawn", seat = 0, position = { x = 500, z = 512 } },
  { kind = "spawn", seat = 1, position = { x = 524, z = 512 } },
  { kind = "loot_container", position = { x = 510, z = 511 }, inventory = ["minecraft:apple"] }
]
`;
  const planned = compileScenario(plannedScenario, plannedMap);
  const natural = {
    ...compileScenario(naturalScenario, naturalMap),
    seed: (1n << 64n) - 1n,
  };
  const helperPath = join(repositoryRoot, '.work/arena-fs/arena-fs');
  const ownedRoot = Buffer.from(repositoryRoot, 'utf8');
  const temporaryPath = `.work/tmp/runtime-server-${randomUUID()}`;
  const temporaryDirectory = resolve(repositoryRoot, temporaryPath);
  const serverInputs: RuntimeServerInputs = {
    preparedRun: { runId: 'runtime-server-test' } as PreparedRun,
    helperPath,
    ownedRoot,
    javaExecutable: '/usr/bin/java',
    paperJarPath: '/repo/.work/paper.jar',
    pluginJarPath: '/repo/.work/arena-plugin.jar',
    javaTmpDir: '/repo/.work/tmp',
  };
  const plannedRelativePath = Buffer.from(`${temporaryPath}/planned/server`, 'utf8');
  const naturalRelativePath = Buffer.from(`${temporaryPath}/natural/server`, 'utf8');
  await mkdir(resolve(repositoryRoot, plannedRelativePath.toString('utf8')), { recursive: true });
  await mkdir(resolve(repositoryRoot, naturalRelativePath.toString('utf8')), { recursive: true });
  try {
    await stageServerDirectory({
      inputs: serverInputs,
      scenario: planned,
      relativePath: plannedRelativePath,
      pluginBytes: Buffer.from('planned plugin'),
    });
    await stageServerDirectory({
      inputs: serverInputs,
      scenario: natural,
      relativePath: naturalRelativePath,
      pluginBytes: Buffer.from('natural plugin'),
    });
    const plannedProperties = await readFile(resolve(repositoryRoot, plannedRelativePath.toString('utf8'), 'server.properties'));
    const naturalProperties = await readFile(resolve(repositoryRoot, naturalRelativePath.toString('utf8'), 'server.properties'));
    assert.equal(plannedProperties.includes(Buffer.from('level-seed=', 'ascii')), false);
    assert.equal(naturalProperties.includes(Buffer.from('level-seed=-1\n', 'ascii')), true);
    assert.equal(existsSync(resolve(repositoryRoot, plannedRelativePath.toString('utf8'), 'bukkit.yml')), true);
    assert.equal(existsSync(resolve(repositoryRoot, naturalRelativePath.toString('utf8'), 'bukkit.yml')), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
