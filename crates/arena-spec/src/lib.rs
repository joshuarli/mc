//! Strict schema-v1 scenario and map compilation into immutable local IR.

mod error;
mod hash;
mod map;
mod raw;
mod scenario;

pub use error::{SpecError, SpecErrorKind};
pub use hash::SemanticId;
pub use map::{BlockPlacement, BlockPosition, ChunkPosition, LootContainer, MapDimensions, MapIr, SpawnPoint, compile_map};
pub use scenario::{BotSettings, BorderSettings, GameMode, MatchSettings, Perception, RecordSettings, ResourceReference, Roster, ScenarioIr, ServerSettings, compile_scenario};

#[cfg(test)]
mod tests {
    use super::{
        BlockPosition, GameMode, SpecErrorKind, compile_map, compile_scenario,
    };

    const HUNGER: &str = include_str!("../../../scenarios/hunger-six.toml");
    const HUNGER_MAP: &str = include_str!("../../../maps/hunger-six.toml");
    const DUEL: &str = include_str!("../../../scenarios/duel.toml");
    const DUEL_MAP: &str = include_str!("../../../maps/duel.toml");
    const UNKNOWN_OPERATION: &str = include_str!("../../../fixtures/spec/unknown-operation.toml");
    const UNKNOWN_FIELD: &str = include_str!("../../../fixtures/spec/unknown-field.toml");

    #[test]
    fn scenario_v1_compiles_hunger_six_and_duel() {
        let hunger = compile_scenario(HUNGER, HUNGER_MAP).expect("hunger scenario compiles");
        assert_eq!(hunger.mode(), GameMode::HungerGames);
        assert_eq!(hunger.roster().competitors(), 6);
        assert_eq!(hunger.map().spawns().len(), 6);
        assert_eq!(hunger.map().loot_containers().len(), 4);
        assert_eq!(hunger.map().blocks().len(), 16_384 + 14);

        let duel = compile_scenario(DUEL, DUEL_MAP).expect("duel scenario compiles");
        assert_eq!(duel.roster().competitors(), 2);
        assert_eq!(duel.map().spawns().len(), 2);
        assert_eq!(duel.map().loot_containers().len(), 2);
        assert_ne!(hunger.semantic_id(), duel.semantic_id());
    }

    #[test]
    fn semantic_ids_ignore_toml_layout_and_labels_but_cover_world_content() {
        let baseline = compile_scenario(HUNGER, HUNGER_MAP).expect("baseline compiles");
        let layout_variant = HUNGER
            .replace("map = \"../maps/hunger-six.toml\"", "map = \"../maps/./hunger-six.toml\"")
            .replace("policy = \"../policies/baseline.toml\"", "policy = \"../policies/./baseline.toml\"");
        let renamed_map = HUNGER_MAP.replace("name = \"hunger-six\"", "name = \"arena-alias\"");
        let equivalent = compile_scenario(&layout_variant, &renamed_map).expect("equivalent source compiles");
        assert_eq!(baseline.semantic_id(), equivalent.semantic_id());

        let changed_world = HUNGER_MAP.replacen("block = \"minecraft:stone\"", "block = \"minecraft:dirt\"", 1);
        let changed = compile_scenario(HUNGER, &changed_world).expect("changed source compiles");
        assert_ne!(baseline.semantic_id(), changed.semantic_id());
        assert_eq!(baseline.semantic_id().to_hex().len(), 64);
    }

    #[test]
    fn scenario_compiler_rejects_unknown_fields_enums_and_invalid_ranges() {
        let unknown_field = format!("unknown = true\n{HUNGER}");
        let error = compile_scenario(&unknown_field, HUNGER_MAP).expect_err("unknown field is rejected");
        assert_eq!(error.kind(), SpecErrorKind::UnknownField);
        assert_eq!(error.path(), "scenario.unknown");

        let unknown_mode = HUNGER.replace("mode = \"hunger_games\"", "mode = \"survival\"");
        let error = compile_scenario(&unknown_mode, HUNGER_MAP).expect_err("unknown enum is rejected");
        assert_eq!(error.kind(), SpecErrorKind::InvalidValue);
        assert_eq!(error.path(), "scenario.mode");

        let invalid_border = HUNGER.replace("shrink_end_tick = 6000", "shrink_end_tick = 1200");
        let error = compile_scenario(&invalid_border, HUNGER_MAP).expect_err("empty shrink interval is rejected");
        assert_eq!(error.kind(), SpecErrorKind::Range);
        assert_eq!(error.path(), "scenario.border.shrink_end_tick");

        let border_finishes_at_limit = HUNGER.replace("shrink_end_tick = 6000", "shrink_end_tick = 7200");
        let error = compile_scenario(&border_finishes_at_limit, HUNGER_MAP).expect_err("border shrink must finish before the authoritative limit");
        assert_eq!(error.kind(), SpecErrorKind::Range);
        assert_eq!(error.path(), "scenario.border.shrink_end_tick");

        let overflow = HUNGER.replace("seed = 481516", "seed = 9223372036854775808");
        let error = compile_scenario(&overflow, HUNGER_MAP).expect_err("TOML integer overflow is rejected");
        assert_eq!(error.kind(), SpecErrorKind::Syntax);
    }

    #[test]
    fn map_compiler_rejects_unknown_schema_fields_operations_and_coordinate_overflow() {
        let error = compile_map(UNKNOWN_FIELD).expect_err("unknown field is rejected");
        assert_eq!(error.kind(), SpecErrorKind::UnknownField);
        assert_eq!(error.path(), "map.palette");

        let error = compile_map(UNKNOWN_OPERATION).expect_err("unknown operation is rejected");
        assert_eq!(error.kind(), SpecErrorKind::InvalidValue);
        assert_eq!(error.path(), "map.operations[0].kind");

        let overflow = HUNGER_MAP.replace("width = 128", "width = 4294967296");
        let error = compile_map(&overflow).expect_err("unsupported coordinate range is rejected");
        assert_eq!(error.kind(), SpecErrorKind::Range);
        assert_eq!(error.path(), "map.dimensions.width");
    }

    #[test]
    fn map_compiler_checks_spawn_support_headroom_and_routes() {
        let no_headroom = r#"
schema = 1
name = "bad-spawn"
operations = [
  { kind = "cuboid", from = { x = 0, y = 1, z = 0 }, to = { x = 7, y = 1, z = 7 }, block = "stone" },
  { kind = "cuboid", from = { x = 1, y = 3, z = 1 }, to = { x = 1, y = 3, z = 1 }, block = "stone" },
  { kind = "spawn", seat = 0, position = { x = 1, y = 2, z = 1 } },
  { kind = "loot_container", position = { x = 4, y = 2, z = 4 }, inventory = ["bread"] }
]
[dimensions]
width = 8
depth = 8
min_y = 0
max_y = 8
"#;
        let error = compile_map(no_headroom).expect_err("blocked spawn headroom is rejected");
        assert_eq!(error.kind(), SpecErrorKind::Geometry);
        assert_eq!(error.path(), "map.spawn[0]");

        let scenario = DUEL
            .replace("initial_diameter_blocks = 62", "initial_diameter_blocks = 12")
            .replace("final_diameter_blocks = 16", "final_diameter_blocks = 2");
        let error = compile_scenario(&scenario, disconnected_final_zone_map()).expect_err("unreachable final border zone is rejected");
        assert_eq!(error.kind(), SpecErrorKind::Geometry);
        assert_eq!(error.path(), "scenario.border");
    }

    #[test]
    fn chunk_conversion_uses_floor_division_for_negative_coordinates() {
        assert_eq!(BlockPosition::new(-1, 0, -1).chunk().x(), -1);
        assert_eq!(BlockPosition::new(-16, 0, -16).chunk().z(), -1);
        assert_eq!(BlockPosition::new(-17, 0, -17).chunk().x(), -2);
        assert_eq!(BlockPosition::new(15, 0, 15).chunk().x(), 0);
        assert_eq!(BlockPosition::new(16, 0, 16).chunk().z(), 1);
    }

    fn disconnected_final_zone_map() -> &'static str {
        r#"
schema = 1
name = "isolated-final-zone"
operations = [
  { kind = "cuboid", from = { x = 0, y = 1, z = 0 }, to = { x = 3, y = 1, z = 3 }, block = "stone" },
  { kind = "cuboid", from = { x = 5, y = 1, z = 5 }, to = { x = 6, y = 1, z = 6 }, block = "stone" },
  { kind = "spawn", seat = 0, position = { x = 1, y = 2, z = 2 } },
  { kind = "spawn", seat = 1, position = { x = 3, y = 2, z = 1 } },
  { kind = "loot_container", position = { x = 2, y = 2, z = 3 }, inventory = ["bread"] }
]
[dimensions]
width = 12
depth = 12
min_y = 0
max_y = 8
"#
    }
}
