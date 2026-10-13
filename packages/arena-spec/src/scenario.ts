import { CanonicalHasher, type SemanticId } from "./hash.js";
import { SpecError, SpecErrorKind } from "./errors.js";
import { compileMap, validateBorder, validateSpawnSeats, type MapIr } from "./map.js";
import * as raw from "./raw.js";

export const GameMode = {
  HungerGames: "hunger_games",
  Civilization: "civilization",
} as const;

export type GameMode = (typeof GameMode)[keyof typeof GameMode];

export interface Roster {
  readonly competitors: number;
  readonly humanSeatsInPlayMode: number;
  readonly spectatorCapacity: bigint;
}

/** Locked-server settings supplied by a scenario. */
export interface ServerSettings {
  readonly minecraft: string;
  readonly viewDistanceChunks: number;
  readonly simulationDistanceChunks: number;
  readonly maxTickRate: number;
}

/** Match behavior and authoritative tick limits. */
export interface MatchSettings {
  readonly countdownTicks: bigint;
  readonly graceTicks: bigint;
  readonly authoritativeMaxTicks: bigint;
  readonly respawn: boolean;
  readonly blockBreaking: boolean;
  readonly blockPlacing: boolean;
  readonly naturalMobs: boolean;
  readonly naturalRandomTicks: boolean;
}

/** Tick-driven world border settings. */
export interface BorderSettings {
  readonly initialDiameterBlocks: number;
  readonly shrinkStartTick: bigint;
  readonly shrinkEndTick: bigint;
  readonly finalDiameterBlocks: number;
}

/** Bounded pathfinding and policy cadence settings. */
export interface BotSettings {
  readonly strategyIntervalTicks: bigint;
  readonly pathExpansionsPerSlice: bigint;
  readonly maxPendingPathsPerBot: bigint;
  readonly perception: "competitive-v1";
}

/** Evaluation recording options. */
export interface RecordSettings {
  readonly policyReplay: boolean;
  readonly worldOutcomes: boolean;
}

declare const resourceReferenceBrand: unique symbol;

/** A normalized reference relative to the declaring scenario file. */
export type ResourceReference = string & { readonly [resourceReferenceBrand]: true };

/** Immutable, fully validated scenario settings and compiled map IR. */
export interface ScenarioIr {
  readonly name: string;
  readonly mode: GameMode;
  readonly seed: bigint;
  readonly mapReference: ResourceReference;
  readonly policyReference: ResourceReference;
  readonly roster: Roster;
  readonly server: ServerSettings;
  readonly matchSettings: MatchSettings;
  readonly border: BorderSettings;
  readonly bots: BotSettings;
  readonly record: RecordSettings;
  readonly map: MapIr;
  readonly semanticId: SemanticId;
}

const SCENARIO_FIELDS = [
  "schema",
  "name",
  "mode",
  "seed",
  "map",
  "policy",
  "roster",
  "server",
  "match",
  "border",
  "bots",
  "record",
] as const;

/**
 * Validates the scenario root and returns its normalized map reference before
 * the runner reads that map's source.
 */
export function scenarioMapReference(source: string): ResourceReference {
  const root = parseScenarioRoot(source);
  return parseReference(raw.field(root, "map", "scenario"), "scenario.map");
}

/**
 * Compiles schema-v1 scenario settings and the content of its declared map.
 * Resolving file references remains the runner's responsibility.
 */
export function compileScenario(scenarioSource: string, mapSource: string): ScenarioIr {
  const root = parseScenarioRoot(scenarioSource);

  const name = raw.string(raw.field(root, "name", "scenario"), "scenario.name");
  const mode = parseMode(raw.field(root, "mode", "scenario"));
  const seed = nonnegativeU64(raw.field(root, "seed", "scenario"), "scenario.seed");
  const mapReference = parseReference(raw.field(root, "map", "scenario"), "scenario.map");
  const policyReference = parseReference(raw.field(root, "policy", "scenario"), "scenario.policy");
  const roster = parseRoster(raw.field(root, "roster", "scenario"));
  const server = parseServer(raw.field(root, "server", "scenario"));
  const matchSettings = parseMatch(raw.field(root, "match", "scenario"));
  const border = parseBorder(raw.field(root, "border", "scenario"), matchSettings);
  const bots = parseBots(raw.field(root, "bots", "scenario"));
  const record = parseRecord(raw.field(root, "record", "scenario"));

  validateMode(mode, roster, matchSettings);
  const map = compileMap(mapSource);
  validateSpawnSeats(map, roster.competitors, "scenario.roster.competitors");
  validateBorder(map, border.initialDiameterBlocks, border.finalDiameterBlocks, "scenario.border");
  validatePreparedChunks(map, server.viewDistanceChunks);
  const semanticId = hashScenario(
    mode,
    seed,
    policyReference,
    roster,
    server,
    matchSettings,
    border,
    bots,
    record,
    map.semanticId,
  );

  return Object.freeze({
    name,
    mode,
    seed,
    mapReference,
    policyReference,
    roster,
    server,
    matchSettings,
    border,
    bots,
    record,
    map,
    semanticId,
  });
}

function parseScenarioRoot(source: string): raw.RawTable {
  const root = raw.asTable(raw.parseDocument(source, "scenario"), "scenario");
  raw.checkFields(root, SCENARIO_FIELDS, SCENARIO_FIELDS, "scenario");
  if (raw.integer(raw.field(root, "schema", "scenario"), "scenario.schema") !== 1n) {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.schema", "only schema version 1 is supported");
  }
  return root;
}

function parseMode(value: raw.RawValue): GameMode {
  const mode = raw.string(value, "scenario.mode");
  if (mode === GameMode.HungerGames || mode === GameMode.Civilization) return mode;
  throw new SpecError(SpecErrorKind.InvalidValue, "scenario.mode", `unknown mode \`${mode}\``);
}

function parseRoster(value: raw.RawValue): Roster {
  const path = "scenario.roster";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["competitors", "human_seats_in_play_mode", "spectator_capacity"], ["competitors", "human_seats_in_play_mode", "spectator_capacity"], path);
  const competitors = boundedNumber(raw.field(table, "competitors", path), "scenario.roster.competitors", 1n, 6n);
  const humanSeatsInPlayMode = boundedNumber(raw.field(table, "human_seats_in_play_mode", path), "scenario.roster.human_seats_in_play_mode", 0n, 1n);
  const spectatorCapacity = nonnegativeU64(raw.field(table, "spectator_capacity", path), "scenario.roster.spectator_capacity");
  if (humanSeatsInPlayMode > competitors) {
    throw new SpecError(SpecErrorKind.Range, "scenario.roster.human_seats_in_play_mode", "cannot exceed the competitor count");
  }
  return Object.freeze({ competitors, humanSeatsInPlayMode, spectatorCapacity });
}

function parseServer(value: raw.RawValue): ServerSettings {
  const path = "scenario.server";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["minecraft", "view_distance_chunks", "simulation_distance_chunks", "max_tick_rate"], ["minecraft", "view_distance_chunks", "simulation_distance_chunks", "max_tick_rate"], path);
  const minecraft = raw.string(raw.field(table, "minecraft", path), "scenario.server.minecraft");
  const viewDistanceChunks = boundedNumber(raw.field(table, "view_distance_chunks", path), "scenario.server.view_distance_chunks", 2n, 32n);
  const simulationDistanceChunks = boundedNumber(raw.field(table, "simulation_distance_chunks", path), "scenario.server.simulation_distance_chunks", 2n, 32n);
  const maxTickRate = boundedNumber(raw.field(table, "max_tick_rate", path), "scenario.server.max_tick_rate", 1n, 20n);
  if (simulationDistanceChunks > viewDistanceChunks) {
    throw new SpecError(SpecErrorKind.Range, "scenario.server.simulation_distance_chunks", "cannot exceed view_distance_chunks");
  }
  return Object.freeze({ minecraft, viewDistanceChunks, simulationDistanceChunks, maxTickRate });
}

function parseMatch(value: raw.RawValue): MatchSettings {
  const path = "scenario.match";
  const table = raw.asTable(value, path);
  raw.checkFields(
    table,
    ["countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking", "block_placing", "natural_mobs", "natural_random_ticks"],
    ["countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking", "block_placing", "natural_mobs", "natural_random_ticks"],
    path,
  );
  const countdownTicks = nonnegativeU64(raw.field(table, "countdown_ticks", path), "scenario.match.countdown_ticks");
  const graceTicks = nonnegativeU64(raw.field(table, "grace_ticks", path), "scenario.match.grace_ticks");
  const authoritativeMaxTicks = positiveU64(raw.field(table, "authoritative_max_ticks", path), "scenario.match.authoritative_max_ticks");
  if (countdownTicks + graceTicks > I64_MAX) {
    throw new SpecError(SpecErrorKind.Range, path, "countdown plus grace ticks exceed the supported signed tick range");
  }
  const settings = Object.freeze({
    countdownTicks,
    graceTicks,
    authoritativeMaxTicks,
    respawn: raw.boolean(raw.field(table, "respawn", path), "scenario.match.respawn"),
    blockBreaking: raw.boolean(raw.field(table, "block_breaking", path), "scenario.match.block_breaking"),
    blockPlacing: raw.boolean(raw.field(table, "block_placing", path), "scenario.match.block_placing"),
    naturalMobs: raw.boolean(raw.field(table, "natural_mobs", path), "scenario.match.natural_mobs"),
    naturalRandomTicks: raw.boolean(raw.field(table, "natural_random_ticks", path), "scenario.match.natural_random_ticks"),
  });
  if (settings.graceTicks >= settings.authoritativeMaxTicks) {
    throw new SpecError(SpecErrorKind.Range, "scenario.match.grace_ticks", "must end before authoritative_max_ticks");
  }
  return settings;
}

function parseBorder(value: raw.RawValue, matchSettings: MatchSettings): BorderSettings {
  const path = "scenario.border";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"], ["initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"], path);
  const initialDiameterBlocks = positiveNumber(raw.field(table, "initial_diameter_blocks", path), "scenario.border.initial_diameter_blocks");
  const shrinkStartTick = nonnegativeU64(raw.field(table, "shrink_start_tick", path), "scenario.border.shrink_start_tick");
  const shrinkEndTick = nonnegativeU64(raw.field(table, "shrink_end_tick", path), "scenario.border.shrink_end_tick");
  const finalDiameterBlocks = positiveNumber(raw.field(table, "final_diameter_blocks", path), "scenario.border.final_diameter_blocks");
  if (finalDiameterBlocks >= initialDiameterBlocks) {
    throw new SpecError(SpecErrorKind.Range, "scenario.border.final_diameter_blocks", "must be smaller than initial_diameter_blocks");
  }
  if (shrinkStartTick < matchSettings.graceTicks) {
    throw new SpecError(SpecErrorKind.Range, "scenario.border.shrink_start_tick", "cannot precede the end of grace");
  }
  if (shrinkEndTick <= shrinkStartTick) {
    throw new SpecError(SpecErrorKind.Range, "scenario.border.shrink_end_tick", "must be after shrink_start_tick");
  }
  if (shrinkEndTick >= matchSettings.authoritativeMaxTicks) {
    throw new SpecError(SpecErrorKind.Range, "scenario.border.shrink_end_tick", "must finish before authoritative_max_ticks");
  }
  return Object.freeze({ initialDiameterBlocks, shrinkStartTick, shrinkEndTick, finalDiameterBlocks });
}

function parseBots(value: raw.RawValue): BotSettings {
  const path = "scenario.bots";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["strategy_interval_ticks", "path_expansions_per_slice", "max_pending_paths_per_bot", "perception"], ["strategy_interval_ticks", "path_expansions_per_slice", "max_pending_paths_per_bot", "perception"], path);
  const strategyIntervalTicks = positiveU64(raw.field(table, "strategy_interval_ticks", path), "scenario.bots.strategy_interval_ticks");
  const pathExpansionsPerSlice = positiveU64(raw.field(table, "path_expansions_per_slice", path), "scenario.bots.path_expansions_per_slice");
  const maxPendingPathsPerBot = positiveU64(raw.field(table, "max_pending_paths_per_bot", path), "scenario.bots.max_pending_paths_per_bot");
  const perception = raw.string(raw.field(table, "perception", path), "scenario.bots.perception");
  if (perception !== "competitive-v1") {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.bots.perception", `unknown perception \`${perception}\``);
  }
  return Object.freeze({ strategyIntervalTicks, pathExpansionsPerSlice, maxPendingPathsPerBot, perception });
}

function parseRecord(value: raw.RawValue): RecordSettings {
  const path = "scenario.record";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["mode", "policy_replay", "world_outcomes"], ["mode", "policy_replay", "world_outcomes"], path);
  const mode = raw.string(raw.field(table, "mode", path), "scenario.record.mode");
  if (mode !== "evaluation") {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.record.mode", `unknown record mode \`${mode}\``);
  }
  return Object.freeze({
    policyReplay: raw.boolean(raw.field(table, "policy_replay", path), "scenario.record.policy_replay"),
    worldOutcomes: raw.boolean(raw.field(table, "world_outcomes", path), "scenario.record.world_outcomes"),
  });
}

function parseReference(value: raw.RawValue, path: string): ResourceReference {
  const reference = raw.string(value, path);
  if (reference.startsWith("/") || reference.startsWith("\\") || reference.includes("\\") || reference.includes(":") || reference.includes("\0")) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must be a relative repository reference using `/` separators");
  }
  const components: string[] = [];
  for (const component of reference.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (components.length > 0 && components[components.length - 1] !== "..") components.pop();
      else components.push("..");
    } else {
      components.push(component);
    }
  }
  if (components.length === 0) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must identify a repository file");
  }
  return components.join("/") as ResourceReference;
}

function validateMode(mode: GameMode, roster: Roster, settings: MatchSettings): void {
  if (settings.respawn) {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match.respawn", "Arena competitors do not respawn");
  }
  switch (mode) {
    case GameMode.HungerGames:
      if (settings.blockBreaking || settings.blockPlacing) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "Hunger Games disables block breaking and placing");
      }
      if (settings.naturalMobs || settings.naturalRandomTicks) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "Hunger Games disables natural mobs and random block ticks");
      }
      break;
    case GameMode.Civilization:
      if (roster.competitors !== 6) {
        throw new SpecError(SpecErrorKind.Range, "scenario.roster.competitors", "civilization scenarios require six competitor seats");
      }
      if (!settings.blockBreaking || !settings.blockPlacing) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "civilization enables block breaking and placing");
      }
      break;
  }
}

function nonnegativeU64(value: raw.RawValue, path: string): bigint {
  const integer = raw.integer(value, path);
  if (integer < 0n) throw new SpecError(SpecErrorKind.Range, path, "must not be negative");
  if (integer > U64_MAX) throw new SpecError(SpecErrorKind.Range, path, "is outside the supported range");
  return integer;
}

function positiveU64(value: raw.RawValue, path: string): bigint {
  const integer = nonnegativeU64(value, path);
  if (integer === 0n) throw new SpecError(SpecErrorKind.Range, path, "must be greater than zero");
  return integer;
}

function boundedNumber(value: raw.RawValue, path: string, min: bigint, max: bigint): number {
  const integer = raw.integer(value, path);
  if (integer < min || integer > max) {
    throw new SpecError(SpecErrorKind.Range, path, `must be between ${min} and ${max}`);
  }
  return Number(integer);
}

function positiveNumber(value: raw.RawValue, path: string): number {
  const number = raw.number(value, path);
  if (number <= 0) throw new SpecError(SpecErrorKind.Range, path, "must be greater than zero");
  return number;
}

function validatePreparedChunks(map: MapIr, viewDistanceChunks: number): void {
  const maxChunkX = BigInt(Math.floor((map.dimensions.width - 1) / 16));
  const maxChunkZ = BigInt(Math.floor((map.dimensions.depth - 1) / 16));
  const halo = BigInt(viewDistanceChunks);
  const width = maxChunkX + halo * 2n + 1n;
  const depth = maxChunkZ + halo * 2n + 1n;
  if (width * depth > MAX_PREPARED_CHUNKS) {
    throw new SpecError(
      SpecErrorKind.ResourceLimit,
      "scenario.server.view_distance_chunks",
      "map and view-distance halo exceed the prepared-chunk limit of 8,192",
    );
  }
}

function hashScenario(
  mode: GameMode,
  seed: bigint,
  policy: ResourceReference,
  roster: Roster,
  server: ServerSettings,
  matchSettings: MatchSettings,
  border: BorderSettings,
  bots: BotSettings,
  record: RecordSettings,
  mapId: SemanticId,
): SemanticId {
  const hash = new CanonicalHasher("arena.scenario.ir.v1\0");
  hash.u8(mode === GameMode.HungerGames ? 0 : 1);
  hash.u64(seed);
  hash.string(policy);
  hash.u16(roster.competitors);
  hash.u16(roster.humanSeatsInPlayMode);
  hash.u64(roster.spectatorCapacity);
  hash.string(server.minecraft);
  hash.u8(server.viewDistanceChunks);
  hash.u8(server.simulationDistanceChunks);
  hash.u8(server.maxTickRate);
  hash.u64(matchSettings.countdownTicks);
  hash.u64(matchSettings.graceTicks);
  hash.u64(matchSettings.authoritativeMaxTicks);
  hash.u8(Number(matchSettings.respawn));
  hash.u8(Number(matchSettings.blockBreaking));
  hash.u8(Number(matchSettings.blockPlacing));
  hash.u8(Number(matchSettings.naturalMobs));
  hash.u8(Number(matchSettings.naturalRandomTicks));
  hash.f64(border.initialDiameterBlocks);
  hash.u64(border.shrinkStartTick);
  hash.u64(border.shrinkEndTick);
  hash.f64(border.finalDiameterBlocks);
  hash.u64(bots.strategyIntervalTicks);
  hash.u64(bots.pathExpansionsPerSlice);
  hash.u64(bots.maxPendingPathsPerBot);
  hash.u8(0);
  hash.u8(Number(record.policyReplay));
  hash.u8(Number(record.worldOutcomes));
  hash.bytes(Buffer.from(mapId, "hex"));
  return hash.finish();
}

const I64_MAX = 9_223_372_036_854_775_807n;
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_PREPARED_CHUNKS = 8_192n;
