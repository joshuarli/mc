export {
  InvalidBlockOffsetError,
  InvalidBlockPositionError,
  InvalidWorldBorderError,
  blockPosition,
  borderCenter,
  isNearOrOutsideBorder,
  isOutsideBorder,
  manhattanDistance,
  offsetBlockPosition,
  squaredDistance,
  worldBorder,
} from './geometry.js';
export type { BlockPosition, CheckedPositionOffset, WorldBorder } from './geometry.js';

export {
  ObservationValidationError,
  agentObservation,
  agentState,
  currentKnowledge,
  emptyEquipment,
  entityId,
  equipmentUpgrade,
  foodStack,
  inventorySlot,
  knownArmor,
  knownFood,
  knownWeapon,
  lootTarget,
  observationSequence,
  seatId,
  staleKnowledge,
  tick,
  unknownKnowledge,
  unopenedContainer,
  visibleDrop,
  visibleOpponent,
} from './observation.js';
export type {
  AgentObservation,
  AgentObservationInput,
  AgentState,
  AgentStateInput,
  ArmorSlot,
  EntityId,
  EquipmentSlot,
  EquipmentSnapshot,
  EquipmentUpgrade,
  FoodStack,
  InventorySlot,
  Knowledge,
  KnownItem,
  LootOpportunity,
  LootTarget,
  ObservationField,
  ObservationSequence,
  ObservationValidationCode,
  SeatId,
  Tick,
  VisibleOpponent,
} from './observation.js';

export {
  InvalidPolicyParamsError,
  PolicyParams,
  decide,
  emptyPolicyMemory,
  policyMemory,
} from './policy.js';
export type {
  Decision,
  Goal,
  Intent,
  InvalidPolicyParamsCode,
  PolicyMemory,
  PolicyMemoryInput,
  PolicyParameterVersion,
  PolicyParamValues,
  RememberedOpponent,
  WaitReason,
} from './policy.js';

export { DeterministicRandom, RandomStream } from './random.js';

export {
  PolicyReplayInputError,
  normalizePolicyReplayInput,
  rehydratePolicyReplayInput,
} from './replay.js';
export type {
  PolicyReplayInputErrorCode,
  PolicyReplayInputSource,
  PolicyReplayInputV1,
  RehydratedPolicyReplayInput,
} from './replay.js';

export { skillProgress } from './outcome.js';
export type {
  SkillCancellation,
  SkillFailure,
  SkillOutcome,
  SkillProgress,
} from './outcome.js';
