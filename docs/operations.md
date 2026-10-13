# Runner operations

The runner supports scenario validation and preparation, headless match supervision, stopped-run inspection, selected-run cleanup, and evidence commands. `validate` compiles the scenario, map, and policy without creating a run. `prepare` compiles a repository scenario and stages its world plan in a new run directory. `run` stages the world plan, starts an owned Paper server, runs the configured competitors, stops the server, and reports the reconstructed result and player statistics.

```sh
./arena doctor
./arena validate --scenario scenarios/hunger-six.toml
./arena prepare --scenario scenarios/hunger-six.toml --run-id smoke-001
./arena run --scenario scenarios/hunger-six.toml --run-id smoke-002
./arena inspect --run-id smoke-002
./arena gc --dry-run --run-id failed-old-001
./arena inspect tests/fixtures/replay-report-v2/segment-0001.json
./arena replay-policy path/to/policy-trace-segment.json
./arena report path/to/lifecycle-trace-segment.json
./arena compare tests/fixtures/replay-report-v2/segment-0001.json tests/fixtures/replay-report-v2/segment-0001-other-run.json
```

Successful commands print one JSON object to stdout. `inspect`, `replay-policy`, and `report` accept one or more complete trace segments; segments are sorted by their declared sequence range and must belong to one run with no gaps or overlaps. `inspect` accepts generic records. `replay-policy` verifies `policy-replay-v1` decisions and post-decision RNG states against the core policy; separate correlated `policy-effect-v1` records preserve skill outcomes and actual path updates. `report` requires the typed lifecycle stream and reconstructs the terminal outcome and elimination counts from the prepared roster, ordered elimination events, public states, and terminal clock. `compare` accepts two single-segment files and compares sequence ranges and ordered records exactly. It ignores only the envelope `run_id`; it does not normalize any record content.

`prepare` requires a repository-relative scenario path and a run ID of 1–64 ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit. Before `prepare` or `run` creates a run directory, it requires at least 4 GiB free space, at most 16 GiB under `.work/arena`, at most 8 GiB of `.work/arena` files outside `runs` and `traces`, and fewer than 10 retained run directories. The check does not prune old runs. It reads bounded UTF-8 scenario and map sources, then writes `.work/arena/runs/<run-id>/world-plan.json`. `validate` also compiles the referenced policy and does not create a run directory. `run` accepts the same repository-relative scenario path and an optional run ID; without one, it generates a UUID. It requires the Java runtime, Paper server JAR, plugin JAR, and owned-files helper configured by `./arena`. A successful run prints the concrete created paths, trace segments, reconstructed result, and stopped player statistics. `doctor` describes the available runner and runtime paths.

`inspect --run-id <id>` reads the completed run's consecutive TypeScript trace-v2 segments, reconstructs its authoritative result, and reads stopped-player statistics by the offline UUIDs in the prepared roster. It rejects an active run while holding the run lease. Missing stats files are reported as absent with null counters; a missing Minecraft counter in an existing stats file is reported as zero.

`gc --dry-run --run-id <id>...` checks only the selected owned runs and reports which completed run directories can be removed. `gc --apply --run-id <id>...` uses the same checks and removes only selected eligible run directories while holding their leases. The latest three validated runner failures are retained; selected winner, draw, and tick-limit runs can be removed. Incomplete or corrupt evidence is protected and excluded from retention ranking; an operational failure with failed cleanup is always protected.

Trace readers follow a user-selected symlink and accept only regular-file targets. Reads are bounded to 8 MiB per segment and 256 MiB per supplied evidence set; JSON nesting is limited to 32 containers. The reader does not write to the selected path. TypeScript trace-v2 files with unsupported schema values, unknown envelope fields, duplicate JSON object names at any depth, excessive nesting, invalid ranges, malformed completion trailers, or checksum failures are rejected. Historical Rust trace-v1 files are not accepted. Sequence bounds are canonical decimal strings in the range 1 through 18446744073709551615. The record checksum covers only the `records` array as compact UTF-8 JSON with object keys sorted by JavaScript string order and numbers serialized by `JSON.stringify`; see [determinism](determinism.md).

The TypeScript runtime target is macOS arm64 or Linux x86_64. Linux arm64 remains unverified. The runner uses a native handle-relative helper for bounded source reads, resource inspection, and safe world-plan staging; it clones the pristine world into each owned run directory.

Errors are one JSON object on stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a missing resource or prerequisite, 4 for an owned-resource or port conflict, 5 for corrupt or incomplete evidence, 6 for runtime failures, and 130 for operator cancellation. An authoritative abort outcome is a runtime failure; its error includes the outcome reason, run ID, and final trace path when available. Error output carries a category, a generic resource label, and structured source details such as the scenario field and source location, OS error codes, the primary and cleanup failure kinds, or whether a failed staging operation may have published a file. It omits parser text and file contents.

The runner does not claim that replaying core decisions reproduces Mineflayer actions or the server trajectory. An event report is only as complete as the supplied trace sequence span. Live lifecycle tests require the prepared Paper/Mineflayer stack and authenticated control event sources.
