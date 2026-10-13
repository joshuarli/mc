# Scenarios and maps

Scenario and map files use schema version 1 and TOML 1.0. `@arena/spec` parses source in memory, rejects unknown or missing keys, and produces immutable typed values after checking field types, ranges, cross-field rules, and map geometry. `SpecError` keeps the failure kind and field path; unknown-key errors also include the key's one-based source line and column. The compiler does not read files. The runner resolves each declared map and policy reference relative to the scenario file and confirms the canonical targets remain inside the repository roots.

Each map or scenario source is limited to 16 MiB of UTF-8 bytes. `@arena/spec` rejects larger source strings before parsing, and the native runner enforces the same bound while reading source files.

The two scenario inputs are [hunger-six.toml](../scenarios/hunger-six.toml) and [duel.toml](../scenarios/duel.toml). Their map inputs are [hunger-six.toml](../maps/hunger-six.toml) and [duel.toml](../maps/duel.toml). Hunger six has six stable bot seats. Duel uses two bot seats for a compact combat world. Both use the schema-v1 Hunger Games rules.

## Scenario rules

Every field in the scenario-v1 compiler contract is required. Supported modes are `hunger_games` and `civilization`; the compiled policy view is currently only `competitive-v1`. Both checked-in scenarios target Minecraft `26.1.2`. The runner checks each scenario's version against `versions.lock.toml` when it resolves the stack.

Competitor seats are limited to 1–6, and every competitor seat is assigned to a bot. Spectator capacity remains independently configurable. View and simulation distances are 2–32 chunks, simulation distance cannot exceed view distance, and tick rate is 1–20. TOML integers retain their exact value; the scenario seed and tick settings are represented as `bigint` in TypeScript. The grace period must end before the authoritative tick limit. The border must shrink after grace, finish after its start and before the authoritative limit, and remain inside the map footprint. Hunger Games rejects respawn, block breaking, block placing, natural mobs, and natural random ticks. Civilization requires six seats, no respawn, and survival block breaking and placing.

Map and policy references must be relative, portable paths using `/`. Dot segments are normalized before they appear in the IR. Canonical repository-root confinement requires the declaring file's location and is checked by the runner.

## Map rules

Map coordinates use `x = 0..width-1`, `z = 0..depth-1`, and inclusive `min_y..max_y`. Cuboid endpoints are inclusive and must be ordered. The `operations` array accepts cuboid, path, ramp, spawn, and loot-container records. Path and ramp records each place one full block at the supplied position; a route or rise is encoded with multiple positions. Operations apply in source order: later block placements replace earlier blocks, `air` clears a position, and a later block operation cannot overwrite an already declared loot container. A loot-container operation places a chest and stores its ordered item list.

Resource identifiers use the Minecraft `namespace:path` form; an omitted namespace means `minecraft`. Loot lists contain 1–27 items because each listed item occupies one chest slot. Each map is limited to 100,000 operations and one million block writes, so malformed or accidental large cuboids fail before generation.

Scenario compilation counts the map's chunk rectangle plus the full view-distance halo and rejects more than 8,192 prepared chunks. The halo begins at negative chunk coordinates and uses floor division at aligned 16-block edges, matching the Java startup guard. The runner may use a tighter 1,024-chunk operating limit; that limit does not alter schema-v1 map input.

The geometry checker treats non-air blocks as full cubes and checks the top walkable surface. Maps intended for this compiler use full-block terrain and avoid water, caves, doors, ladders, and partial-block routes. Every spawn needs a supporting block, two clear blocks of headroom, at least two horizontal blocks from every other seat, and a shared traversable surface with the other seats. Seat IDs must be contiguous from zero. Every seat must be able to reach every loot container; each chest needs support and an adjacent walkable interaction position. For a compiled scenario, every spawn must begin inside the initial circular border and reach the final circular border zone, and each loot container must lie inside the initial border. The border center is the geometric center of the map footprint.

Compiled positions use the readonly `BlockPosition` type exported by `@arena/core`. The map compiler validates the schema's signed 32-bit coordinate bounds before constructing each position.

## Canonical identity

The map semantic ID is SHA-256 over a versioned canonical encoding of dimensions, final non-air block placements, stable seat spawns, and ordered container inventories. It ignores TOML formatting, operation labels, and the map display name. Equivalent final block states therefore have the same map ID.

The runner stages `world-plan-v1` before starting Paper so `getDefaultWorldGenerator` can read resolved inputs during world loading. The runner rejects encoded output above 128 MiB before staging, and the Java reader enforces the same limit while parsing. The file has a run ID, the map semantic ID, dimensions, final block placements, seat spawns, and ordered loot inventories; it contains no source paths, scenario names, or random choices. The Java reader rejects duplicate JSON names, unknown fields, unsupported schema versions, and values outside this schema. It checks that positions fit the dimensions, seats are contiguous from zero, blocks and containers are uniquely ordered by x/y/z, each chest inventory has at most 27 one-item entries, and the recomputed map semantic ID matches. The run ID binds the staged file to the later control envelope and is not part of the map semantic ID. `tests/fixtures/world-plan/world-plan-v1.json` is the cross-language v1 fixture.

The map semantic ID uses SHA-256 over `arena.map.ir.v1\0`, followed by little-endian `u32` width/depth and little-endian `i32` min/max y. It then stores a little-endian `u64` block count followed by block records ordered by x/y/z; each block has three little-endian `i32` coordinates and a UTF-8 resource ID preceded by its little-endian `u64` byte length. A little-endian `u64` spawn count precedes spawn records ordered by seat; each has a little-endian `u16` seat and three little-endian `i32` coordinates. A little-endian `u64` loot-container count precedes loot records ordered by x/y/z; each has three little-endian `i32` coordinates, a little-endian `u64` item count, and ordered UTF-8 resource IDs with little-endian `u64` byte lengths. The fixture's map ID is `94f1cf73fef47c767b574477350ee7ce59f139e4a680464d88f99c1a25b2eedb`.

The scenario semantic ID covers the resolved scenario settings, seed, normalized policy reference, and map semantic ID. It excludes display names and the map reference path, so moving an identical map source does not change world identity. Absolute machine paths are never included. The registered policy's code and parameter identity must be joined by the runner when it builds a run manifest; this crate only sees the policy reference string.

`MapIr` exposes the shared `BlockPosition` type from `@arena/core`. Coordinate ordering is lexicographic by x, y, then z, which defines stable block placement order in the compiled map. The TypeScript runner writes unsigned 64-bit values as canonical decimal strings when serializing JSON so JavaScript precision cannot change them.

Named offline checks:

- `scenario_v1_compiles_hunger_six_and_duel`
- `semantic_ids_ignore_toml_layout_and_labels_but_cover_world_content`
- `scenario_compiler_rejects_unknown_fields_enums_and_invalid_ranges`
- `scenario_rejects_removed_human_seat_field_without_fallback`
- `map_compiler_rejects_unknown_schema_fields_operations_and_coordinate_overflow`
- `map_compiler_resolves_nested_tables_under_the_current_array_table`
- `map_chest_placement_counts_toward_the_block_write_cap`
- `map_compiler_checks_spawn_support_headroom_and_routes`
- `map_positions_use_shared_core_geometry_and_stable_order`
- `map_semantic_id_matches_java_world_plan_v1_fixture`
- `scenario_prepared_chunk_halo_matches_java_limit_at_aligned_boundaries`
- `compilers_reject_sources_above_the_utf8_byte_limit`
