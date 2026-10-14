import { decodeCheckpoint, CheckpointDecodeError } from '../control/checkpoint.js';
import type { CheckpointWrittenPayload } from '../control/types.js';
import { canonicalJson } from '../canonical.js';
import { RunnerError } from '../errors.js';
import {
  cloneOwnedTree,
  createOwnedDirectory,
  MAX_OWNED_READ_BYTES,
  MAX_OWNED_TREE_BYTES,
  MAX_OWNED_TREE_FILES,
  OwnedFilesError,
  readOwnedFile,
  stageOwnedFile,
} from '../owned-files/index.js';
import {
  checkpointDirectory,
  encodeCheckpointManifest,
  sha256Hex,
  type CheckpointManifest,
} from './manifest.js';

const MAX_RECORD_FILE_BYTES = MAX_OWNED_READ_BYTES;
const MAX_BOT_STATE_BYTES = MAX_OWNED_READ_BYTES;
const PLUGIN_CHECKPOINT_DIRECTORY = 'server/plugins/ArenaFoundation/checkpoints';

export interface PersistCheckpointOptions {
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly runDirectoryPath: Buffer;
  readonly runId: string;
  readonly checkpointId: string;
  readonly epoch: number;
  readonly written: CheckpointWrittenPayload;
  readonly botState: object;
  readonly scenario: CheckpointManifest['scenario'];
  readonly signal?: AbortSignal;
}

export async function persistCheckpoint(options: PersistCheckpointOptions): Promise<CheckpointManifest> {
  const { helperPath, ownedRoot, written } = options;
  const common = { helperPath, ownedRoot, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const fail = (kind: string): RunnerError => new RunnerError('corrupt_evidence', 'checkpoint', {
    kind, field: options.checkpointId,
  });
  if (written.checkpoint_id !== options.checkpointId || written.epoch !== options.epoch) {
    throw fail('checkpoint_written_identity_mismatch');
  }
  const recordPath = Buffer.concat([options.runDirectoryPath,
    Buffer.from(`/${PLUGIN_CHECKPOINT_DIRECTORY}/${options.checkpointId}.json`, 'ascii')]);
  let recordFile: Buffer;
  try {
    recordFile = await readOwnedFile({ ...common, relativePath: recordPath, maxBytes: MAX_RECORD_FILE_BYTES });
  } catch (error) {
    if (error instanceof OwnedFilesError) throw fail(`checkpoint_record_${error.category}`);
    throw error;
  }
  let decoded: ReturnType<typeof decodeCheckpoint>;
  try {
    decoded = decodeCheckpoint(recordFile);
  } catch (error) {
    if (error instanceof CheckpointDecodeError) throw fail('checkpoint_record_incomplete');
    throw error;
  }
  if (decoded.digest !== written.digest || decoded.byteLength !== written.byte_length) throw fail('checkpoint_digest_mismatch');
  if (decoded.record.epoch !== options.epoch || decoded.record.match_tick !== written.match_tick
      || decoded.record.checkpoint_id !== options.checkpointId || decoded.record.run_id !== options.runId) {
    throw fail('checkpoint_record_identity_mismatch');
  }

  const directory = checkpointDirectory(options.checkpointId);
  try {
    await createOwnedDirectory({ ...common, relativePath: Buffer.from(directory) });
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'conflict') {
      throw new RunnerError('owner_conflict', 'checkpoint', { kind: 'checkpoint_exists', field: options.checkpointId });
    }
    throw error;
  }
  await cloneOwnedTree({
    ...common,
    sourceRelativePath: Buffer.concat([options.runDirectoryPath, Buffer.from('/server/world', 'ascii')]),
    destinationRelativePath: Buffer.from(`${directory}/world`),
    maxFiles: MAX_OWNED_TREE_FILES,
    maxBytes: MAX_OWNED_TREE_BYTES,
  });
  const stage = async (name: string, contents: Buffer, maxBytes: number): Promise<void> => {
    await stageOwnedFile({ ...common, relativePath: Buffer.from(`${directory}/${name}`), contents, maxBytes });
    const back = await readOwnedFile({ ...common, relativePath: Buffer.from(`${directory}/${name}`), maxBytes });
    if (sha256Hex(back) !== sha256Hex(contents) || back.length !== contents.length) throw fail('checkpoint_copy_mismatch');
  };
  const botBytes = Buffer.from(`${canonicalJson(options.botState)}\n`, 'utf8');
  await stage('checkpoint.json', recordFile, MAX_RECORD_FILE_BYTES);
  await stage('bots.json', botBytes, MAX_BOT_STATE_BYTES);

  const manifest: CheckpointManifest = Object.freeze({
    schema: 1,
    checkpoint_id: options.checkpointId,
    run_id: options.runId,
    epoch: options.epoch,
    match_tick: written.match_tick.toString(),
    record: Object.freeze({
      digest: decoded.digest, body_bytes: decoded.byteLength, file_bytes: recordFile.length, file_sha256: sha256Hex(recordFile),
    }),
    bots: Object.freeze({ bytes: botBytes.length, sha256: sha256Hex(botBytes) }),
    scenario: options.scenario,
  });
  await stageOwnedFile({
    ...common, relativePath: Buffer.from(`${directory}/manifest.json`),
    contents: encodeCheckpointManifest(manifest), maxBytes: 64 * 1024,
  });
  return manifest;
}

export interface LoadedCheckpoint {
  readonly manifest: CheckpointManifest;
  readonly record: ReturnType<typeof decodeCheckpoint>['record'];
  readonly botState: unknown;
  readonly directory: string;
  readonly worldPath: Buffer;
  readonly recordPath: Buffer;
}

export async function loadCheckpoint(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  checkpointId: string;
  signal?: AbortSignal;
}>): Promise<LoadedCheckpoint> {
  const { parseCheckpointManifest } = await import('./manifest.js');
  const common = { helperPath: options.helperPath, ownedRoot: options.ownedRoot,
    ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const directory = checkpointDirectory(options.checkpointId);
  const fail = (kind: string): RunnerError => new RunnerError('corrupt_evidence', 'checkpoint', {
    kind, field: options.checkpointId,
  });
  const read = async (name: string, maxBytes: number): Promise<Buffer> => {
    try {
      return await readOwnedFile({ ...common, relativePath: Buffer.from(`${directory}/${name}`), maxBytes });
    } catch (error) {
      if (error instanceof OwnedFilesError && error.category === 'not_found') {
        throw new RunnerError('missing_prerequisite', 'checkpoint', {
          kind: name === 'manifest.json' ? 'checkpoint_not_found_or_incomplete' : `checkpoint_${name}_missing`,
          field: options.checkpointId,
        });
      }
      throw error;
    }
  };
  const manifest = parseCheckpointManifest(await read('manifest.json', 64 * 1024));
  if (manifest.checkpoint_id !== options.checkpointId) throw fail('manifest_identity_mismatch');
  const recordFile = await read('checkpoint.json', MAX_RECORD_FILE_BYTES);
  if (recordFile.length !== manifest.record.file_bytes || sha256Hex(recordFile) !== manifest.record.file_sha256) {
    throw fail('checkpoint_file_mismatch');
  }
  let decoded: ReturnType<typeof decodeCheckpoint>;
  try {
    decoded = decodeCheckpoint(recordFile);
  } catch (error) {
    if (error instanceof CheckpointDecodeError) throw fail('checkpoint_record_incomplete');
    throw error;
  }
  if (decoded.digest !== manifest.record.digest || decoded.byteLength !== manifest.record.body_bytes
      || decoded.record.epoch !== manifest.epoch || decoded.record.match_tick.toString() !== manifest.match_tick
      || decoded.record.run_id !== manifest.run_id) {
    throw fail('checkpoint_manifest_mismatch');
  }
  const botBytes = await read('bots.json', MAX_BOT_STATE_BYTES);
  if (botBytes.length !== manifest.bots.bytes || sha256Hex(botBytes) !== manifest.bots.sha256) throw fail('bot_state_mismatch');
  return Object.freeze({
    manifest, record: decoded.record, botState: JSON.parse(botBytes.toString('utf8')) as unknown, directory,
    worldPath: Buffer.from(`${directory}/world`), recordPath: Buffer.from(`${directory}/checkpoint.json`),
  });
}
