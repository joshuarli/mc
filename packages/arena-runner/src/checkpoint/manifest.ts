import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical.js';
import { RunnerError } from '../errors.js';
import { parseStrictJson, StrictJsonError, type StrictJsonValue } from '../control/strict-json.js';

export const CHECKPOINT_MANIFEST_SCHEMA = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface CheckpointManifest {
  readonly schema: 1;
  readonly checkpoint_id: string;
  readonly run_id: string;
  readonly epoch: number;
  readonly match_tick: string;
  readonly record: Readonly<{ digest: string; body_bytes: number; file_bytes: number; file_sha256: string }>;
  readonly bots: Readonly<{ bytes: number; sha256: string }>;
  readonly scenario: Readonly<{
    path: string;
    semantic_id: string;
    external_seat: Readonly<{ seat: number; username: string }> | null;
  }>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function encodeCheckpointManifest(manifest: CheckpointManifest): Buffer {
  return Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
}

export function checkpointDirectory(checkpointId: string): string {
  if (!ID.test(checkpointId)) throw new RunnerError('invalid_input', 'checkpoint id', { kind: 'invalid_checkpoint_id' });
  return `.work/arena/checkpoints/${checkpointId}`;
}

export function parseCheckpointManifest(bytes: Uint8Array): CheckpointManifest {
  const bad = (kind: string): RunnerError => new RunnerError('corrupt_evidence', 'checkpoint manifest', { kind });
  let value: StrictJsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof StrictJsonError) throw bad('invalid_manifest_json');
    throw error;
  }
  const object = (candidate: unknown, keys: readonly string[]): Record<string, StrictJsonValue> => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw bad('invalid_manifest');
    const record = candidate as Record<string, StrictJsonValue>;
    const present = Object.keys(record);
    if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw bad('invalid_manifest_fields');
    return record;
  };
  const integer = (candidate: unknown, min = 0): number => {
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < min) throw bad('invalid_manifest_number');
    return candidate;
  };
  const text = (candidate: unknown, pattern?: RegExp): string => {
    if (typeof candidate !== 'string' || candidate.length === 0 || (pattern !== undefined && !pattern.test(candidate))) {
      throw bad('invalid_manifest_string');
    }
    return candidate;
  };
  const root = object(value, ['schema', 'checkpoint_id', 'run_id', 'epoch', 'match_tick', 'record', 'bots', 'scenario']);
  if (root.schema !== CHECKPOINT_MANIFEST_SCHEMA) throw bad('unsupported_manifest_schema');
  const record = object(root.record, ['digest', 'body_bytes', 'file_bytes', 'file_sha256']);
  const bots = object(root.bots, ['bytes', 'sha256']);
  const scenario = object(root.scenario, ['path', 'semantic_id', 'external_seat']);
  let externalSeat: CheckpointManifest['scenario']['external_seat'] = null;
  if (scenario.external_seat !== null) {
    const seat = object(scenario.external_seat, ['seat', 'username']);
    externalSeat = Object.freeze({ seat: integer(seat.seat), username: text(seat.username) });
  }
  return Object.freeze({
    schema: 1,
    checkpoint_id: text(root.checkpoint_id, ID),
    run_id: text(root.run_id, ID),
    epoch: integer(root.epoch),
    match_tick: text(root.match_tick, /^(0|[1-9][0-9]*)$/),
    record: Object.freeze({
      digest: text(record.digest, HEX64), body_bytes: integer(record.body_bytes, 1),
      file_bytes: integer(record.file_bytes, 1), file_sha256: text(record.file_sha256, HEX64),
    }),
    bots: Object.freeze({ bytes: integer(bots.bytes, 1), sha256: text(bots.sha256, HEX64) }),
    scenario: Object.freeze({ path: text(scenario.path), semantic_id: text(scenario.semantic_id, HEX64), external_seat: externalSeat }),
  });
}
