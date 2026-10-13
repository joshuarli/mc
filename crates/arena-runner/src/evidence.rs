use serde_json::{Map, Value, json};

use crate::trace::{TraceError, TraceSegment};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SegmentSummary {
    pub(crate) first_sequence: u64,
    pub(crate) last_sequence: u64,
    pub(crate) record_count: usize,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Evidence {
    pub(crate) run_id: String,
    pub(crate) first_sequence: u64,
    pub(crate) last_sequence: u64,
    pub(crate) segments: Vec<SegmentSummary>,
    pub(crate) records: Vec<Map<String, Value>>,
}

impl Evidence {
    pub(crate) fn inspect_json(&self) -> Value {
        let segments: Vec<Value> = self
            .segments
            .iter()
            .map(|segment| {
                json!({
                    "first_sequence": segment.first_sequence,
                    "last_sequence": segment.last_sequence,
                    "record_count": segment.record_count,
                    "sha256": segment.sha256,
                })
            })
            .collect();
        json!({
            "schema": 1,
            "run_id": self.run_id,
            "sequence_range": {
                "first": self.first_sequence,
                "last": self.last_sequence,
            },
            "segments": segments,
            "record_count": self.records.len(),
            "records": self.records,
        })
    }

    pub(crate) fn report_json(&self) -> Value {
        json!({
            "schema": 1,
            "run_id": self.run_id,
            "sequence_range": {
                "first": self.first_sequence,
                "last": self.last_sequence,
            },
            "segment_count": self.segments.len(),
            "record_count": self.records.len(),
            "records": self.records,
            "outcome": null,
            "outcome_status": "unavailable_without_authoritative_event_contract",
        })
    }

    pub(crate) fn semantically_equal(&self, other: &Self) -> bool {
        self.first_sequence == other.first_sequence
            && self.last_sequence == other.last_sequence
            && self.records == other.records
    }

    pub(crate) fn comparison_json(&self, other: &Self) -> Value {
        json!({
            "schema": 1,
            "comparison": "exact_ordered_records_and_sequence_range",
            "run_ids_compared": false,
            "equal": self.semantically_equal(other),
            "left": {
                "sequence_range": {
                    "first": self.first_sequence,
                    "last": self.last_sequence,
                },
                "segment_count": self.segments.len(),
                "record_count": self.records.len(),
            },
            "right": {
                "sequence_range": {
                    "first": other.first_sequence,
                    "last": other.last_sequence,
                },
                "segment_count": other.segments.len(),
                "record_count": other.records.len(),
            },
        })
    }
}

pub(crate) fn reconstruct(mut segments: Vec<TraceSegment>) -> Result<Evidence, TraceError> {
    if segments.is_empty() {
        return Err(TraceError::NoSegments);
    }
    segments.sort_by_key(|segment| segment.first_sequence.get());
    let run_id = segments[0].run_id.clone();
    if segments.iter().any(|segment| segment.run_id != run_id) {
        return Err(TraceError::RunIdMismatch);
    }
    for pair in segments.windows(2) {
        let expected_first = pair[0]
            .last_sequence
            .get()
            .checked_add(1)
            .ok_or(TraceError::InvalidSequenceRange)?;
        if pair[1].first_sequence.get() != expected_first {
            return Err(TraceError::SegmentDiscontinuity);
        }
    }
    let first_sequence = segments[0].first_sequence.get();
    let last_sequence = segments.last().ok_or(TraceError::NoSegments)?.last_sequence.get();
    let mut summaries = Vec::with_capacity(segments.len());
    let mut records = Vec::new();
    for segment in segments {
        summaries.push(SegmentSummary {
            first_sequence: segment.first_sequence.get(),
            last_sequence: segment.last_sequence.get(),
            record_count: segment.records.len(),
            sha256: segment.sha256,
        });
        records.extend(segment.records);
    }
    Ok(Evidence { run_id, first_sequence, last_sequence, segments: summaries, records })
}

#[cfg(test)]
mod tests {
    use super::reconstruct;
    use crate::trace::{TraceError, TraceSegment};

    const SEGMENT_1: &str = r#"{"schema":1,"run_id":"fixture","first_sequence":1,"last_sequence":1,"records":[{"a":1}],"sha256":"b713f6d2a989e907c58516a7c8bb487792c8785ddbf367b80dc774bf33b85a85","trailer":{"complete":true}}"#;
    const SEGMENT_2: &str = r#"{"schema":1,"run_id":"fixture","first_sequence":2,"last_sequence":2,"records":[{"b":2}],"sha256":"e3c77c410917eec55f1d8faa000d1af356ca3ca284a8aa21deffe73580d700ae","trailer":{"complete":true}}"#;

    #[test]
    fn reconstructs_adjacent_segments_in_sequence_order() {
        let first = TraceSegment::parse(SEGMENT_1.as_bytes()).unwrap();
        let second = TraceSegment::parse(SEGMENT_2.as_bytes()).unwrap();
        let evidence = reconstruct(vec![second, first]).unwrap();
        assert_eq!((evidence.first_sequence, evidence.last_sequence), (1, 2));
        assert_eq!(evidence.records.len(), 2);
        assert_eq!(evidence.records[0].get("a").unwrap(), 1);
        assert_eq!(evidence.records[1].get("b").unwrap(), 2);
    }

    #[test]
    fn rejects_run_changes_and_sequence_gaps() {
        let first = TraceSegment::parse(SEGMENT_1.as_bytes()).unwrap();
        let gap = SEGMENT_2.replace("\"first_sequence\":2", "\"first_sequence\":3").replace("\"last_sequence\":2", "\"last_sequence\":3");
        let gap = TraceSegment::parse(gap.as_bytes()).unwrap();
        assert_eq!(reconstruct(vec![first.clone(), gap]), Err(TraceError::SegmentDiscontinuity));

        let other_run = SEGMENT_2.replace("\"run_id\":\"fixture\"", "\"run_id\":\"other\"");
        let other_run = TraceSegment::parse(other_run.as_bytes()).unwrap();
        assert_eq!(reconstruct(vec![first, other_run]), Err(TraceError::RunIdMismatch));
    }
}
