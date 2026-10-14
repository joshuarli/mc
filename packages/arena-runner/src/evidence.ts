import { canonicalJson } from './canonical.js';
import { ControlCodecError, decodeControlEnvelope } from './control/index.js';
import type { ControlMessage, PreparePayload } from './control/types.js';
import { actionFunnelReport } from './funnel-report.js';
import { reconstructEventResult, type EventDerivedResult } from './event-report.js';
import { MAX_EVIDENCE_BYTES, TraceError, type TraceRecord, type TraceSegment } from './trace.js';

const MAX_SEQUENCE = (1n << 64n) - 1n;

export interface SegmentSummary {
  readonly first_sequence: string;
  readonly last_sequence: string;
  readonly record_count: number;
  readonly sha256: string;
}

export interface Evidence {
  readonly run_id: string;
  readonly first_sequence: string;
  readonly last_sequence: string;
  readonly segments: readonly SegmentSummary[];
  readonly records: readonly TraceRecord[];
}

export interface ReconstructedRunEvidence {
  readonly report: EventDerivedResult;
  readonly players: readonly {
    readonly username: string;
    readonly offlineUuid: string;
  }[];
}

export function reconstruct(segments: readonly TraceSegment[]): Evidence {
  if (segments.length === 0) throw evidenceFailure('no_segments');

  const ordered = [...segments].sort((left, right) => compareBigInt(left.firstSequence, right.firstSequence));
  let byteLength = 0;
  for (const segment of ordered) {
    if (segment.byteLength > MAX_EVIDENCE_BYTES - byteLength) throw evidenceFailure('evidence_set_too_large');
    byteLength += segment.byteLength;
  }
  const runId = ordered[0]!.runId;
  if (ordered.some((segment) => segment.runId !== runId)) throw evidenceFailure('run_id_mismatch');

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.lastSequence === MAX_SEQUENCE) throw evidenceFailure('invalid_sequence_range');
    if (current.firstSequence !== previous.lastSequence + 1n) throw evidenceFailure('sequence_discontinuity');
  }

  const firstSequence = ordered[0]!.firstSequence;
  const lastSequence = ordered[ordered.length - 1]!.lastSequence;
  const summaries = ordered.map((segment): SegmentSummary => ({
    first_sequence: segment.firstSequence.toString(),
    last_sequence: segment.lastSequence.toString(),
    record_count: segment.records.length,
    sha256: segment.sha256,
  }));
  const records = ordered.flatMap((segment) => segment.records);
  return {
    run_id: runId,
    first_sequence: firstSequence.toString(),
    last_sequence: lastSequence.toString(),
    segments: summaries,
    records,
  };
}

export function inspectJson(evidence: Evidence): object {
  return {
    schema: 1,
    run_id: evidence.run_id,
    sequence_range: { first: evidence.first_sequence, last: evidence.last_sequence },
    segments: evidence.segments,
    record_count: evidence.records.length,
    records: evidence.records,
  };
}

export function reportJson(evidence: Evidence): object {
  const { report } = reconstructRunEvidence(evidence);
  const funnel = actionFunnelReport(evidence);
  return {
    ...(funnel === undefined ? {} : { action_funnel: funnel }),
    schema: 1,
    run_id: evidence.run_id,
    sequence_range: { first: evidence.first_sequence, last: evidence.last_sequence },
    segment_count: evidence.segments.length,
    record_count: evidence.records.length,
    records: evidence.records,
    ...report,
  };
}

export function reconstructRunEvidence(evidence: Evidence): ReconstructedRunEvidence {
  let readySeen = false;
  let civilizationCapability = false;
  let prepare: PreparePayload | undefined;
  let outcomeSeen = false;
  let startSeen = false;
  let abortSeen = false;
  let pendingRunnerCommand: { readonly type: 'prepare' | 'start' | 'abort'; readonly sequence: bigint } | undefined;
  let lastAcknowledgedRunnerSequence = 0n;
  const lastSequence = new Map<'runner' | 'plugin', bigint>();
  const events: ControlMessage[] = [];

  for (const [index, record] of evidence.records.entries()) {
    const recordNumber = index + 1;
    if (record.schema === 'policy-replay-v1' || record.schema === 'policy-replay-v2' || record.schema === 'policy-replay-v3' || record.schema === 'policy-effect-v1' || record.schema === 'civilization-policy-replay-v1'
        || record.schema === 'civilization-policy-effect-v1' || record.schema === 'action-funnel-v1'
        || record.schema === 'worker-topology-v1' || record.schema === 'worker-loss-v1') continue;
    const direction = record.direction;
    if (direction !== 'runner' && direction !== 'plugin') {
      throw eventRecordFailure('invalid_event_direction', recordNumber);
    }
    const envelope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'direction') envelope[key] = value;
    }

    let message: ControlMessage;
    try {
      message = decodeControlEnvelope(canonicalJson(envelope));
    } catch (error) {
      if (error instanceof ControlCodecError) {
        throw eventRecordFailure('invalid_control_event', recordNumber, error.path ?? undefined);
      }
      throw error;
    }
    if (message.run_id !== evidence.run_id) throw eventRecordFailure('event_run_id_mismatch', recordNumber);
    const previousSequence = lastSequence.get(direction) ?? 0n;
    if (message.sequence <= previousSequence) throw eventRecordFailure('event_sequence_not_increasing', recordNumber);
    lastSequence.set(direction, message.sequence);

    if (!readySeen) {
      if (recordNumber !== 1 || direction !== 'plugin' || message.type !== 'ready') {
        throw eventRecordFailure('readiness_missing_or_out_of_order', recordNumber);
      }
      readySeen = true;
      civilizationCapability = message.payload.capabilities.includes('civilization_v1');
      if (message.correlation === undefined) throw eventRecordFailure('invalid_readiness_correlation', recordNumber);
      lastSequence.set('runner', message.correlation);
      lastAcknowledgedRunnerSequence = message.correlation;
      continue;
    }

    if (direction === 'runner') {
      if (message.correlation !== undefined || pendingRunnerCommand !== undefined) {
        throw eventRecordFailure('invalid_runner_command_correlation', recordNumber);
      }
      if (message.type === 'prepare') {
        if (prepare !== undefined || events.length > 0 || startSeen || abortSeen) {
          throw eventRecordFailure('unexpected_runner_event', recordNumber);
        }
        if (message.payload.mode === 'civilization' && !civilizationCapability) {
          throw eventRecordFailure('unsupported_civilization_capability', recordNumber);
        }
        prepare = message.payload;
        pendingRunnerCommand = { type: message.type, sequence: message.sequence };
        continue;
      }
      if (message.type === 'start') {
        if (prepare === undefined || startSeen || abortSeen || outcomeSeen) {
          throw eventRecordFailure('unexpected_runner_event', recordNumber);
        }
        startSeen = true;
        pendingRunnerCommand = { type: message.type, sequence: message.sequence };
        continue;
      }
      if (message.type === 'abort') {
        if (prepare === undefined || abortSeen || outcomeSeen) {
          throw eventRecordFailure('unexpected_runner_event', recordNumber);
        }
        abortSeen = true;
        pendingRunnerCommand = { type: message.type, sequence: message.sequence };
        continue;
      }
      throw eventRecordFailure('unexpected_runner_event', recordNumber);
    }

    if (message.type === 'ready') throw eventRecordFailure('repeated_readiness', recordNumber);
    if (message.type === 'ack' || message.type === 'error') {
      if (pendingRunnerCommand === undefined || message.correlation !== pendingRunnerCommand.sequence
          || message.correlation <= lastAcknowledgedRunnerSequence) {
        throw eventRecordFailure('invalid_command_acknowledgment', recordNumber);
      }
      lastAcknowledgedRunnerSequence = message.correlation;
      pendingRunnerCommand = undefined;
    } else if (message.correlation !== undefined) {
      throw eventRecordFailure('unexpected_event_correlation', recordNumber);
    }
    if (outcomeSeen) throw eventRecordFailure('event_after_outcome', recordNumber);
    if (message.type === 'build_progress' || message.type === 'ack') continue;
    if (message.type === 'error') throw eventRecordFailure('plugin_reported_error', recordNumber);
    if (message.type === 'heartbeat' || message.type === 'metrics') continue;
    if (prepare === undefined) throw eventRecordFailure('prepare_context_missing', recordNumber);
    const authoritativeEvent = message.type === 'public_clock' || message.type === 'public_state'
      || message.type === 'elimination' || message.type === 'civilization_state' || message.type === 'outcome';
    if (authoritativeEvent && pendingRunnerCommand !== undefined) {
      const inFlightBeforeAbort = pendingRunnerCommand.type === 'abort'
        && (message.type === 'public_state' || message.type === 'civilization_state' || message.type === 'elimination'
          || (message.type === 'public_clock' && message.payload.phase !== 'aborted' && message.payload.phase !== 'finished'));
      if (!inFlightBeforeAbort) throw eventRecordFailure('event_before_command_acknowledgment', recordNumber);
    }
    if (message.type === 'civilization_state' || message.type === 'public_state' || message.type === 'elimination'
        || (message.type === 'public_clock' && message.payload.phase !== 'waiting' && message.payload.phase !== 'aborted')
        || (message.type === 'outcome' && message.payload.kind !== 'abort')) {
      if (!startSeen) throw eventRecordFailure('event_before_start', recordNumber);
    }
    if (message.type === 'outcome') outcomeSeen = true;
    if (message.type === 'public_clock' || message.type === 'public_state'
        || message.type === 'civilization_state' || message.type === 'elimination' || message.type === 'outcome') {
      events.push(message);
      continue;
    }
    throw eventRecordFailure('unexpected_plugin_event', recordNumber);
  }

  if (!readySeen) throw eventRecordFailure('readiness_missing');
  if (prepare === undefined) throw eventRecordFailure('prepare_context_missing');
  if (pendingRunnerCommand !== undefined) throw eventRecordFailure('unacknowledged_runner_command');
  if (!outcomeSeen) throw eventRecordFailure('missing_terminal_outcome');
  const report = reconstructEventResult(evidence.run_id, prepare, events);
  return {
    report,
    players: prepare.roster.map((competitor) => ({
      username: competitor.username,
      offlineUuid: competitor.offline_uuid,
    })),
  };
}

function eventRecordFailure(kind: string, record?: number, field?: string): TraceError {
  return new TraceError({
    kind,
    ...(record === undefined ? {} : { record }),
    ...(field === undefined ? {} : { field }),
  });
}

export function comparisonJson(left: Evidence, right: Evidence): object {
  return {
    schema: 1,
    comparison: 'exact_ordered_records_and_sequence_range',
    run_ids_compared: false,
    equal: left.first_sequence === right.first_sequence
      && left.last_sequence === right.last_sequence
      && canonicalJson(left.records) === canonicalJson(right.records),
    left: comparisonSummary(left),
    right: comparisonSummary(right),
  };
}

function comparisonSummary(evidence: Evidence): object {
  return {
    sequence_range: { first: evidence.first_sequence, last: evidence.last_sequence },
    segment_count: evidence.segments.length,
    record_count: evidence.records.length,
  };
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceFailure(kind: string): TraceError {
  return new TraceError({ kind });
}
