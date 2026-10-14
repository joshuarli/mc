import { RunnerError } from '../errors.js';
import { MAX_OWNED_READ_BYTES, readOwnedFile } from '../owned-files/index.js';
import type { ControlCapability, ControlMessage } from '../control/index.js';
import { TextDecoder } from 'node:util';

const PLUGIN_DESCRIPTOR_PATH = Buffer.from('server/arena-plugin/src/main/resources/plugin.yml', 'ascii');
const PLUGIN_DESCRIPTOR_MAX_BYTES = 16 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export interface RuntimePluginIdentity {
  readonly name: string;
  readonly version: string;
}

/** Reads the expected plugin identity from the descriptor that is packaged into the Paper artifact. */
export async function readRuntimePluginIdentity(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  signal?: AbortSignal;
}>): Promise<RuntimePluginIdentity> {
  const contents = await readOwnedFile({
    helperPath: options.helperPath,
    ownedRoot: options.ownedRoot,
    relativePath: PLUGIN_DESCRIPTOR_PATH,
    maxBytes: Math.min(PLUGIN_DESCRIPTOR_MAX_BYTES, MAX_OWNED_READ_BYTES),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let source: string;
  try {
    source = UTF8.decode(contents);
  } catch (cause) {
    throw new RunnerError('runtime_failure', 'plugin descriptor', { kind: 'plugin_descriptor_invalid_utf8' }, { cause });
  }
  return parseRuntimePluginIdentity(source);
}

export function parseRuntimePluginIdentity(source: string): RuntimePluginIdentity {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    if (!/^\s*(?:name|version)\s*:/.test(line)) continue;
    const match = /^(name|version): ([A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/.exec(line);
    if (match === null) throw invalidPluginDescriptor();
    const [, key, value] = match;
    if (key === undefined || value === undefined || values.has(key)) {
      throw invalidPluginDescriptor();
    }
    values.set(key, value);
  }
  const name = values.get('name');
  const version = values.get('version');
  if (name === undefined || version === undefined) throw invalidPluginDescriptor();
  return Object.freeze({ name, version });
}

export function assertRuntimePluginIdentity(
  ready: Extract<ControlMessage, { readonly type: 'ready' }>,
  expected: RuntimePluginIdentity,
): void {
  if (ready.payload.plugin.name !== expected.name) {
    throw new RunnerError('runtime_failure', 'Paper plugin identity', {
      kind: 'plugin_identity_mismatch',
      field: 'name',
    });
  }
  if (ready.payload.plugin.version !== expected.version) {
    throw new RunnerError('runtime_failure', 'Paper plugin identity', {
      kind: 'plugin_identity_mismatch',
      field: 'version',
    });
  }
}

/** Supported wire capabilities do not imply that the authenticated plugin supports this match. */
export function assertRuntimePluginCapability(
  ready: Extract<ControlMessage, { readonly type: 'ready' }>,
  required: ControlCapability,
): void {
  if (!ready.payload.capabilities.includes(required)) {
    throw new RunnerError('runtime_failure', 'Paper plugin capabilities', {
      kind: 'unsupported_capability',
      field: required,
    });
  }
}

function invalidPluginDescriptor(): RunnerError {
  return new RunnerError('runtime_failure', 'plugin descriptor', { kind: 'plugin_descriptor_invalid' });
}
