# Runner operations

The runner supports offline scenario preparation and evidence commands. `prepare` compiles a repository scenario and stages its world plan in a new run directory. It does not start Paper, launch Mineflayer clients, reset a world, or supervise a live match.

```sh
./arena doctor
./arena prepare --scenario scenarios/hunger-six.toml --run-id smoke-001
./arena inspect tests/fixtures/replay-report/segment-0001.json
./arena report tests/fixtures/replay-report/segment-0002.json tests/fixtures/replay-report/segment-0001.json
./arena compare tests/fixtures/replay-report/segment-0001.json tests/fixtures/replay-report/segment-0001-other-run.json
```

Successful commands print one JSON object to stdout. `inspect` and `report` accept one or more complete trace segments; segments are sorted by their declared sequence range and must belong to one run with no gaps or overlaps. `compare` accepts two single-segment files and compares sequence ranges and ordered records exactly. It ignores only the envelope `run_id`; it does not normalize any record content.

`prepare` requires a repository-relative scenario path and a run ID of 1–64 ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit. It reads bounded UTF-8 scenario and map sources, then writes `.work/arena/runs/<run-id>/world-plan.json`. A successful command prints the concrete run-directory and world-plan paths. `doctor` describes the paths available in the TypeScript runner. Policy replay, authoritative outcome reporting, live lifecycle supervision, and world reset report their specific missing contracts. The generic report preserves each record in sequence order and leaves `outcome` null. It does not reconstruct game statistics or claim D2/D3.

Trace readers follow a user-selected symlink and accept only regular-file targets. Reads are bounded to 8 MiB per segment and 256 MiB per supplied evidence set; JSON nesting is limited to 32 containers. The reader does not write to the selected path. Trace-v1 files with unsupported schema values, unknown envelope fields, duplicate JSON object names at any depth, excessive nesting, invalid ranges, malformed completion trailers, or checksum failures are rejected. Sequence bounds are canonical decimal strings in the range 1 through 18446744073709551615. The record checksum covers only the `records` array as compact UTF-8 JSON with object keys sorted by JavaScript string order and numbers serialized by `JSON.stringify`; see [determinism](determinism.md).

The TypeScript runtime target is macOS arm64 or Linux x86_64. Linux arm64 remains unverified. The runner uses a native handle-relative helper for bounded source reads and safe world-plan staging. World reset by clone remains parked with live lifecycle supervision.

Errors are one JSON object on stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a missing resource or prerequisite, 5 for corrupt or incomplete evidence, and 6 for runtime failures. Error output carries a category, a generic resource label, and structured source details such as the scenario field and source location, OS error codes, or whether a failed staging operation may have published a file. It omits parser text and file contents.

Child supervision, control handshake, `run`, `replay-policy`, world reset, and event-derived outcomes remain follow-up work. Live lifecycle tests require the prepared Paper/Mineflayer stack and J1 handshake/event sources. D2 policy execution requires B1's policy and recorded-input contracts. D3 requires the authoritative ordered event schema.
