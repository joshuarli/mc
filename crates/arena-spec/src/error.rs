use std::{error::Error, fmt};

/// The kind of invalid input found while compiling a scenario or map.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpecErrorKind {
    Syntax,
    UnknownField,
    MissingField,
    InvalidValue,
    Range,
    Conflict,
    Geometry,
    ResourceLimit,
}

/// A one-based TOML source position.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceLocation {
    line: usize,
    column: usize,
}

impl SourceLocation {
    pub(crate) const fn new(line: usize, column: usize) -> Self {
        Self { line, column }
    }

    /// Returns the one-based source line.
    pub const fn line(self) -> usize {
        self.line
    }

    /// Returns the one-based character column.
    pub const fn column(self) -> usize {
        self.column
    }
}

/// A source-aware specification failure suitable for CLI or API presentation.
#[derive(Debug)]
pub struct SpecError {
    kind: SpecErrorKind,
    path: String,
    source_location: Option<SourceLocation>,
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl SpecError {
    pub(crate) fn new(kind: SpecErrorKind, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind,
            path: path.into(),
            source_location: None,
            message: message.into(),
            source: None,
        }
    }

    pub(crate) fn syntax(
        document: &str,
        error: toml_edit::TomlError,
    ) -> Self {
        let message = error.to_string();
        Self {
            kind: SpecErrorKind::Syntax,
            path: document.to_owned(),
            source_location: None,
            message,
            source: Some(Box::new(error)),
        }
    }

    pub(crate) fn with_source_location(mut self, location: SourceLocation) -> Self {
        self.source_location = Some(location);
        self
    }

    /// Returns the structured input failure category.
    pub const fn kind(&self) -> SpecErrorKind {
        self.kind
    }

    /// Returns the scenario, map, or field path associated with the failure.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Returns the source position when the failure maps to an input token.
    pub const fn source_location(&self) -> Option<SourceLocation> {
        self.source_location
    }
}

impl fmt::Display for SpecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.source_location {
            Some(location) => write!(formatter, "{}:{}: {}: {}", location.line, location.column, self.path, self.message),
            None => write!(formatter, "{}: {}", self.path, self.message),
        }
    }
}

impl Error for SpecError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}
