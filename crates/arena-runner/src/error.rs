use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ErrorCategory {
    InvalidInput,
    MissingPrerequisite,
    CorruptEvidence,
    RuntimeFailure,
}

impl ErrorCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::MissingPrerequisite => "missing_prerequisite",
            Self::CorruptEvidence => "corrupt_evidence",
            Self::RuntimeFailure => "runtime_failure",
        }
    }

    fn exit_code(self) -> u8 {
        match self {
            Self::InvalidInput => 2,
            Self::MissingPrerequisite => 3,
            Self::CorruptEvidence => 5,
            Self::RuntimeFailure => 6,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ErrorSource {
    pub(crate) kind: &'static str,
    pub(crate) argument: Option<usize>,
    pub(crate) line: Option<usize>,
    pub(crate) column: Option<usize>,
    pub(crate) os_code: Option<i32>,
}

impl ErrorSource {
    pub(crate) fn kind(kind: &'static str) -> Self {
        Self { kind, argument: None, line: None, column: None, os_code: None }
    }

    pub(crate) fn argument(kind: &'static str, argument: usize) -> Self {
        Self { kind, argument: Some(argument), line: None, column: None, os_code: None }
    }

    pub(crate) fn json(&self) -> Value {
        let mut source = serde_json::Map::new();
        source.insert("kind".into(), json!(self.kind));
        if let Some(argument) = self.argument {
            source.insert("argument".into(), json!(argument));
        }
        if let Some(line) = self.line {
            source.insert("line".into(), json!(line));
        }
        if let Some(column) = self.column {
            source.insert("column".into(), json!(column));
        }
        if let Some(os_code) = self.os_code {
            source.insert("os_code".into(), json!(os_code));
        }
        Value::Object(source)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliError {
    category: ErrorCategory,
    resource: String,
    source: ErrorSource,
}

impl CliError {
    pub(crate) fn new(category: ErrorCategory, resource: String, source: ErrorSource) -> Self {
        Self { category, resource, source }
    }

    pub fn exit_code(&self) -> u8 {
        self.category.exit_code()
    }

    pub fn as_json(&self) -> String {
        json!({
            "error": {
                "category": self.category.as_str(),
                "resource": self.resource,
                "source": self.source.json(),
            }
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{CliError, ErrorCategory, ErrorSource};
    use serde_json::Value;

    #[test]
    fn maps_corrupt_evidence_to_documented_exit_code_without_error_text() {
        let error = CliError::new(
            ErrorCategory::CorruptEvidence,
            "trace segment argument 1".into(),
            ErrorSource::argument("checksum_mismatch", 1),
        );
        assert_eq!(error.exit_code(), 5);
        let json: Value = serde_json::from_str(&error.as_json()).unwrap();
        assert_eq!(json["error"]["category"], "corrupt_evidence");
        assert_eq!(json["error"]["source"]["kind"], "checksum_mismatch");
        assert!(json["error"].get("message").is_none());
    }
}
