export { SpecError, SpecErrorKind } from "./errors.js";
export type { SourceLocation } from "./errors.js";
export { compilePolicy } from "./policy.js";
export type { PolicyIr } from "./policy.js";
export { compileMap } from "./map.js";
export type { BlockPlacement, LootContainer, MapDimensions, MapIr, SpawnPoint } from "./map.js";
export { GameMode, compileScenario, scenarioMapReference } from "./scenario.js";
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
  ItemStackIr,
  MatchSettings,
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
