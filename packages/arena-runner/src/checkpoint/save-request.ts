import { RunnerError } from '../errors.js';
import { canonicalJson } from '../canonical.js';
import {
  OwnedFilesError,
  readOwnedFile,
  stageOwnedFile,
} from '../owned-files/index.js';

const MAX_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type SaveResult =
  | Readonly<{ schema: 1; status: 'saved'; checkpoint_id: string; run_id: string; epoch: number; match_tick: string;
    digest: string; directory: string }>
  | Readonly<{ schema: 1; status: 'failed'; checkpoint_id: string; run_id: string; reason: string }>;

export interface RunFiles {
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly runDirectoryPath: Buffer;
}

function path(files: RunFiles, name: string): Buffer {
  return Buffer.concat([files.runDirectoryPath, Buffer.from(`/${name}`, 'ascii')]);
}

export async function requestSave(files: RunFiles, checkpointId: string): Promise<void> {
  if (!ID.test(checkpointId)) throw new RunnerError('invalid_input', 'checkpoint id', { kind: 'invalid_checkpoint_id' });
  try {
    await stageOwnedFile({
      helperPath: files.helperPath, ownedRoot: files.ownedRoot, relativePath: path(files, 'save-request.json'),
      contents: Buffer.from(canonicalJson({ schema: 1, checkpoint_id: checkpointId }), 'utf8'), maxBytes: MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'conflict') {
      throw new RunnerError('owner_conflict', 'save request', { kind: 'save_already_requested' });
    }
    if (error instanceof OwnedFilesError && error.category === 'not_found') {
      throw new RunnerError('missing_prerequisite', 'run directory', { kind: 'run_not_found' });
    }
    throw error;
  }
}

export async function readSaveRequest(files: RunFiles): Promise<string | undefined> {
  const bytes = await readIfPresent(files, 'save-request.json');
  if (bytes === undefined) return undefined;
  const parsed = JSON.parse(bytes.toString('utf8')) as { schema?: unknown; checkpoint_id?: unknown };
  if (parsed.schema !== 1 || typeof parsed.checkpoint_id !== 'string' || !ID.test(parsed.checkpoint_id)) {
    throw new RunnerError('corrupt_evidence', 'save request', { kind: 'invalid_save_request' });
  }
  return parsed.checkpoint_id;
}

export async function publishSaveResult(files: RunFiles, result: SaveResult): Promise<void> {
  await stageOwnedFile({
    helperPath: files.helperPath, ownedRoot: files.ownedRoot, relativePath: path(files, 'save-result.json'),
    contents: Buffer.from(canonicalJson(result), 'utf8'), maxBytes: MAX_BYTES,
  });
}

export async function readSaveResult(files: RunFiles): Promise<SaveResult | undefined> {
  const bytes = await readIfPresent(files, 'save-result.json');
  return bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8')) as SaveResult;
}

async function readIfPresent(files: RunFiles, name: string): Promise<Buffer | undefined> {
  try {
    return await readOwnedFile({
      helperPath: files.helperPath, ownedRoot: files.ownedRoot, relativePath: path(files, name), maxBytes: MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'not_found') return undefined;
    throw error;
  }
}
