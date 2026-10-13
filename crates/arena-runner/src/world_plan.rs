use std::{fmt, io};

use arena_spec::{BlockPlacement, LootContainer, MapIr, SpawnPoint};
use serde::{Serialize, ser::SerializeSeq};

const WORLD_PLAN_MAX_ENCODED_BYTES: usize = 128 * 1024 * 1024;
const WORLD_PLAN_SCHEMA_VERSION: u8 = 1;

/// A validated input for producing the offline world adapter's schema-v1 plan.
#[derive(Clone, Debug)]
pub struct WorldPlanV1<'a> {
    run_id: String,
    map: &'a MapIr,
}

impl<'a> WorldPlanV1<'a> {
    /// Validates the run identifier and that the map's spawns meet plan constraints.
    pub fn new(run_id: &str, map: &'a MapIr) -> Result<Self, WorldPlanError> {
        if !is_valid_run_id(run_id) {
            return Err(WorldPlanError::InvalidRunId);
        }
        if map.spawns().len() > 6 {
            return Err(WorldPlanError::TooManySpawns {
                count: map.spawns().len(),
            });
        }
        if let Some(spawn) = map.spawns().iter().find(|spawn| spawn.seat() > 5) {
            return Err(WorldPlanError::SpawnSeatOutsideSchema {
                seat: spawn.seat(),
            });
        }
        for (expected, spawn) in map.spawns().iter().enumerate() {
            let expected = u16::try_from(expected).expect("schema spawn count is at most six");
            if spawn.seat() != expected {
                return Err(WorldPlanError::NonContiguousSpawnSeats {
                    expected,
                    actual: spawn.seat(),
                });
            }
        }

        Ok(Self {
            run_id: run_id.to_owned(),
            map,
        })
    }

    /// Encodes the plan as compact JSON without allowing the output to exceed 128 MiB.
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, WorldPlanError> {
        serialize_with_limit(self, WORLD_PLAN_MAX_ENCODED_BYTES)
    }
}

/// A validation or encoding failure while producing a world plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorldPlanError {
    /// The run identifier does not match the schema's ASCII pattern or length limit.
    InvalidRunId,
    /// The map has more than the six supported spawn points.
    TooManySpawns { count: usize },
    /// A spawn seat exceeds the schema's range from zero through five.
    SpawnSeatOutsideSchema { seat: u16 },
    /// Spawn seats are not contiguous from zero.
    NonContiguousSpawnSeats { expected: u16, actual: u16 },
    /// The compact JSON output would exceed the configured byte limit.
    EncodedOutputTooLarge { max_bytes: usize },
    /// JSON serialization failed for a reason other than the output limit.
    SerializationFailed { message: String },
}

impl fmt::Display for WorldPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRunId => formatter.write_str("run id does not match the world-plan schema"),
            Self::TooManySpawns { count } => {
                write!(formatter, "world plan has {count} spawns; at most 6 are supported")
            }
            Self::SpawnSeatOutsideSchema { seat } => {
                write!(formatter, "spawn seat {seat} is outside the world-plan schema range 0..=5")
            }
            Self::NonContiguousSpawnSeats { expected, actual } => {
                write!(formatter, "expected spawn seat {expected} but found {actual}")
            }
            Self::EncodedOutputTooLarge { max_bytes } => {
                write!(formatter, "encoded world plan exceeds {max_bytes} bytes")
            }
            Self::SerializationFailed { message } => {
                write!(formatter, "could not serialize world plan: {message}")
            }
        }
    }
}

impl std::error::Error for WorldPlanError {}

fn is_valid_run_id(run_id: &str) -> bool {
    let bytes = run_id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
}

fn serialize_with_limit(
    plan: &WorldPlanV1<'_>,
    max_bytes: usize,
) -> Result<Vec<u8>, WorldPlanError> {
    let dimensions = plan.map.dimensions();
    let wire = WorldPlanWire {
        schema: WORLD_PLAN_SCHEMA_VERSION,
        run_id: &plan.run_id,
        map_semantic_id: plan.map.semantic_id().to_hex(),
        dimensions: DimensionsWire {
            width: dimensions.width(),
            depth: dimensions.depth(),
            min_y: dimensions.min_y(),
            max_y: dimensions.max_y(),
        },
        blocks: BlocksWire(plan.map.blocks()),
        spawns: SpawnsWire(plan.map.spawns()),
        loot_containers: LootContainersWire(plan.map.loot_containers()),
    };

    let mut writer = BoundedVecWriter::new(max_bytes);
    if let Err(error) = serde_json::to_writer(&mut writer, &wire) {
        if writer.exceeded_limit {
            return Err(WorldPlanError::EncodedOutputTooLarge { max_bytes });
        }
        return Err(WorldPlanError::SerializationFailed {
            message: error.to_string(),
        });
    }
    Ok(writer.bytes)
}

#[derive(Serialize)]
struct WorldPlanWire<'a> {
    schema: u8,
    run_id: &'a str,
    map_semantic_id: String,
    dimensions: DimensionsWire,
    blocks: BlocksWire<'a>,
    spawns: SpawnsWire<'a>,
    loot_containers: LootContainersWire<'a>,
}

#[derive(Serialize)]
struct DimensionsWire {
    width: u32,
    depth: u32,
    min_y: i32,
    max_y: i32,
}

#[derive(Serialize)]
struct PositionWire {
    x: i32,
    y: i32,
    z: i32,
}

impl From<arena_spec::BlockPosition> for PositionWire {
    fn from(position: arena_spec::BlockPosition) -> Self {
        Self {
            x: position.x(),
            y: position.y(),
            z: position.z(),
        }
    }
}

#[derive(Serialize)]
struct BlockWire<'a> {
    position: PositionWire,
    block: &'a str,
}

struct BlocksWire<'a>(&'a [BlockPlacement]);

impl Serialize for BlocksWire<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for block in self.0 {
            sequence.serialize_element(&BlockWire {
                position: block.position().into(),
                block: block.block(),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct SpawnWire {
    seat: u16,
    position: PositionWire,
}

struct SpawnsWire<'a>(&'a [SpawnPoint]);

impl Serialize for SpawnsWire<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for spawn in self.0 {
            sequence.serialize_element(&SpawnWire {
                seat: spawn.seat(),
                position: spawn.position().into(),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct LootContainerWire<'a> {
    position: PositionWire,
    inventory: &'a [String],
}

struct LootContainersWire<'a>(&'a [LootContainer]);

impl Serialize for LootContainersWire<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for container in self.0 {
            sequence.serialize_element(&LootContainerWire {
                position: container.position().into(),
                inventory: container.inventory(),
            })?;
        }
        sequence.end()
    }
}

struct BoundedVecWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
    exceeded_limit: bool,
}

impl BoundedVecWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
            exceeded_limit: false,
        }
    }
}

impl io::Write for BoundedVecWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self.max_bytes.saturating_sub(self.bytes.len());
        if bytes.len() > remaining {
            self.exceeded_limit = true;
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "encoded world plan exceeds the output limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use arena_spec::compile_map;
    use serde_json::{Value, json};

    use super::{
        WORLD_PLAN_MAX_ENCODED_BYTES, WorldPlanError, WorldPlanV1, serialize_with_limit,
    };

    const FIXTURE_MAP: &str = r#"
schema = 1
name = "fixture"
dimensions = { width = 4, depth = 4, min_y = 0, max_y = 3 }
operations = [
  { kind = "cuboid", from = { x = 0, y = 0, z = 0 }, to = { x = 2, y = 0, z = 2 }, block = "minecraft:stone" },
  { kind = "spawn", seat = 0, position = { x = 0, y = 1, z = 0 } },
  { kind = "loot_container", position = { x = 2, y = 1, z = 2 }, inventory = ["minecraft:apple"] }
]
"#;

    const ORDERED_MAP_OPERATIONS: [&str; 5] = [
        r#"{ kind = "cuboid", from = { x = 0, y = 0, z = 0 }, to = { x = 7, y = 0, z = 3 }, block = "minecraft:stone" }"#,
        r#"{ kind = "spawn", seat = 1, position = { x = 7, y = 1, z = 0 } }"#,
        r#"{ kind = "spawn", seat = 0, position = { x = 0, y = 1, z = 0 } }"#,
        r#"{ kind = "loot_container", position = { x = 5, y = 1, z = 2 }, inventory = ["minecraft:bread", "minecraft:apple"] }"#,
        r#"{ kind = "loot_container", position = { x = 2, y = 1, z = 2 }, inventory = ["minecraft:apple", "minecraft:bread"] }"#,
    ];

    #[test]
    fn world_plan_v1_matches_committed_fixture_and_schema() {
        let map = compile_map(FIXTURE_MAP).expect("fixture map compiles");
        let plan = WorldPlanV1::new("fixture-run", &map).expect("run id is valid");
        let bytes = plan.to_json_bytes().expect("world plan serializes");
        let actual: Value = serde_json::from_slice(&bytes).expect("world plan is JSON");
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/world-plan/world-plan-v1.json"
        ))
        .expect("committed fixture is JSON");
        let schema: Value = serde_json::from_str(include_str!(
            "../../../schemas/world-plan.schema.json"
        ))
        .expect("world-plan schema is JSON");

        assert_eq!(actual, fixture);
        assert_eq!(actual["map_semantic_id"], map.semantic_id().to_hex());
        assert_eq!(schema["properties"]["schema"]["const"], 1);
        assert_eq!(schema["additionalProperties"], false);

        let mut required: Vec<_> = schema["required"]
            .as_array()
            .expect("schema has required fields")
            .iter()
            .map(|field| field.as_str().expect("required field is a string"))
            .collect();
        required.sort_unstable();
        let mut actual_fields: Vec<_> = actual
            .as_object()
            .expect("plan is an object")
            .keys()
            .map(String::as_str)
            .collect();
        actual_fields.sort_unstable();
        assert_eq!(actual_fields, required);
        assert!(!bytes.iter().any(|byte| matches!(*byte, b' ' | b'\n' | b'\r' | b'\t')));
    }

    #[test]
    fn world_plan_v1_uses_canonical_order_and_preserves_inventory_order() {
        let first = compile_map(&map_with_operations(&ORDERED_MAP_OPERATIONS))
            .expect("ordered map compiles");
        let reversed_operations: Vec<_> = ORDERED_MAP_OPERATIONS.iter().rev().copied().collect();
        let second = compile_map(&map_with_operations(&reversed_operations))
            .expect("reversed map operations compile");
        let first_plan = WorldPlanV1::new("stable-order", &first).expect("run id is valid");
        let second_plan = WorldPlanV1::new("stable-order", &second).expect("run id is valid");
        let first_bytes = first_plan.to_json_bytes().expect("first plan serializes");
        let second_bytes = second_plan.to_json_bytes().expect("second plan serializes");
        let actual: Value = serde_json::from_slice(&first_bytes).expect("world plan is JSON");

        assert_eq!(first_bytes, second_bytes);
        assert_eq!(
            actual["spawns"],
            json!([
                { "seat": 0, "position": { "x": 0, "y": 1, "z": 0 } },
                { "seat": 1, "position": { "x": 7, "y": 1, "z": 0 } }
            ])
        );
        assert_eq!(
            actual["loot_containers"],
            json!([
                { "position": { "x": 2, "y": 1, "z": 2 }, "inventory": ["minecraft:apple", "minecraft:bread"] },
                { "position": { "x": 5, "y": 1, "z": 2 }, "inventory": ["minecraft:bread", "minecraft:apple"] }
            ])
        );
        let blocks = actual["blocks"].as_array().expect("blocks are an array");
        let positions: Vec<_> = blocks.iter().map(|block| &block["position"]).collect();
        let mut sorted_positions = positions.clone();
        sorted_positions.sort_by_key(|position| {
            (
                position["x"].as_i64().expect("x is an integer"),
                position["y"].as_i64().expect("y is an integer"),
                position["z"].as_i64().expect("z is an integer"),
            )
        });
        assert_eq!(positions, sorted_positions);
    }

    #[test]
    fn world_plan_v1_rejects_invalid_run_id() {
        let map = compile_map(FIXTURE_MAP).expect("fixture map compiles");

        for invalid in ["", "-starts-with-hyphen", "_starts-with-underscore", "bad id", "é"] {
            assert_eq!(
                WorldPlanV1::new(invalid, &map).err(),
                Some(WorldPlanError::InvalidRunId),
                "accepted invalid run id {invalid:?}"
            );
        }
        let too_long = "x".repeat(65);
        assert_eq!(
            WorldPlanV1::new(&too_long, &map).err(),
            Some(WorldPlanError::InvalidRunId)
        );
        let maximum_length = format!("a{}", "b".repeat(63));
        assert!(WorldPlanV1::new(&maximum_length, &map).is_ok());
    }

    #[test]
    fn world_plan_v1_rejects_noncontiguous_spawn_seats() {
        let sparse_spawn_map = FIXTURE_MAP.replace("seat = 0", "seat = 2");
        let map = compile_map(&sparse_spawn_map).expect("map with sparse seats compiles");

        assert_eq!(
            WorldPlanV1::new("fixture-run", &map).err(),
            Some(WorldPlanError::NonContiguousSpawnSeats {
                expected: 0,
                actual: 2,
            })
        );
    }

    #[test]
    fn world_plan_v1_rejects_encoded_output_over_limit() {
        let map = compile_map(FIXTURE_MAP).expect("fixture map compiles");
        let plan = WorldPlanV1::new("fixture-run", &map).expect("run id is valid");
        let max_bytes = 1;

        assert_eq!(WORLD_PLAN_MAX_ENCODED_BYTES, 128 * 1024 * 1024);
        assert_eq!(
            serialize_with_limit(&plan, max_bytes),
            Err(WorldPlanError::EncodedOutputTooLarge { max_bytes })
        );
    }

    fn map_with_operations(operations: &[&str]) -> String {
        let mut source = String::from(
            "schema = 1\nname = \"order-test\"\ndimensions = { width = 8, depth = 4, min_y = 0, max_y = 3 }\noperations = [\n",
        );
        for operation in operations {
            source.push_str("  ");
            source.push_str(operation);
            source.push_str(",\n");
        }
        source.push_str("]\n");
        source
    }
}
