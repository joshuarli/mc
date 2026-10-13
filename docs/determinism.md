# Determinism and evidence

## Trace-v1 reading

The runner accepts only trace schema version 1. A segment must have the required envelope fields and no extra envelope fields. Its trailer must be exactly `{ "complete": true }`. Record objects are opaque to this reader because J1 has not supplied an authoritative event contract.

A segment's `records` array is the sequential stream. JSON nesting is limited to 32 containers per segment. The number of records must equal `last_sequence - first_sequence + 1`; array index therefore determines the record's position in that declared sequence range. Across supplied segments, the runner orders by `first_sequence`, requires one `run_id`, and rejects gaps, overlaps, and sequence overflow. This reconstructs a complete ordered span from the supplied files; it cannot establish that the span covers the full run.

The `sha256` field is the lowercase SHA-256 digest of the compact serialization of the `records` array only. The byte sequence is exactly `serde_json::to_vec(records)`: UTF-8, no whitespace added, object keys ordered by serde_json's default map ordering, array order preserved, and no trailing newline. The digest does not include the envelope, `run_id`, trailer, or checksum text. The reader verifies this serialization; trace producers must use the same bytes. A Java producer and cross-language golden fixture remain pending.

## Replay and reports

`inspect` exposes generic ordered records. `report` emits the validated record stream and sequence span, with no inferred event meanings or outcome. `compare` performs exact record and range comparison while ignoring only the outer run ID. None of these operations demonstrates policy replay or cross-run semantic equivalence.

D1 semantic world determinism is not implemented by the runner. D2 is parked until B1 supplies the policy decision API and normalized observation, memory, RNG, and skill/path result contracts. D3 is parked until J1 supplies the authoritative event stream and terminal outcome contract. No live trajectory or cross-architecture replay claim is made by these offline checks.
