use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::{error::{SpecError, SpecErrorKind}, hash::{CanonicalHasher, SemanticId}, raw};

const MAX_BLOCK_WRITES: u64 = 1_000_000;
const MAX_OPERATIONS: usize = 100_000;

/// A block coordinate. Map compilation ensures every stored coordinate is within its map.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct BlockPosition {
    x: i32,
    y: i32,
    z: i32,
}

impl BlockPosition {
    /// Creates a coordinate value; map bounds are checked when it is compiled into a map.
    pub const fn new(x: i32, y: i32, z: i32) -> Self {
        Self { x, y, z }
    }

    pub const fn x(self) -> i32 { self.x }
    pub const fn y(self) -> i32 { self.y }
    pub const fn z(self) -> i32 { self.z }

    /// Returns the chunk containing this coordinate using Euclidean division.
    pub const fn chunk(self) -> ChunkPosition {
        ChunkPosition {
            x: self.x.div_euclid(16),
            z: self.z.div_euclid(16),
        }
    }
}

/// A Minecraft chunk coordinate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkPosition {
    x: i32,
    z: i32,
}

impl ChunkPosition {
    pub const fn x(self) -> i32 { self.x }
    pub const fn z(self) -> i32 { self.z }
}

/// Inclusive vertical and horizontal bounds for a compiled map.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MapDimensions {
    width: u32,
    depth: u32,
    min_y: i32,
    max_y: i32,
}

impl MapDimensions {
    pub const fn width(self) -> u32 { self.width }
    pub const fn depth(self) -> u32 { self.depth }
    pub const fn min_y(self) -> i32 { self.min_y }
    pub const fn max_y(self) -> i32 { self.max_y }
}

/// A final non-air block placement in canonical coordinate order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockPlacement {
    position: BlockPosition,
    block: String,
}

impl BlockPlacement {
    pub const fn position(&self) -> BlockPosition { self.position }
    pub fn block(&self) -> &str { &self.block }
}

/// A validated spawn point assigned to a stable seat.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpawnPoint {
    seat: u16,
    position: BlockPosition,
}

impl SpawnPoint {
    pub const fn seat(self) -> u16 { self.seat }
    pub const fn position(self) -> BlockPosition { self.position }
}

/// A chest setup record with its ordered starting inventory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LootContainer {
    position: BlockPosition,
    inventory: Vec<String>,
}

impl LootContainer {
    pub const fn position(&self) -> BlockPosition { self.position }
    pub fn inventory(&self) -> &[String] { &self.inventory }
}

/// Immutable, validated map input for the world adapter.
#[derive(Clone, Debug, PartialEq)]
pub struct MapIr {
    name: String,
    dimensions: MapDimensions,
    blocks: Vec<BlockPlacement>,
    spawns: Vec<SpawnPoint>,
    loot_containers: Vec<LootContainer>,
    surface_y: BTreeMap<(i32, i32), i32>,
    components: BTreeMap<(i32, i32), u32>,
    semantic_id: SemanticId,
}

impl MapIr {
    pub fn name(&self) -> &str { &self.name }
    pub const fn dimensions(&self) -> MapDimensions { self.dimensions }
    pub fn blocks(&self) -> &[BlockPlacement] { &self.blocks }
    pub fn spawns(&self) -> &[SpawnPoint] { &self.spawns }
    pub fn loot_containers(&self) -> &[LootContainer] { &self.loot_containers }
    pub const fn semantic_id(&self) -> SemanticId { self.semantic_id }

    pub(crate) fn validate_spawn_seats(&self, count: u16, path: &str) -> Result<(), SpecError> {
        if self.spawns.len() != usize::from(count) {
            return Err(SpecError::new(
                SpecErrorKind::Geometry,
                path,
                format!("map has {} spawns but scenario requires {count}", self.spawns.len()),
            ));
        }
        for (expected, spawn) in self.spawns.iter().enumerate() {
            if usize::from(spawn.seat) != expected {
                return Err(SpecError::new(
                    SpecErrorKind::Geometry,
                    path,
                    format!("spawn seats must be contiguous from zero; expected seat {expected}"),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn validate_border(
        &self,
        initial_diameter: f64,
        final_diameter: f64,
        path: &str,
    ) -> Result<(), SpecError> {
        if initial_diameter > f64::from(self.dimensions.width.min(self.dimensions.depth)) {
            return Err(SpecError::new(
                SpecErrorKind::Geometry,
                path,
                "initial border diameter must fit inside the map footprint",
            ));
        }
        let center_x = (f64::from(self.dimensions.width) - 1.0) / 2.0;
        let center_z = (f64::from(self.dimensions.depth) - 1.0) / 2.0;
        let initial_radius_squared = (initial_diameter / 2.0).powi(2);
        let final_radius_squared = (final_diameter / 2.0).powi(2);

        for spawn in &self.spawns {
            if !inside_circle(spawn.position.x, spawn.position.z, center_x, center_z, initial_radius_squared) {
                return Err(SpecError::new(
                    SpecErrorKind::Geometry,
                    path,
                    format!("spawn seat {} lies outside the initial border", spawn.seat),
                ));
            }
            let column = (spawn.position.x, spawn.position.z);
            let component = self.components[&column];
            let reaches_final_zone = self.surface_y.iter().any(|(&(x, z), _)| {
                self.components.get(&(x, z)) == Some(&component)
                    && inside_circle(x, z, center_x, center_z, final_radius_squared)
            });
            if !reaches_final_zone {
                return Err(SpecError::new(
                    SpecErrorKind::Geometry,
                    path,
                    format!("spawn seat {} cannot reach the final border zone", spawn.seat),
                ));
            }
        }

        for container in &self.loot_containers {
            if !inside_circle(
                container.position.x,
                container.position.z,
                center_x,
                center_z,
                initial_radius_squared,
            ) {
                return Err(SpecError::new(
                    SpecErrorKind::Geometry,
                    path,
                    "loot container lies outside the initial border",
                ));
            }
        }
        Ok(())
    }
}

/// Compiles a schema-v1 TOML map into immutable, validated world data.
pub fn compile_map(source: &str) -> Result<MapIr, SpecError> {
    let root = raw::parse_document(source, "map")?;
    let root = raw::as_table(&root, "map")?;
    raw::check_fields(root, &["schema", "name", "dimensions", "operations"], &["schema", "name", "dimensions", "operations"], "map")?;

    let schema = raw::integer(raw::field(root, "schema", "map")?, "map.schema")?;
    if schema != 1 {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, "map.schema", "only schema version 1 is supported"));
    }
    let name = raw::string(raw::field(root, "name", "map")?, "map.name")?;
    let dimensions = parse_dimensions(raw::field(root, "dimensions", "map")?)?;
    let operations = raw::as_array(raw::field(root, "operations", "map")?, "map.operations")?;
    if operations.len() > MAX_OPERATIONS {
        return Err(SpecError::new(
            SpecErrorKind::ResourceLimit,
            "map.operations",
            format!("at most {MAX_OPERATIONS} operations are supported"),
        ));
    }

    let mut blocks = BTreeMap::<BlockPosition, String>::new();
    let mut spawns = BTreeMap::<u16, BlockPosition>::new();
    let mut loot = BTreeMap::<BlockPosition, Vec<String>>::new();
    let mut attempted_writes = 0u64;

    for (index, operation) in operations.iter().enumerate() {
        let path = format!("map.operations[{index}]");
        let operation = raw::as_table(operation, &path)?;
        let kind = raw::string(raw::field(operation, "kind", &path)?, &format!("{path}.kind"))?;
        match kind.as_str() {
            "cuboid" => {
                raw::check_fields(operation, &["kind", "from", "to", "block"], &["kind", "from", "to", "block"], &path)?;
                let from = parse_position(raw::field(operation, "from", &path)?, &format!("{path}.from"), dimensions)?;
                let to = parse_position(raw::field(operation, "to", &path)?, &format!("{path}.to"), dimensions)?;
                if from.x > to.x || from.y > to.y || from.z > to.z {
                    return Err(SpecError::new(SpecErrorKind::Range, &path, "cuboid `from` coordinates must not exceed `to` coordinates"));
                }
                let block = parse_resource_id(raw::field(operation, "block", &path)?, &format!("{path}.block"))?;
                let x_count = (i64::from(to.x) - i64::from(from.x) + 1) as u64;
                let y_count = (i64::from(to.y) - i64::from(from.y) + 1) as u64;
                let z_count = (i64::from(to.z) - i64::from(from.z) + 1) as u64;
                let volume = x_count.checked_mul(y_count).and_then(|n| n.checked_mul(z_count)).ok_or_else(|| {
                    SpecError::new(SpecErrorKind::Range, &path, "cuboid volume overflows")
                })?;
                attempted_writes = add_block_writes(attempted_writes, volume, &path)?;
                if loot.keys().any(|position| inside_cuboid(*position, from, to)) {
                    return Err(SpecError::new(SpecErrorKind::Conflict, &path, "block operation would overwrite an earlier loot container"));
                }
                for x in from.x..=to.x {
                    for y in from.y..=to.y {
                        for z in from.z..=to.z {
                            assign_block(&mut blocks, BlockPosition::new(x, y, z), &block);
                        }
                    }
                }
            }
            "path" | "ramp" => {
                raw::check_fields(operation, &["kind", "position", "block"], &["kind", "position", "block"], &path)?;
                let position = parse_position(raw::field(operation, "position", &path)?, &format!("{path}.position"), dimensions)?;
                let block = parse_resource_id(raw::field(operation, "block", &path)?, &format!("{path}.block"))?;
                attempted_writes = add_block_writes(attempted_writes, 1, &path)?;
                if loot.contains_key(&position) {
                    return Err(SpecError::new(SpecErrorKind::Conflict, &path, "block operation would overwrite an earlier loot container"));
                }
                assign_block(&mut blocks, position, &block);
            }
            "spawn" => {
                raw::check_fields(operation, &["kind", "position", "seat"], &["kind", "position", "seat"], &path)?;
                let position = parse_position(raw::field(operation, "position", &path)?, &format!("{path}.position"), dimensions)?;
                let seat = nonnegative_u16(raw::field(operation, "seat", &path)?, &format!("{path}.seat"))?;
                if spawns.insert(seat, position).is_some() {
                    return Err(SpecError::new(SpecErrorKind::Conflict, format!("{path}.seat"), "spawn seat is declared more than once"));
                }
            }
            "loot_container" => {
                raw::check_fields(operation, &["kind", "position", "inventory"], &["kind", "position", "inventory"], &path)?;
                let position = parse_position(raw::field(operation, "position", &path)?, &format!("{path}.position"), dimensions)?;
                let inventory_values = raw::as_array(raw::field(operation, "inventory", &path)?, &format!("{path}.inventory"))?;
                let mut inventory = Vec::with_capacity(inventory_values.len());
                for (item_index, value) in inventory_values.iter().enumerate() {
                    inventory.push(parse_resource_id(value, &format!("{path}.inventory[{item_index}]"))?);
                }
                if inventory.is_empty() {
                    return Err(SpecError::new(SpecErrorKind::InvalidValue, format!("{path}.inventory"), "loot inventory must contain at least one item"));
                }
                if loot.insert(position, inventory).is_some() {
                    return Err(SpecError::new(SpecErrorKind::Conflict, format!("{path}.position"), "loot container position is declared more than once"));
                }
                assign_block(&mut blocks, position, "minecraft:chest");
            }
            _ => {
                return Err(SpecError::new(SpecErrorKind::InvalidValue, format!("{path}.kind"), format!("unknown map operation `{kind}`")));
            }
        }
    }

    if spawns.is_empty() {
        return Err(SpecError::new(SpecErrorKind::Geometry, "map.operations", "map must define at least one spawn"));
    }
    if loot.is_empty() {
        return Err(SpecError::new(SpecErrorKind::Geometry, "map.operations", "map must define at least one loot container"));
    }

    let surface_y = build_walkable_surface(&blocks, dimensions)?;
    let components = label_surface_components(&surface_y);
    let spawn_points: Vec<_> = spawns
        .into_iter()
        .map(|(seat, position)| SpawnPoint { seat, position })
        .collect();
    let loot_containers: Vec<_> = loot
        .into_iter()
        .map(|(position, inventory)| LootContainer { position, inventory })
        .collect();
    validate_spawns(&spawn_points, &surface_y, &components)?;
    validate_loot(&loot_containers, &blocks, &surface_y, &components, spawn_points[0])?;
    let block_placements: Vec<_> = blocks
        .into_iter()
        .map(|(position, block)| BlockPlacement { position, block })
        .collect();
    let semantic_id = hash_map(dimensions, &block_placements, &spawn_points, &loot_containers);

    Ok(MapIr {
        name,
        dimensions,
        blocks: block_placements,
        spawns: spawn_points,
        loot_containers,
        surface_y,
        components,
        semantic_id,
    })
}

fn parse_dimensions(value: &raw::RawValue) -> Result<MapDimensions, SpecError> {
    let table = raw::as_table(value, "map.dimensions")?;
    raw::check_fields(table, &["width", "depth", "min_y", "max_y"], &["width", "depth", "min_y", "max_y"], "map.dimensions")?;
    let width = positive_u32(raw::field(table, "width", "map.dimensions")?, "map.dimensions.width")?;
    let depth = positive_u32(raw::field(table, "depth", "map.dimensions")?, "map.dimensions.depth")?;
    let min_y = signed_i32(raw::field(table, "min_y", "map.dimensions")?, "map.dimensions.min_y")?;
    let max_y = signed_i32(raw::field(table, "max_y", "map.dimensions")?, "map.dimensions.max_y")?;
    if width - 1 > i32::MAX as u32 || depth - 1 > i32::MAX as u32 {
        return Err(SpecError::new(SpecErrorKind::Range, "map.dimensions", "width and depth must fit signed block coordinates"));
    }
    if min_y > max_y {
        return Err(SpecError::new(SpecErrorKind::Range, "map.dimensions.max_y", "must be greater than or equal to min_y"));
    }
    Ok(MapDimensions { width, depth, min_y, max_y })
}

fn parse_position(value: &raw::RawValue, path: &str, dimensions: MapDimensions) -> Result<BlockPosition, SpecError> {
    let table = raw::as_table(value, path)?;
    raw::check_fields(table, &["x", "y", "z"], &["x", "y", "z"], path)?;
    let x = signed_i32(raw::field(table, "x", path)?, &format!("{path}.x"))?;
    let y = signed_i32(raw::field(table, "y", path)?, &format!("{path}.y"))?;
    let z = signed_i32(raw::field(table, "z", path)?, &format!("{path}.z"))?;
    let position = BlockPosition::new(x, y, z);
    check_position(position, dimensions, path)?;
    Ok(position)
}

fn check_position(position: BlockPosition, dimensions: MapDimensions, path: &str) -> Result<(), SpecError> {
    if position.x < 0 || position.x as u32 >= dimensions.width {
        return Err(SpecError::new(SpecErrorKind::Range, format!("{path}.x"), "must be within the map width"));
    }
    if position.z < 0 || position.z as u32 >= dimensions.depth {
        return Err(SpecError::new(SpecErrorKind::Range, format!("{path}.z"), "must be within the map depth"));
    }
    if position.y < dimensions.min_y || position.y > dimensions.max_y {
        return Err(SpecError::new(SpecErrorKind::Range, format!("{path}.y"), "must be within the map vertical bounds"));
    }
    Ok(())
}

fn positive_u32(value: &raw::RawValue, path: &str) -> Result<u32, SpecError> {
    let integer = raw::integer(value, path)?;
    if integer <= 0 {
        return Err(SpecError::new(SpecErrorKind::Range, path, "must be greater than zero"));
    }
    u32::try_from(integer).map_err(|_| SpecError::new(SpecErrorKind::Range, path, "exceeds the supported coordinate range"))
}

fn signed_i32(value: &raw::RawValue, path: &str) -> Result<i32, SpecError> {
    let integer = raw::integer(value, path)?;
    i32::try_from(integer).map_err(|_| SpecError::new(SpecErrorKind::Range, path, "exceeds signed block coordinate range"))
}

fn nonnegative_u16(value: &raw::RawValue, path: &str) -> Result<u16, SpecError> {
    let integer = raw::integer(value, path)?;
    if integer < 0 {
        return Err(SpecError::new(SpecErrorKind::Range, path, "must not be negative"));
    }
    u16::try_from(integer).map_err(|_| SpecError::new(SpecErrorKind::Range, path, "exceeds the supported seat range"))
}

fn parse_resource_id(value: &raw::RawValue, path: &str) -> Result<String, SpecError> {
    let value = raw::string(value, path)?;
    let (namespace, resource_path) = match value.split_once(':') {
        Some((namespace, resource_path)) if !resource_path.contains(':') => (namespace, resource_path),
        Some(_) => return Err(SpecError::new(SpecErrorKind::InvalidValue, path, "must be a valid Minecraft resource identifier")),
        None => ("minecraft", value.as_str()),
    };
    if namespace.is_empty()
        || resource_path.is_empty()
        || !namespace.bytes().all(valid_namespace_byte)
        || !resource_path.bytes().all(valid_path_byte)
        || resource_path.starts_with('/')
        || resource_path.ends_with('/')
        || resource_path.contains("//")
    {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, path, "must be a valid Minecraft resource identifier"));
    }
    Ok(format!("{namespace}:{resource_path}"))
}

fn valid_namespace_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
}

fn valid_path_byte(byte: u8) -> bool {
    valid_namespace_byte(byte) || byte == b'/'
}

fn add_block_writes(current: u64, additional: u64, path: &str) -> Result<u64, SpecError> {
    let total = current.checked_add(additional).ok_or_else(|| {
        SpecError::new(SpecErrorKind::Range, path, "total block writes overflow")
    })?;
    if total > MAX_BLOCK_WRITES {
        return Err(SpecError::new(
            SpecErrorKind::ResourceLimit,
            path,
            format!("at most {MAX_BLOCK_WRITES} block writes are supported per map"),
        ));
    }
    Ok(total)
}

fn inside_cuboid(position: BlockPosition, from: BlockPosition, to: BlockPosition) -> bool {
    position.x >= from.x && position.x <= to.x
        && position.y >= from.y && position.y <= to.y
        && position.z >= from.z && position.z <= to.z
}

fn assign_block(blocks: &mut BTreeMap<BlockPosition, String>, position: BlockPosition, block: &str) {
    if is_air(block) {
        blocks.remove(&position);
    } else {
        blocks.insert(position, block.to_owned());
    }
}

fn is_air(block: &str) -> bool {
    matches!(block, "minecraft:air" | "minecraft:cave_air" | "minecraft:void_air")
}

fn build_walkable_surface(
    blocks: &BTreeMap<BlockPosition, String>,
    dimensions: MapDimensions,
) -> Result<BTreeMap<(i32, i32), i32>, SpecError> {
    let mut highest_block = BTreeMap::<(i32, i32), i32>::new();
    for position in blocks.keys() {
        highest_block
            .entry((position.x, position.z))
            .and_modify(|highest| *highest = (*highest).max(position.y))
            .or_insert(position.y);
    }

    let mut surface = BTreeMap::new();
    for ((x, z), block_y) in highest_block {
        let Some(feet_y) = block_y.checked_add(1) else {
            continue;
        };
        let Some(head_y) = feet_y.checked_add(1) else {
            continue;
        };
        if feet_y >= dimensions.min_y && head_y <= dimensions.max_y {
            surface.insert((x, z), feet_y);
        }
    }
    if surface.is_empty() {
        return Err(SpecError::new(SpecErrorKind::Geometry, "map.operations", "map has no two-block-high walkable surface"));
    }
    Ok(surface)
}

fn label_surface_components(surface: &BTreeMap<(i32, i32), i32>) -> BTreeMap<(i32, i32), u32> {
    let mut labels = BTreeMap::new();
    let mut next_component = 0u32;
    for &start in surface.keys() {
        if labels.contains_key(&start) {
            continue;
        }
        let component = next_component;
        next_component = next_component.wrapping_add(1);
        let mut queue = VecDeque::from([start]);
        labels.insert(start, component);
        while let Some((x, z)) = queue.pop_front() {
            let y = surface[&(x, z)];
            for (next_x, next_z) in cardinal_neighbors(x, z) {
                let Some(&next_y) = surface.get(&(next_x, next_z)) else {
                    continue;
                };
                if (i64::from(next_y) - i64::from(y)).abs() > 1 || labels.contains_key(&(next_x, next_z)) {
                    continue;
                }
                labels.insert((next_x, next_z), component);
                queue.push_back((next_x, next_z));
            }
        }
    }
    labels
}

fn cardinal_neighbors(x: i32, z: i32) -> [(i32, i32); 4] {
    [
        (x.saturating_add(1), z),
        (x.saturating_sub(1), z),
        (x, z.saturating_add(1)),
        (x, z.saturating_sub(1)),
    ]
}

fn validate_spawns(
    spawns: &[SpawnPoint],
    surface: &BTreeMap<(i32, i32), i32>,
    components: &BTreeMap<(i32, i32), u32>,
) -> Result<(), SpecError> {
    for (index, spawn) in spawns.iter().enumerate() {
        if surface.get(&(spawn.position.x, spawn.position.z)) != Some(&spawn.position.y) {
            return Err(SpecError::new(
                SpecErrorKind::Geometry,
                format!("map.spawn[{}]", spawn.seat),
                "spawn needs a full-block support with two clear blocks of headroom",
            ));
        }
        for other in spawns.iter().take(index) {
            let dx = i64::from(spawn.position.x) - i64::from(other.position.x);
            let dz = i64::from(spawn.position.z) - i64::from(other.position.z);
            if dx * dx + dz * dz < 4 {
                return Err(SpecError::new(
                    SpecErrorKind::Geometry,
                    format!("map.spawn[{}]", spawn.seat),
                    format!("spawn is less than two blocks from seat {}", other.seat),
                ));
            }
        }
    }
    let spawn_components: BTreeSet<_> = spawns
        .iter()
        .filter_map(|spawn| components.get(&(spawn.position.x, spawn.position.z)).copied())
        .collect();
    if spawn_components.len() != 1 {
        return Err(SpecError::new(SpecErrorKind::Geometry, "map.spawn", "all spawn seats must share one traversable surface"));
    }
    Ok(())
}

fn validate_loot(
    loot: &[LootContainer],
    blocks: &BTreeMap<BlockPosition, String>,
    surface: &BTreeMap<(i32, i32), i32>,
    components: &BTreeMap<(i32, i32), u32>,
    spawn: SpawnPoint,
) -> Result<(), SpecError> {
    let spawn_component = components.get(&(spawn.position.x, spawn.position.z)).copied().ok_or_else(|| {
        SpecError::new(SpecErrorKind::Geometry, "map.spawn", "map has no traversable spawn surface")
    })?;
    for (index, container) in loot.iter().enumerate() {
        let position = container.position;
        if !blocks.contains_key(&position) {
            return Err(SpecError::new(SpecErrorKind::Geometry, format!("map.loot[{index}]"), "loot container block is missing"));
        }
        let below_y = position.y.checked_sub(1).ok_or_else(|| {
            SpecError::new(SpecErrorKind::Geometry, format!("map.loot[{index}]"), "loot container has no support block below it")
        })?;
        if !blocks.contains_key(&BlockPosition::new(position.x, below_y, position.z)) {
            return Err(SpecError::new(SpecErrorKind::Geometry, format!("map.loot[{index}]"), "loot container needs a support block below it"));
        }
        let accessible_component = cardinal_neighbors(position.x, position.z)
            .iter()
            .find_map(|column| {
                (surface.get(column) == Some(&position.y))
                    .then(|| components.get(column).copied())
                    .flatten()
            });
        match accessible_component {
            Some(component) if component == spawn_component => {}
            Some(_) => return Err(SpecError::new(SpecErrorKind::Geometry, format!("map.loot[{index}]"), "loot container is unreachable from the spawn surface")),
            None => return Err(SpecError::new(SpecErrorKind::Geometry, format!("map.loot[{index}]"), "loot container needs an adjacent walkable interaction position")),
        }
    }
    Ok(())
}

fn inside_circle(x: i32, z: i32, center_x: f64, center_z: f64, radius_squared: f64) -> bool {
    let dx = f64::from(x) - center_x;
    let dz = f64::from(z) - center_z;
    dx * dx + dz * dz <= radius_squared
}

fn hash_map(
    dimensions: MapDimensions,
    blocks: &[BlockPlacement],
    spawns: &[SpawnPoint],
    loot: &[LootContainer],
) -> SemanticId {
    let mut hash = CanonicalHasher::new(b"arena.map.ir.v1\0");
    hash.u32(dimensions.width);
    hash.u32(dimensions.depth);
    hash.i32(dimensions.min_y);
    hash.i32(dimensions.max_y);
    hash.u64(blocks.len() as u64);
    for placement in blocks {
        hash.i32(placement.position.x);
        hash.i32(placement.position.y);
        hash.i32(placement.position.z);
        hash.string(&placement.block);
    }
    hash.u64(spawns.len() as u64);
    for spawn in spawns {
        hash.u16(spawn.seat);
        hash.i32(spawn.position.x);
        hash.i32(spawn.position.y);
        hash.i32(spawn.position.z);
    }
    hash.u64(loot.len() as u64);
    for container in loot {
        hash.i32(container.position.x);
        hash.i32(container.position.y);
        hash.i32(container.position.z);
        hash.u64(container.inventory.len() as u64);
        for item in &container.inventory {
            hash.string(item);
        }
    }
    hash.finish()
}
