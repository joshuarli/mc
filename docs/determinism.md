# Determinism and evidence

## Trace-v1 reading

The TypeScript runner accepts only trace schema version 1. A segment has exactly the required envelope fields and its trailer is exactly `{ "complete": true }`. Record objects are opaque to this reader because J1 has not supplied an authoritative event contract. Duplicate JSON object names are rejected recursively before a JavaScript object can overwrite one.

A segment's `records` array is the sequential stream. JSON nesting is limited to 32 containers per segment. `first_sequence` and `last_sequence` are canonical unsigned decimal strings from 1 through 18446744073709551615. The number of records must equal `last_sequence - first_sequence + 1`, calculated without integer overflow; array index therefore determines each record's sequence. Across supplied segments, the runner orders by `first_sequence`, requires one `run_id`, and rejects gaps, overlaps, and sequence overflow. This reconstructs a complete ordered span from the supplied files; it cannot establish that the span covers the full run.

The `sha256` field is the lowercase SHA-256 digest of the compact serialization of the `records` array only. The byte sequence is UTF-8 with no whitespace: object keys use JavaScript's default string sort order, arrays keep their order, and numbers use `JSON.stringify` serialization. Non-finite values and integer-valued numbers outside JavaScript's safe integer range are rejected. The digest excludes the envelope, `run_id`, trailer, and checksum text. Producers must use the same canonicalization. This TypeScript trace-v1 contract is intentionally incompatible with historical Rust trace-v1 files, whose sequence fields were JSON numbers and whose checksum used serde_json ordering/number formatting; there is no compatibility fallback. There are no revised persisted consumers.

## Java world-plan transfer

The TypeScript encoder writes world-plan schema version 1 in the field shape consumed by Java `MapPlanReader`: `schema`, `run_id`, `map_semantic_id`, `dimensions`, `blocks`, `spawns`, and `loot_containers`. Blocks and loot containers retain the spec compiler's canonical position order; spawn seats are contiguous from zero and capped at six; loot inventory order is preserved. The compact UTF-8 plan is capped at 128 MiB. Its golden fixture is shared with the Java reader. Writing that plan into an owned run directory remains parked until the runner has the native handle-relative filesystem boundary.

## Replay and reports

`inspect` exposes generic ordered records. `report` emits the validated record stream and sequence span, with no inferred event meanings or outcome. `compare` performs exact record and range comparison while ignoring only the outer run ID. None of these operations demonstrates policy replay or cross-run semantic equivalence.

D1 semantic world determinism is not implemented by the runner. D2 is parked until B1 supplies the policy decision API and normalized observation, memory, RNG, and skill/path result contracts. D3 is parked until J1 supplies the authoritative event stream and terminal outcome contract. No live trajectory or cross-architecture replay claim is made by these offline checks.
