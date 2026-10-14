export { SpecError, SpecErrorKind } from "./errors.js";
export type { SourceLocation } from "./errors.js";
export { compileCandidateProfile } from "./candidate.js";
export type { CandidateProfileIr } from "./candidate.js";
export { compilePolicy } from "./policy.js";
export type { PolicyIr } from "./policy.js";
export { compileMap } from "./map.js";
export type {
  BlockPlacement,
  LootContainer,
  MapDimensions,
  MapFootprint,
  MapIr,
  NaturalMapIr,
  PlannedMapIr,
  SpawnPoint,
  SurfaceColumn,
  SurfaceLootContainer,
  SurfaceSpawnPoint,
} from "./map.js";
export {
  EXTERNAL_USERNAME_PATTERN,
  GameMode,
  LEGACY_MAX_COMPETITORS,
  MAX_COMPETITORS,
  MAX_FRONTIER_EDITS_PER_SEAT,
  MAX_FRONTIER_EDIT_RADIUS_BLOCKS,
  MAX_SQUADS,
  MIN_FRONTIER_EDIT_RADIUS_BLOCKS,
  SQUAD_ID_PATTERN,
  UHC_ARMOR_TIERS,
  UHC_FOOD_ITEMS,
  UHC_SWORD_MATERIALS,
  uhcFoodStackLimit,
  OPENING_STYLES,
  RESERVED_RUNNER_USERNAME_PREFIXES,
  isReservedRunnerUsername,
  compileScenario,
  scenarioMapReference,
} from "./scenario.js";
export type {
  BorderSettings,
  BlueprintAnchorIr,
  BotSettings,
  CaptureZoneIr,
  CivilizationFactionIr,
  CivilizationFactionMemberIr,
  CivilizationRulesIr,
  CivilizationScenarioIr,
  CivilizationStartingKitIr,
  FixedBorderSettings,
  HungerGamesScenarioIr,
  HungerGamesScenarioV1Ir,
  HungerGamesScenarioV2Ir,
  HungerGamesScenarioV3Ir,
  HungerGamesScenarioV4Ir,
  ItemStackIr,
  MatchSettings,
  OpeningStyle,
  OpeningStyleCycle,
  OutpostBlueprintIr,
  RecordSettings,
  RuleModeIr,
  SquadIr,
  UhcArmorTier,
  UhcDuelKitIr,
  UhcFoodItem,
  UhcSwordMaterial,
  ResourceReference,
  Roster,
  SeatController,
  SeatIr,
  ScenarioIr,
  ServerSettings,
  ShrinkingBorderSettings,
} from "./scenario.js";
export { withExternalSeat } from "./effective.js";
export type { ExternalSeatRequest } from "./effective.js";
export type { SemanticId } from "./hash.js";
export type { BlockPosition } from "@arena/core";
export type { CivilizationFactionId, CivilizationRole, OutpostBlueprintId } from "@arena/core";
export { MAX_SOURCE_BYTES } from "./raw.js";
