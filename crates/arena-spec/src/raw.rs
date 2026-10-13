use std::collections::BTreeMap;

use toml_edit::{Array, ArrayOfTables, Document, InlineTable, Item, Table, Value};

use crate::error::{SpecError, SpecErrorKind};

#[derive(Debug)]
pub(crate) struct RawEntry {
    value: RawValue,
    source_location: Option<crate::SourceLocation>,
}

pub(crate) type RawTable = BTreeMap<String, RawEntry>;

#[derive(Debug)]
pub(crate) enum RawValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Array(Vec<RawValue>),
    Table(RawTable),
    Other,
}

pub(crate) fn parse_document(source: &str, document: &str) -> Result<RawValue, SpecError> {
    let parsed = Document::parse(source.to_owned())
        .map_err(|error| SpecError::syntax(document, error))?;
    table_to_raw(parsed.as_table(), source).map(RawValue::Table)
}

fn table_to_raw(table: &Table, source: &str) -> Result<RawTable, SpecError> {
    table
        .iter()
        .map(|(key, value)| {
            let source_location = table
                .key(key)
                .and_then(|key| key.span())
                .map(|span| source_location(source, span.start));
            Ok((
                key.to_owned(),
                RawEntry {
                    value: item_to_raw(value, source)?,
                    source_location,
                },
            ))
        })
        .collect()
}

fn inline_table_to_raw(table: &InlineTable, source: &str) -> Result<RawTable, SpecError> {
    table
        .iter()
        .map(|(key, value)| {
            let source_location = table
                .key(key)
                .and_then(|key| key.span())
                .map(|span| source_location(source, span.start));
            Ok((
                key.to_owned(),
                RawEntry {
                    value: value_to_raw(value, source)?,
                    source_location,
                },
            ))
        })
        .collect()
}

fn array_to_raw(array: &Array, source: &str) -> Result<Vec<RawValue>, SpecError> {
    array.iter().map(|value| value_to_raw(value, source)).collect()
}

fn array_of_tables_to_raw(array: &ArrayOfTables, source: &str) -> Result<Vec<RawValue>, SpecError> {
    array
        .iter()
        .map(|table| table_to_raw(table, source).map(RawValue::Table))
        .collect()
}

fn item_to_raw(item: &Item, source: &str) -> Result<RawValue, SpecError> {
    match item {
        Item::None => Ok(RawValue::Other),
        Item::Value(value) => value_to_raw(value, source),
        Item::Table(table) => table_to_raw(table, source).map(RawValue::Table),
        Item::ArrayOfTables(tables) => array_of_tables_to_raw(tables, source).map(RawValue::Array),
    }
}

fn value_to_raw(value: &Value, source: &str) -> Result<RawValue, SpecError> {
    match value {
        Value::String(value) => Ok(RawValue::String(value.value().to_owned())),
        Value::Integer(value) => Ok(RawValue::Integer(*value.value())),
        Value::Float(value) => Ok(RawValue::Float(*value.value())),
        Value::Boolean(value) => Ok(RawValue::Boolean(*value.value())),
        Value::Datetime(_) => Ok(RawValue::Other),
        Value::Array(array) => array_to_raw(array, source).map(RawValue::Array),
        Value::InlineTable(table) => inline_table_to_raw(table, source).map(RawValue::Table),
    }
}

fn source_location(source: &str, offset: usize) -> crate::SourceLocation {
    let prefix = &source[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or(prefix)
        .chars()
        .count()
        + 1;
    crate::SourceLocation::new(line, column)
}

pub(crate) fn as_table<'a>(value: &'a RawValue, path: &str) -> Result<&'a RawTable, SpecError> {
    match value {
        RawValue::Table(table) => Ok(table),
        _ => Err(type_error(path, "table")),
    }
}

pub(crate) fn as_array<'a>(value: &'a RawValue, path: &str) -> Result<&'a [RawValue], SpecError> {
    match value {
        RawValue::Array(array) => Ok(array),
        _ => Err(type_error(path, "array")),
    }
}

pub(crate) fn field<'a>(
    table: &'a RawTable,
    key: &str,
    path: &str,
) -> Result<&'a RawValue, SpecError> {
    table
        .get(key)
        .map(|entry| &entry.value)
        .ok_or_else(|| SpecError::new(SpecErrorKind::MissingField, format!("{path}.{key}"), "required field is missing"))
}

pub(crate) fn check_fields(
    table: &RawTable,
    allowed: &[&str],
    required: &[&str],
    path: &str,
) -> Result<(), SpecError> {
    for (key, entry) in table {
        if !allowed.contains(&key.as_str()) {
            let error = SpecError::new(
                SpecErrorKind::UnknownField,
                format!("{path}.{key}"),
                "unknown field",
            );
            return Err(match entry.source_location {
                Some(location) => error.with_source_location(location),
                None => error,
            });
        }
    }
    for key in required {
        if !table.contains_key(*key) {
            return Err(SpecError::new(
                SpecErrorKind::MissingField,
                format!("{path}.{key}"),
                "required field is missing",
            ));
        }
    }
    Ok(())
}

pub(crate) fn string(value: &RawValue, path: &str) -> Result<String, SpecError> {
    match value {
        RawValue::String(value) if !value.is_empty() => Ok(value.clone()),
        RawValue::String(_) => Err(SpecError::new(SpecErrorKind::InvalidValue, path, "must not be empty")),
        _ => Err(type_error(path, "string")),
    }
}

pub(crate) fn integer(value: &RawValue, path: &str) -> Result<i64, SpecError> {
    match value {
        RawValue::Integer(value) => Ok(*value),
        _ => Err(type_error(path, "integer")),
    }
}

pub(crate) fn number(value: &RawValue, path: &str) -> Result<f64, SpecError> {
    let value = match value {
        RawValue::Integer(value) => *value as f64,
        RawValue::Float(value) => *value,
        _ => return Err(type_error(path, "number")),
    };
    if !value.is_finite() {
        return Err(SpecError::new(SpecErrorKind::Range, path, "must be finite"));
    }
    Ok(value)
}

pub(crate) fn boolean(value: &RawValue, path: &str) -> Result<bool, SpecError> {
    match value {
        RawValue::Boolean(value) => Ok(*value),
        _ => Err(type_error(path, "boolean")),
    }
}

fn type_error(path: &str, expected: &str) -> SpecError {
    SpecError::new(
        SpecErrorKind::InvalidValue,
        path,
        format!("must be a {expected}"),
    )
}
