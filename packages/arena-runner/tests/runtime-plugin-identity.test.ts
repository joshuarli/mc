import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { decodeControlFrame, encodeControlFrame } from '../src/control/index.js';
import { RunnerError } from '../src/errors.js';
import {
  assertRuntimePluginIdentity,
  parseRuntimePluginIdentity,
} from '../src/runtime/plugin-identity.js';

const RUN_ID = 'runtime-plugin-identity-test';
const PLUGIN_DESCRIPTOR = 'server/arena-plugin/src/main/resources/plugin.yml';

test('runtime rejects a ready message with a plugin identity different from the shipped descriptor', () => {
  const identity = parseRuntimePluginIdentity(readFileSync(join(process.cwd(), PLUGIN_DESCRIPTOR), 'utf8'));
  const ready = readyMessage({
    name: `Other${identity.name}`,
    version: identity.version,
  });

  assert.throws(
    () => assertRuntimePluginIdentity(ready, identity),
    (error: unknown) => error instanceof RunnerError
      && error.category === 'runtime_failure'
      && error.source.kind === 'plugin_identity_mismatch'
      && error.source.field === 'name',
  );

  assert.throws(
    () => assertRuntimePluginIdentity(readyMessage({ name: identity.name, version: `0.${identity.version}` }), identity),
    (error: unknown) => error instanceof RunnerError
      && error.source.kind === 'plugin_identity_mismatch'
      && error.source.field === 'version',
  );
});

test('runtime plugin descriptor requires exactly one supported name and version', () => {
  assert.throws(() => parseRuntimePluginIdentity('name: ArenaFoundation\n'), /plugin_descriptor_invalid/);
  assert.throws(() => parseRuntimePluginIdentity(
    'name: ArenaFoundation\nname: OtherPlugin\nversion: 0.1.0\n',
  ), /plugin_descriptor_invalid/);
  assert.throws(() => parseRuntimePluginIdentity(
    'name: ArenaFoundation\nversion: "0.1.0"\n',
  ), /plugin_descriptor_invalid/);
  assert.throws(() => parseRuntimePluginIdentity(
    'name: ArenaFoundation\nversion : 0.1.0\n',
  ), /plugin_descriptor_invalid/);
});

function readyMessage(plugin: Readonly<{ name: string; version: string }>) {
  const message = decodeControlFrame(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    correlation: 1n,
    type: 'ready',
    payload: {
      server: {
        name: 'Paper',
        version: '26.1.2',
        minecraft_version: '26.1.2',
        protocol_version: 775,
      },
      plugin,
      capabilities: ['hunger_games_v1'],
    },
  }));
  if (message.type !== 'ready') throw new Error('fixture must decode as ready');
  return message;
}
