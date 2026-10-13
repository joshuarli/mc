export { SpecError, SpecErrorKind } from "./errors.js";
export type { SourceLocation } from "./errors.js";
export { compileMap } from "./map.js";
export type { BlockPlacement, LootContainer, MapDimensions, MapIr, SpawnPoint } from "./map.js";
export { GameMode, compileScenario, scenarioMapReference } from "./scenario.js";
export type {
  BorderSettings,
  BotSettings,
  MatchSettings,
  RecordSettings,
  ResourceReference,
  Roster,
  ScenarioIr,
  ServerSettings,
} from "./scenario.js";
export type { SemanticId } from "./hash.js";
export type { BlockPosition } from "@arena/core";
export { MAX_SOURCE_BYTES } from "./raw.js";
