# Scenarios and maps

Scenario files use schema versions 1, 2, and 3; map files use schema versions 1 and 2. All use TOML 1.0. `@arena/spec` parses source in memory and rejects unknown or missing keys. It checks types, ranges, cross-field rules, and map geometry before returning immutable typed values. `SpecError` keeps the failure kind and field path. Errors tied to source tokens include a one-based line and column. The compiler does not read files. The runner resolves map and policy references relative to the scenario file. It checks that canonical targets stay inside the repository roots.

Each map, scenario, or policy source is limited to 16 MiB of UTF-8 bytes. `@arena/spec` rejects larger source strings before parsing, and the native runner enforces the same bound while reading source files.

The scenario inputs are [hunger-six.toml](../scenarios/hunger-six.toml), [duel.toml](../scenarios/duel.toml), [civilization-six.toml](../scenarios/civilization-six.toml), and [hunger-24.toml](../scenarios/hunger-24.toml). Their maps are [hunger-six.toml](../maps/hunger-six.toml), [duel.toml](../maps/duel.toml), [civilization-six.toml](../maps/civilization-six.toml), and [hunger-24.toml](../maps/hunger-24.toml). Hunger 24 is a schema-3 scenario that `./arena validate` accepts; the runner does not yet launch schema-3 scenarios. Hunger six has six stable bot seats. Duel uses two bot seats for a compact combat world. Civilization six assigns three seats to each faction.

## Scenario rules

Scenario schema 1 supports `hunger_games` and `civilization` with planned maps. Schema 2 supports `hunger_games` with a natural terrain map. Schema 2 requires `opening_styles` with `explorer`, `scavenger`, and `hunter` exactly once. Their order is part of the scenario semantic ID. The compiled policy view is `competitive-v1`. All three checked-in scenarios target Minecraft `26.1.2`. The runner checks each version against `versions.lock.toml` when it resolves the stack.

Schema 1 and 2 competitor seats range from 1 to 6, and every seat is a bot. Schema 3 supports `hunger_games` with a natural terrain map only and competitor seats range from 1 to 256, matching the seat IDs 0 through 255. Schema 3 requires `opening_styles` like schema 2. Schema 3 `[roster]` also accepts an optional `external` array of `{ seat, username }` tables. Each listed seat has controller kind `external` and the username becomes that seat's reserved offline identity; every other seat is a `bot`. External seats are unique and listed in ascending order, usernames are 3 to 16 ASCII letters, digits, or underscores, unique ignoring case, and cannot begin with `ArenaBot` or `ArenaSpec` in any case. The compiled scenario resolves one `{ seat, controller }` entry per competitor, so consumers never re-derive defaults. Schema 1 and 2 reject `external`. Civilization keeps exactly six seats. Schema 3 accepts an optional `[rules]` table with a `kind` and `version = 1`; its absence is the classic `hunger_games` rule set. `kind = "frontier_survival"` takes `edit_radius_blocks` (16 to 512) and `max_block_edits_per_seat` (1 to 100,000) and requires `block_breaking` and `block_placing` true with `natural_mobs` and `natural_random_ticks` false. `kind = "squads"` takes `squads = [{ id, seats }]` with 2 to 64 lowercase identifiers whose ascending seats assign every competitor seat exactly once, under the classic block rules. The rule mode is part of the scenario semantic ID. [hunger-12.toml](../scenarios/hunger-12.toml) and [hunger-24.toml](../scenarios/hunger-24.toml) are validate-only classic schema-3 scenarios.

The 256-seat boundary fixtures `fixtures/spec/hunger-256-scenario.toml` and `fixtures/spec/hunger-256-map.toml` are test inputs, not shipped scenarios. They prove 256 seats compile, 257 are rejected, and a roster whose spawn and chest halos exceed 8,192 chunks fails with a resource-limit error. Spectator capacity is independent: spectators never consume competitor seats and the runner derives their identities from a separate name space. View and simulation distances range from 2 to 32 chunks. Simulation distance cannot exceed view distance. Tick rate ranges from 1 to 20. TOML integers retain their exact value. TypeScript represents scenario seeds and tick settings as `bigint`. Seeds range from 0 through 18446744073709551615. For schema 2, the runner uses the scenario seed to generate the natural terrain world. The grace period must end before the authoritative tick limit. Hunger Games borders shrink after grace and finish before that limit. They must stay inside the map footprint. Hunger Games rejects respawn, block breaking, block placing, natural mobs, and natural random ticks.

Civilization requires six seats, a fixed 192-block border, a 2,400-tick grace period, an 18,000-tick match limit, no respawn, and block breaking and placing. Ember owns seats 0–2 and Tide owns seats 3–5; each faction's ordered roles are gatherer-crafter, builder, and defender-scout. Both factions receive four bread, one wooden axe, one wooden pickaxe, and one wooden sword. The capture zone uses inclusive coordinates, requires 200 uncontested ticks, and awards one point for each owned tick. The scenario declares the `oak-outpost-v1` blueprint ID and each faction's anchor and rotation; core defines its cells and material recipe.

Map and policy references must be relative, portable paths using `/`. Dot segments are normalized before they appear in the IR. Canonical repository-root confinement requires the declaring file's location and is checked by the runner.

Policy files use version 1 and require `eat_at_hunger_or_below`, `retreat_at_health_half_hearts_or_below`, `border_margin_blocks`, `fight_range_blocks`, `opponent_memory_ticks`, `loot_hysteresis_blocks`, and `search_radius_blocks`. `compilePolicy(source)` rejects missing, duplicate, unknown, non-integer, unsupported, and out-of-range values. Core `PolicyParams` defines the supported numeric ranges. The policy semantic ID is SHA-256 over `arena.policy.ir.v1\0`, followed by the one-byte version and one-byte parameter values in the order listed above. TOML layout does not affect the ID; the runner resolves the policy reference and records that identity with the policy implementation.

## Map rules

Map schema 1 uses `x = 0..width-1`, `z = 0..depth-1`, and inclusive `min_y..max_y` coordinates. Cuboid endpoints are inclusive and must be ordered. Its `operations` array accepts cuboid, path, ramp, spawn, and loot-container records. Path and ramp records place one full block at the supplied position. Encode a route or rise with multiple positions. Operations apply in source order. Later block placements replace earlier blocks. `air` clears a position. A block operation cannot overwrite a declared loot container. A loot-container operation places a chest and stores its ordered item list.

Map schema 2 requires `terrain = "vanilla"` and a 1024 by 1024 footprint. Its operations can declare only spawn seats and loot-container columns. Each column has `x` and `z` coordinates. It has no height. The compiler emits no block placements. The natural arena border is centered on the integer block coordinate that is the floor, per axis, of the arithmetic mean of the configured spawn columns; clients and policies need an integer border center. Java applies the same rule to the declared columns. Java resolves each column against the generated world. If a cache column's top block is already a chest, setup reuses it; otherwise it places the cache above the resolved surface. Spawns and chests need safe support. Spawn feet and head positions need clear space. Chest positions and the blocks above them need clear space. Every chest needs a safe adjacent interaction position.

Resource identifiers use the Minecraft `namespace:path` form; an omitted namespace means `minecraft`. Loot lists contain 1–27 items because each listed item occupies one chest slot. Each map is limited to 100,000 operations and one million block writes, so malformed or accidental large cuboids fail before generation.

Scenario compilation rejects plans that prepare more than 8,192 chunks. Schema 1 counts the map's chunk rectangle and full view-distance halo. Schema 2 counts the union of spawn and loot-container chunks with their view-distance halos. Chunk coordinates use floor division at aligned 16-block edges. Java uses the same rule.

The schema-1 geometry checker treats each non-air block as a full cube. It checks the top walkable surface. Use full-block terrain. Avoid water, caves, doors, ladders, and partial-block routes. Every spawn needs support, two clear blocks of headroom, and two horizontal blocks from every other seat. All seats need a shared traversable surface. Seat IDs must be contiguous from zero. Every seat must reach every loot container. Each chest needs support and an adjacent walkable interaction position. Hunger Games spawns must begin inside the initial circular border and reach the final border zone. Loot containers must stay inside the initial border. Civilization capture zones need clear, supported, spawn-connected surfaces. Each outpost needs a supported, unobstructed build volume inside the fixed border. Outposts must stay clear of spawns and the capture zone. For planned maps, the border center is the geometric center of the map footprint.

The schema-2 compiler validates columns, unique seats and containers, spawn separation, and border placement. Java loads only chunks around spawn and cache columns with their view-distance halos. It resolves each column's surface and checks its support. Spawns need two clear blocks and at least two horizontal blocks between seats. Java checks each cache chest and adjacent interaction position before placing or filling chests.

Compiled positions use the readonly `BlockPosition` type exported by `@arena/core`. The map compiler validates the schema's signed 32-bit coordinate bounds before constructing each position.

## Canonical identity

The map semantic ID is SHA-256 over a versioned canonical encoding. Schema 1 includes dimensions, final non-air block placements, seat spawns, and ordered container inventories. Schema 2 includes the `vanilla` terrain label, width, depth, seat columns, and ordered container columns and inventories. Both IDs ignore TOML formatting, operation labels, and the map display name.

The runner stages a world plan before starting Paper. Schema 1 carries dimensions, block placements, seat spawns, and loot inventories. Schema 2 carries a canonical unsigned `world_seed`, `terrain = "vanilla"`, a 1024 by 1024 footprint, an empty block list, and spawn and loot-container columns. The runner rejects encoded output above 128 MiB. The Java reader enforces the same limit. Plans contain no source paths or scenario display names. Schema 2 carries the world seed explicitly. The Java reader rejects duplicate JSON names, unknown fields, unsupported versions, and invalid values. It checks canonical ordering, seat IDs, dimensions, inventory sizes, and the map semantic ID. The run ID binds the file to the later control envelope. It is not part of the map semantic ID. The v1 fixture is `tests/fixtures/world-plan/world-plan-v1.json`. The v2 fixture is `tests/fixtures/world-plan/world-plan-v2.json`.

World-plan schema 3 is the natural plan of schema 2 plus a required `roster` array and up to 256 spawns. Each roster entry is `{ seat, kind: "bot" }` or `{ seat, kind: "external", username }`, ordered and contiguous from zero with exactly one entry per spawn seat. Schema 1 and 2 plans keep at most six spawns and reject `roster`. The schema-3 fixtures are `tests/fixtures/world-plan/world-plan-v3.json`, the 256-seat `world-plan-v3-256.json`, and the `world-plan-v3-invalid-*` and `world-plan-v2-invalid-roster-field` negatives; the TypeScript encoder and the Java reader are both tested against them. The schema-3 map semantic ID is the schema-2 natural map ID.

Schema 1 map IDs use SHA-256 over `arena.map.ir.v1\0`. The encoding starts with little-endian `u32` width and depth, then little-endian `i32` minimum and maximum y. A little-endian `u64` block count precedes blocks ordered by x/y/z. Each block stores three little-endian `i32` coordinates and a resource ID. A resource ID stores a little-endian `u64` byte length followed by UTF-8 bytes. A little-endian `u64` spawn count precedes spawns ordered by seat. Each spawn stores a little-endian `u16` seat and three little-endian `i32` coordinates. A little-endian `u64` loot-container count precedes containers ordered by x/y/z. Each container stores three little-endian `i32` coordinates, a little-endian `u64` item count, and its ordered resource IDs. The v1 fixture map ID is `94f1cf73fef47c767b574477350ee7ce59f139e4a680464d88f99c1a25b2eedb`.

Schema 2 map IDs use SHA-256 over `arena.map.ir.v2\0`. The encoding starts with the UTF-8 string `vanilla`, preceded by its little-endian `u64` byte length. Little-endian `u32` width and depth follow. A little-endian `u64` spawn count precedes spawns ordered by seat. Each spawn stores a little-endian `u16` seat and little-endian `i32` x and z coordinates. A little-endian `u64` loot-container count precedes containers ordered by x and z. Each container stores little-endian `i32` x and z coordinates and a little-endian `u64` item count. Its ordered resource IDs each store a little-endian `u64` byte length followed by UTF-8 bytes.

The scenario semantic ID covers resolved settings, seed, normalized policy reference, and map semantic ID. Schema 2 also includes the ordered opening-style cycle. Schema 3 uses the `arena.scenario.ir.v3\0` prefix and appends, per seat in seat order, a `u16` seat and a `u8` controller kind (0 bot, 1 external) followed by the external username string, so roster and controller changes alter scenario identity while the map ID stays unchanged. Civilization IDs include ordered factions and roles, the starting kit, capture-zone values, and blueprint anchors. Map IDs cover map content alone. Changing a faction or objective does not change the map ID. Scenario IDs exclude display names and map reference paths. Moving an identical map source does not change world identity. Absolute machine paths are never included. The scenario IR carries the normalized policy reference. The runner compiles that source and joins its semantic ID with the registered implementation in the run manifest.

`MapIr` exposes the shared `BlockPosition` type from `@arena/core`. Coordinate ordering is lexicographic by x, y, then z, which defines stable block placement order in the compiled map. The TypeScript runner writes unsigned 64-bit values as canonical decimal strings when serializing JSON so JavaScript precision cannot change them.

Named offline checks:

- `scenario_v1_compiles_hunger_six_and_duel`
- `natural_map_v2_keeps_surface_columns_unresolved_and_rejects_invalid_columns`
- `scenario_v2_requires_natural_terrain_and_records_a_complete_opening_cycle`
- `civilization_scenario_compiles_fixed_seats_goals_and_outposts`
- `civilization_scenario_rejects_roster_match_and_blueprint_conflicts`
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
- `scenario_v3_compiles_hunger_24_with_resolved_bot_seats`
- `scenario_v3_roster_accepts_256_seats_and_rejects_257`
- `scenario_v3_rejects_rosters_above_the_prepared_chunk_cap`
- `scenario_v3_external_seats_validate_identity_and_bind_scenario_identity`
- `scenario_v3_spectator_capacity_is_independent_of_competitor_seats`
- `scenario_v1_and_v2_reject_the_generalized_roster`
- `scenario_v3_requires_hunger_games_and_natural_terrain`
- `natural_border_center_is_the_floor_of_the_mean_spawn_column`
- `scenario_v3_compiles_hunger_12_as_classic_rules`
- `scenario_v3_frontier_survival_requires_block_editing_without_random_ticks`
- `scenario_v3_squads_partition_every_seat_into_named_teams`
- `scenario_v2_rejects_rule_tables`
