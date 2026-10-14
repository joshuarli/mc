export { SpecError, SpecErrorKind } from "./errors.js";
export type { SourceLocation } from "./errors.js";
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
export { GameMode, OPENING_STYLES, compileScenario, scenarioMapReference } from "./scenario.js";
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
  ItemStackIr,
  MatchSettings,
  OpeningStyle,
  OpeningStyleCycle,
  OutpostBlueprintIr,
  RecordSettings,
  ResourceReference,
  Roster,
  ScenarioIr,
  ServerSettings,
  ShrinkingBorderSettings,
} from "./scenario.js";
export type { SemanticId } from "./hash.js";
export type { BlockPosition } from "@arena/core";
export type { CivilizationFactionId, CivilizationRole, OutpostBlueprintId } from "@arena/core";
export { MAX_SOURCE_BYTES } from "./raw.js";
