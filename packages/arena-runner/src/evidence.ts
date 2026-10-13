import { canonicalJson } from './canonical.js';
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
  return {
    schema: 1,
    run_id: evidence.run_id,
    sequence_range: { first: evidence.first_sequence, last: evidence.last_sequence },
    segment_count: evidence.segments.length,
    record_count: evidence.records.length,
    records: evidence.records,
    outcome: null,
    outcome_status: 'unavailable_without_authoritative_event_contract',
  };
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
