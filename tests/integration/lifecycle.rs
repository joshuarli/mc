use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/replay-report")
        .join(name)
}

fn run_command(command_name: &str, args: &[&Path]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_arena-runner"));
    command.arg(command_name);
    for arg in args {
        command.arg(arg);
    }
    command.output().unwrap()
}

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.work/tmp");
        fs::create_dir_all(&root).unwrap();
        for _ in 0..128 {
            let suffix = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!("arena-runner-lifecycle-{}-{suffix}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create lifecycle test directory: {error}"),
            }
        }
        panic!("failed to allocate unique lifecycle test directory under .work/tmp");
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            // A second panic here would abort and hide the primary test failure.
            if !std::thread::panicking() {
                panic!("failed to remove lifecycle test directory: {error}");
            }
        }
    }
}

#[test]
fn report_reconstructs_ordered_records_and_matches_fixture() {
    let output = run_command("report", &[&fixture("segment-0002.json"), &fixture("segment-0001.json")]);
    assert!(output.status.success());
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value = serde_json::from_slice(&fs::read(fixture("ordered-report.json")).unwrap()).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn comparison_ignores_envelope_run_id_but_compares_ordered_records() {
    let output = run_command("compare", &[&fixture("segment-0001.json"), &fixture("segment-0001-other-run.json")]);
    assert!(output.status.success());
    let comparison: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(comparison["equal"], true);
    assert_eq!(comparison["run_ids_compared"], false);
}

#[test]
fn incomplete_segment_returns_structured_corrupt_evidence_error() {
    let output = run_command("inspect", &[&fixture("incomplete-segment.json")]);
    assert_eq!(output.status.code(), Some(5));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["category"], "corrupt_evidence");
    assert_eq!(error["error"]["source"]["kind"], "invalid_completion_trailer");
    assert!(error["error"].get("message").is_none());
}

#[test]
fn missing_segment_returns_structured_prerequisite_error() {
    let temp = TempDirectory::new();
    let missing = temp.path().join("missing.json");
    let output = run_command("inspect", &[&missing]);
    assert_eq!(output.status.code(), Some(3));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["category"], "missing_prerequisite");
    assert_eq!(error["error"]["source"]["kind"], "io");
    assert_eq!(error["error"]["source"]["argument"], 1);
    assert_eq!(error["error"]["resource"], "trace segment argument 1");
    assert!(error["error"].get("message").is_none());
}

#[test]
fn trace_reader_follows_selected_symlink_and_rejects_directory() {
    let temp = TempDirectory::new();
    let linked = temp.path().join("selected.json");
    #[cfg(unix)]
    std::os::unix::fs::symlink(fixture("segment-0001.json"), &linked).unwrap();
    #[cfg(not(unix))]
    fs::copy(fixture("segment-0001.json"), &linked).unwrap();
    let output = run_command("inspect", &[&linked]);
    assert!(output.status.success());

    let output = run_command("inspect", &[temp.path()]);
    assert_eq!(output.status.code(), Some(5));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["source"]["kind"], "not_a_regular_file");
}

#[test]
fn oversized_segment_is_rejected_before_reading_contents() {
    let temp = TempDirectory::new();
    let oversized = temp.path().join("oversized.json");
    File::create(&oversized).unwrap().set_len(8 * 1024 * 1024 + 1).unwrap();
    let output = run_command("inspect", &[&oversized]);
    assert_eq!(output.status.code(), Some(5));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["source"]["kind"], "segment_too_large");
}

#[test]
fn doctor_reports_offline_capabilities_as_structured_json() {
    let output = run_command("doctor", &[]);
    assert!(output.status.success());
    let doctor: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(doctor["mode"], "offline_evidence");
    assert_eq!(doctor["capabilities"]["policy_replay"], "parked_missing_recorded_input_and_policy_contracts");
}
