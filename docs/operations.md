# Runner operations

The runner currently supports read-only offline evidence commands. It does not start Paper, launch Mineflayer clients, reset a world, or supervise a live match.

```sh
./arena run doctor
./arena run inspect tests/fixtures/replay-report/segment-0001.json
./arena run report tests/fixtures/replay-report/segment-0002.json tests/fixtures/replay-report/segment-0001.json
./arena run compare tests/fixtures/replay-report/segment-0001.json tests/fixtures/replay-report/segment-0001-other-run.json
```

Successful commands print one JSON object to stdout. `inspect` and `report` accept one or more complete trace segments; segments are sorted by their declared sequence range and must belong to one run with no gaps or overlaps. `compare` accepts two single-segment files and compares sequence ranges and ordered records exactly. It ignores only the envelope `run_id`; it does not normalize any record content.

`doctor` describes the paths available in the TypeScript runner. Policy replay, authoritative outcome reporting, live lifecycle supervision, and safe owned-path staging report their specific missing contracts. The generic report preserves each record in sequence order and leaves `outcome` null. It does not reconstruct game statistics or claim D2/D3.

Trace readers follow a user-selected symlink and accept only regular-file targets. Reads are bounded to 8 MiB per segment and 256 MiB per supplied evidence set; JSON nesting is limited to 32 containers. The reader does not write to the selected path. Trace-v1 files with unsupported schema values, unknown envelope fields, duplicate JSON object names at any depth, excessive nesting, invalid ranges, malformed completion trailers, or checksum failures are rejected. Sequence bounds are canonical decimal strings in the range 1 through 18446744073709551615. The record checksum covers only the `records` array as compact UTF-8 JSON with object keys sorted by JavaScript string order and numbers serialized by `JSON.stringify`; see [determinism](determinism.md).

The TypeScript runtime target is macOS arm64 or Linux x86_64. Linux arm64 remains unverified. Native handle-relative file operations are not exposed by Node's standard filesystem API, so safe owned-root staging and reset-by-clone are parked pending a native path boundary. The runner does not replace that requirement with path normalization or check-then-write checks.

Errors are one JSON object on stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a missing resource or prerequisite, 5 for corrupt or incomplete evidence, and 6 for runtime failures. Error output carries a category, a generic resource label, and structured source details; it omits parser text and file contents.

Child supervision, safe world-plan staging, control handshake, `run`, `replay-policy`, and event-derived outcomes remain follow-up work. Live lifecycle tests require the prepared Paper/Mineflayer stack and J1 handshake/event sources. D2 policy execution requires B1's policy and recorded-input contracts. D3 requires the authoritative ordered event schema.
