import { reconstruct, reconstructRunEvidence, type Evidence } from '../evidence.js';
import { RunnerError } from '../errors.js';
import {
  acquireOwnedRunLease,
  assertOwnedRunLeaseMatches,
  createOwnedDirectory,
  listOwnedRuns,
  MAX_OWNED_FILE_BYTES,
  MAX_OWNED_READ_BYTES,
  OwnedFilesError,
  readOwnedFileWithIdentity,
  removeOwnedRun,
  stageOwnedFile,
  type OwnedRunLease,
  type OwnedRunSnapshot,
} from '../owned-files/index.js';
import { canonicalJson } from '../canonical.js';
import { isValidRunId } from '../run-id.js';
import {
  MAX_EVIDENCE_BYTES,
  MAX_TRACE_SEGMENTS,
  MAX_TRACE_SEGMENT_BYTES,
  parseSegment,
  TraceError,
  type TraceSegment,
} from '../trace.js';
import {
  MAX_OPERATIONAL_FAILURE_BYTES,
  failureArtifactPath,
  parseOperationalFailureArtifact,
  type OperationalFailureArtifactV1,
} from './failure-artifact.js';
import {
  archiveDirectoryPath,
  readRunEvidence,
  type RunEvidenceFiles,
} from './inspect.js';
import {
  readStoppedPlayerStats,
  readStoppedPlayerStatsFile,
  stoppedPlayerStatsDirectoryPath,
  stoppedPlayerStatsPath,
  type StoppedPlayerStatsFile,
} from './observations.js';

const RUN_DIRECTORY_PREFIX = '.work/arena/runs/';
const LATEST_FAILURES_TO_RETAIN = 3;

export type RunGarbageCollectionMode = 'dry_run' | 'apply';

export interface RunGarbageCollectionDecision {
  readonly run_id: string;
  readonly path: string;
  readonly status: 'eligible' | 'removed' | 'protected';
  readonly reason: string;
  readonly evidence_path: string | null;
  readonly failure_type?: 'operational_failure' | 'authority_abort';
  readonly outcome_kind?: 'winner' | 'draw';
}

export interface RunGarbageCollectionResult {
  readonly schema: 1;
  readonly mode: RunGarbageCollectionMode;
  readonly retained_failure_run_ids: readonly string[];
  readonly unclassified_failure_run_ids: readonly string[];
  readonly runs: readonly RunGarbageCollectionDecision[];
}

type ClassifiedRun =
  | Readonly<{ kind: 'incomplete' }>
  | Readonly<{ kind: 'unknown'; reason: string; evidencePath: string | null }>
  | Readonly<{
      kind: 'success';
      outcomeKind: 'winner' | 'draw';
      evidencePath: string;
    }>
  | Readonly<{
      kind: 'failure';
      failureType: 'operational_failure' | 'authority_abort';
      modifiedTimeNs: bigint;
      evidencePath: string;
      cleanupFailed: boolean;
    }>;

type HeldRun = Readonly<{
  snapshot: OwnedRunSnapshot;
  lease: OwnedRunLease;
}>;

/** Removes selected validated runs while retaining the newest three validated failures. */
export async function collectOwnedRuns(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  runIds: readonly string[];
  mode: RunGarbageCollectionMode;
}>): Promise<RunGarbageCollectionResult> {
  if ((options.mode !== 'dry_run' && options.mode !== 'apply') || options.runIds.length === 0) {
    throw new RunnerError('invalid_input', 'run garbage collection', { kind: 'invalid_run_selection' });
  }
  const selectedIds = new Set<string>();
  for (const runId of options.runIds) {
    if (!isValidRunId(runId) || selectedIds.has(runId)) {
      throw new RunnerError('invalid_input', 'run garbage collection', { kind: 'invalid_run_selection' });
    }
    selectedIds.add(runId);
  }

  let snapshots: readonly OwnedRunSnapshot[];
  try {
    snapshots = await listOwnedRuns({ helperPath: options.helperPath, ownedRoot: options.ownedRoot });
  } catch (error) {
    throw mapOwnedRunListError(error);
  }
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.runId, snapshot]));
  for (const runId of selectedIds) {
    if (!snapshotsById.has(runId)) {
      throw new RunnerError('missing_prerequisite', 'owned run', { kind: 'run_not_found', run_id: runId });
    }
  }

  const candidateSnapshots = snapshots.filter((snapshot) => selectedIds.has(snapshot.runId)
    || snapshot.failureArtifactModifiedTimeNs !== undefined
    || snapshot.terminalTraceSequence !== undefined);
  const heldRuns = new Map<string, HeldRun>();
  const unclassifiedFailureRunIds = new Set<string>();
  const classifications = new Map<string, ClassifiedRun>();
  let primaryError: unknown;
  let collectionResult: RunGarbageCollectionResult | undefined;
  try {
    for (const snapshot of candidateSnapshots) {
      let lease: OwnedRunLease;
      try {
        lease = await acquireOwnedRunLease({
          helperPath: options.helperPath,
          ownedRoot: options.ownedRoot,
          relativePath: runDirectoryPath(snapshot.runId),
        });
      } catch (error) {
        if (selectedIds.has(snapshot.runId)) throw mapRunLeaseError(error, snapshot.runId);
        if (isOwnedRunUnavailable(error)) {
          unclassifiedFailureRunIds.add(snapshot.runId);
          continue;
        }
        throw mapRunLeaseError(error, snapshot.runId);
      }
      heldRuns.set(snapshot.runId, { snapshot, lease });

      try {
        await assertOwnedRunLeaseMatches({
          lease,
          ownedRoot: options.ownedRoot,
          runId: snapshot.runId,
          identity: snapshot.identity,
        });
      } catch (error) {
        if (selectedIds.has(snapshot.runId)) throw mapRunIdentityError(error, snapshot.runId);
        if (isOwnedRunConflict(error)) {
          unclassifiedFailureRunIds.add(snapshot.runId);
          continue;
        }
        throw mapRunIdentityError(error, snapshot.runId);
      }

      try {
        classifications.set(snapshot.runId, await classifyRun(options, snapshot));
      } catch (error) {
        if (!isCorruptEvidence(error)) throw error;
        classifications.set(snapshot.runId, {
          kind: 'unknown',
          reason: corruptEvidenceReason(error),
          evidencePath: relevantEvidencePath(snapshot),
        });
        unclassifiedFailureRunIds.add(snapshot.runId);
      }
    }

    const failures = snapshots.flatMap((snapshot) => {
      const classification = classifications.get(snapshot.runId);
      return classification?.kind === 'failure'
        ? [{ snapshot, classification }]
        : [];
    });
    failures.sort((left, right) => compareNewestFailure(
      left.snapshot.runId,
      left.classification.modifiedTimeNs,
      right.snapshot.runId,
      right.classification.modifiedTimeNs,
    ));
    const retainedIds = new Set(failures.slice(0, LATEST_FAILURES_TO_RETAIN).map(({ snapshot }) => snapshot.runId));
    for (const { snapshot, classification } of failures) {
      if (classification.cleanupFailed) retainedIds.add(snapshot.runId);
    }
    const decisions: RunGarbageCollectionDecision[] = [];

    for (const runId of [...selectedIds].sort(compareText)) {
      const snapshot = snapshotsById.get(runId)!;
      const held = heldRuns.get(runId);
      if (held === undefined || !classifications.has(runId)) {
        decisions.push(protectedRun(runId, 'run_evidence_unavailable', relevantEvidencePath(snapshot)));
        continue;
      }
      const classification = classifications.get(runId)!;
      if (classification.kind === 'unknown') {
        decisions.push(protectedRun(runId, classification.reason, classification.evidencePath));
        continue;
      }
      if (classification.kind === 'incomplete') {
        decisions.push(protectedRun(runId, 'incomplete_run_evidence', relevantEvidencePath(snapshot)));
        continue;
      }
      if (classification.kind === 'failure' && classification.cleanupFailed) {
        decisions.push(protectedRun(
          runId,
          'cleanup_failed',
          classification.evidencePath,
          classification.failureType,
        ));
        continue;
      }
      if (classification.kind === 'failure' && retainedIds.has(runId)) {
        decisions.push(protectedRun(
          runId,
          'among_latest_three_failures',
          classification.evidencePath,
          classification.failureType,
        ));
        continue;
      }

      const removalReason = classification.kind === 'success'
        ? 'completed_success'
        : 'older_than_latest_three_failures';
      const failureType = classification.kind === 'failure' ? classification.failureType : undefined;
      const outcomeKind = classification.kind === 'success' ? classification.outcomeKind : undefined;

      if (options.mode === 'dry_run') {
        decisions.push({
          run_id: runId,
          path: runDirectoryPathText(runId),
          status: 'eligible',
          reason: removalReason,
          evidence_path: classification.evidencePath,
          ...(failureType === undefined ? {} : { failure_type: failureType }),
          ...(outcomeKind === undefined ? {} : { outcome_kind: outcomeKind }),
        });
        continue;
      }

      let evidencePath = classification.evidencePath;
      if (isArchivableRun(classification)) {
        try {
          assertOwnedRunLeaseMatches({
            lease: held.lease,
            ownedRoot: options.ownedRoot,
            runId,
            identity: snapshot.identity,
          });
        } catch (error) {
          throw mapRunIdentityError(error, runId);
        }
        evidencePath = await archiveCompletedRun(options, snapshot, classification);
      }

      try {
        await assertOwnedRunLeaseMatches({
          lease: held.lease,
          ownedRoot: options.ownedRoot,
          runId,
          identity: snapshot.identity,
        });
        await removeOwnedRun({
          helperPath: options.helperPath,
          ownedRoot: options.ownedRoot,
          runId,
          identity: snapshot.identity,
          lease: held.lease,
        });
      } catch (error) {
        throw mapRunRemovalError(error, runId);
      }
      decisions.push({
        run_id: runId,
        path: runDirectoryPathText(runId),
        status: 'removed',
        reason: removalReason,
        evidence_path: evidencePath,
        ...(failureType === undefined ? {} : { failure_type: failureType }),
        ...(outcomeKind === undefined ? {} : { outcome_kind: outcomeKind }),
      });
    }

    collectionResult = {
      schema: 1,
      mode: options.mode,
      retained_failure_run_ids: [...retainedIds].sort(compareText),
      unclassified_failure_run_ids: [...unclassifiedFailureRunIds].sort(compareText),
      runs: decisions,
    };
    return collectionResult;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const releases = [...heldRuns.values()].reverse().map(({ lease }) => lease.release());
    const results = await Promise.allSettled(releases);
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) {
      const cleanupError = failures[0];
      const cleanupKind = cleanupError instanceof OwnedFilesError ? cleanupError.category : 'release_failed';
      const cleanupOsCode = cleanupError instanceof OwnedFilesError
        ? cleanupError.errno ?? cleanupError.cleanupErrno
        : undefined;
      if (primaryError instanceof RunnerError) {
        throw new RunnerError(primaryError.category, primaryError.resource, {
          ...primaryError.source,
          cleanup_kind: cleanupKind,
          ...(cleanupOsCode === undefined ? {} : { cleanup_os_code: cleanupOsCode }),
        });
      }
      if (primaryError !== undefined) {
        throw new AggregateError([primaryError, ...failures], 'run collection and lease release failed');
      }
      const changedRun = collectionResult?.runs.find((run) => run.status === 'removed' || run.status === 'eligible');
      throw new RunnerError('runtime_failure', 'run lease', {
        kind: 'lease_release_failed',
        cleanup_kind: cleanupKind,
        ...(changedRun === undefined ? {} : { run_id: changedRun.run_id, relative_artifact: changedRun.path }),
        ...(cleanupOsCode === undefined ? {} : { cleanup_os_code: cleanupOsCode }),
      });
    }
  }
}

async function classifyRun(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  snapshot: OwnedRunSnapshot,
): Promise<ClassifiedRun> {
  if (snapshot.failureArtifactModifiedTimeNs !== undefined) {
    const path = failureArtifactPath(snapshot.runId);
    const read = await readEvidenceFile(
      options,
      path,
      Math.min(MAX_OPERATIONAL_FAILURE_BYTES, MAX_OWNED_READ_BYTES),
      'operational failure artifact',
    );
    const artifact = parseOperationalFailureArtifact(read.contents, snapshot.runId);
    if (artifact.trace_checkpoint_segments.length !== (snapshot.terminalTraceSequence ?? 0)) {
      throw new RunnerError('corrupt_evidence', 'operational failure artifact', {
        kind: 'failure_trace_segment_count_mismatch',
      });
    }
    await validateFailureTraceReferences(options, artifact);
    return {
      kind: 'failure',
      failureType: 'operational_failure',
      modifiedTimeNs: snapshot.failureArtifactModifiedTimeNs,
      evidencePath: path.toString('ascii'),
      cleanupFailed: artifact.cleanup.status === 'failed',
    };
  }

  if (snapshot.terminalTraceSequence === undefined || snapshot.terminalTraceModifiedTimeNs === undefined) {
    return { kind: 'incomplete' };
  }
  const evidencePath = traceSegmentPath(snapshot.runId, snapshot.terminalTraceSequence).toString('ascii');
  const evidence = await readTerminalEvidence(options, snapshot);
  const reconstructed = reconstructRunEvidence(evidence);
  const outcome = reconstructed.report.outcome;
  if (outcome.kind === 'abort') {
    return {
      kind: 'failure',
      failureType: 'authority_abort',
      modifiedTimeNs: snapshot.terminalTraceModifiedTimeNs,
      evidencePath,
      cleanupFailed: false,
    };
  }
  if (outcome.kind === 'winner' || outcome.kind === 'draw') {
    return { kind: 'success', outcomeKind: outcome.kind, evidencePath };
  }
  throw new RunnerError('corrupt_evidence', 'run outcome', { kind: 'invalid_terminal_outcome' });
}

async function validateFailureTraceReferences(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  artifact: OperationalFailureArtifactV1,
): Promise<void> {
  const segments: TraceSegment[] = [];
  let byteLength = 0;
  for (const reference of artifact.trace_checkpoint_segments) {
    const path = Buffer.from(reference.path, 'ascii');
    const { contents, identity } = await readEvidenceFile(
      options,
      path,
      MAX_TRACE_SEGMENT_BYTES,
      'operational failure trace',
    );
    if (!sameIdentity(identity, reference.identity) || contents.length !== reference.byte_length) {
      throw new RunnerError('corrupt_evidence', 'operational failure trace', {
        kind: 'failure_trace_identity_or_length_mismatch',
      });
    }
    if (contents.length > MAX_EVIDENCE_BYTES - byteLength) {
      throw new RunnerError('corrupt_evidence', 'operational failure trace', { kind: 'evidence_set_too_large' });
    }
    byteLength += contents.length;
    const segment = parseStoredSegment(contents, artifact.run_id, reference.path);
    segments.push(segment);
  }
  if (segments.length > 0) {
    try {
      reconstruct(segments);
    } catch (error) {
      if (!(error instanceof TraceError)) throw error;
      throw new RunnerError('corrupt_evidence', 'operational failure trace', error.source);
    }
  }
}

async function readTerminalEvidence(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  snapshot: OwnedRunSnapshot,
): Promise<Evidence> {
  const segmentCount = snapshot.terminalTraceSequence!;
  if (segmentCount > MAX_TRACE_SEGMENTS) {
    throw new RunnerError('corrupt_evidence', 'run trace', { kind: 'segment_count_limit_exceeded' });
  }
  const files = await readRunEvidence(
    options.helperPath,
    options.ownedRoot,
    runDirectoryPath(snapshot.runId),
    snapshot.runId,
  );
  if (files.segmentContents.length !== segmentCount) {
    throw new RunnerError('corrupt_evidence', 'run trace', { kind: 'terminal_trace_segment_count_mismatch' });
  }
  return files.evidence;
}

function isArchivableRun(classification: ClassifiedRun): boolean {
  return classification.kind === 'success'
    || (classification.kind === 'failure' && classification.failureType === 'authority_abort');
}

// The final trace segment marks archive completion, so it is published after every prefix and stats file.
async function archiveCompletedRun(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  snapshot: OwnedRunSnapshot,
  classification: Extract<ClassifiedRun, { kind: 'success' | 'failure' }>,
): Promise<string> {
  const sourceDirectory = runDirectoryPath(snapshot.runId);
  const archiveDirectory = archiveDirectoryPath(snapshot.runId);
  const source = await readRunEvidence(
    options.helperPath,
    options.ownedRoot,
    sourceDirectory,
    snapshot.runId,
  );
  if (source.segmentContents.length !== snapshot.terminalTraceSequence) {
    throw new RunnerError('corrupt_evidence', 'run trace', { kind: 'terminal_trace_segment_count_mismatch' });
  }
  const sourceReconstruction = reconstructRunEvidence(source.evidence);
  const sourceOutcome = sourceReconstruction.report.outcome;
  const expectedOutcomeKind = classification.kind === 'success'
    ? classification.outcomeKind
    : classification.failureType === 'authority_abort' ? 'abort' : undefined;
  if (expectedOutcomeKind === undefined || sourceOutcome.kind !== expectedOutcomeKind) {
    throw new RunnerError('corrupt_evidence', 'run outcome', { kind: 'archive_outcome_changed' });
  }

  const statsFiles: StoppedPlayerStatsFile[] = [];
  for (const player of sourceReconstruction.players) {
    statsFiles.push(await readStoppedPlayerStatsFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      runDirectoryPath: sourceDirectory,
      player,
    }));
  }

  await ensureArchiveDirectory(options, archiveDirectory);
  for (let index = 0; index < source.segmentContents.length - 1; index += 1) {
    const destination = traceSegmentPathAt(archiveDirectory, index + 1);
    await publishOrCompareArchiveFile(options, destination, source.segmentContents[index]!);
  }
  if (statsFiles.some(({ contents }) => contents !== null)) {
    const statsDirectory = stoppedPlayerStatsDirectoryPath(archiveDirectory);
    await ensureArchiveDirectory(options, statsDirectory);
  }
  for (const [index, player] of sourceReconstruction.players.entries()) {
    const stats = statsFiles[index]!;
    const destination = stoppedPlayerStatsPath(archiveDirectory, player.offlineUuid);
    if (stats.contents === null) {
      const archived = await readArchiveFile(options, destination, MAX_OWNED_READ_BYTES);
      if (archived !== undefined) {
        throw archiveMismatch(destination);
      }
      continue;
    }
    await publishOrCompareArchiveFile(options, destination, stats.contents);
  }

  const terminalIndex = source.segmentContents.length - 1;
  const terminalPath = traceSegmentPathAt(archiveDirectory, terminalIndex + 1);
  await publishOrCompareArchiveFile(options, terminalPath, source.segmentContents[terminalIndex]!);
  const unexpectedNextSegment = await readArchiveFile(
    options,
    traceSegmentPathAt(archiveDirectory, terminalIndex + 2),
    Math.min(MAX_TRACE_SEGMENT_BYTES, MAX_OWNED_READ_BYTES),
  );
  if (unexpectedNextSegment !== undefined) {
    throw archiveMismatch(traceSegmentPathAt(archiveDirectory, terminalIndex + 2));
  }

  const archived: RunEvidenceFiles = await readRunEvidence(
    options.helperPath,
    options.ownedRoot,
    archiveDirectory,
    snapshot.runId,
  );
  if (archived.segmentContents.length !== source.segmentContents.length) {
    throw new RunnerError('corrupt_evidence', 'run archive', { kind: 'archive_segment_count_mismatch' });
  }
  for (let index = 0; index < source.segmentContents.length; index += 1) {
    if (!archived.segmentContents[index]!.equals(source.segmentContents[index]!)) {
      throw archiveMismatch(traceSegmentPathAt(archiveDirectory, index + 1));
    }
  }
  const archivedReconstruction = reconstructRunEvidence(archived.evidence);
  if (canonicalJson(archivedReconstruction.report) !== canonicalJson(sourceReconstruction.report)) {
    throw new RunnerError('corrupt_evidence', 'run archive', { kind: 'archive_report_mismatch' });
  }
  const archivedStats = await readStoppedPlayerStats({
    helperPath: options.helperPath,
    ownedRoot: options.ownedRoot,
    runDirectoryPath: archiveDirectory,
    players: archivedReconstruction.players,
  });
  const sourceStats = statsFiles.map(({ stats }) => stats);
  if (canonicalJson(archivedStats) !== canonicalJson(sourceStats)) {
    throw new RunnerError('corrupt_evidence', 'run archive', { kind: 'archive_statistics_mismatch' });
  }
  return terminalPath.toString('ascii');
}

async function ensureArchiveDirectory(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  relativePath: Buffer,
): Promise<void> {
  try {
    await createOwnedDirectory({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
    });
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'conflict'
        && error.operation === 'create-owned-directory') return;
    throw mapArchiveWriteError(error, relativePath);
  }
}

async function publishOrCompareArchiveFile(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  relativePath: Buffer,
  expectedContents: Buffer,
): Promise<void> {
  try {
    await stageOwnedFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      contents: expectedContents,
      maxBytes: MAX_OWNED_FILE_BYTES,
    });
  } catch (error) {
    if (!(error instanceof OwnedFilesError && error.category === 'conflict'
          && error.operation === 'stage-owned-file')) {
      throw mapArchiveWriteError(error, relativePath);
    }
    const existing = await readArchiveFile(options, relativePath, MAX_OWNED_READ_BYTES);
    if (existing === undefined || !existing.equals(expectedContents)) {
      throw archiveMismatch(relativePath);
    }
    return;
  }

  const published = await readArchiveFile(options, relativePath, MAX_OWNED_READ_BYTES);
  if (published === undefined || !published.equals(expectedContents)) {
    throw archiveMismatch(relativePath);
  }
}

async function readArchiveFile(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  relativePath: Buffer,
  maxBytes: number,
): Promise<Buffer | undefined> {
  try {
    return (await readOwnedFileWithIdentity({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      maxBytes,
    })).contents;
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'not_found') return undefined;
    throw mapArchiveWriteError(error, relativePath);
  }
}

function archiveMismatch(relativePath: Buffer): RunnerError {
  return new RunnerError('corrupt_evidence', 'run archive', {
    kind: 'archive_file_mismatch',
    relative_artifact: relativePath.toString('ascii'),
  });
}

function mapArchiveWriteError(error: unknown, relativePath: Buffer): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', 'run archive', {
      kind: 'archive_operation_failed',
      relative_artifact: relativePath.toString('ascii'),
    });
  }
  if (error.category === 'too_large' || error.category === 'unsupported_file_type'
      || error.category === 'symlink_rejected') {
    return new RunnerError('corrupt_evidence', 'run archive', {
      kind: error.category,
      relative_artifact: relativePath.toString('ascii'),
    });
  }
  return new RunnerError(
    error.category === 'helper_start' ? 'missing_prerequisite' : 'runtime_failure',
    'run archive',
    {
      kind: error.category,
      relative_artifact: relativePath.toString('ascii'),
      ...(error.errno === undefined ? {} : { os_code: error.errno }),
    },
  );
}

function traceSegmentPathAt(directoryPath: Buffer, sequence: number): Buffer {
  return Buffer.concat([
    directoryPath,
    Buffer.from(`/trace-v2-${String(sequence).padStart(6, '0')}.json`, 'ascii'),
  ]);
}

function parseStoredSegment(contents: Buffer, runId: string, path: string): TraceSegment {
  try {
    const segment = parseSegment(contents);
    if (segment.runId !== runId) {
      throw new RunnerError('corrupt_evidence', 'run trace', { kind: 'run_id_mismatch' });
    }
    return segment;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    if (!(error instanceof TraceError)) throw error;
    throw new RunnerError('corrupt_evidence', path, error.source);
  }
}

function mapOwnedRunListError(error: unknown): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', 'owned run list', { kind: 'list_failed' });
  }
  return new RunnerError(
    error.category === 'helper_start' || error.category === 'not_found' ? 'missing_prerequisite' : 'runtime_failure',
    'owned run list',
    { kind: error.category, ...(error.errno === undefined ? {} : { os_code: error.errno }) },
  );
}

function mapRunLeaseError(error: unknown, runId: string): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', 'run lease', { kind: 'lease_failed', run_id: runId });
  }
  if (error.category === 'conflict' && error.operation === 'hold-run-lease') {
    return new RunnerError('owner_conflict', 'run lease', {
      kind: 'owner_conflict',
      run_id: runId,
      relative_artifact: runDirectoryPathText(runId),
    });
  }
  return new RunnerError(
    error.category === 'helper_start' || error.category === 'not_found' ? 'missing_prerequisite' : 'runtime_failure',
    'run lease',
    {
      kind: error.category,
      run_id: runId,
      relative_artifact: runDirectoryPathText(runId),
      ...(error.errno === undefined ? {} : { os_code: error.errno }),
    },
  );
}

function isOwnedRunUnavailable(error: unknown): boolean {
  return error instanceof OwnedFilesError && (
    error.category === 'not_found'
    || (error.category === 'conflict' && error.operation === 'hold-run-lease')
  );
}

function isOwnedRunConflict(error: unknown): boolean {
  return error instanceof OwnedFilesError && error.category === 'conflict';
}

function mapRunIdentityError(error: unknown, runId: string): RunnerError {
  if (error instanceof OwnedFilesError && error.category === 'conflict') {
    return new RunnerError('owner_conflict', 'run identity', {
      kind: 'run_identity_changed',
      run_id: runId,
      relative_artifact: runDirectoryPathText(runId),
    });
  }
  return new RunnerError('runtime_failure', 'run identity', {
    kind: 'identity_check_failed',
    run_id: runId,
    relative_artifact: runDirectoryPathText(runId),
  });
}

function mapRunRemovalError(error: unknown, runId: string): RunnerError {
  if (error instanceof OwnedFilesError && error.category === 'conflict') {
    return new RunnerError('owner_conflict', 'run removal', {
      kind: 'run_identity_changed',
      run_id: runId,
      relative_artifact: runDirectoryPathText(runId),
    });
  }
  return new RunnerError(
    error instanceof OwnedFilesError && (error.category === 'helper_start' || error.category === 'not_found')
      ? 'missing_prerequisite'
      : 'runtime_failure',
    'run removal',
    {
      kind: error instanceof OwnedFilesError ? error.category : 'remove_failed',
      run_id: runId,
      relative_artifact: runDirectoryPathText(runId),
      ...(error instanceof OwnedFilesError && error.errno !== undefined ? { os_code: error.errno } : {}),
      ...(error instanceof OwnedFilesError && error.cleanupErrno !== undefined
        ? { cleanup_os_code: error.cleanupErrno }
        : {}),
    },
  );
}

function isCorruptEvidence(error: unknown): boolean {
  return error instanceof TraceError || (error instanceof RunnerError && error.category === 'corrupt_evidence');
}

function corruptEvidenceReason(error: unknown): string {
  return error instanceof RunnerError && error.category === 'corrupt_evidence'
    ? error.source.kind
    : 'invalid_trace_evidence';
}

async function readEvidenceFile(
  options: Readonly<{ helperPath: string; ownedRoot: Buffer }>,
  relativePath: Buffer,
  maxBytes: number,
  resource: string,
): Promise<Readonly<{ contents: Buffer; identity: Readonly<{ device: string; inode: string }> }>> {
  try {
    return await readOwnedFileWithIdentity({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      maxBytes,
    });
  } catch (error) {
    if (!(error instanceof OwnedFilesError)) throw error;
    if (error.category === 'not_found' || error.category === 'too_large'
        || error.category === 'unsupported_file_type' || error.category === 'symlink_rejected') {
      throw new RunnerError('corrupt_evidence', resource, { kind: error.category });
    }
    throw new RunnerError(
      error.category === 'helper_start' ? 'missing_prerequisite' : 'runtime_failure',
      resource,
      { kind: error.category, ...(error.errno === undefined ? {} : { os_code: error.errno }) },
    );
  }
}

function protectedRun(
  runId: string,
  reason: string,
  evidencePath: string | null,
  failureType?: 'operational_failure' | 'authority_abort',
): RunGarbageCollectionDecision {
  return {
    run_id: runId,
    path: runDirectoryPathText(runId),
    status: 'protected',
    reason,
    evidence_path: evidencePath,
    ...(failureType === undefined ? {} : { failure_type: failureType }),
  };
}

function relevantEvidencePath(snapshot: OwnedRunSnapshot): string | null {
  if (snapshot.failureArtifactModifiedTimeNs !== undefined) {
    return failureArtifactPath(snapshot.runId).toString('ascii');
  }
  if (snapshot.terminalTraceSequence !== undefined) {
    return traceSegmentPath(snapshot.runId, snapshot.terminalTraceSequence).toString('ascii');
  }
  return runDirectoryPathText(snapshot.runId);
}

function compareNewestFailure(
  leftRunId: string,
  leftTime: bigint,
  rightRunId: string,
  rightTime: bigint,
): number {
  if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
  return compareText(leftRunId, rightRunId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runDirectoryPath(runId: string): Buffer {
  return Buffer.from(`${RUN_DIRECTORY_PREFIX}${runId}`, 'ascii');
}

function runDirectoryPathText(runId: string): string {
  return `${RUN_DIRECTORY_PREFIX}${runId}`;
}

function traceSegmentPath(runId: string, sequence: number): Buffer {
  return Buffer.concat([
    runDirectoryPath(runId),
    Buffer.from(`/trace-v2-${String(sequence).padStart(6, '0')}.json`, 'ascii'),
  ]);
}

function sameIdentity(
  left: Readonly<{ device: string; inode: string }>,
  right: Readonly<{ device: string; inode: string }>,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}
