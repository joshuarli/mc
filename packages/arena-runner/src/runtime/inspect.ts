import { isAbsolute } from 'node:path';
import { RunnerError } from '../errors.js';
import { reconstruct, reconstructRunEvidence, type Evidence } from '../evidence.js';
import {
  acquireOwnedRunLease,
  MAX_OWNED_READ_BYTES,
  OwnedFilesError,
  readOwnedFile,
} from '../owned-files/index.js';
import { isValidRunId } from '../run-id.js';
import {
  MAX_EVIDENCE_BYTES,
  MAX_TRACE_SEGMENT_BYTES,
  parseSegment,
  TraceError,
  type TraceSegment,
} from '../trace.js';
import { readStoppedPlayerStats } from './observations.js';

const RUN_DIRECTORY_PREFIX = '.work/arena/runs/';
const MAX_TRACE_SEGMENTS = 100_000;

/** Inspects a stopped owned run from its persisted lifecycle evidence and Minecraft stats. */
export async function inspectStoppedRun(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  runId: string;
}>): Promise<object> {
  if (!isValidRunId(options.runId)) {
    throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  }
  if (!isAbsolute(options.helperPath)) {
    throw new RunnerError('invalid_input', 'filesystem helper', { kind: 'helper_path_not_absolute' });
  }

  const runDirectoryPath = Buffer.from(`${RUN_DIRECTORY_PREFIX}${options.runId}`, 'utf8');
  let lease: Awaited<ReturnType<typeof acquireOwnedRunLease>>;
  try {
    lease = await acquireOwnedRunLease({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath: runDirectoryPath,
    });
  } catch (error) {
    throw mapRunLeaseError(error);
  }

  try {
    const evidence = await readRunEvidence(options.helperPath, options.ownedRoot, runDirectoryPath, options.runId);
    const reconstructed = reconstructRunEvidence(evidence);
    const stats = await readStoppedPlayerStats({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      runDirectoryPath,
      players: reconstructed.players,
    });
    return {
      schema: 1,
      run_id: options.runId,
      report: reconstructed.report,
      stats,
    };
  } finally {
    await lease.release();
  }
}

async function readRunEvidence(
  helperPath: string,
  ownedRoot: Buffer,
  runDirectoryPath: Buffer,
  runId: string,
): Promise<Evidence> {
  const segments: TraceSegment[] = [];
  let byteLength = 0;
  for (let index = 1; index <= MAX_TRACE_SEGMENTS + 1; index += 1) {
    const segmentPath = Buffer.concat([
      runDirectoryPath,
      Buffer.from(`/trace-v2-${String(index).padStart(6, '0')}.json`, 'ascii'),
    ]);
    let bytes: Buffer;
    try {
      bytes = await readOwnedFile({
        helperPath,
        ownedRoot,
        relativePath: segmentPath,
        maxBytes: Math.min(MAX_TRACE_SEGMENT_BYTES, MAX_OWNED_READ_BYTES),
      });
    } catch (error) {
      if (error instanceof OwnedFilesError && error.category === 'not_found') {
        if (segments.length === 0) {
          throw new RunnerError('missing_prerequisite', 'run trace', { kind: 'trace_missing' });
        }
        break;
      }
      throw mapTraceReadError(error);
    }

    if (index > MAX_TRACE_SEGMENTS) {
      throw new RunnerError('corrupt_evidence', 'run trace', { kind: 'segment_count_limit_exceeded' });
    }

    if (bytes.length > MAX_EVIDENCE_BYTES - byteLength) {
      throw new RunnerError('corrupt_evidence', 'run trace', { kind: 'evidence_set_too_large' });
    }
    byteLength += bytes.length;
    try {
      const segment = parseSegment(bytes);
      if (segment.runId !== runId) {
        throw new RunnerError('corrupt_evidence', `run trace segment ${index}`, {
          kind: 'run_id_mismatch',
          argument: index,
        });
      }
      segments.push(segment);
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      if (!(error instanceof TraceError)) throw error;
      throw new RunnerError('corrupt_evidence', `run trace segment ${index}`, {
        ...error.source,
        argument: index,
      });
    }
  }

  try {
    return reconstruct(segments);
  } catch (error) {
    if (!(error instanceof TraceError)) throw error;
    throw new RunnerError('corrupt_evidence', 'run trace segment set', error.source);
  }
}

function mapRunLeaseError(error: unknown): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', 'run lease', { kind: 'lease_failed' });
  }
  const category = error.category === 'helper_start' ? 'missing_prerequisite' : 'runtime_failure';
  return new RunnerError(category, 'run lease', {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
  });
}

function mapTraceReadError(error: unknown): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', 'run trace', { kind: 'read_failed' });
  }
  if (error.category === 'too_large' || error.category === 'unsupported_file_type'
      || error.category === 'symlink_rejected') {
    return new RunnerError('corrupt_evidence', 'run trace', { kind: error.category });
  }
  const category = error.category === 'helper_start' ? 'missing_prerequisite' : 'runtime_failure';
  return new RunnerError(category, 'run trace', {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
  });
}
