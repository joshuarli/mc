import { canonicalJson, sha256Json } from '../canonical.js';
import type { ControlMessage } from '../control/index.js';
import type { StrictJsonValue } from '../control/strict-json.js';
import {
  MAX_OWNED_FILE_BYTES,
  stageOwnedFile,
  type FileIdentity,
} from '../owned-files/index.js';
import { RunnerError } from '../errors.js';
import { isCivilizationMaterialAction, type PolicyEffectRecord, type PolicyReplayRecord } from '../policy-replay.js';
import type { PreparedRun } from '../prepare.js';
import {
  MAX_EVIDENCE_BYTES,
  MAX_TRACE_SEGMENT_BYTES,
  TRACE_SCHEMA_VERSION,
  type TraceRecord,
} from '../trace.js';
import { isAuthenticatedControlMessage, type RunnerCommandEnvelope } from './session.js';
import {
  OPERATIONAL_FAILURE_SCHEMA_VERSION,
  writeOperationalFailureArtifact,
  type OperationalFailureArtifactV1,
  type OperationalFailureCleanupV1,
  type OperationalFailurePrimaryV1,
} from './failure-artifact.js';

const MAX_RUNTIME_TRACE_RECORDS = 100_000;
const CHECKPOINT_OBSERVATION_INTERVAL = 200;
const MAX_POLICY_SEQUENCE = (1n << 64n) - 1n;

export interface RuntimeTraceSegment {
  readonly relativePath: Buffer;
  readonly identity: FileIdentity;
  readonly byteLength: number;
}

export interface RuntimeTraceResult {
  readonly segments: readonly RuntimeTraceSegment[];
  readonly totalByteLength: number;
}

export interface RuntimeFailureTraceResult {
  readonly artifact: OperationalFailureArtifactV1;
  readonly artifactPath: Buffer;
  readonly artifactIdentity: FileIdentity;
  readonly artifactByteLength: number;
}

export interface RuntimeTraceOptions {
  readonly runId: string;
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly preparedRun: Pick<PreparedRun, 'runId' | 'runDirectoryPath'>;
}

/** Stages ordered trace segments and keeps the outcome segment private until the JVM stops. */
export class RuntimeTraceBuilder {
  readonly #runId: string;
  readonly #helperPath: string;
  readonly #ownedRoot: Buffer;
  readonly #runDirectoryPath: Buffer;
  readonly #segments: RuntimeTraceSegment[] = [];
  readonly #records: TraceRecord[] = [];
  readonly #policyDecisionSequences = new Set<string>();
  readonly #civilizationDecisionSequences = new Set<string>();
  readonly #materialActionSequences = new Set<string>();
  #mode: 'hunger_games' | 'civilization' | undefined;
  readonly #activePolicyActions = new Map<number, string>();
  readonly #policyActionSeats = new Map<string, number>();
  // An action can still settle after Java publishes the terminal result.
  readonly #pendingPolicyEffectSequences = new Set<string>();
  readonly #policyEffectSequences = new Set<string>();
  #recordBytes = 0;
  #totalRecordCount = 0;
  #stagedByteLength = 0;
  #hasReady = false;
  #hasPrepare = false;
  #hasStart = false;
  #hasOutcome = false;
  #lastPluginSequence = 0n;
  #lastRunnerSequence = 0n;
  #lastAcknowledgedRunnerSequence = 0n;
  #lastPolicyDecisionSequence = 0n;
  #lastCheckpointObservation = 0;
  #checkpointSegmentCount = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;
  #finalized: RuntimeTraceResult | undefined;
  #failureArtifact: RuntimeFailureTraceResult | undefined;

  constructor(options: RuntimeTraceOptions) {
    if (options.runId.length === 0 || options.preparedRun.runId !== options.runId) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_run_id' });
    }
    this.#runId = options.runId;
    this.#helperPath = options.helperPath;
    this.#ownedRoot = Buffer.from(options.ownedRoot);
    this.#runDirectoryPath = Buffer.from(options.preparedRun.runDirectoryPath);
  }

  /** Records the authenticated ready envelope while excluding the hello token. */
  recordReady(ready: Extract<ControlMessage, { readonly type: 'ready' }>): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#hasReady || this.#totalRecordCount !== 0) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_out_of_order' });
      }
      if (!isAuthenticatedControlMessage(ready)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'unauthenticated_readiness_envelope' });
      }
      if (ready.protocol !== 1 || ready.run_id !== this.#runId || ready.sequence <= 0n
          || ready.correlation === undefined || ready.correlation <= 0n) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_readiness_envelope' });
      }
      await this.#append(toTraceRecord('plugin', ready));
      this.#hasReady = true;
      this.#lastPluginSequence = ready.sequence;
      this.#lastRunnerSequence = ready.correlation;
      this.#lastAcknowledgedRunnerSequence = ready.correlation;
    });
  }

  /** Records non-secret runner commands so evidence retains the configured match roster. */
  recordRunnerCommand(message: RunnerCommandEnvelope): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (!this.#hasReady) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_missing' });
      }
      if (!isAuthenticatedControlMessage(message)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'unauthenticated_runner_command' });
      }
      if (message.protocol !== 1 || message.run_id !== this.#runId || message.sequence <= this.#lastRunnerSequence
          || message.correlation !== undefined) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_runner_command_envelope' });
      }
      if (this.#hasOutcome) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'command_after_outcome' });
      }
      if (message.type === 'prepare') {
        if (this.#hasPrepare) {
          throw new RunnerError('runtime_failure', 'run trace', { kind: 'duplicate_prepare_command' });
        }
        this.#hasPrepare = true;
        this.#mode = message.payload.mode;
      } else if (message.type === 'start') {
        if (!this.#hasPrepare || this.#hasStart) {
          throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_start_command' });
        }
        this.#hasStart = true;
      } else if (!this.#hasPrepare) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'abort_before_prepare' });
      }
      await this.#append(toTraceRecord('runner', message));
      this.#lastRunnerSequence = message.sequence;
    });
  }

  /** Records authenticated plugin events, omitting non-semantic heartbeat and metrics frames. */
  recordControlMessage(message: ControlMessage): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (message.type === 'hello' || message.type === 'ready') {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'unexpected_handshake' });
      }
      if (!isAuthenticatedControlMessage(message)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'unauthenticated_plugin_message' });
      }
      if (!this.#hasReady) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_missing' });
      }
      if (message.run_id !== this.#runId) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'run_id_mismatch' });
      }
      if (message.sequence <= this.#lastPluginSequence) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'non_monotonic_control_sequence' });
      }
      if (this.#hasOutcome) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'event_after_outcome' });
      }

      switch (message.type) {
        case 'heartbeat':
        case 'metrics':
          this.#lastPluginSequence = message.sequence;
          return;
        case 'prepare':
        case 'start':
        case 'abort':
          throw new RunnerError('runtime_failure', 'run trace', { kind: 'unexpected_runner_command' });
        case 'ack':
        case 'error':
          if (message.correlation === undefined || message.correlation <= this.#lastAcknowledgedRunnerSequence
              || message.correlation > this.#lastRunnerSequence) {
            throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_command_acknowledgment' });
          }
          this.#lastAcknowledgedRunnerSequence = message.correlation;
          break;
        default:
          break;
      }

      if (!this.#hasPrepare) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'prepare_missing' });
      }
      await this.#append(toTraceRecord('plugin', message));
      this.#lastPluginSequence = message.sequence;
      if (message.type === 'outcome') this.#hasOutcome = true;
    });
  }

  /** Records the exact core policy input, decision, and resulting random state. */
  recordPolicyDecision(record: PolicyReplayRecord): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (!this.#hasReady || !this.#hasPrepare) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_decision_out_of_order' });
      }
      if (this.#hasOutcome) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_decision_after_outcome' });
      }
      if (record.schema !== 'policy-replay-v1' && record.schema !== 'policy-replay-v2' && record.schema !== 'civilization-policy-replay-v1') {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_policy_decision' });
      }
      if ((record.schema === 'civilization-policy-replay-v1') !== (this.#mode === 'civilization')) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_namespace_mode_mismatch' });
      }
      const sequence = parsePolicySequence(record.sequence, 'sequence');
      if (sequence <= this.#lastPolicyDecisionSequence || this.#policyDecisionSequences.has(record.sequence)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_sequence_not_increasing' });
      }
      if (record.schema === 'policy-replay-v1') {
        if (record.decision.intent.kind !== 'hold') this.#pendingPolicyEffectSequences.add(record.sequence);
      } else {
        const disposition = record.disposition;
        const active = this.#activePolicyActions.get(record.seat);
        if (disposition.kind === 'hold') {
          if (active !== undefined || record.decision.intent.kind !== 'hold') {
            throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_policy_hold_disposition' });
          }
        } else if (disposition.kind === 'start' || disposition.kind === 'replace') {
          if (disposition.action_sequence !== record.sequence || record.decision.intent.kind === 'hold'
              || (disposition.kind === 'start' ? active !== undefined : active !== disposition.replaces_action_sequence)) {
            throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_policy_action_identity' });
          }
          this.#activePolicyActions.set(record.seat, record.sequence);
          this.#policyActionSeats.set(record.sequence, record.seat);
          this.#pendingPolicyEffectSequences.add(record.sequence);
        } else if (active !== disposition.action_sequence
            || this.#policyActionSeats.get(disposition.action_sequence) !== record.seat
            || !this.#pendingPolicyEffectSequences.has(disposition.action_sequence)) {
          throw new RunnerError('runtime_failure', 'run trace', { kind: 'unmatched_policy_action' });
        }
      }
      await this.#append(toTraceRecord(undefined, record));
      this.#lastPolicyDecisionSequence = sequence;
      this.#policyDecisionSequences.add(record.sequence);
      if (record.schema === 'civilization-policy-replay-v1') {
        this.#civilizationDecisionSequences.add(record.sequence);
        if (isCivilizationMaterialAction(record.decision)) this.#materialActionSequences.add(record.sequence);
      }
    });
  }

  /** Records completed skill effects, including late cancellation of an already recorded decision. */
  recordPolicyEffect(record: PolicyEffectRecord): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (!this.#hasReady || !this.#hasPrepare) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_effect_out_of_order' });
      }
      if (record.schema !== 'policy-effect-v1' && record.schema !== 'civilization-policy-effect-v1') {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_policy_effect' });
      }
      parsePolicySequence(record.decision_sequence, 'decision_sequence');
      if (!this.#policyDecisionSequences.has(record.decision_sequence)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'unmatched_policy_effect' });
      }
      if ((record.schema === 'civilization-policy-effect-v1') !== this.#civilizationDecisionSequences.has(record.decision_sequence)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_effect_namespace_mismatch' });
      }
      if (this.#policyEffectSequences.has(record.decision_sequence)) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'duplicate_policy_effect' });
      }
      if (!this.#pendingPolicyEffectSequences.has(record.decision_sequence)) {
        throw new RunnerError('runtime_failure', 'run trace', {
          kind: this.#hasOutcome ? 'policy_effect_not_pending_after_outcome' : 'policy_effect_not_pending',
        });
      }
      if (this.#policyActionSeats.has(record.decision_sequence) && (record.skill.kind === 'pending'
          || (record.skill.kind === 'progress' && !this.#materialActionSequences.has(record.decision_sequence)))) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'nonterminal_policy_effect' });
      }
      await this.#append(toTraceRecord(undefined, record));
      this.#policyEffectSequences.add(record.decision_sequence);
      this.#pendingPolicyEffectSequences.delete(record.decision_sequence);
      const seat = this.#policyActionSeats.get(record.decision_sequence);
      if (seat !== undefined && this.#activePolicyActions.get(seat) === record.decision_sequence) {
        this.#activePolicyActions.delete(seat);
      }
    });
  }

  /** Persists each nonterminal checkpoint at recorded decision counts 200, 400, and onward.
   * Pending effects are absent until they settle; this watermark does not assert action completion.
   */
  checkpoint(globalObservationCount: number): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertMutable();
      if (!Number.isSafeInteger(globalObservationCount)
          || globalObservationCount !== this.#lastCheckpointObservation + CHECKPOINT_OBSERVATION_INTERVAL) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_trace_checkpoint' });
      }
      this.#lastCheckpointObservation = globalObservationCount;
      if (this.#hasOutcome || this.#records.length === 0) return;
      await this.#stagePendingSegment();
    });
  }

  /** Stages the outcome segment after the JVM stops and returns every staged segment identity. */
  finalize(): Promise<RuntimeTraceResult> {
    if (this.#finalized !== undefined) return Promise.resolve(copyTraceResult(this.#finalized));
    return this.#enqueue(async () => {
      if (this.#finalized !== undefined) return copyTraceResult(this.#finalized);
      this.#assertMutable();
      if (!this.#hasReady) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'readiness_missing' });
      }
      if (!this.#hasOutcome) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'outcome_missing' });
      }
      if (this.#pendingPolicyEffectSequences.size > 0) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'policy_skill_result_pending' });
      }
      if (this.#records.length === 0) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'outcome_segment_missing' });
      }
      await this.#stagePendingSegment('complete');
      this.#finalized = Object.freeze({
        segments: Object.freeze(this.#segments.map(copySegment)),
        totalByteLength: this.#stagedByteLength,
      });
      return copyTraceResult(this.#finalized);
    });
  }

  /** Persists actual pending records after Paper has been reaped, without asserting a valid match. */
  persistFailurePartial(
    primary: OperationalFailurePrimaryV1,
    cleanup: OperationalFailureCleanupV1,
  ): Promise<RuntimeFailureTraceResult> {
    if (this.#failureArtifact !== undefined) {
      return Promise.resolve(copyFailureTraceResult(this.#failureArtifact));
    }
    return this.#enqueueRecovery(async () => {
      if (this.#failureArtifact !== undefined) return copyFailureTraceResult(this.#failureArtifact);
      const persistenceSignal = new AbortController().signal;
      if (this.#records.length > 0) await this.#stagePendingSegment('failure', persistenceSignal);

      const artifact: OperationalFailureArtifactV1 = Object.freeze({
        schema: OPERATIONAL_FAILURE_SCHEMA_VERSION,
        run_id: this.#runId,
        primary,
        cleanup,
        trace_checkpoint_segments: Object.freeze(this.#segments.slice(0, this.#checkpointSegmentCount).map((segment) =>
          Object.freeze({
            path: segment.relativePath.toString('ascii'),
            identity: Object.freeze({ ...segment.identity }),
            byte_length: segment.byteLength,
          }))),
      });
      const staged = await writeOperationalFailureArtifact({
        helperPath: this.#helperPath,
        ownedRoot: this.#ownedRoot,
        artifact,
        signal: persistenceSignal,
      });
      this.#failureArtifact = Object.freeze({
        artifact,
        artifactPath: Buffer.from(staged.path),
        artifactIdentity: Object.freeze({ ...staged.identity }),
        artifactByteLength: staged.byteLength,
      });
      return copyFailureTraceResult(this.#failureArtifact);
    });
  }

  async #append(record: TraceRecord): Promise<void> {
    if (this.#totalRecordCount >= MAX_RUNTIME_TRACE_RECORDS) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_record_limit_exceeded' });
    }
    const recordBytes = Buffer.byteLength(canonicalJson(record), 'utf8');
    if (this.#records.length > 0 && this.#estimatedPendingBytes(recordBytes) > MAX_TRACE_SEGMENT_BYTES) {
      if (this.#hasOutcome) {
        throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_limit_exceeded' });
      }
      await this.#stagePendingSegment();
    }
    if (this.#estimatedPendingBytes(recordBytes) > MAX_TRACE_SEGMENT_BYTES) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_limit_exceeded' });
    }
    if (this.#stagedByteLength + this.#estimatedPendingBytes(recordBytes) > MAX_EVIDENCE_BYTES) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'evidence_limit_exceeded' });
    }
    this.#records.push(record);
    this.#recordBytes += recordBytes;
    this.#totalRecordCount += 1;
  }

  #estimatedPendingBytes(extraRecordBytes = 0): number {
    const firstSequence = this.#totalRecordCount - this.#records.length + 1;
    const lastSequence = this.#totalRecordCount + (extraRecordBytes === 0 ? 0 : 1);
    const envelopeBytes = Buffer.byteLength(canonicalJson({
      schema: TRACE_SCHEMA_VERSION,
      run_id: this.#runId,
      first_sequence: String(firstSequence),
      last_sequence: String(lastSequence),
      records: [],
      sha256: '0'.repeat(64),
      trailer: { complete: true },
    }), 'utf8');
    const existingSeparators = Math.max(0, this.#records.length - 1);
    const extraSeparator = this.#records.length === 0 ? 0 : extraRecordBytes === 0 ? 0 : 1;
    return envelopeBytes + this.#recordBytes + existingSeparators + extraSeparator + extraRecordBytes;
  }

  async #stagePendingSegment(
    purpose: 'checkpoint' | 'complete' | 'failure' = 'checkpoint',
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#records.length === 0) return;
    if (this.#hasOutcome && purpose === 'checkpoint') {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'outcome_staged_before_jvm_stop' });
    }
    const firstSequence = this.#totalRecordCount - this.#records.length + 1;
    const lastSequence = this.#totalRecordCount;
    const segment = {
      schema: TRACE_SCHEMA_VERSION,
      run_id: this.#runId,
      first_sequence: String(firstSequence),
      last_sequence: String(lastSequence),
      records: this.#records,
      sha256: sha256Json(this.#records),
      trailer: { complete: true },
    };
    const contents = Buffer.from(canonicalJson(segment), 'utf8');
    if (contents.byteLength > MAX_TRACE_SEGMENT_BYTES
        || contents.byteLength > MAX_OWNED_FILE_BYTES
        || this.#stagedByteLength + contents.byteLength > MAX_EVIDENCE_BYTES) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'evidence_limit_exceeded' });
    }
    const segmentNumber = this.#segments.length + 1;
    const filename = `/trace-v2-${String(segmentNumber).padStart(6, '0')}.json`;
    const relativePath = Buffer.concat([this.#runDirectoryPath, Buffer.from(filename, 'ascii')]);
    const identity = await stageOwnedFile({
      helperPath: this.#helperPath,
      ownedRoot: this.#ownedRoot,
      relativePath,
      contents,
      maxBytes: MAX_TRACE_SEGMENT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    this.#segments.push(Object.freeze({ relativePath, identity, byteLength: contents.byteLength }));
    if (purpose !== 'complete') this.#checkpointSegmentCount += 1;
    this.#stagedByteLength += contents.byteLength;
    this.#records.length = 0;
    this.#recordBytes = 0;
  }

  #assertMutable(): void {
    if (this.#finalized !== undefined || this.#failureArtifact !== undefined) {
      throw new RunnerError('runtime_failure', 'run trace', { kind: 'trace_finalized' });
    }
  }

  #enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      try {
        return await operation();
      } catch (error) {
        this.#failure = error;
        throw error;
      }
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #enqueueRecovery<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function toTraceRecord(direction: 'runner' | 'plugin' | undefined, value: unknown): TraceRecord {
  const source = asRecord(value);
  const converted = toTraceValue(direction === undefined ? source : { direction, ...source });
  if (converted === null || typeof converted !== 'object' || Array.isArray(converted)) {
    throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_record' });
  }
  return converted as TraceRecord;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_record' });
  }
  return value as Record<string, unknown>;
}

function toTraceValue(value: unknown): StrictJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => toTraceValue(item));
  if (typeof value === 'object') {
    const result: Record<string, StrictJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      result[key] = toTraceValue(item);
    }
    return result;
  }
  throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_record_value' });
}

function copySegment(segment: RuntimeTraceSegment): RuntimeTraceSegment {
  return Object.freeze({
    relativePath: Buffer.from(segment.relativePath),
    identity: Object.freeze({ device: segment.identity.device, inode: segment.identity.inode }),
    byteLength: segment.byteLength,
  });
}

function copyTraceResult(result: RuntimeTraceResult): RuntimeTraceResult {
  return Object.freeze({
    segments: Object.freeze(result.segments.map(copySegment)),
    totalByteLength: result.totalByteLength,
  });
}

function copyFailureTraceResult(result: RuntimeFailureTraceResult): RuntimeFailureTraceResult {
  return Object.freeze({
    artifact: result.artifact,
    artifactPath: Buffer.from(result.artifactPath),
    artifactIdentity: Object.freeze({ ...result.artifactIdentity }),
    artifactByteLength: result.artifactByteLength,
  });
}

function parsePolicySequence(value: string, field: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_policy_sequence', field });
  }
  const sequence = BigInt(value);
  if (sequence > MAX_POLICY_SEQUENCE) {
    throw new RunnerError('runtime_failure', 'run trace', { kind: 'invalid_policy_sequence', field });
  }
  return sequence;
}
