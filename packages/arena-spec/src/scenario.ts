import {
  blockPosition,
  CIVILIZATION_FACTION_IDS,
  CIVILIZATION_ROLES,
  OUTPOST_BLUEPRINT_ID,
  civilizationOutpostCells,
  civilizationProfileForSeat,
  OUTPOST_BLOCK_COUNT,
  type BlockPosition,
  type CivilizationFactionId,
  type CivilizationRole,
  type OutpostBlueprintId,
} from "@arena/core";

import { CanonicalHasher, type SemanticId } from "./hash.js";
import { SpecError, SpecErrorKind } from "./errors.js";
import {
  compileMap,
  parseBlockPosition,
  validateBorder,
  validateReachableSurfacePosition,
  validateSpawnSeats,
  type PlannedMapIr,
  type MapIr,
} from "./map.js";
import * as raw from "./raw.js";
import { parseResourceId } from "./resource-id.js";

export const GameMode = {
  HungerGames: "hunger_games",
  Civilization: "civilization",
} as const;

export type GameMode = (typeof GameMode)[keyof typeof GameMode];

export const OPENING_STYLES = ["explorer", "scavenger", "hunter"] as const;
export type OpeningStyle = (typeof OPENING_STYLES)[number];
export type OpeningStyleCycle = readonly [OpeningStyle, OpeningStyle, OpeningStyle];

const CIVILIZATION_SEAT_COUNT = 6 as const;
const CIVILIZATION_MAP_DIAMETER_BLOCKS = 192 as const;
const CIVILIZATION_CAPTURE_UNCONTESTED_TICKS = 200 as const;
const CIVILIZATION_SCORE_POINTS_PER_TICK = 1 as const;
const CIVILIZATION_STARTING_KIT = Object.freeze([
  Object.freeze({ item: "minecraft:bread", count: 4 } as const),
  Object.freeze({ item: "minecraft:wooden_axe", count: 1 } as const),
  Object.freeze({ item: "minecraft:wooden_pickaxe", count: 1 } as const),
  Object.freeze({ item: "minecraft:wooden_sword", count: 1 } as const),
] as const);

export const MAX_COMPETITORS = 256 as const;
export const LEGACY_MAX_COMPETITORS = 6 as const;
export const EXTERNAL_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
export const RESERVED_RUNNER_USERNAME_PREFIXES = ["ArenaBot", "ArenaSpec"] as const;

export function isReservedRunnerUsername(username: string): boolean {
  const folded = username.toLowerCase();
  return RESERVED_RUNNER_USERNAME_PREFIXES.some((prefix) => folded.startsWith(prefix.toLowerCase()));
}

export type SeatController =
  | { readonly kind: "bot" }
  | { readonly kind: "external"; readonly username: string };

export interface SeatIr {
  readonly seat: number;
  readonly controller: SeatController;
}

export const SQUAD_ID_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;
export const MIN_FRONTIER_EDIT_RADIUS_BLOCKS = 16;
export const MAX_FRONTIER_EDIT_RADIUS_BLOCKS = 512;
export const MAX_FRONTIER_EDITS_PER_SEAT = 100_000;
export const MAX_SQUADS = 64;

export interface SquadIr {
  readonly id: string;
  readonly seats: readonly number[];
}

/** Versioned rule mode of a schema-3 Hunger Games scenario; `classic` is the frozen rule set. */
export type RuleModeIr =
  | { readonly kind: "classic" }
  | {
    readonly kind: "frontier_survival";
    readonly version: 1;
    readonly editRadiusBlocks: number;
    readonly maxBlockEditsPerSeat: number;
  }
  | { readonly kind: "squads"; readonly version: 1; readonly squads: readonly SquadIr[] };

export interface Roster {
  readonly competitors: number;
  readonly spectatorCapacity: bigint;
  readonly seats: readonly SeatIr[];
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

/** Tick-driven Hunger Games world border settings. */
export interface ShrinkingBorderSettings {
  readonly initialDiameterBlocks: number;
  readonly shrinkStartTick: bigint;
  readonly shrinkEndTick: bigint;
  readonly finalDiameterBlocks: number;
}

/** Fixed civilization world border settings. */
export interface FixedBorderSettings {
  readonly kind: "fixed";
  readonly diameterBlocks: typeof CIVILIZATION_MAP_DIAMETER_BLOCKS;
}

export type BorderSettings = ShrinkingBorderSettings | FixedBorderSettings;

export interface CivilizationFactionMemberIr {
  readonly seat: number;
  readonly role: CivilizationRole;
}

export interface CivilizationFactionIr {
  readonly id: CivilizationFactionId;
  readonly members: readonly [CivilizationFactionMemberIr, CivilizationFactionMemberIr, CivilizationFactionMemberIr];
}

export type ItemStackIr = (typeof CIVILIZATION_STARTING_KIT)[number];

export type CivilizationStartingKitIr = typeof CIVILIZATION_STARTING_KIT;

export interface CaptureZoneIr {
  readonly min: BlockPosition;
  readonly max: BlockPosition;
  readonly uncontestedTicks: typeof CIVILIZATION_CAPTURE_UNCONTESTED_TICKS;
  readonly pointsPerOwnedTick: typeof CIVILIZATION_SCORE_POINTS_PER_TICK;
}

export interface BlueprintAnchorIr {
  readonly position: BlockPosition;
  readonly rotationDegrees: 0 | 180;
}

export interface OutpostBlueprintIr {
  readonly id: OutpostBlueprintId;
  readonly anchors: Readonly<Record<CivilizationFactionId, BlueprintAnchorIr>>;
}

export interface CivilizationRulesIr {
  readonly factions: readonly [CivilizationFactionIr, CivilizationFactionIr];
  readonly startingKit: CivilizationStartingKitIr;
  readonly captureZone: CaptureZoneIr;
  readonly blueprint: OutpostBlueprintIr;
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

/** Shared validated scenario settings that do not depend on game mode. */
interface ScenarioBaseIr {
  readonly schemaVersion: 1 | 2 | 3;
  readonly name: string;
  readonly seed: bigint;
  readonly mapReference: ResourceReference;
  readonly policyReference: ResourceReference;
  readonly roster: Roster;
  readonly server: ServerSettings;
  readonly matchSettings: MatchSettings;
  readonly bots: BotSettings;
  readonly record: RecordSettings;
  readonly map: MapIr;
  readonly semanticId: SemanticId;
}

/** Fully validated schema-v1 Hunger Games settings and compiled planned map IR. */
export interface HungerGamesScenarioV1Ir extends ScenarioBaseIr {
  readonly schemaVersion: 1;
  readonly mode: typeof GameMode.HungerGames;
  readonly border: ShrinkingBorderSettings;
  readonly map: Extract<MapIr, { readonly terrain: "planned" }>;
}

/** Fully validated schema-v2 Hunger Games settings and compiled natural map IR. */
export interface HungerGamesScenarioV2Ir extends ScenarioBaseIr {
  readonly schemaVersion: 2;
  readonly mode: typeof GameMode.HungerGames;
  readonly border: ShrinkingBorderSettings;
  readonly map: Extract<MapIr, { readonly terrain: "vanilla" }>;
  readonly openingStyleCycle: OpeningStyleCycle;
}

/** Fully validated schema-v3 Hunger Games settings with a generalized seat roster. */
export interface HungerGamesScenarioV3Ir extends ScenarioBaseIr {
  readonly schemaVersion: 3;
  readonly mode: typeof GameMode.HungerGames;
  readonly border: ShrinkingBorderSettings;
  readonly map: Extract<MapIr, { readonly terrain: "vanilla" }>;
  readonly openingStyleCycle: OpeningStyleCycle;
  readonly rules: RuleModeIr;
}

export type HungerGamesScenarioIr = HungerGamesScenarioV1Ir | HungerGamesScenarioV2Ir | HungerGamesScenarioV3Ir;

/** Fully validated civilization rules and compiled map IR. */
export interface CivilizationScenarioIr extends ScenarioBaseIr {
  readonly schemaVersion: 1;
  readonly mode: typeof GameMode.Civilization;
  readonly border: FixedBorderSettings;
  readonly civilization: CivilizationRulesIr;
  readonly map: Extract<MapIr, { readonly terrain: "planned" }>;
}

/** Immutable scenario result narrowed by its game mode. */
export type ScenarioIr = HungerGamesScenarioIr | CivilizationScenarioIr;

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

const OPTIONAL_SCENARIO_FIELDS = ["civilization"] as const;
const OPTIONAL_SCENARIO_V3_FIELDS = ["civilization", "rules"] as const;

/**
 * Validates the scenario root and returns its normalized map reference before
 * the runner reads that map's source.
 */
export function scenarioMapReference(source: string): ResourceReference {
  const root = parseScenarioRoot(source);
  return parseReference(raw.field(root, "map", "scenario"), "scenario.map");
}

export function compileScenario(scenarioSource: string, mapSource: string): ScenarioIr {
  const root = parseScenarioRoot(scenarioSource);
  const schemaVersion = readScenarioSchemaVersion(root);

  const name = raw.string(raw.field(root, "name", "scenario"), "scenario.name");
  const mode = parseMode(raw.field(root, "mode", "scenario"));
  if (schemaVersion >= 2 && mode !== GameMode.HungerGames) {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.schema", `schema version ${schemaVersion} is only supported for Hunger Games`);
  }
  if (mode === GameMode.HungerGames && root.has("civilization")) {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.civilization", "is only valid for civilization mode");
  }
  const openingStyleCycle = schemaVersion >= 2
    ? parseOpeningStyleCycle(raw.field(root, "opening_styles", "scenario"))
    : undefined;
  const seed = nonnegativeU64(raw.field(root, "seed", "scenario"), "scenario.seed");
  const mapReference = parseReference(raw.field(root, "map", "scenario"), "scenario.map");
  const policyReference = parseReference(raw.field(root, "policy", "scenario"), "scenario.policy");
  const roster = parseRoster(raw.field(root, "roster", "scenario"), schemaVersion);
  const server = parseServer(raw.field(root, "server", "scenario"));
  const matchSettings = parseMatch(raw.field(root, "match", "scenario"));
  const border = parseModeBorder(mode, raw.field(root, "border", "scenario"), matchSettings);
  const bots = parseBots(raw.field(root, "bots", "scenario"));
  const record = parseRecord(raw.field(root, "record", "scenario"));
  const civilization = mode === GameMode.Civilization
    ? parseCivilization(raw.field(root, "civilization", "scenario"))
    : undefined;

  const rules: RuleModeIr = schemaVersion === 3 && root.has("rules")
    ? parseRules(raw.field(root, "rules", "scenario"), roster)
    : Object.freeze({ kind: "classic" });
  validateMode(mode, roster, matchSettings, rules);
  const map = compileMap(mapSource);
  if (schemaVersion === 1 && map.terrain !== "planned") {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.map", "schema version 1 requires a planned map");
  }
  if (schemaVersion >= 2 && map.terrain !== "vanilla") {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.map", `schema version ${schemaVersion} requires a natural terrain map`);
  }
  validateSpawnSeats(map, roster.competitors, "scenario.roster.competitors");
  validatePreparedChunks(map, server.viewDistanceChunks);
  if (border.mode === GameMode.HungerGames) {
    validateBorder(map, border.settings.initialDiameterBlocks, border.settings.finalDiameterBlocks, "scenario.border");
    const semanticId = hashScenario(
      schemaVersion,
      { mode: border.mode, border: border.settings },
      seed,
      policyReference,
      roster,
      server,
      matchSettings,
      bots,
      record,
      map.semanticId,
      openingStyleCycle,
      rules,
    );
    const common = {
      name,
      mode: border.mode,
      seed,
      mapReference,
      policyReference,
      roster,
      server,
      matchSettings,
      border: border.settings,
      bots,
      record,
      map,
      semanticId,
    } as const;
    if (schemaVersion === 1) {
      if (map.terrain !== "planned") throw new Error("planned scenario contract is incomplete");
      return Object.freeze({
        ...common,
        schemaVersion,
        map,
      });
    }
    if (openingStyleCycle === undefined || map.terrain !== "vanilla") throw new Error("natural scenario contract is incomplete");
    return Object.freeze({
      ...common,
      schemaVersion,
      map,
      openingStyleCycle,
      ...(schemaVersion === 3 ? { rules } : {}),
    }) as HungerGamesScenarioIr;
  }

  if (schemaVersion !== 1 || map.terrain !== "planned") {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.schema", "civilization requires schema version 1 and a planned map");
  }
  if (civilization === undefined) throw new Error("civilization scenario was parsed without civilization rules");
  validateCivilizationMap(map, civilization);
  validateBorder(map, border.settings.diameterBlocks, border.settings.diameterBlocks, "scenario.border");
  const semanticId = hashScenario(
    schemaVersion,
    { mode: border.mode, border: border.settings, civilization },
    seed,
    policyReference,
    roster,
    server,
    matchSettings,
    bots,
    record,
    map.semanticId,
  );
  return Object.freeze({
    schemaVersion,
    name,
    mode: border.mode,
    seed,
    mapReference,
    policyReference,
    roster,
    server,
    matchSettings,
    border: border.settings,
    civilization,
    bots,
    record,
    map,
    semanticId,
  });
}

function parseScenarioRoot(source: string): raw.RawTable {
  const root = raw.asTable(raw.parseDocument(source, "scenario"), "scenario");
  const schemaVersion = readScenarioSchemaVersion(root);
  const fields = schemaVersion === 1 ? SCENARIO_FIELDS : [...SCENARIO_FIELDS, "opening_styles"];
  const optional = schemaVersion === 3 ? OPTIONAL_SCENARIO_V3_FIELDS : OPTIONAL_SCENARIO_FIELDS;
  raw.checkFields(root, [...fields, ...optional], fields, "scenario");
  return root;
}

function readScenarioSchemaVersion(root: raw.RawTable): 1 | 2 | 3 {
  const schema = raw.integer(raw.field(root, "schema", "scenario"), "scenario.schema");
  if (schema === 1n || schema === 2n || schema === 3n) return Number(schema) as 1 | 2 | 3;
  throw new SpecError(SpecErrorKind.InvalidValue, "scenario.schema", "supported schema versions are 1, 2, and 3");
}

function parseOpeningStyleCycle(value: raw.RawValue): OpeningStyleCycle {
  const path = "scenario.opening_styles";
  const values = raw.asArray(value, path);
  if (values.length !== 3) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must list each opening style exactly once");
  }
  const styles = values.map((entry, index) => {
    const style = raw.string(entry, `${path}[${index}]`);
    if (!(OPENING_STYLES as readonly string[]).includes(style)) {
      throw new SpecError(SpecErrorKind.InvalidValue, `${path}[${index}]`, `unknown opening style \`${style}\``);
    }
    return style as OpeningStyle;
  });
  if (new Set(styles).size !== 3) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must list each opening style exactly once");
  }
  return Object.freeze(styles) as unknown as OpeningStyleCycle;
}

function parseMode(value: raw.RawValue): GameMode {
  const mode = raw.string(value, "scenario.mode");
  if (mode === GameMode.HungerGames || mode === GameMode.Civilization) return mode;
  throw new SpecError(SpecErrorKind.InvalidValue, "scenario.mode", `unknown mode \`${mode}\``);
}

function parseRoster(value: raw.RawValue, schemaVersion: 1 | 2 | 3): Roster {
  const path = "scenario.roster";
  const table = raw.asTable(value, path);
  const required = ["competitors", "spectator_capacity"];
  raw.checkFields(table, schemaVersion === 3 ? [...required, "external"] : required, required, path);
  const maxCompetitors = schemaVersion === 3 ? MAX_COMPETITORS : LEGACY_MAX_COMPETITORS;
  const competitors = boundedNumber(
    raw.field(table, "competitors", path),
    "scenario.roster.competitors",
    1n,
    BigInt(maxCompetitors),
  );
  const spectatorCapacity = nonnegativeU64(raw.field(table, "spectator_capacity", path), "scenario.roster.spectator_capacity");
  const externalSeats = schemaVersion === 3 && table.has("external")
    ? parseExternalSeats(raw.field(table, "external", path), competitors)
    : new Map<number, string>();
  const seats = Object.freeze(Array.from({ length: competitors }, (_, seat): SeatIr => {
    const username = externalSeats.get(seat);
    const controller: SeatController = username === undefined
      ? Object.freeze({ kind: "bot" })
      : Object.freeze({ kind: "external", username });
    return Object.freeze({ seat, controller });
  }));
  return Object.freeze({ competitors, spectatorCapacity, seats });
}

function parseExternalSeats(value: raw.RawValue, competitors: number): ReadonlyMap<number, string> {
  const path = "scenario.roster.external";
  const entries = raw.asArray(value, path);
  const seats = new Map<number, string>();
  const usernames = new Set<string>();
  let previousSeat = -1;
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    const table = raw.asTable(entry, entryPath);
    raw.checkFields(table, ["seat", "username"], ["seat", "username"], entryPath);
    const seat = boundedNumber(raw.field(table, "seat", entryPath), `${entryPath}.seat`, 0n, BigInt(competitors - 1));
    if (seat <= previousSeat) {
      throw new SpecError(SpecErrorKind.Conflict, `${entryPath}.seat`, "external seats must be unique and in ascending order");
    }
    previousSeat = seat;
    const username = raw.string(raw.field(table, "username", entryPath), `${entryPath}.username`);
    if (!EXTERNAL_USERNAME_PATTERN.test(username)) {
      throw new SpecError(SpecErrorKind.InvalidValue, `${entryPath}.username`, "must be 3 to 16 ASCII letters, digits, or underscores");
    }
    const folded = username.toLowerCase();
    if (isReservedRunnerUsername(username)) {
      throw new SpecError(SpecErrorKind.Conflict, `${entryPath}.username`, "collides with the runner's bot and spectator identity space");
    }
    if (usernames.has(folded)) {
      throw new SpecError(SpecErrorKind.Conflict, `${entryPath}.username`, "external usernames must be unique ignoring case");
    }
    usernames.add(folded);
    seats.set(seat, username);
  }
  return seats;
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

function parseShrinkingBorder(value: raw.RawValue, matchSettings: MatchSettings): ShrinkingBorderSettings {
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

function parseFixedBorder(value: raw.RawValue): FixedBorderSettings {
  const path = "scenario.border";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["kind", "diameter_blocks"], ["kind", "diameter_blocks"], path);
  const kind = raw.string(raw.field(table, "kind", path), `${path}.kind`);
  if (kind !== "fixed") {
    throw new SpecError(SpecErrorKind.InvalidValue, `${path}.kind`, "civilization requires a fixed world border");
  }
  boundedNumber(
    raw.field(table, "diameter_blocks", path),
    `${path}.diameter_blocks`,
    BigInt(CIVILIZATION_MAP_DIAMETER_BLOCKS),
    BigInt(CIVILIZATION_MAP_DIAMETER_BLOCKS),
  );
  return Object.freeze({ kind: "fixed", diameterBlocks: CIVILIZATION_MAP_DIAMETER_BLOCKS });
}

type ModeBorder =
  | { readonly mode: typeof GameMode.HungerGames; readonly settings: ShrinkingBorderSettings }
  | { readonly mode: typeof GameMode.Civilization; readonly settings: FixedBorderSettings };

function parseModeBorder(mode: GameMode, value: raw.RawValue, matchSettings: MatchSettings): ModeBorder {
  if (mode === GameMode.HungerGames) {
    return Object.freeze({ mode, settings: parseShrinkingBorder(value, matchSettings) });
  }
  return Object.freeze({ mode, settings: parseFixedBorder(value) });
}

function parseCivilization(value: raw.RawValue): CivilizationRulesIr {
  const path = "scenario.civilization";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["factions", "starting_kit", "capture_zone", "blueprint"], ["factions", "starting_kit", "capture_zone", "blueprint"], path);
  const factions = parseFactions(raw.field(table, "factions", path));
  const startingKit = parseStartingKit(raw.field(table, "starting_kit", path));
  const captureZone = parseCaptureZone(raw.field(table, "capture_zone", path));
  const blueprint = parseOutpostBlueprint(raw.field(table, "blueprint", path));
  return Object.freeze({ factions, startingKit, captureZone, blueprint });
}

function parseFactions(value: raw.RawValue): readonly [CivilizationFactionIr, CivilizationFactionIr] {
  const path = "scenario.civilization.factions";
  const values = raw.asArray(value, path);
  if (values.length !== CIVILIZATION_FACTION_IDS.length) {
    throw new SpecError(SpecErrorKind.Range, path, `must contain exactly ${CIVILIZATION_FACTION_IDS.length} factions`);
  }
  const factions = values.map((factionValue, factionIndex): CivilizationFactionIr => {
    const factionPath = `${path}[${factionIndex}]`;
    const faction = raw.asTable(factionValue, factionPath);
    raw.checkFields(faction, ["id", "members"], ["id", "members"], factionPath);
    const idText = raw.string(raw.field(faction, "id", factionPath), `${factionPath}.id`);
    const id = CIVILIZATION_FACTION_IDS.find((candidate) => candidate === idText);
    const expectedId = CIVILIZATION_FACTION_IDS[factionIndex];
    if (id === undefined || id !== expectedId) {
      throw new SpecError(
        SpecErrorKind.InvalidValue,
        `${factionPath}.id`,
        `must be ${expectedId ?? "a declared faction"} at this position`,
      );
    }

    const members = parseFactionMembers(raw.field(faction, "members", factionPath), id, factionIndex);
    return Object.freeze({ id, members });
  });
  const ember = factions[0];
  const tide = factions[1];
  if (ember === undefined || tide === undefined) throw new Error("validated civilization factions are incomplete");
  return Object.freeze([ember, tide]);
}

function parseFactionMembers(
  value: raw.RawValue,
  faction: CivilizationFactionId,
  factionIndex: number,
): readonly [CivilizationFactionMemberIr, CivilizationFactionMemberIr, CivilizationFactionMemberIr] {
  const path = `scenario.civilization.factions[${factionIndex}].members`;
  const values = raw.asArray(value, path);
  if (values.length !== CIVILIZATION_ROLES.length) {
    throw new SpecError(SpecErrorKind.Range, path, `must contain exactly ${CIVILIZATION_ROLES.length} members`);
  }
  const members = values.map((memberValue, memberIndex): CivilizationFactionMemberIr => {
    const memberPath = `${path}[${memberIndex}]`;
    const member = raw.asTable(memberValue, memberPath);
    raw.checkFields(member, ["seat", "role"], ["seat", "role"], memberPath);
    const seat = boundedNumber(raw.field(member, "seat", memberPath), `${memberPath}.seat`, 0n, 5n);
    const roleText = raw.string(raw.field(member, "role", memberPath), `${memberPath}.role`);
    const role = CIVILIZATION_ROLES.find((candidate) => candidate === roleText);
    if (role === undefined) {
      throw new SpecError(SpecErrorKind.InvalidValue, `${memberPath}.role`, `unknown civilization role \`${roleText}\``);
    }
    const profile = civilizationProfileForSeat(seat);
    if (profile === null) {
      throw new SpecError(SpecErrorKind.Range, `${memberPath}.seat`, "must be a civilization competitor seat from 0 through 5");
    }
    const expectedSeat = factionIndex * CIVILIZATION_ROLES.length + memberIndex;
    if (seat !== expectedSeat || profile.faction !== faction || profile.role !== role) {
      throw new SpecError(
        SpecErrorKind.InvalidValue,
        memberPath,
        `seat ${seat} must belong to faction \`${profile.faction}\` with role \`${profile.role}\``,
      );
    }
    return Object.freeze({ seat, role });
  });
  const first = members[0];
  const second = members[1];
  const third = members[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("validated civilization faction members are incomplete");
  }
  return Object.freeze([first, second, third]);
}

function parseStartingKit(value: raw.RawValue): CivilizationStartingKitIr {
  const path = "scenario.civilization.starting_kit";
  const values = raw.asArray(value, path);
  if (values.length !== CIVILIZATION_STARTING_KIT.length) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must declare the equal food and tool starting kit");
  }
  const [bread, axe, pickaxe, sword] = CIVILIZATION_STARTING_KIT;
  return Object.freeze([
    parseStartingKitItem(requiredArrayValue(values, 0), `${path}[0]`, bread),
    parseStartingKitItem(requiredArrayValue(values, 1), `${path}[1]`, axe),
    parseStartingKitItem(requiredArrayValue(values, 2), `${path}[2]`, pickaxe),
    parseStartingKitItem(requiredArrayValue(values, 3), `${path}[3]`, sword),
  ]);
}

function parseStartingKitItem<const Expected extends ItemStackIr>(
  value: raw.RawValue,
  path: string,
  expected: Expected,
): Expected {
  const item = raw.asTable(value, path);
  raw.checkFields(item, ["item", "count"], ["item", "count"], path);
  const resourceId = parseResourceId(raw.field(item, "item", path), `${path}.item`);
  const count = boundedNumber(raw.field(item, "count", path), `${path}.count`, 1n, 64n);
  if (resourceId !== expected.item || count !== expected.count) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "does not match the declared civilization starting kit");
  }
  return expected;
}

function requiredArrayValue(values: readonly raw.RawValue[], index: number): raw.RawValue {
  const value = values[index];
  if (value === undefined) throw new Error("validated civilization starting kit is incomplete");
  return value;
}

function parseCaptureZone(value: raw.RawValue): CaptureZoneIr {
  const path = "scenario.civilization.capture_zone";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["min", "max", "uncontested_ticks", "score_points_per_tick"], ["min", "max", "uncontested_ticks", "score_points_per_tick"], path);
  const min = parseBlockPosition(raw.field(table, "min", path), `${path}.min`);
  const max = parseBlockPosition(raw.field(table, "max", path), `${path}.max`);
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new SpecError(SpecErrorKind.Range, path, "capture-zone minimum coordinates must not exceed maximum coordinates");
  }
  boundedNumber(
    raw.field(table, "uncontested_ticks", path),
    `${path}.uncontested_ticks`,
    BigInt(CIVILIZATION_CAPTURE_UNCONTESTED_TICKS),
    BigInt(CIVILIZATION_CAPTURE_UNCONTESTED_TICKS),
  );
  boundedNumber(
    raw.field(table, "score_points_per_tick", path),
    `${path}.score_points_per_tick`,
    BigInt(CIVILIZATION_SCORE_POINTS_PER_TICK),
    BigInt(CIVILIZATION_SCORE_POINTS_PER_TICK),
  );
  return Object.freeze({
    min,
    max,
    uncontestedTicks: CIVILIZATION_CAPTURE_UNCONTESTED_TICKS,
    pointsPerOwnedTick: CIVILIZATION_SCORE_POINTS_PER_TICK,
  });
}

function parseOutpostBlueprint(value: raw.RawValue): OutpostBlueprintIr {
  const path = "scenario.civilization.blueprint";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["id", "anchors"], ["id", "anchors"], path);
  const idText = raw.string(raw.field(table, "id", path), `${path}.id`);
  if (idText !== OUTPOST_BLUEPRINT_ID) {
    throw new SpecError(SpecErrorKind.InvalidValue, `${path}.id`, `unknown blueprint \`${idText}\``);
  }
  const anchorTable = raw.asTable(raw.field(table, "anchors", path), `${path}.anchors`);
  raw.checkFields(anchorTable, CIVILIZATION_FACTION_IDS, CIVILIZATION_FACTION_IDS, `${path}.anchors`);
  const anchors = Object.fromEntries(CIVILIZATION_FACTION_IDS.map((faction) => [
    faction,
    parseBlueprintAnchor(
      raw.field(anchorTable, faction, `${path}.anchors`),
      `${path}.anchors.${faction}`,
      faction === "ember" ? 0 : 180,
    ),
  ])) as Record<CivilizationFactionId, BlueprintAnchorIr>;
  return Object.freeze({ id: OUTPOST_BLUEPRINT_ID, anchors: Object.freeze(anchors) });
}

function parseBlueprintAnchor(value: raw.RawValue, path: string, expectedRotation: 0 | 180): BlueprintAnchorIr {
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["position", "rotation_degrees"], ["position", "rotation_degrees"], path);
  const position = parseBlockPosition(raw.field(table, "position", path), `${path}.position`);
  const rotationDegreesValue = raw.integer(raw.field(table, "rotation_degrees", path), `${path}.rotation_degrees`);
  if (rotationDegreesValue !== 0n && rotationDegreesValue !== 180n) {
    throw new SpecError(SpecErrorKind.InvalidValue, `${path}.rotation_degrees`, "must be 0 or 180");
  }
  if (rotationDegreesValue !== BigInt(expectedRotation)) {
    throw new SpecError(SpecErrorKind.InvalidValue, `${path}.rotation_degrees`, `must be ${expectedRotation} for this faction`);
  }
  return Object.freeze({ position, rotationDegrees: Number(rotationDegreesValue) as 0 | 180 });
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

function parseRules(value: raw.RawValue, roster: Roster): RuleModeIr {
  const path = "scenario.rules";
  const table = raw.asTable(value, path);
  const kind = raw.string(raw.field(table, "kind", path), `${path}.kind`);
  const version = raw.integer(raw.field(table, "version", path), `${path}.version`);
  if (version !== 1n) {
    throw new SpecError(SpecErrorKind.InvalidValue, `${path}.version`, "only rule version 1 is supported");
  }
  if (kind === "frontier_survival") {
    raw.checkFields(table, ["kind", "version", "edit_radius_blocks", "max_block_edits_per_seat"],
      ["kind", "version", "edit_radius_blocks", "max_block_edits_per_seat"], path);
    return Object.freeze({
      kind,
      version: 1,
      editRadiusBlocks: boundedNumber(raw.field(table, "edit_radius_blocks", path), `${path}.edit_radius_blocks`,
        BigInt(MIN_FRONTIER_EDIT_RADIUS_BLOCKS), BigInt(MAX_FRONTIER_EDIT_RADIUS_BLOCKS)),
      maxBlockEditsPerSeat: boundedNumber(raw.field(table, "max_block_edits_per_seat", path),
        `${path}.max_block_edits_per_seat`, 1n, BigInt(MAX_FRONTIER_EDITS_PER_SEAT)),
    });
  }
  if (kind === "squads") {
    raw.checkFields(table, ["kind", "version", "squads"], ["kind", "version", "squads"], path);
    return Object.freeze({ kind, version: 1, squads: parseSquads(raw.field(table, "squads", path), roster) });
  }
  throw new SpecError(SpecErrorKind.InvalidValue, `${path}.kind`, `unknown rule mode \`${kind}\``);
}

function parseSquads(value: raw.RawValue, roster: Roster): readonly SquadIr[] {
  const path = "scenario.rules.squads";
  const entries = raw.asArray(value, path);
  if (entries.length < 2 || entries.length > MAX_SQUADS) {
    throw new SpecError(SpecErrorKind.Range, path, `must declare 2 to ${MAX_SQUADS} squads`);
  }
  const ids = new Set<string>();
  const assigned = new Set<number>();
  const squads = entries.map((entry, index): SquadIr => {
    const entryPath = `${path}[${index}]`;
    const table = raw.asTable(entry, entryPath);
    raw.checkFields(table, ["id", "seats"], ["id", "seats"], entryPath);
    const id = raw.string(raw.field(table, "id", entryPath), `${entryPath}.id`);
    if (!SQUAD_ID_PATTERN.test(id)) {
      throw new SpecError(SpecErrorKind.InvalidValue, `${entryPath}.id`, "must be a lowercase identifier of at most 16 characters");
    }
    if (ids.has(id)) throw new SpecError(SpecErrorKind.Conflict, `${entryPath}.id`, "squad ids must be unique");
    ids.add(id);
    const seatValues = raw.asArray(raw.field(table, "seats", entryPath), `${entryPath}.seats`);
    if (seatValues.length === 0) {
      throw new SpecError(SpecErrorKind.Range, `${entryPath}.seats`, "a squad needs at least one seat");
    }
    let previous = -1;
    const seats = seatValues.map((seatValue, seatIndex) => {
      const seatPath = `${entryPath}.seats[${seatIndex}]`;
      const seat = boundedNumber(seatValue, seatPath, 0n, BigInt(roster.competitors - 1));
      if (seat <= previous) {
        throw new SpecError(SpecErrorKind.Conflict, seatPath, "squad seats must be unique and ascending");
      }
      previous = seat;
      if (assigned.has(seat)) {
        throw new SpecError(SpecErrorKind.Conflict, seatPath, "a seat can belong to only one squad");
      }
      assigned.add(seat);
      return seat;
    });
    return Object.freeze({ id, seats: Object.freeze(seats) });
  });
  if (assigned.size !== roster.competitors) {
    throw new SpecError(SpecErrorKind.Conflict, path, "squads must assign every competitor seat");
  }
  return Object.freeze(squads);
}

function validateMode(mode: GameMode, roster: Roster, settings: MatchSettings, rules: RuleModeIr): void {
  if (settings.respawn) {
    throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match.respawn", "Arena competitors do not respawn");
  }
  switch (mode) {
    case GameMode.HungerGames:
      if (rules.kind === "frontier_survival") {
        if (!settings.blockBreaking || !settings.blockPlacing) {
          throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "frontier survival enables block breaking and placing");
        }
        if (settings.naturalMobs || settings.naturalRandomTicks) {
          throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "frontier survival keeps natural mobs and random block ticks off");
        }
        break;
      }
      if (settings.blockBreaking || settings.blockPlacing) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "Hunger Games disables block breaking and placing");
      }
      if (settings.naturalMobs || settings.naturalRandomTicks) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "Hunger Games disables natural mobs and random block ticks");
      }
      break;
    case GameMode.Civilization:
      if (roster.competitors !== CIVILIZATION_SEAT_COUNT) {
        throw new SpecError(SpecErrorKind.Range, "scenario.roster.competitors", "civilization scenarios require six competitor seats");
      }
      if (!settings.blockBreaking || !settings.blockPlacing) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match", "civilization enables block breaking and placing");
      }
      if (settings.graceTicks !== 2_400n) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match.grace_ticks", "civilization requires a 2,400-tick grace period");
      }
      if (settings.authoritativeMaxTicks !== 18_000n) {
        throw new SpecError(SpecErrorKind.InvalidValue, "scenario.match.authoritative_max_ticks", "civilization requires an 18,000-tick match limit");
      }
      break;
  }
}

function validateCivilizationMap(map: MapIr, rules: CivilizationRulesIr): void {
  const path = "scenario.civilization";
  if (map.terrain !== "planned") {
    throw new SpecError(SpecErrorKind.Geometry, "scenario.civilization.map", "civilization requires a planned map");
  }
  if (
    map.dimensions.width !== CIVILIZATION_MAP_DIAMETER_BLOCKS
    || map.dimensions.depth !== CIVILIZATION_MAP_DIAMETER_BLOCKS
  ) {
    throw new SpecError(SpecErrorKind.Geometry, "scenario.civilization.map", "civilization requires a 192 by 192 block map");
  }

  const blockKeys = new Set(map.blocks.map(({ position }) => positionKey(position)));
  const capture = rules.captureZone;
  validateMapPosition(map, capture.min, `${path}.capture_zone.min`);
  validateMapPosition(map, capture.max, `${path}.capture_zone.max`);
  if (capture.min.y <= map.dimensions.minY || capture.max.y + 1 > map.dimensions.maxY) {
    throw new SpecError(SpecErrorKind.Geometry, `${path}.capture_zone`, "capture zone needs floor support and clear headroom");
  }
  const captureCenter = blockPosition(
    Math.floor((capture.min.x + capture.max.x) / 2),
    capture.min.y,
    Math.floor((capture.min.z + capture.max.z) / 2),
  );
  validateReachableSurfacePosition(map, captureCenter, `${path}.capture_zone`);
  for (let x = capture.min.x; x <= capture.max.x; x += 1) {
    for (let z = capture.min.z; z <= capture.max.z; z += 1) {
      if (!blockKeys.has(positionKey(blockPosition(x, capture.min.y - 1, z)))) {
        throw new SpecError(SpecErrorKind.Geometry, `${path}.capture_zone`, "capture zone needs continuous full-block floor support");
      }
    }
  }
  for (const { position } of map.blocks) {
    if (insideBox(position, capture.min, capture.max, capture.max.y + 1)) {
      throw new SpecError(SpecErrorKind.Geometry, `${path}.capture_zone`, "capture zone must have clear headroom");
    }
  }
  for (const spawn of map.spawns) {
    if (insideBox(spawn.position, capture.min, capture.max, capture.max.y)) {
      throw new SpecError(SpecErrorKind.Geometry, `${path}.capture_zone`, `capture zone overlaps spawn seat ${spawn.seat}`);
    }
  }
  for (const [x, z] of [
    [capture.min.x, capture.min.z],
    [capture.min.x, capture.max.z],
    [capture.max.x, capture.min.z],
    [capture.max.x, capture.max.z],
  ] as const) {
    validateCivilizationBorderPosition(map, blockPosition(x, capture.min.y, z), `${path}.capture_zone`);
  }

  const occupiedBlueprintCells = new Set<string>();
  for (const faction of CIVILIZATION_FACTION_IDS) {
    const anchor = rules.blueprint.anchors[faction];
    const anchorPath = `${path}.blueprint.anchors.${faction}`;
    validateMapPosition(map, anchor.position, `${anchorPath}.position`);
    validateCivilizationBorderPosition(map, anchor.position, `${anchorPath}.position`);
    const cells = civilizationOutpostCells(anchor.position, anchor.rotationDegrees);
    if (cells.length !== OUTPOST_BLOCK_COUNT) throw new Error("core outpost cell count does not match its declared block count");

    const minX = Math.min(...cells.map(({ position }) => position.x));
    const maxX = Math.max(...cells.map(({ position }) => position.x));
    const minZ = Math.min(...cells.map(({ position }) => position.z));
    const maxZ = Math.max(...cells.map(({ position }) => position.z));
    const topY = Math.max(...cells.map(({ position }) => position.y));
    const stand = blockPosition(minX - 1, anchor.position.y, minZ + 1);
    validateReachableSurfacePosition(map, stand, `${anchorPath}.position`);
    validateCivilizationBorderPosition(map, stand, `${anchorPath}.position`);

    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        const support = blockPosition(x, anchor.position.y - 1, z);
        validateMapPosition(map, support, anchorPath);
        if (!blockKeys.has(positionKey(support))) {
          throw new SpecError(SpecErrorKind.Geometry, anchorPath, "blueprint needs full-block support under every floor cell");
        }
        for (let y = anchor.position.y; y <= topY; y += 1) {
          const position = blockPosition(x, y, z);
          if (blockKeys.has(positionKey(position)) || insideBox(position, capture.min, capture.max, capture.max.y)) {
            throw new SpecError(SpecErrorKind.Geometry, anchorPath, "blueprint build volume must be clear of map blocks and the capture zone");
          }
        }
      }
    }
    if (topY + 1 > map.dimensions.maxY) {
      throw new SpecError(SpecErrorKind.Geometry, anchorPath, "blueprint needs one clear block above its highest cell");
    }
    for (const { position, supportPosition } of cells) {
      validateMapPosition(map, position, anchorPath);
      validateMapPosition(map, supportPosition, anchorPath);
      const key = positionKey(position);
      if (occupiedBlueprintCells.has(key)) {
        throw new SpecError(SpecErrorKind.Conflict, anchorPath, "faction blueprint build volumes overlap");
      }
      occupiedBlueprintCells.add(key);
      validateCivilizationBorderPosition(map, position, anchorPath);
    }
    for (const spawn of map.spawns) {
      if (
        spawn.position.y >= anchor.position.y && spawn.position.y <= topY + 1
        && spawn.position.x >= minX - 1 && spawn.position.x <= maxX + 1
        && spawn.position.z >= minZ - 1 && spawn.position.z <= maxZ + 1
      ) {
        throw new SpecError(SpecErrorKind.Geometry, anchorPath, `blueprint build volume is too close to spawn seat ${spawn.seat}`);
      }
    }
  }
}

function validateMapPosition(map: PlannedMapIr, position: BlockPosition, path: string): void {
  if (
    position.x < 0 || position.x >= map.dimensions.width
    || position.z < 0 || position.z >= map.dimensions.depth
    || position.y < map.dimensions.minY || position.y > map.dimensions.maxY
  ) {
    throw new SpecError(SpecErrorKind.Geometry, path, "position lies outside the map dimensions");
  }
}

function validateCivilizationBorderPosition(map: PlannedMapIr, position: BlockPosition, path: string): void {
  const centerX = (map.dimensions.width - 1) / 2;
  const centerZ = (map.dimensions.depth - 1) / 2;
  const radius = CIVILIZATION_MAP_DIAMETER_BLOCKS / 2;
  if ((position.x - centerX) ** 2 + (position.z - centerZ) ** 2 > radius ** 2) {
    throw new SpecError(SpecErrorKind.Geometry, path, "position lies outside the fixed civilization border");
  }
}

function insideBox(position: BlockPosition, min: BlockPosition, max: BlockPosition, maxY: number): boolean {
  return position.x >= min.x && position.x <= max.x
    && position.y >= min.y && position.y <= maxY
    && position.z >= min.z && position.z <= max.z;
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
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
  if (map.terrain === "vanilla") {
    const chunks = new Set<string>();
    const columns = [
      ...map.spawns.map(({ column }) => column),
      ...map.lootContainers.map(({ column }) => column),
    ];
    for (const column of columns) {
      const chunkX = Math.floor(column.x / 16);
      const chunkZ = Math.floor(column.z / 16);
      for (let x = chunkX - viewDistanceChunks; x <= chunkX + viewDistanceChunks; x += 1) {
        for (let z = chunkZ - viewDistanceChunks; z <= chunkZ + viewDistanceChunks; z += 1) {
          chunks.add(`${x},${z}`);
        }
      }
    }
    if (BigInt(chunks.size) > MAX_PREPARED_CHUNKS) {
      throw new SpecError(
        SpecErrorKind.ResourceLimit,
        "scenario.server.view_distance_chunks",
        "spawn, objective, and view-distance halo exceed the prepared-chunk limit of 8,192",
      );
    }
    return;
  }

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

type ScenarioHashMode =
  | { readonly mode: typeof GameMode.HungerGames; readonly border: ShrinkingBorderSettings }
  | { readonly mode: typeof GameMode.Civilization; readonly border: FixedBorderSettings; readonly civilization: CivilizationRulesIr };

function hashScenario(
  schemaVersion: 1 | 2 | 3,
  modeSettings: ScenarioHashMode,
  seed: bigint,
  policy: ResourceReference,
  roster: Roster,
  server: ServerSettings,
  matchSettings: MatchSettings,
  bots: BotSettings,
  record: RecordSettings,
  mapId: SemanticId,
  openingStyleCycle?: OpeningStyleCycle,
  rules?: RuleModeIr,
): SemanticId {
  const hash = new CanonicalHasher(`arena.scenario.ir.v${schemaVersion}\0`);
  hash.u8(modeSettings.mode === GameMode.HungerGames ? 0 : 1);
  hash.u64(seed);
  hash.string(policy);
  hash.u16(roster.competitors);
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
  if (modeSettings.mode === GameMode.HungerGames) {
    hash.f64(modeSettings.border.initialDiameterBlocks);
    hash.u64(modeSettings.border.shrinkStartTick);
    hash.u64(modeSettings.border.shrinkEndTick);
    hash.f64(modeSettings.border.finalDiameterBlocks);
  } else {
    hash.string("fixed");
    hash.f64(modeSettings.border.diameterBlocks);
  }
  hash.u64(bots.strategyIntervalTicks);
  hash.u64(bots.pathExpansionsPerSlice);
  hash.u64(bots.maxPendingPathsPerBot);
  hash.u8(0);
  hash.u8(Number(record.policyReplay));
  hash.u8(Number(record.worldOutcomes));
  hash.bytes(Buffer.from(mapId, "hex"));
  if (modeSettings.mode === GameMode.Civilization) hashCivilizationRules(hash, modeSettings.civilization);
  if (schemaVersion >= 2) {
    if (openingStyleCycle === undefined) throw new Error(`schema-v${schemaVersion} scenario has no opening style cycle`);
    for (const style of openingStyleCycle) hash.string(style);
  }
  if (schemaVersion === 3) {
    if (rules === undefined) throw new Error("schema-v3 scenario has no rule mode");
    hashRules(hash, rules);
    for (const { seat, controller } of roster.seats) {
      hash.u16(seat);
      if (controller.kind === "bot") {
        hash.u8(0);
      } else {
        hash.u8(1);
        hash.string(controller.username);
      }
    }
  }
  return hash.finish();
}

function hashRules(hash: CanonicalHasher, rules: RuleModeIr): void {
  switch (rules.kind) {
    case "classic":
      hash.u8(0);
      return;
    case "frontier_survival":
      hash.u8(1);
      hash.u8(rules.version);
      hash.u16(rules.editRadiusBlocks);
      hash.u64(BigInt(rules.maxBlockEditsPerSeat));
      return;
    case "squads":
      hash.u8(2);
      hash.u8(rules.version);
      hash.u16(rules.squads.length);
      for (const squad of rules.squads) {
        hash.string(squad.id);
        hash.u16(squad.seats.length);
        for (const seat of squad.seats) hash.u16(seat);
      }
  }
}

function hashCivilizationRules(hash: CanonicalHasher, rules: CivilizationRulesIr): void {
  for (const faction of rules.factions) {
    hash.string(faction.id);
    for (const member of faction.members) {
      hash.u16(member.seat);
      hash.string(member.role);
    }
  }
  hash.u64(BigInt(rules.startingKit.length));
  for (const item of rules.startingKit) {
    hash.string(item.item);
    hash.u16(item.count);
  }
  for (const point of [rules.captureZone.min, rules.captureZone.max]) {
    hash.i32(point.x);
    hash.i32(point.y);
    hash.i32(point.z);
  }
  hash.u64(BigInt(rules.captureZone.uncontestedTicks));
  hash.u16(rules.captureZone.pointsPerOwnedTick);
  hash.string(rules.blueprint.id);
  for (const faction of CIVILIZATION_FACTION_IDS) {
    const anchor = rules.blueprint.anchors[faction];
    hash.string(faction);
    hash.i32(anchor.position.x);
    hash.i32(anchor.position.y);
    hash.i32(anchor.position.z);
    hash.u16(anchor.rotationDegrees);
  }
}

const I64_MAX = 9_223_372_036_854_775_807n;
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_PREPARED_CHUNKS = 8_192n;
