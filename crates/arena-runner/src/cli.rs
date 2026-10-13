use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::evidence::{Evidence, reconstruct};
use crate::error::{CliError, ErrorCategory, ErrorSource};
use crate::trace::{TraceError, TraceSegment, read_segment};

pub fn run(args: impl IntoIterator<Item = OsString>) -> Result<String, CliError> {
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        return Err(invalid_input("missing_command"));
    };
    if command == OsStr::new("--help") || command == OsStr::new("help") {
        if args.next().is_some() {
            return Err(invalid_input("unexpected_argument"));
        }
        return Ok(output(help_json()));
    }
    match command.to_str() {
        Some("doctor") => {
            if args.next().is_some() {
                return Err(invalid_input("unexpected_argument"));
            }
            Ok(output(doctor_json()))
        }
        Some("inspect") => {
            let evidence = load_evidence(args)?;
            Ok(output(evidence.inspect_json()))
        }
        Some("report") => {
            let evidence = load_evidence(args)?;
            Ok(output(evidence.report_json()))
        }
        Some("compare") => {
            let paths = collect_paths(args);
            if paths.len() != 2 {
                return Err(invalid_input("compare_requires_two_trace_sets"));
            }
            let left = load_path_set(&paths[0], 1)?;
            let right = load_path_set(&paths[1], 2)?;
            Ok(output(left.comparison_json(&right)))
        }
        Some(_) | None => Err(invalid_input("unknown_command")),
    }
}

fn load_evidence(args: impl IntoIterator<Item = OsString>) -> Result<Evidence, CliError> {
    let paths = collect_paths(args);
    if paths.is_empty() {
        return Err(invalid_input("trace_path_required"));
    }
    load_segments(&paths)
}

fn collect_paths(args: impl IntoIterator<Item = OsString>) -> Vec<PathBuf> {
    args.into_iter().map(PathBuf::from).collect()
}

fn load_path_set(path: &PathBuf, set_number: usize) -> Result<Evidence, CliError> {
    let segments = read_segment(path, set_number)?;
    reconstruct(vec![segments]).map_err(|error| evidence_error(format!("trace set {set_number}"), error))
}

fn load_segments(paths: &[PathBuf]) -> Result<Evidence, CliError> {
    let mut segments: Vec<TraceSegment> = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        segments.push(read_segment(path, index + 1)?);
    }
    reconstruct(segments).map_err(|error| evidence_error("trace segment set".into(), error))
}

fn evidence_error(resource: String, error: TraceError) -> CliError {
    CliError::new(ErrorCategory::CorruptEvidence, resource, error.source())
}

fn invalid_input(kind: &'static str) -> CliError {
    CliError::new(ErrorCategory::InvalidInput, "command line arguments".into(), ErrorSource::kind(kind))
}

fn output(value: Value) -> String {
    value.to_string()
}

fn help_json() -> Value {
    json!({
        "schema": 1,
        "commands": {
            "doctor": "Report offline evidence capabilities and parked integrations.",
            "inspect <segment>...": "Validate and display ordered records from completed trace segments.",
            "report <segment>...": "Build an offline evidence report from completed trace segments.",
            "compare <left-segment> <right-segment>": "Compare two single-segment record streams exactly.",
        },
        "errors": {
            "2": "invalid input or configuration",
            "3": "missing prerequisite or resource",
            "5": "corrupt or incomplete evidence",
            "6": "runtime failure",
        }
    })
}

fn doctor_json() -> Value {
    json!({
        "schema": 1,
        "mode": "offline_evidence",
        "capabilities": {
            "trace_validation": "available",
            "ordered_record_reconstruction": "available",
            "generic_record_comparison": "available",
            "policy_replay": "parked_missing_recorded_input_and_policy_contracts",
            "authoritative_result_reporting": "parked_missing_j1_event_contract",
            "process_supervision_and_world_reset": "parked_missing_live_prerequisites",
        }
    })
}

#[cfg(test)]
mod tests {
    use super::run;
    use std::ffi::OsString;

    #[test]
    fn help_and_doctor_are_json_and_do_not_require_server_state() {
        for command in ["help", "doctor"] {
            let output = run([OsString::from(command)]).unwrap();
            let value: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(value["schema"], 1);
        }
    }

    #[test]
    fn unknown_commands_are_invalid_input() {
        let error = run([OsString::from("run")]).unwrap_err();
        assert_eq!(error.exit_code(), 2);
    }
}
