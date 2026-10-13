use crate::{error::{SpecError, SpecErrorKind}, hash::{CanonicalHasher, SemanticId}, map::{MapIr, compile_map}, raw};

/// A supported Arena game mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameMode {
    HungerGames,
    Civilization,
}

impl GameMode {
    fn tag(self) -> u8 {
        match self {
            Self::HungerGames => 0,
            Self::Civilization => 1,
        }
    }
}

/// Stable competitor seats and spectator capacity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Roster {
    competitors: u16,
    human_seats_in_play_mode: u16,
    spectator_capacity: u64,
}

impl Roster {
    pub const fn competitors(self) -> u16 { self.competitors }
    pub const fn human_seats_in_play_mode(self) -> u16 { self.human_seats_in_play_mode }
    pub const fn spectator_capacity(self) -> u64 { self.spectator_capacity }
}

/// Locked-server settings supplied by a scenario.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerSettings {
    minecraft: String,
    view_distance_chunks: u8,
    simulation_distance_chunks: u8,
    max_tick_rate: u8,
}

impl ServerSettings {
    pub fn minecraft(&self) -> &str { &self.minecraft }
    pub const fn view_distance_chunks(&self) -> u8 { self.view_distance_chunks }
    pub const fn simulation_distance_chunks(&self) -> u8 { self.simulation_distance_chunks }
    pub const fn max_tick_rate(&self) -> u8 { self.max_tick_rate }
}

/// Match behavior and authoritative tick limits.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MatchSettings {
    countdown_ticks: u64,
    grace_ticks: u64,
    authoritative_max_ticks: u64,
    respawn: bool,
    block_breaking: bool,
    block_placing: bool,
    natural_mobs: bool,
    natural_random_ticks: bool,
}

impl MatchSettings {
    pub const fn countdown_ticks(self) -> u64 { self.countdown_ticks }
    pub const fn grace_ticks(self) -> u64 { self.grace_ticks }
    pub const fn authoritative_max_ticks(self) -> u64 { self.authoritative_max_ticks }
    pub const fn respawn(self) -> bool { self.respawn }
    pub const fn block_breaking(self) -> bool { self.block_breaking }
    pub const fn block_placing(self) -> bool { self.block_placing }
    pub const fn natural_mobs(self) -> bool { self.natural_mobs }
    pub const fn natural_random_ticks(self) -> bool { self.natural_random_ticks }
}

/// Tick-driven world border settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BorderSettings {
    initial_diameter_blocks: f64,
    shrink_start_tick: u64,
    shrink_end_tick: u64,
    final_diameter_blocks: f64,
}

impl BorderSettings {
    pub const fn initial_diameter_blocks(self) -> f64 { self.initial_diameter_blocks }
    pub const fn shrink_start_tick(self) -> u64 { self.shrink_start_tick }
    pub const fn shrink_end_tick(self) -> u64 { self.shrink_end_tick }
    pub const fn final_diameter_blocks(self) -> f64 { self.final_diameter_blocks }
}

/// Bounded pathfinding and policy cadence settings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BotSettings {
    strategy_interval_ticks: u64,
    path_expansions_per_slice: u64,
    max_pending_paths_per_bot: u64,
}

impl BotSettings {
    pub const fn strategy_interval_ticks(self) -> u64 { self.strategy_interval_ticks }
    pub const fn path_expansions_per_slice(self) -> u64 { self.path_expansions_per_slice }
    pub const fn max_pending_paths_per_bot(self) -> u64 { self.max_pending_paths_per_bot }
    pub const fn perception(self) -> Perception { Perception::CompetitiveV1 }
}

/// A registered observation view; evaluator-only full state is deliberately absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Perception {
    CompetitiveV1,
}

/// Evaluation recording options.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordSettings {
    policy_replay: bool,
    world_outcomes: bool,
}

impl RecordSettings {
    pub const fn policy_replay(self) -> bool { self.policy_replay }
    pub const fn world_outcomes(self) -> bool { self.world_outcomes }
}

/// A normalized reference relative to the declaring scenario file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceReference(String);

impl ResourceReference {
    pub fn as_str(&self) -> &str { &self.0 }
}

/// Immutable, fully validated scenario settings and map IR.
#[derive(Clone, Debug, PartialEq)]
pub struct ScenarioIr {
    name: String,
    mode: GameMode,
    seed: u64,
    map_reference: ResourceReference,
    policy_reference: ResourceReference,
    roster: Roster,
    server: ServerSettings,
    match_settings: MatchSettings,
    border: BorderSettings,
    bots: BotSettings,
    record: RecordSettings,
    map: MapIr,
    semantic_id: SemanticId,
}

impl ScenarioIr {
    pub fn name(&self) -> &str { &self.name }
    pub const fn mode(&self) -> GameMode { self.mode }
    pub const fn seed(&self) -> u64 { self.seed }
    pub fn map_reference(&self) -> &ResourceReference { &self.map_reference }
    pub fn policy_reference(&self) -> &ResourceReference { &self.policy_reference }
    pub const fn roster(&self) -> Roster { self.roster }
    pub fn server(&self) -> &ServerSettings { &self.server }
    pub const fn match_settings(&self) -> MatchSettings { self.match_settings }
    pub const fn border(&self) -> BorderSettings { self.border }
    pub const fn bots(&self) -> BotSettings { self.bots }
    pub const fn record(&self) -> RecordSettings { self.record }
    pub fn map(&self) -> &MapIr { &self.map }
    pub const fn semantic_id(&self) -> SemanticId { self.semantic_id }
}

/// Compiles a schema-v1 scenario and the content of its declared map.
///
/// File access and repository-root confinement remain the runner's responsibility.
pub fn compile_scenario(scenario_source: &str, map_source: &str) -> Result<ScenarioIr, SpecError> {
    let root = raw::parse_document(scenario_source, "scenario")?;
    let root = raw::as_table(&root, "scenario")?;
    raw::check_fields(
        root,
        &["schema", "name", "mode", "seed", "map", "policy", "roster", "server", "match", "border", "bots", "record"],
        &["schema", "name", "mode", "seed", "map", "policy", "roster", "server", "match", "border", "bots", "record"],
        "scenario",
    )?;
    let schema = raw::integer(raw::field(root, "schema", "scenario")?, "scenario.schema")?;
    if schema != 1 {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.schema", "only schema version 1 is supported"));
    }
    let name = raw::string(raw::field(root, "name", "scenario")?, "scenario.name")?;
    let mode = parse_mode(raw::field(root, "mode", "scenario")?)?;
    let seed = nonnegative_u64(raw::field(root, "seed", "scenario")?, "scenario.seed")?;
    let map_reference = parse_reference(raw::field(root, "map", "scenario")?, "scenario.map")?;
    let policy_reference = parse_reference(raw::field(root, "policy", "scenario")?, "scenario.policy")?;
    let roster = parse_roster(raw::field(root, "roster", "scenario")?)?;
    let server = parse_server(raw::field(root, "server", "scenario")?)?;
    let match_settings = parse_match(raw::field(root, "match", "scenario")?)?;
    let border = parse_border(raw::field(root, "border", "scenario")?, match_settings)?;
    let bots = parse_bots(raw::field(root, "bots", "scenario")?)?;
    let record = parse_record(raw::field(root, "record", "scenario")?)?;

    validate_mode(mode, roster, match_settings)?;
    let map = compile_map(map_source)?;
    map.validate_spawn_seats(roster.competitors, "scenario.roster.competitors")?;
    map.validate_border(border.initial_diameter_blocks, border.final_diameter_blocks, "scenario.border")?;
    let semantic_id = hash_scenario(
        mode,
        seed,
        &policy_reference,
        roster,
        &server,
        match_settings,
        border,
        bots,
        record,
        map.semantic_id(),
    );

    Ok(ScenarioIr {
        name,
        mode,
        seed,
        map_reference,
        policy_reference,
        roster,
        server,
        match_settings,
        border,
        bots,
        record,
        map,
        semantic_id,
    })
}

fn parse_mode(value: &raw::RawValue) -> Result<GameMode, SpecError> {
    match raw::string(value, "scenario.mode")?.as_str() {
        "hunger_games" => Ok(GameMode::HungerGames),
        "civilization" => Ok(GameMode::Civilization),
        value => Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.mode", format!("unknown mode `{value}`"))),
    }
}

fn parse_roster(value: &raw::RawValue) -> Result<Roster, SpecError> {
    let path = "scenario.roster";
    let table = raw::as_table(value, path)?;
    raw::check_fields(table, &["competitors", "human_seats_in_play_mode", "spectator_capacity"], &["competitors", "human_seats_in_play_mode", "spectator_capacity"], path)?;
    let competitors = bounded_u16(raw::field(table, "competitors", path)?, "scenario.roster.competitors", 1, 6)?;
    let human_seats_in_play_mode = bounded_u16(raw::field(table, "human_seats_in_play_mode", path)?, "scenario.roster.human_seats_in_play_mode", 0, 1)?;
    let spectator_capacity = nonnegative_u64(raw::field(table, "spectator_capacity", path)?, "scenario.roster.spectator_capacity")?;
    if human_seats_in_play_mode > competitors {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.roster.human_seats_in_play_mode", "cannot exceed the competitor count"));
    }
    Ok(Roster { competitors, human_seats_in_play_mode, spectator_capacity })
}

fn parse_server(value: &raw::RawValue) -> Result<ServerSettings, SpecError> {
    let path = "scenario.server";
    let table = raw::as_table(value, path)?;
    raw::check_fields(table, &["minecraft", "view_distance_chunks", "simulation_distance_chunks", "max_tick_rate"], &["minecraft", "view_distance_chunks", "simulation_distance_chunks", "max_tick_rate"], path)?;
    let minecraft = raw::string(raw::field(table, "minecraft", path)?, "scenario.server.minecraft")?;
    let view_distance_chunks = bounded_u8(raw::field(table, "view_distance_chunks", path)?, "scenario.server.view_distance_chunks", 2, 32)?;
    let simulation_distance_chunks = bounded_u8(raw::field(table, "simulation_distance_chunks", path)?, "scenario.server.simulation_distance_chunks", 2, 32)?;
    let max_tick_rate = bounded_u8(raw::field(table, "max_tick_rate", path)?, "scenario.server.max_tick_rate", 1, 20)?;
    if simulation_distance_chunks > view_distance_chunks {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.server.simulation_distance_chunks", "cannot exceed view_distance_chunks"));
    }
    Ok(ServerSettings { minecraft, view_distance_chunks, simulation_distance_chunks, max_tick_rate })
}

fn parse_match(value: &raw::RawValue) -> Result<MatchSettings, SpecError> {
    let path = "scenario.match";
    let table = raw::as_table(value, path)?;
    raw::check_fields(
        table,
        &["countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking", "block_placing", "natural_mobs", "natural_random_ticks"],
        &["countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking", "block_placing", "natural_mobs", "natural_random_ticks"],
        path,
    )?;
    let countdown_ticks = nonnegative_u64(raw::field(table, "countdown_ticks", path)?, "scenario.match.countdown_ticks")?;
    let grace_ticks = nonnegative_u64(raw::field(table, "grace_ticks", path)?, "scenario.match.grace_ticks")?;
    let authoritative_max_ticks = positive_u64(raw::field(table, "authoritative_max_ticks", path)?, "scenario.match.authoritative_max_ticks")?;
    let _countdown_and_grace = i64::try_from(countdown_ticks)
        .ok()
        .and_then(|countdown| i64::try_from(grace_ticks).ok().and_then(|grace| countdown.checked_add(grace)))
        .ok_or_else(|| SpecError::new(SpecErrorKind::Range, path, "countdown plus grace ticks exceed the supported signed tick range"))?;
    let settings = MatchSettings {
        countdown_ticks,
        grace_ticks,
        authoritative_max_ticks,
        respawn: raw::boolean(raw::field(table, "respawn", path)?, "scenario.match.respawn")?,
        block_breaking: raw::boolean(raw::field(table, "block_breaking", path)?, "scenario.match.block_breaking")?,
        block_placing: raw::boolean(raw::field(table, "block_placing", path)?, "scenario.match.block_placing")?,
        natural_mobs: raw::boolean(raw::field(table, "natural_mobs", path)?, "scenario.match.natural_mobs")?,
        natural_random_ticks: raw::boolean(raw::field(table, "natural_random_ticks", path)?, "scenario.match.natural_random_ticks")?,
    };
    if settings.grace_ticks >= settings.authoritative_max_ticks {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.match.grace_ticks", "must end before authoritative_max_ticks"));
    }
    Ok(settings)
}

fn parse_border(value: &raw::RawValue, match_settings: MatchSettings) -> Result<BorderSettings, SpecError> {
    let path = "scenario.border";
    let table = raw::as_table(value, path)?;
    raw::check_fields(table, &["initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"], &["initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"], path)?;
    let initial_diameter_blocks = positive_number(raw::field(table, "initial_diameter_blocks", path)?, "scenario.border.initial_diameter_blocks")?;
    let shrink_start_tick = nonnegative_u64(raw::field(table, "shrink_start_tick", path)?, "scenario.border.shrink_start_tick")?;
    let shrink_end_tick = nonnegative_u64(raw::field(table, "shrink_end_tick", path)?, "scenario.border.shrink_end_tick")?;
    let final_diameter_blocks = positive_number(raw::field(table, "final_diameter_blocks", path)?, "scenario.border.final_diameter_blocks")?;
    if final_diameter_blocks >= initial_diameter_blocks {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.border.final_diameter_blocks", "must be smaller than initial_diameter_blocks"));
    }
    if shrink_start_tick < match_settings.grace_ticks {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.border.shrink_start_tick", "cannot precede the end of grace"));
    }
    if shrink_end_tick <= shrink_start_tick {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.border.shrink_end_tick", "must be after shrink_start_tick"));
    }
    if shrink_end_tick >= match_settings.authoritative_max_ticks {
        return Err(SpecError::new(SpecErrorKind::Range, "scenario.border.shrink_end_tick", "must finish before authoritative_max_ticks"));
    }
    Ok(BorderSettings { initial_diameter_blocks, shrink_start_tick, shrink_end_tick, final_diameter_blocks })
}

fn parse_bots(value: &raw::RawValue) -> Result<BotSettings, SpecError> {
    let path = "scenario.bots";
    let table = raw::as_table(value, path)?;
    raw::check_fields(table, &["strategy_interval_ticks", "path_expansions_per_slice", "max_pending_paths_per_bot", "perception"], &["strategy_interval_ticks", "path_expansions_per_slice", "max_pending_paths_per_bot", "perception"], path)?;
    let strategy_interval_ticks = positive_u64(raw::field(table, "strategy_interval_ticks", path)?, "scenario.bots.strategy_interval_ticks")?;
    let path_expansions_per_slice = positive_u64(raw::field(table, "path_expansions_per_slice", path)?, "scenario.bots.path_expansions_per_slice")?;
    let max_pending_paths_per_bot = positive_u64(raw::field(table, "max_pending_paths_per_bot", path)?, "scenario.bots.max_pending_paths_per_bot")?;
    let perception = raw::string(raw::field(table, "perception", path)?, "scenario.bots.perception")?;
    if perception != "competitive-v1" {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.bots.perception", format!("unknown perception `{perception}`")));
    }
    Ok(BotSettings { strategy_interval_ticks, path_expansions_per_slice, max_pending_paths_per_bot })
}

fn parse_record(value: &raw::RawValue) -> Result<RecordSettings, SpecError> {
    let path = "scenario.record";
    let table = raw::as_table(value, path)?;
    raw::check_fields(table, &["mode", "policy_replay", "world_outcomes"], &["mode", "policy_replay", "world_outcomes"], path)?;
    let mode = raw::string(raw::field(table, "mode", path)?, "scenario.record.mode")?;
    if mode != "evaluation" {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.record.mode", format!("unknown record mode `{mode}`")));
    }
    Ok(RecordSettings {
        policy_replay: raw::boolean(raw::field(table, "policy_replay", path)?, "scenario.record.policy_replay")?,
        world_outcomes: raw::boolean(raw::field(table, "world_outcomes", path)?, "scenario.record.world_outcomes")?,
    })
}

fn parse_reference(value: &raw::RawValue, path: &str) -> Result<ResourceReference, SpecError> {
    let value = raw::string(value, path)?;
    if value.starts_with('/') || value.starts_with('\\') || value.contains('\\') || value.contains(':') || value.contains('\0') {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, path, "must be a relative repository reference using `/` separators"));
    }
    let mut components: Vec<String> = Vec::new();
    for component in value.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if components.last().is_some_and(|last| last != "..") {
                    components.pop();
                } else {
                    components.push("..".to_owned());
                }
            }
            other => components.push(other.to_owned()),
        }
    }
    if components.is_empty() {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, path, "must identify a repository file"));
    }
    Ok(ResourceReference(components.join("/")))
}

fn validate_mode(mode: GameMode, roster: Roster, settings: MatchSettings) -> Result<(), SpecError> {
    if settings.respawn {
        return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.match.respawn", "Arena competitors do not respawn"));
    }
    match mode {
        GameMode::HungerGames => {
            if settings.block_breaking || settings.block_placing {
                return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.match", "Hunger Games disables block breaking and placing"));
            }
            if settings.natural_mobs || settings.natural_random_ticks {
                return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.match", "Hunger Games disables natural mobs and random block ticks"));
            }
        }
        GameMode::Civilization => {
            if roster.competitors != 6 {
                return Err(SpecError::new(SpecErrorKind::Range, "scenario.roster.competitors", "civilization scenarios require six competitor seats"));
            }
            if !settings.block_breaking || !settings.block_placing {
                return Err(SpecError::new(SpecErrorKind::InvalidValue, "scenario.match", "civilization enables block breaking and placing"));
            }
        }
    }
    Ok(())
}

fn nonnegative_u64(value: &raw::RawValue, path: &str) -> Result<u64, SpecError> {
    let integer = raw::integer(value, path)?;
    u64::try_from(integer).map_err(|_| SpecError::new(SpecErrorKind::Range, path, "must not be negative"))
}

fn positive_u64(value: &raw::RawValue, path: &str) -> Result<u64, SpecError> {
    let integer = nonnegative_u64(value, path)?;
    if integer == 0 {
        return Err(SpecError::new(SpecErrorKind::Range, path, "must be greater than zero"));
    }
    Ok(integer)
}

fn bounded_u16(value: &raw::RawValue, path: &str, min: u16, max: u16) -> Result<u16, SpecError> {
    let integer = raw::integer(value, path)?;
    let parsed = u16::try_from(integer).map_err(|_| SpecError::new(SpecErrorKind::Range, path, "is outside the supported range"))?;
    if !(min..=max).contains(&parsed) {
        return Err(SpecError::new(SpecErrorKind::Range, path, format!("must be between {min} and {max}")));
    }
    Ok(parsed)
}

fn bounded_u8(value: &raw::RawValue, path: &str, min: u8, max: u8) -> Result<u8, SpecError> {
    let integer = raw::integer(value, path)?;
    let parsed = u8::try_from(integer).map_err(|_| SpecError::new(SpecErrorKind::Range, path, "is outside the supported range"))?;
    if !(min..=max).contains(&parsed) {
        return Err(SpecError::new(SpecErrorKind::Range, path, format!("must be between {min} and {max}")));
    }
    Ok(parsed)
}

fn positive_number(value: &raw::RawValue, path: &str) -> Result<f64, SpecError> {
    let number = raw::number(value, path)?;
    if number <= 0.0 {
        return Err(SpecError::new(SpecErrorKind::Range, path, "must be greater than zero"));
    }
    Ok(number)
}

fn hash_scenario(
    mode: GameMode,
    seed: u64,
    policy: &ResourceReference,
    roster: Roster,
    server: &ServerSettings,
    match_settings: MatchSettings,
    border: BorderSettings,
    bots: BotSettings,
    record: RecordSettings,
    map_id: SemanticId,
) -> SemanticId {
    let mut hash = CanonicalHasher::new(b"arena.scenario.ir.v1\0");
    hash.u8(mode.tag());
    hash.u64(seed);
    hash.string(policy.as_str());
    hash.u16(roster.competitors);
    hash.u16(roster.human_seats_in_play_mode);
    hash.u64(roster.spectator_capacity);
    hash.string(&server.minecraft);
    hash.u8(server.view_distance_chunks);
    hash.u8(server.simulation_distance_chunks);
    hash.u8(server.max_tick_rate);
    hash.u64(match_settings.countdown_ticks);
    hash.u64(match_settings.grace_ticks);
    hash.u64(match_settings.authoritative_max_ticks);
    hash.u8(match_settings.respawn.into());
    hash.u8(match_settings.block_breaking.into());
    hash.u8(match_settings.block_placing.into());
    hash.u8(match_settings.natural_mobs.into());
    hash.u8(match_settings.natural_random_ticks.into());
    hash.f64(border.initial_diameter_blocks);
    hash.u64(border.shrink_start_tick);
    hash.u64(border.shrink_end_tick);
    hash.f64(border.final_diameter_blocks);
    hash.u64(bots.strategy_interval_ticks);
    hash.u64(bots.path_expansions_per_slice);
    hash.u64(bots.max_pending_paths_per_bot);
    hash.u8(0); // The sole supported perception is competitive-v1.
    hash.u8(record.policy_replay.into());
    hash.u8(record.world_outcomes.into());
    hash.bytes(map_id.as_bytes());
    hash.finish()
}
