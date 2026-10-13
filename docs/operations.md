# Runner operations

The current runner supports read-only offline evidence commands. It does not start a Paper server, launch clients, reset a world, or supervise a live match yet.

```sh
cargo run -p arena-runner -- doctor
cargo run -p arena-runner -- inspect tests/fixtures/replay-report/segment-0001.json
cargo run -p arena-runner -- report tests/fixtures/replay-report/segment-0002.json tests/fixtures/replay-report/segment-0001.json
cargo run -p arena-runner -- compare tests/fixtures/replay-report/segment-0001.json tests/fixtures/replay-report/segment-0001-other-run.json
```

Successful commands print one JSON object to stdout. `inspect` and `report` accept one or more complete trace segments; segments are sorted by their declared sequence range and must belong to one run with no gaps or overlaps. `compare` accepts two single-segment files and compares sequence ranges and ordered records exactly. It ignores only the envelope `run_id`; it does not normalize any record content.

`doctor` describes the code paths available in this binary. It reports policy replay, authoritative outcome reporting, and live lifecycle supervision as parked until their recorded-input, event, and live-stack contracts exist. The generic report preserves each record in sequence order and leaves `outcome` null. It does not reconstruct game statistics or claim D2/D3.

Trace readers follow a user-selected symlink and accept only regular-file targets. Reads are bounded to 8 MiB per segment and JSON nesting is limited to 32 containers. The reader does not write to the selected path. Trace-v1 files with unsupported schema values, unknown envelope fields, duplicate JSON object names, excessive nesting, invalid ranges, malformed completion trailers, or checksum failures are rejected. The checksum covers only the `records` array as compact UTF-8 JSON serialized by serde_json; see [determinism](determinism.md).

The supported native targets are macOS arm64 and Linux x86_64. Other target pairs fail compilation; Linux arm64 remains unverified.

Errors are one JSON object on stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a missing resource or prerequisite, 5 for corrupt or incomplete evidence, and 6 for runtime failures. Error output carries a category, a generic resource label, and structured source details; it omits parser text and file contents.

World cloning/reset, child supervision, control handshake, `run`/`play`, `replay-policy`, and event-derived outcomes remain follow-up work. Live lifecycle tests require the prepared Paper/Azalea stack and J1 handshake/event sources. D2 policy execution requires B1's policy and recorded-input contracts. D3 requires the authoritative ordered event schema.
