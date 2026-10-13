use std::fs::OpenOptions;
use std::io::{self, Read};
use std::path::Path;

use arena_core::control::Sequence;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::error::{CliError, ErrorCategory, ErrorSource};

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64"),
)))]
compile_error!("arena-runner supports macOS arm64 and Linux x86_64");

const TRACE_SCHEMA_VERSION: u64 = 1;
const MAX_TRACE_BYTES: u64 = 8 * 1024 * 1024;
const TRACE_FIELDS: [&str; 7] = [
    "schema",
    "run_id",
    "first_sequence",
    "last_sequence",
    "records",
    "sha256",
    "trailer",
];

// Avoid blocking on a FIFO before the opened descriptor can be checked as regular.
#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0004;
#[cfg(target_os = "linux")]
const O_NONBLOCK: i32 = 0o4000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TraceSegment {
    pub(crate) run_id: String,
    pub(crate) first_sequence: Sequence,
    pub(crate) last_sequence: Sequence,
    pub(crate) records: Vec<Map<String, Value>>,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TraceError {
    InvalidJson { line: usize, column: usize },
    RootNotObject,
    MissingField(&'static str),
    UnknownField,
    UnsupportedSchema,
    InvalidField(&'static str),
    InvalidTrailer,
    InvalidSequenceRange,
    RecordCountMismatch { expected: u64, actual: u64 },
    InvalidChecksumFormat,
    ChecksumMismatch,
    NoSegments,
    RunIdMismatch,
    SegmentDiscontinuity,
}

impl TraceError {
    pub(crate) fn source(&self) -> ErrorSource {
        match self {
            Self::InvalidJson { line, column } => ErrorSource {
                kind: "invalid_json",
                argument: None,
                line: Some(*line),
                column: Some(*column),
                os_code: None,
            },
            Self::RootNotObject => ErrorSource::kind("trace_root_not_object"),
            Self::MissingField(field) => ErrorSource::kind(match *field {
                "schema" => "missing_schema",
                "run_id" => "missing_run_id",
                "first_sequence" => "missing_first_sequence",
                "last_sequence" => "missing_last_sequence",
                "records" => "missing_records",
                "sha256" => "missing_sha256",
                "trailer" => "missing_trailer",
                _ => "missing_field",
            }),
            Self::UnknownField => ErrorSource::kind("unknown_field"),
            Self::UnsupportedSchema => ErrorSource::kind("unsupported_schema"),
            Self::InvalidField(field) => ErrorSource::kind(match *field {
                "schema" => "invalid_schema",
                "run_id" => "invalid_run_id",
                "first_sequence" => "invalid_first_sequence",
                "last_sequence" => "invalid_last_sequence",
                "records" => "invalid_records",
                "sha256" => "invalid_sha256",
                _ => "invalid_field",
            }),
            Self::InvalidTrailer => ErrorSource::kind("invalid_completion_trailer"),
            Self::InvalidSequenceRange => ErrorSource::kind("invalid_sequence_range"),
            Self::RecordCountMismatch { .. } => ErrorSource::kind("record_sequence_count_mismatch"),
            Self::InvalidChecksumFormat => ErrorSource::kind("invalid_checksum_format"),
            Self::ChecksumMismatch => ErrorSource::kind("checksum_mismatch"),
            Self::NoSegments => ErrorSource::kind("no_segments"),
            Self::RunIdMismatch => ErrorSource::kind("run_id_mismatch"),
            Self::SegmentDiscontinuity => ErrorSource::kind("sequence_discontinuity"),
        }
    }
}

impl TraceSegment {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, TraceError> {
        let StrictValue(value) = serde_json::from_slice(bytes).map_err(|error| TraceError::InvalidJson {
            line: error.line(),
            column: error.column(),
        })?;
        let mut root = match value {
            Value::Object(root) => root,
            _ => return Err(TraceError::RootNotObject),
        };

        for field in root.keys() {
            if !TRACE_FIELDS.contains(&field.as_str()) {
                return Err(TraceError::UnknownField);
            }
        }
        for field in TRACE_FIELDS {
            if !root.contains_key(field) {
                return Err(TraceError::MissingField(field));
            }
        }

        let schema = root.remove("schema").and_then(|value| value.as_u64());
        if schema != Some(TRACE_SCHEMA_VERSION) {
            return Err(TraceError::UnsupportedSchema);
        }
        let run_id = root.remove("run_id").and_then(|value| value.as_str().map(str::to_owned));
        let Some(run_id) = run_id.filter(|run_id| !run_id.is_empty()) else {
            return Err(TraceError::InvalidField("run_id"));
        };
        let first_sequence = parse_sequence(root.remove("first_sequence"), "first_sequence")?;
        let last_sequence = parse_sequence(root.remove("last_sequence"), "last_sequence")?;
        let records_value = root.remove("records").ok_or(TraceError::MissingField("records"))?;
        let Value::Array(record_values) = records_value else {
            return Err(TraceError::InvalidField("records"));
        };
        let mut records = Vec::with_capacity(record_values.len());
        for value in record_values {
            let Value::Object(record) = value else {
                return Err(TraceError::InvalidField("records"));
            };
            records.push(record);
        }
        let sha256 = root.remove("sha256").and_then(|value| value.as_str().map(str::to_owned));
        let Some(sha256) = sha256 else {
            return Err(TraceError::InvalidField("sha256"));
        };
        if !is_lower_hex_sha256(&sha256) {
            return Err(TraceError::InvalidChecksumFormat);
        }
        if !valid_trailer(root.remove("trailer")) {
            return Err(TraceError::InvalidTrailer);
        }

        let range_length = last_sequence
            .get()
            .checked_sub(first_sequence.get())
            .and_then(|difference| difference.checked_add(1))
            .ok_or(TraceError::InvalidSequenceRange)?;
        let record_count = u64::try_from(records.len()).map_err(|_| TraceError::InvalidSequenceRange)?;
        if range_length != record_count {
            return Err(TraceError::RecordCountMismatch { expected: range_length, actual: record_count });
        }
        if sha256_records(&records)? != sha256 {
            return Err(TraceError::ChecksumMismatch);
        }

        Ok(Self { run_id, first_sequence, last_sequence, records, sha256 })
    }
}

// serde_json::Value overwrites duplicate object names, so validate uniqueness while decoding.
struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value without duplicate object names")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(Number::from(value))))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(Number::from(value))))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .map(StrictValue)
            .ok_or_else(|| E::custom("invalid JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(StrictValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(StrictValue(value)) = sequence.next_element()? {
            values.push(value);
        }
        Ok(StrictValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let StrictValue(value) = object.next_value()?;
            values.insert(key, value);
        }
        Ok(StrictValue(Value::Object(values)))
    }
}

fn parse_sequence(value: Option<Value>, field: &'static str) -> Result<Sequence, TraceError> {
    let value = value.and_then(|value| value.as_u64()).ok_or(TraceError::InvalidField(field))?;
    Sequence::try_from(value).map_err(|_| TraceError::InvalidField(field))
}

fn valid_trailer(value: Option<Value>) -> bool {
    let Some(Value::Object(mut trailer)) = value else {
        return false;
    };
    if trailer.len() != 1 {
        return false;
    }
    trailer.remove("complete") == Some(Value::Bool(true))
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_records(records: &[Map<String, Value>]) -> Result<String, TraceError> {
    let bytes = serde_json::to_vec(records).map_err(|_| TraceError::InvalidField("records"))?;
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut result, "{byte:02x}").map_err(|_| TraceError::InvalidField("sha256"))?;
    }
    Ok(result)
}

pub(crate) fn read_segment(path: &Path, argument: usize) -> Result<TraceSegment, CliError> {
    let resource = format!("trace segment argument {argument}");
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(O_NONBLOCK);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| map_io_error(&resource, argument, error))?;
    let metadata = file.metadata().map_err(|error| map_io_error(&resource, argument, error))?;
    if !metadata.is_file() {
        return Err(CliError::new(
            ErrorCategory::CorruptEvidence,
            resource,
            ErrorSource::argument("not_a_regular_file", argument),
        ));
    }
    if metadata.len() > MAX_TRACE_BYTES {
        return Err(CliError::new(
            ErrorCategory::CorruptEvidence,
            resource,
            ErrorSource::argument("segment_too_large", argument),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let read_result = file.take(MAX_TRACE_BYTES + 1).read_to_end(&mut bytes);
    if let Err(error) = read_result {
        return Err(map_io_error(&resource, argument, error));
    }
    if bytes.len() as u64 > MAX_TRACE_BYTES {
        return Err(CliError::new(
            ErrorCategory::CorruptEvidence,
            resource,
            ErrorSource::argument("segment_too_large", argument),
        ));
    }
    TraceSegment::parse(&bytes).map_err(|error| {
        let mut source = error.source();
        source.argument = Some(argument);
        CliError::new(ErrorCategory::CorruptEvidence, resource, source)
    })
}

fn map_io_error(resource: &str, argument: usize, error: io::Error) -> CliError {
    let category = match error.kind() {
        io::ErrorKind::NotFound => ErrorCategory::MissingPrerequisite,
        io::ErrorKind::PermissionDenied => ErrorCategory::RuntimeFailure,
        _ => ErrorCategory::RuntimeFailure,
    };
    let mut source = ErrorSource::argument("io", argument);
    source.os_code = error.raw_os_error();
    CliError::new(category, resource.to_owned(), source)
}

#[cfg(test)]
mod tests {
    use super::{MAX_TRACE_BYTES, TRACE_FIELDS, TRACE_SCHEMA_VERSION, TraceError, TraceSegment};

    const VALID: &str = r#"{"schema":1,"run_id":"fixture","first_sequence":1,"last_sequence":1,"records":[{"a":1}],"sha256":"b713f6d2a989e907c58516a7c8bb487792c8785ddbf367b80dc774bf33b85a85","trailer":{"complete":true}}"#;

    #[test]
    fn trace_constants_match_the_integrator_owned_schema() {
        let schema: serde_json::Value = serde_json::from_str(include_str!("../../../schemas/trace.schema.json")).unwrap();
        assert_eq!(schema["properties"]["schema"]["const"], TRACE_SCHEMA_VERSION);
        assert_eq!(schema["additionalProperties"], false);
        let mut required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| field.as_str().unwrap())
            .collect();
        required.sort_unstable();
        let mut implementation: Vec<&str> = TRACE_FIELDS.to_vec();
        implementation.sort_unstable();
        assert_eq!(required, implementation);
        assert_eq!(MAX_TRACE_BYTES, 8 * 1024 * 1024);
        assert!(include_str!("../../../docs/operations.md").contains("8 MiB per segment"));
    }

    #[test]
    fn parses_schema_one_and_checks_record_sequence_count_and_checksum() {
        let segment = TraceSegment::parse(VALID.as_bytes()).unwrap();
        assert_eq!(segment.run_id, "fixture");
        assert_eq!(segment.first_sequence.get(), 1);
        assert_eq!(segment.last_sequence.get(), 1);
        assert_eq!(segment.records.len(), 1);
    }

    #[test]
    fn rejects_duplicate_names_at_every_object_depth() {
        let duplicate_envelope = VALID.replace("\"schema\":1", "\"schema\":1,\"schema\":1");
        let duplicate_trailer = VALID.replace("\"complete\":true", "\"complete\":true,\"complete\":true");
        let duplicate_record = VALID.replace("\"a\":1", "\"a\":1,\"a\":1");
        for invalid in [duplicate_envelope, duplicate_trailer, duplicate_record] {
            assert!(matches!(TraceSegment::parse(invalid.as_bytes()), Err(TraceError::InvalidJson { .. })));
        }
    }

    #[test]
    fn rejects_unknown_envelope_fields() {
        let invalid = VALID.replace("\"schema\":1", "\"schema\":1,\"extra\":true");
        assert!(matches!(TraceSegment::parse(invalid.as_bytes()), Err(TraceError::UnknownField)));
    }

    #[test]
    fn rejects_unsupported_schema_versions() {
        let invalid = VALID.replace("\"schema\":1", "\"schema\":2");
        assert_eq!(TraceSegment::parse(invalid.as_bytes()), Err(TraceError::UnsupportedSchema));
    }

    #[test]
    fn rejects_incomplete_or_extended_trailers() {
        let incomplete = VALID.replace("\"complete\":true", "\"complete\":false");
        assert_eq!(TraceSegment::parse(incomplete.as_bytes()), Err(TraceError::InvalidTrailer));
        let extended = VALID.replace("\"complete\":true", "\"complete\":true,\"extra\":0");
        assert_eq!(TraceSegment::parse(extended.as_bytes()), Err(TraceError::InvalidTrailer));
    }

    #[test]
    fn rejects_gaps_in_declared_sequence_coverage() {
        let invalid = VALID.replace("\"last_sequence\":1", "\"last_sequence\":2");
        assert_eq!(
            TraceSegment::parse(invalid.as_bytes()),
            Err(TraceError::RecordCountMismatch { expected: 2, actual: 1 })
        );
    }

    #[test]
    fn rejects_checksum_mismatch() {
        let invalid = VALID.replace("b713f6d2", "c713f6d2");
        assert_eq!(TraceSegment::parse(invalid.as_bytes()), Err(TraceError::ChecksumMismatch));
    }
}
