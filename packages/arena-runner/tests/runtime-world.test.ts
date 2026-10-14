import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileScenario } from '@arena/spec';
import { templateWorldPath } from '../src/runtime/world.js';

const repositoryRoot = process.cwd();

test('pristine world templates change when plugin bytes change at the same path', () => {
  const scenarioSource = readFileSync(join(repositoryRoot, 'scenarios/duel.toml'), 'utf8');
  const mapSource = readFileSync(join(repositoryRoot, 'maps/duel.toml'), 'utf8');
  const scenario = compileScenario(scenarioSource, mapSource);
  const artifacts = {
    scenario,
    javaExecutable: '/repo/.work/jdk/bin/java',
    paperJarPath: '/repo/.work/paper.jar',
    pluginJarPath: '/repo/.work/arena-plugin.jar',
  };

  const first = templateWorldPath({ ...artifacts, pluginJarBytes: Buffer.from('plugin-v1') });
  const same = templateWorldPath({ ...artifacts, pluginJarBytes: Buffer.from('plugin-v1') });
  const rebuilt = templateWorldPath({ ...artifacts, pluginJarBytes: Buffer.from('plugin-v2') });

  assert.deepEqual(first, same);
  assert.notDeepEqual(first, rebuilt);
});
