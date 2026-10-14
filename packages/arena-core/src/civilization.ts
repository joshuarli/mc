import {
  blockPosition,
  compareBlockPositions,
  offsetBlockPosition,
  squaredDistance,
  type BlockPosition,
} from './geometry.js';
import {
  agentObservation,
  assertValidatedAgentObservation,
  currentKnowledge,
  entityId,
  inventorySlot,
  seatId,
  tick,
  unknownKnowledge,
  type AgentObservation,
  type EntityId,
  type InventorySlot,
  type Knowledge,
  type SeatId,
  type Tick,
} from './observation.js';
import {
  decide,
  emptyPolicyMemory,
  policyFeedbackBatch,
  policyMemory,
  type Decision,
  type Goal,
  type Intent,
  type PolicyMemory,
  type PolicyFeedbackBatch,
  type PolicyParams,
} from './policy.js';
import { skillProgress, type SkillFailure, type SkillOutcome } from './outcome.js';
import { DeterministicRandom } from './random.js';

export const CIVILIZATION_FACTION_IDS = Object.freeze(['ember', 'tide'] as const);
export const CIVILIZATION_ROLES = Object.freeze([
  'gatherer_crafter',
  'builder',
  'defender_scout',
] as const);
export const OUTPOST_BLUEPRINT_ID = 'oak-outpost-v1' as const;
export const OUTPOST_LOGS_REQUIRED = 4;
export const OUTPOST_PLANKS_REQUIRED = 16;
export const OUTPOST_BLOCK_COUNT = 15;
export const CIVILIZATION_TEAM_MESSAGE_MAX_BYTES = 1_024;
export const CIVILIZATION_TEAM_MESSAGE_MIN_INTERVAL_TICKS = 20;
export const CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS = 200;
export const CIVILIZATION_TEAM_MESSAGE_QUEUE_LIMIT = 16;

const OAK_PLANKS_PER_LOG = OUTPOST_PLANKS_REQUIRED / OUTPOST_LOGS_REQUIRED;
const CONTAINER_INTERACTION_DISTANCE_BLOCKS = 3n;
const BLOCK_INTERACTION_DISTANCE_SQUARED = 25n;
const MAX_CIVILIZATION_FEEDBACKS = 2;
const MAX_FAILED_MATERIAL_TARGETS = 16;
const MATERIAL_TARGET_RETRY_TICKS = 20;

export type CivilizationFactionId = typeof CIVILIZATION_FACTION_IDS[number];
export type CivilizationRole = typeof CIVILIZATION_ROLES[number];
export type OutpostBlueprintId = typeof OUTPOST_BLUEPRINT_ID;
export type OutpostRotationDegrees = 0 | 180;
export type MaterialItem = 'oak_log' | 'oak_planks';
export type ReportedResource = 'oakLogBlock' | 'oakLogDrop' | 'oakPlankDrop' | 'container';

export interface CivilizationProfile {
  readonly seat: SeatId;
  readonly faction: CivilizationFactionId;
  readonly role: CivilizationRole;
}

export interface CaptureBox {
  readonly min: BlockPosition;
  readonly max: BlockPosition;
}

export interface OutpostObjective {
  readonly blueprintId: OutpostBlueprintId;
  readonly anchor: BlockPosition;
  readonly rotationDegrees: OutpostRotationDegrees;
}

export interface CivilizationObjective {
  readonly captureBox: CaptureBox;
  readonly outpost: OutpostObjective;
}

const validatedCivilizationContext: unique symbol = Symbol('validated-civilization-context');
export interface CivilizationPolicyContext {
  readonly [validatedCivilizationContext]: true;
  readonly seat: SeatId;
  readonly faction: CivilizationFactionId;
  readonly role: CivilizationRole;
  readonly objective: CivilizationObjective;
}

export interface CivilizationPolicyContextInput {
  readonly seat: SeatId | number;
  readonly faction: CivilizationFactionId;
  readonly role: CivilizationRole;
  readonly objective: CivilizationObjective;
}

export function civilizationProfileForSeat(value: number): CivilizationProfile | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5) {
    return null;
  }
  const seat = seatId(value);
  const faction: CivilizationFactionId = value < 3 ? 'ember' : 'tide';
  const role = CIVILIZATION_ROLES[value % CIVILIZATION_ROLES.length];
  if (role === undefined) {
    throw new RangeError('civilization role mapping is incomplete');
  }
  return Object.freeze({ seat, faction, role });
}

export function civilizationPolicyContext(input: CivilizationPolicyContextInput): CivilizationPolicyContext {
  assertExactKeys(input, ['seat', 'faction', 'role', 'objective'], 'civilization policy context');
  const profile = civilizationProfileForSeat(input.seat);
  if (profile === null || input.faction !== profile.faction || input.role !== profile.role) {
    throw new RangeError('civilization seat, faction, and role do not match the six-seat roster');
  }
  const objective = cloneObjective(input.objective);
  const context = {
    seat: profile.seat,
    faction: profile.faction,
    role: profile.role,
    objective,
  };
  Object.defineProperty(context, validatedCivilizationContext, { value: true });
  return Object.freeze(context) as CivilizationPolicyContext;
}

export interface MaterialStack {
  readonly inventorySlot: InventorySlot;
  readonly item: MaterialItem;
  readonly count: number;
}

export interface StoredMaterialStack {
  readonly slot: number;
  readonly item: MaterialItem;
  readonly count: number;
}

export function materialStack(slot: number, item: MaterialItem, count: number): MaterialStack {
  assertMaterialItem(item);
  assertStackCount(count, 'material stack count');
  return Object.freeze({ inventorySlot: inventorySlot(slot), item, count });
}

export function storedMaterialStack(slot: number, item: MaterialItem, count: number): StoredMaterialStack {
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new RangeError(`container slot must be a nonnegative safe integer, received ${slot}`);
  }
  assertMaterialItem(item);
  assertStackCount(count, 'stored material stack count');
  return Object.freeze({ slot, item, count });
}

export type OutpostCellState = 'unloaded' | 'air' | 'oak_planks' | 'other';
export type OutpostSupportState = 'unknown' | 'solid' | 'notSolid';

export interface OutpostCellObservation {
  readonly kind: 'outpostCell';
  readonly position: BlockPosition;
  readonly state: OutpostCellState;
  readonly support: OutpostSupportState;
}

export function outpostCell(
  position: BlockPosition,
  state: OutpostCellState,
  support: OutpostSupportState,
): OutpostCellObservation {
  assertCellState(state);
  assertSupportState(support);
  return Object.freeze({ kind: 'outpostCell', position: clonePosition(position), state, support });
}

export interface OutpostCell {
  readonly index: number;
  readonly position: BlockPosition;
  readonly supportPosition: BlockPosition;
  readonly layer: 'floor' | 'pillar';
}

/** Generates the fixed 3x3 floor and two opposing three-block corner pillars. */
export function civilizationOutpostCells(
  anchor: BlockPosition,
  rotationDegrees: OutpostRotationDegrees,
): readonly OutpostCell[] {
  const base = clonePosition(anchor);
  assertRotation(rotationDegrees);
  const floor: OutpostCell[] = [];
  const pillars: OutpostCell[] = [];
  const corners = [[0, 0], [2, 2]] as const;

  for (let x = 0; x <= 2; x += 1) {
    for (let z = 0; z <= 2; z += 1) {
      const position = checkedOffset(base, x, 0, z);
      floor.push(makeCell(floor.length, position, 'floor'));
    }
  }
  for (const [x, z] of corners) {
    for (let height = 1; height <= 3; height += 1) {
      const position = checkedOffset(base, x, height, z);
      pillars.push(makeCell(0, position, 'pillar', checkedOffset(base, x, height - 1, z)));
    }
  }

  return Object.freeze([...floor, ...pillars].map((cell, index) => Object.freeze({ ...cell, index })));
}

export type CivilizationResourceObservation =
  | { readonly kind: 'logBlock'; readonly position: BlockPosition }
  | {
    readonly kind: 'materialDrop';
    readonly entityId: EntityId;
    readonly position: BlockPosition;
    readonly item: MaterialItem;
  }
  | {
    readonly kind: 'container';
    readonly position: BlockPosition;
    readonly contents: Knowledge<readonly StoredMaterialStack[]>;
  }
  | OutpostCellObservation;

export interface CivilizationTeamMessage {
  readonly sender: SeatId;
  readonly sourceTick: Tick;
  readonly declaredStale: boolean;
  readonly kind: 'resourceSighting';
  readonly resource: ReportedResource;
  readonly position: BlockPosition;
}

export interface CivilizationTeamMessageInput {
  readonly sender: SeatId | number;
  readonly sourceTick: Tick | number;
  readonly declaredStale: boolean;
  readonly kind: 'resourceSighting';
  readonly resource: ReportedResource;
  readonly position: BlockPosition;
}

export function civilizationTeamMessage(input: CivilizationTeamMessageInput): CivilizationTeamMessage {
  assertExactKeys(input, ['sender', 'sourceTick', 'declaredStale', 'kind', 'resource', 'position'], 'civilization team message');
  const sender = seatId(input.sender);
  const sourceTick = tick(input.sourceTick);
  if (typeof input.declaredStale !== 'boolean') {
    throw new TypeError('declaredStale must be a boolean');
  }
  if (input.kind !== 'resourceSighting') {
    throw new TypeError(`unknown civilization team message kind: ${String(input.kind)}`);
  }
  assertReportedResource(input.resource);
  return Object.freeze({
    sender,
    sourceTick,
    declaredStale: input.declaredStale,
    kind: input.kind,
    resource: input.resource,
    position: clonePosition(input.position),
  });
}

const validatedCivilizationObservation: unique symbol = Symbol('validated-civilization-observation');
export interface CivilizationObservation {
  readonly [validatedCivilizationObservation]: true;
  readonly base: AgentObservation;
  readonly ownMaterials: Knowledge<readonly MaterialStack[]>;
  readonly observedResources: Knowledge<readonly CivilizationResourceObservation[]>;
  readonly teamMessages: readonly CivilizationTeamMessage[];
}

export interface CivilizationObservationInput {
  readonly base: AgentObservation;
  readonly ownMaterials: Knowledge<readonly MaterialStack[]>;
  readonly observedResources: Knowledge<readonly CivilizationResourceObservation[]>;
  readonly teamMessages: readonly CivilizationTeamMessage[];
}

export type CivilizationObservationErrorCode =
  | 'invalid-team-queue'
  | 'message-from-other-faction'
  | 'future-message'
  | 'expired-message';

export class CivilizationObservationError extends Error {
  constructor(readonly code: CivilizationObservationErrorCode) {
    super(`civilization observation is invalid: ${code}`);
    this.name = 'CivilizationObservationError';
  }
}

/**
 * Validates one client's civilization view. `base.tick` is the authoritative shared match tick,
 * so same-faction report age can be checked without comparing client-local clocks.
 */
export function civilizationObservation(
  input: CivilizationObservationInput,
  context: CivilizationPolicyContext,
): CivilizationObservation {
  assertExactKeys(input, ['base', 'ownMaterials', 'observedResources', 'teamMessages'], 'civilization observation');
  assertValidatedCivilizationContext(context);
  assertValidatedAgentObservation(input.base);
  if (!Array.isArray(input.teamMessages) || input.teamMessages.length > CIVILIZATION_TEAM_MESSAGE_QUEUE_LIMIT) {
    throw new CivilizationObservationError('invalid-team-queue');
  }
  const base = agentObservation({
    tick: input.base.tick,
    sequence: input.base.sequence,
    agent: input.base.agent,
    border: input.base.border,
    opponents: input.base.opponents,
    loot: input.base.loot,
  });
  const ownMaterials = cloneKnowledge(input.ownMaterials, cloneMaterialStacks, base.tick, 'own materials');
  const observedResources = cloneKnowledge(
    input.observedResources,
    (resources) => cloneResources(resources, base.tick),
    base.tick,
    'observed resources',
  );
  const teamMessages = Object.freeze(input.teamMessages.map((message) => {
    const validated = civilizationTeamMessage(message);
    const senderProfile = civilizationProfileForSeat(validated.sender);
    if (senderProfile === null || senderProfile.faction !== context.faction) {
      throw new CivilizationObservationError('message-from-other-faction');
    }
    if (validated.sourceTick > base.tick) {
      throw new CivilizationObservationError('future-message');
    }
    if (base.tick - validated.sourceTick > CIVILIZATION_TEAM_MESSAGE_MAX_AGE_TICKS) {
      throw new CivilizationObservationError('expired-message');
    }
    return validated;
  }));

  const observation = { base, ownMaterials, observedResources, teamMessages };
  Object.defineProperty(observation, validatedCivilizationObservation, { value: true });
  return Object.freeze(observation) as CivilizationObservation;
}

export function assertValidatedCivilizationContext(value: unknown): asserts value is CivilizationPolicyContext {
  if (value === null
      || typeof value !== 'object'
      || Object.getOwnPropertyDescriptor(value, validatedCivilizationContext)?.value !== true) {
    throw new TypeError('civilization decisions require a context created by civilizationPolicyContext');
  }
}

export function assertValidatedCivilizationObservation(value: unknown): asserts value is CivilizationObservation {
  if (value === null
      || typeof value !== 'object'
      || Object.getOwnPropertyDescriptor(value, validatedCivilizationObservation)?.value !== true) {
    throw new TypeError('civilization decisions require an observation created by civilizationObservation');
  }
}

export type CivilizationHoldReason =
  | 'materialsUnknown'
  | 'resourcesUnknown'
  | 'blueprintObstructed'
  | 'blueprintComplete'
  | 'materialsUnavailable'
  | 'captureZoneOccupied'
  | 'materialTargetCoolingDown';

export type CivIntent =
  | { readonly kind: 'mineBlock'; readonly position: BlockPosition; readonly expectedBlock: 'oak_log' }
  | { readonly kind: 'craft'; readonly output: 'oak_planks'; readonly resultCount: number; readonly table: null }
  | {
    readonly kind: 'containerTransfer';
    readonly position: BlockPosition;
    readonly direction: 'deposit' | 'withdraw';
    readonly item: MaterialItem;
    readonly count: number;
  }
  | {
    readonly kind: 'placeBlock';
    readonly target: BlockPosition;
    readonly referencePosition: BlockPosition;
    readonly face: 'up';
    readonly item: 'oak_planks';
  }
  | { readonly kind: 'hold'; readonly reason: CivilizationHoldReason };

export type CivilizationGoal =
  | { readonly kind: 'gatherMaterial'; readonly item: MaterialItem; readonly target: BlockPosition }
  | { readonly kind: 'craftMaterial'; readonly item: 'oak_planks'; readonly resultCount: number }
  | {
    readonly kind: 'transferMaterial';
    readonly item: MaterialItem;
    readonly count: number;
    readonly direction: 'deposit' | 'withdraw';
    readonly container: BlockPosition;
  }
  | {
    readonly kind: 'buildOutpost';
    readonly blueprintId: OutpostBlueprintId;
    readonly cellIndex: number;
    readonly target: BlockPosition;
  }
  | { readonly kind: 'captureZone'; readonly target: BlockPosition }
  | { readonly kind: 'holdCaptureZone' }
  | { readonly kind: 'outpostComplete' }
  | { readonly kind: 'wait'; readonly reason: CivilizationHoldReason };

export type CivilizationMaterialTarget =
  | { readonly kind: 'gather'; readonly item: MaterialItem; readonly target: BlockPosition }
  | {
    readonly kind: 'transfer';
    readonly item: MaterialItem;
    readonly direction: 'deposit' | 'withdraw';
    readonly container: BlockPosition;
  }
  | {
    readonly kind: 'build';
    readonly blueprintId: OutpostBlueprintId;
    readonly cellIndex: number;
    readonly target: BlockPosition;
  }
  | { readonly kind: 'craft'; readonly item: 'oak_planks' };

type CivilizationMaterialTargetTemplate =
  | { readonly kind: 'gather'; readonly item: MaterialItem }
  | { readonly kind: 'transfer'; readonly item: MaterialItem; readonly direction: 'deposit' | 'withdraw' };

export interface CivilizationFailedMaterialTarget {
  readonly target: CivilizationMaterialTarget;
  readonly retryAt: Tick;
}

export interface CivilizationPolicyMemory {
  readonly policy: PolicyMemory;
  readonly failedMaterialTargets: readonly CivilizationFailedMaterialTarget[];
}

export type CivilizationActionIntent = CivIntent
  | Extract<Intent, { readonly kind: 'navigate' | 'dropCollect' | 'containerOpen' }>;

export type CivilizationActionFeedbackOutcome = Exclude<SkillOutcome, { readonly kind: 'pending' | 'cancelled' }>;

export interface CivilizationActionFeedbackSource {
  readonly goal: CivilizationGoal;
  readonly intent: CivilizationActionIntent;
  readonly outcome: CivilizationActionFeedbackOutcome;
  readonly startedAt: Tick | number;
  readonly completedAt: Tick | number;
}

export interface CivilizationActionFeedback extends CivilizationActionFeedbackSource {
  readonly startedAt: Tick;
  readonly completedAt: Tick;
}

export interface CivilizationPolicyFeedbackBatchInput {
  readonly shared: PolicyFeedbackBatch;
  readonly actions: readonly CivilizationActionFeedbackSource[];
}

export interface CivilizationPolicyFeedbackBatch {
  readonly shared: PolicyFeedbackBatch;
  readonly actions: readonly CivilizationActionFeedback[];
}

export interface CivilizationDecision {
  readonly goal: Goal | CivilizationGoal;
  readonly intent: Intent | CivIntent;
  readonly memory: CivilizationPolicyMemory;
}

export function emptyCivilizationPolicyMemory(): CivilizationPolicyMemory {
  return Object.freeze({
    policy: emptyPolicyMemory(),
    failedMaterialTargets: Object.freeze([]),
  });
}

export function civilizationPolicyMemory(input: CivilizationPolicyMemory): CivilizationPolicyMemory {
  assertExactKeys(input, ['policy', 'failedMaterialTargets'], 'civilization policy memory');
  if (!Array.isArray(input.failedMaterialTargets) || input.failedMaterialTargets.length > MAX_FAILED_MATERIAL_TARGETS) {
    throw new RangeError(`civilization policy memory can hold at most ${MAX_FAILED_MATERIAL_TARGETS} failed material targets`);
  }
  assertDenseArray(input.failedMaterialTargets, 'civilization policy memory failedMaterialTargets');
  const failedMaterialTargets = input.failedMaterialTargets.map(cloneFailedMaterialTarget);
  for (let index = 0; index < failedMaterialTargets.length; index += 1) {
    const candidate = failedMaterialTargets[index]!;
    if (failedMaterialTargets.slice(0, index).some((existing) => (
      sameCivilizationMaterialTarget(existing.target, candidate.target)
    ))) {
      throw new TypeError('civilization policy memory cannot contain duplicate failed material targets');
    }
  }
  return Object.freeze({
    policy: policyMemory(input.policy),
    failedMaterialTargets: Object.freeze(failedMaterialTargets),
  });
}

export function civilizationPolicyFeedbackBatch(
  input: CivilizationPolicyFeedbackBatchInput,
): CivilizationPolicyFeedbackBatch {
  assertExactKeys(input, ['shared', 'actions'], 'civilization policy feedback batch');
  const shared = policyFeedbackBatch(input.shared);
  if (!Array.isArray(input.actions) || shared.length + input.actions.length > MAX_CIVILIZATION_FEEDBACKS) {
    throw new RangeError(`civilization feedback can contain at most ${MAX_CIVILIZATION_FEEDBACKS} completed outcomes`);
  }
  assertDenseArray(input.actions, 'civilization action feedback');
  let previousCompletedAt: Tick | null = null;
  const actions = input.actions.map((source) => {
    const feedback = cloneCivilizationActionFeedback(source);
    if (previousCompletedAt !== null && feedback.completedAt < previousCompletedAt) {
      throw new RangeError('civilization action feedback must be in completion order');
    }
    previousCompletedAt = feedback.completedAt;
    return feedback;
  });
  return Object.freeze({ shared, actions: Object.freeze(actions) });
}

interface ResourceHint {
  readonly position: BlockPosition;
  readonly resource: ReportedResource;
  readonly declaredStale: boolean;
  readonly sourceTick: Tick;
  readonly receiveOrder: number;
}

/** Runs role tasks after shared survival and combat priorities, except container handling. */
export function decideCivilization(
  context: CivilizationPolicyContext,
  observation: CivilizationObservation,
  memory: CivilizationPolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: CivilizationPolicyFeedbackBatch,
): CivilizationDecision {
  assertValidatedCivilizationContext(context);
  assertValidatedCivilizationObservation(observation);

  const civilizationMemory = civilizationPolicyMemory(memory);
  const policyFeedback = civilizationPolicyFeedbackBatch(feedback);
  const baseline = decide(observation.base, civilizationMemory.policy, params, random, policyFeedback.shared);
  const nextMemory = applyCivilizationActionFeedback(civilizationMemory, policyFeedback.actions, observation);
  const resultMemory = civilizationPolicyMemory({ ...nextMemory, policy: baseline.memory });
  if (isSharedPriorityGoal(baseline.goal)) {
    return civilizationDecision(baseline.goal, baseline.intent, resultMemory);
  }
  const agent = observation.base.agent.kind === 'current' ? observation.base.agent.value : null;
  if (agent === null) {
    return civilizationDecision(baseline.goal, baseline.intent, resultMemory);
  }

  switch (context.role) {
    case 'gatherer_crafter':
      return decideGatherer(observation, baseline, resultMemory, agent.position);
    case 'builder':
      return decideBuilder(context, observation, baseline, resultMemory, agent.position);
    case 'defender_scout':
      return decideDefender(context, observation, baseline, resultMemory, agent.position);
  }
}

function isSharedPriorityGoal(goal: Goal): boolean {
  if (goal.kind === 'explore') {
    return false;
  }
  // Civilization transfers need the opened container snapshot before deciding what to move.
  if (goal.kind === 'loot' && goal.target.kind === 'container') {
    return false;
  }
  return true;
}

function cloneCivilizationActionFeedback(source: CivilizationActionFeedbackSource): CivilizationActionFeedback {
  assertExactKeys(source, ['goal', 'intent', 'outcome', 'startedAt', 'completedAt'], 'civilization action feedback');
  const goal = cloneCivilizationGoal(source.goal);
  const intent = cloneCivilizationIntent(source.intent);
  validateCivilizationGoalIntent(goal, intent);
  const outcome = cloneCivilizationActionOutcome(source.outcome);
  const startedAt = tick(source.startedAt);
  const completedAt = tick(source.completedAt);
  if (startedAt > completedAt) {
    throw new RangeError('civilization action feedback must start no later than completion');
  }
  return Object.freeze({ goal, intent, outcome, startedAt, completedAt });
}

function cloneCivilizationGoal(goal: CivilizationGoal): CivilizationGoal {
  switch (goal.kind) {
    case 'gatherMaterial':
      assertExactKeys(goal, ['kind', 'item', 'target'], 'civilization gather goal');
      assertMaterialItem(goal.item);
      return Object.freeze({ kind: goal.kind, item: goal.item, target: clonePosition(goal.target) });
    case 'craftMaterial':
      assertExactKeys(goal, ['kind', 'item', 'resultCount'], 'civilization craft goal');
      if (goal.item !== 'oak_planks') throw new TypeError('civilization craft goal must produce oak_planks');
      assertStackCount(goal.resultCount, 'craft result count');
      return Object.freeze({ kind: goal.kind, item: goal.item, resultCount: goal.resultCount });
    case 'transferMaterial':
      assertExactKeys(goal, ['kind', 'item', 'count', 'direction', 'container'], 'civilization transfer goal');
      assertMaterialItem(goal.item);
      assertStackCount(goal.count, 'transfer count');
      if (goal.direction !== 'deposit' && goal.direction !== 'withdraw') {
        throw new TypeError(`unknown transfer direction: ${String(goal.direction)}`);
      }
      return Object.freeze({
        kind: goal.kind,
        item: goal.item,
        count: goal.count,
        direction: goal.direction,
        container: clonePosition(goal.container),
      });
    case 'buildOutpost':
      assertExactKeys(goal, ['kind', 'blueprintId', 'cellIndex', 'target'], 'civilization build goal');
      if (goal.blueprintId !== OUTPOST_BLUEPRINT_ID) throw new TypeError('unknown outpost blueprint');
      if (!Number.isSafeInteger(goal.cellIndex) || goal.cellIndex < 0 || goal.cellIndex >= OUTPOST_BLOCK_COUNT) {
        throw new RangeError('outpost cell index is out of range');
      }
      return Object.freeze({
        kind: goal.kind, blueprintId: goal.blueprintId, cellIndex: goal.cellIndex, target: clonePosition(goal.target),
      });
    case 'captureZone':
      assertExactKeys(goal, ['kind', 'target'], 'civilization capture goal');
      return Object.freeze({ kind: goal.kind, target: clonePosition(goal.target) });
    case 'holdCaptureZone':
    case 'outpostComplete':
      assertExactKeys(goal, ['kind'], 'civilization completed goal');
      return Object.freeze({ kind: goal.kind });
    case 'wait':
      assertExactKeys(goal, ['kind', 'reason'], 'civilization wait goal');
      assertCivilizationHoldReason(goal.reason);
      return Object.freeze({ kind: goal.kind, reason: goal.reason });
    default:
      throw new TypeError(`unknown civilization goal: ${String((goal as { kind?: unknown }).kind)}`);
  }
}

function cloneCivilizationIntent(intent: CivilizationActionIntent): CivilizationActionIntent {
  switch (intent.kind) {
    case 'mineBlock':
      assertExactKeys(intent, ['kind', 'position', 'expectedBlock'], 'civilization mining intent');
      if (intent.expectedBlock !== 'oak_log') throw new TypeError('civilization mining intent must target oak_log');
      return Object.freeze({ kind: intent.kind, position: clonePosition(intent.position), expectedBlock: intent.expectedBlock });
    case 'craft':
      assertExactKeys(intent, ['kind', 'output', 'resultCount', 'table'], 'civilization craft intent');
      if (intent.output !== 'oak_planks' || intent.table !== null) {
        throw new TypeError('civilization craft intent must craft oak_planks without a table');
      }
      assertStackCount(intent.resultCount, 'craft result count');
      return Object.freeze({ kind: intent.kind, output: intent.output, resultCount: intent.resultCount, table: null });
    case 'containerTransfer':
      assertExactKeys(intent, ['kind', 'position', 'direction', 'item', 'count'], 'civilization container transfer intent');
      if (intent.direction !== 'deposit' && intent.direction !== 'withdraw') {
        throw new TypeError(`unknown transfer direction: ${String(intent.direction)}`);
      }
      assertMaterialItem(intent.item);
      assertStackCount(intent.count, 'transfer count');
      return Object.freeze({
        kind: intent.kind,
        position: clonePosition(intent.position),
        direction: intent.direction,
        item: intent.item,
        count: intent.count,
      });
    case 'placeBlock':
      assertExactKeys(intent, ['kind', 'target', 'referencePosition', 'face', 'item'], 'civilization placement intent');
      if (intent.face !== 'up' || intent.item !== 'oak_planks') {
        throw new TypeError('civilization placement must place oak_planks on the upper face');
      }
      return Object.freeze({
        kind: intent.kind,
        target: clonePosition(intent.target),
        referencePosition: clonePosition(intent.referencePosition),
        face: intent.face,
        item: intent.item,
      });
    case 'navigate':
      assertExactKeys(intent, ['kind', 'target'], 'civilization navigation intent');
      return Object.freeze({ kind: intent.kind, target: clonePosition(intent.target) });
    case 'dropCollect':
      assertExactKeys(intent, ['kind', 'entityId'], 'civilization collection intent');
      return Object.freeze({ kind: intent.kind, entityId: entityId(intent.entityId) });
    case 'containerOpen':
      assertExactKeys(intent, ['kind', 'position'], 'civilization container open intent');
      return Object.freeze({ kind: intent.kind, position: clonePosition(intent.position) });
    case 'hold':
      assertExactKeys(intent, ['kind', 'reason'], 'civilization hold intent');
      assertCivilizationHoldReason(intent.reason);
      return Object.freeze({ kind: intent.kind, reason: intent.reason });
    default:
      throw new TypeError(`unknown civilization intent: ${String((intent as { kind?: unknown }).kind)}`);
  }
}

function cloneCivilizationActionOutcome(outcome: CivilizationActionFeedbackOutcome): CivilizationActionFeedbackOutcome {
  switch (outcome.kind) {
    case 'succeeded':
      assertExactKeys(outcome, ['kind'], 'civilization successful action outcome');
      return Object.freeze({ kind: 'succeeded' });
    case 'failed':
      assertExactKeys(outcome, ['kind', 'cause'], 'civilization failed action outcome');
      assertSkillFailure(outcome.cause);
      return Object.freeze({ kind: 'failed', cause: outcome.cause });
    case 'progress':
      assertExactKeys(outcome, ['kind', 'progress'], 'civilization progress outcome');
      assertExactKeys(outcome.progress, ['completedSteps', 'totalSteps'], 'civilization skill progress');
      return Object.freeze({
        kind: 'progress',
        progress: skillProgress(outcome.progress.completedSteps, outcome.progress.totalSteps),
      });
    default:
      throw new TypeError('civilization feedback accepts only progress or completed action outcomes');
  }
}

function validateCivilizationGoalIntent(goal: CivilizationGoal, intent: CivilizationActionIntent): void {
  const matchesPosition = (first: BlockPosition, second: BlockPosition): boolean => compareBlockPositions(first, second) === 0;
  switch (goal.kind) {
    case 'gatherMaterial':
      if (intent.kind === 'navigate') {
        if (matchesPosition(intent.target, goal.target)) return;
      } else if (intent.kind === 'mineBlock') {
        if (goal.item === 'oak_log' && matchesPosition(intent.position, goal.target)) return;
      } else if (intent.kind === 'dropCollect') {
        return;
      }
      break;
    case 'craftMaterial':
      if (intent.kind === 'craft'
          && intent.output === goal.item
          && intent.resultCount === goal.resultCount) return;
      break;
    case 'transferMaterial':
      if ((intent.kind === 'navigate' && matchesPosition(intent.target, goal.container))
          || (intent.kind === 'containerOpen' && matchesPosition(intent.position, goal.container))) return;
      if (intent.kind === 'containerTransfer'
          && matchesPosition(intent.position, goal.container)
          && intent.direction === goal.direction
          && intent.item === goal.item
          && intent.count <= goal.count) return;
      break;
    case 'buildOutpost':
      if (intent.kind === 'navigate' && matchesPosition(intent.target, goal.target)) return;
      if (intent.kind === 'placeBlock' && matchesPosition(intent.target, goal.target)) return;
      break;
    case 'captureZone':
      if (intent.kind === 'navigate' && matchesPosition(intent.target, goal.target)) return;
      break;
    case 'holdCaptureZone':
      if (intent.kind === 'hold' && intent.reason === 'captureZoneOccupied') return;
      break;
    case 'outpostComplete':
      if (intent.kind === 'hold' && intent.reason === 'blueprintComplete') return;
      break;
    case 'wait':
      if (intent.kind === 'hold' && intent.reason === goal.reason) return;
      break;
  }
  throw new TypeError('civilization feedback goal and intent do not match');
}

function assertCivilizationHoldReason(value: string): asserts value is CivilizationHoldReason {
  if (value !== 'materialsUnknown'
      && value !== 'resourcesUnknown'
      && value !== 'blueprintObstructed'
      && value !== 'blueprintComplete'
      && value !== 'materialsUnavailable'
      && value !== 'captureZoneOccupied'
      && value !== 'materialTargetCoolingDown') {
    throw new TypeError(`unknown civilization hold reason: ${value}`);
  }
}

function assertSkillFailure(value: SkillFailure): void {
  if (value !== 'preconditionsNotMet' && value !== 'noProgress' && value !== 'serverRejected' && value !== 'timedOut') {
    throw new TypeError(`unknown skill failure cause: ${String(value)}`);
  }
}

function cloneFailedMaterialTarget(input: CivilizationFailedMaterialTarget): CivilizationFailedMaterialTarget {
  assertExactKeys(input, ['target', 'retryAt'], 'failed civilization material target');
  return Object.freeze({ target: cloneCivilizationMaterialTarget(input.target), retryAt: tick(input.retryAt) });
}

function cloneCivilizationMaterialTarget(target: CivilizationMaterialTarget): CivilizationMaterialTarget {
  switch (target.kind) {
    case 'gather':
      assertExactKeys(target, ['kind', 'item', 'target'], 'civilization gather target');
      assertMaterialItem(target.item);
      return Object.freeze({ kind: target.kind, item: target.item, target: clonePosition(target.target) });
    case 'transfer':
      assertExactKeys(target, ['kind', 'item', 'direction', 'container'], 'civilization transfer target');
      assertMaterialItem(target.item);
      if (target.direction !== 'deposit' && target.direction !== 'withdraw') {
        throw new TypeError(`unknown transfer direction: ${String(target.direction)}`);
      }
      return Object.freeze({
        kind: target.kind, item: target.item, direction: target.direction, container: clonePosition(target.container),
      });
    case 'build':
      assertExactKeys(target, ['kind', 'blueprintId', 'cellIndex', 'target'], 'civilization build target');
      if (target.blueprintId !== OUTPOST_BLUEPRINT_ID) throw new TypeError('unknown outpost blueprint');
      if (!Number.isSafeInteger(target.cellIndex) || target.cellIndex < 0 || target.cellIndex >= OUTPOST_BLOCK_COUNT) {
        throw new RangeError('outpost cell index is out of range');
      }
      return Object.freeze({
        kind: target.kind,
        blueprintId: target.blueprintId,
        cellIndex: target.cellIndex,
        target: clonePosition(target.target),
      });
    case 'craft':
      assertExactKeys(target, ['kind', 'item'], 'civilization craft target');
      if (target.item !== 'oak_planks') throw new TypeError('unknown civilization craft target item');
      return Object.freeze({ kind: target.kind, item: target.item });
    default:
      throw new TypeError(`unknown civilization material target: ${String((target as { kind?: unknown }).kind)}`);
  }
}

function sameCivilizationMaterialTarget(first: CivilizationMaterialTarget, second: CivilizationMaterialTarget): boolean {
  if (first.kind !== second.kind) return false;
  switch (first.kind) {
    case 'gather':
      return second.kind === 'gather' && first.item === second.item && compareBlockPositions(first.target, second.target) === 0;
    case 'transfer':
      return second.kind === 'transfer'
        && first.item === second.item
        && first.direction === second.direction
        && compareBlockPositions(first.container, second.container) === 0;
    case 'build':
      return second.kind === 'build'
        && first.blueprintId === second.blueprintId
        && first.cellIndex === second.cellIndex
        && compareBlockPositions(first.target, second.target) === 0;
    case 'craft':
      return second.kind === 'craft' && first.item === second.item;
  }
}

function isCivilizationMaterialTargetCoolingDown(
  memory: CivilizationPolicyMemory,
  target: CivilizationMaterialTarget,
): boolean {
  return memory.failedMaterialTargets.some((failed) => sameCivilizationMaterialTarget(failed.target, target));
}

function applyCivilizationActionFeedback(
  memory: CivilizationPolicyMemory,
  feedback: readonly CivilizationActionFeedback[],
  observation: CivilizationObservation,
): CivilizationPolicyMemory {
  const currentTick = observation.base.tick;
  let failedMaterialTargets = [...memory.failedMaterialTargets];
  for (const event of feedback) {
    if (event.startedAt > currentTick || event.completedAt > currentTick) {
      throw new RangeError('civilization action feedback cannot follow its current observation');
    }
    const target = civilizationMaterialTargetFromAction(event.goal, event.intent);
    if (target === null) continue;
    failedMaterialTargets = failedMaterialTargets.filter((entry) => (
      !sameCivilizationMaterialTarget(entry.target, target)
    ));
    if (event.outcome.kind === 'failed') {
      const retryAt = tick(event.completedAt + MATERIAL_TARGET_RETRY_TICKS);
      if (retryAt > currentTick) {
        failedMaterialTargets.push(Object.freeze({ target, retryAt }));
        if (failedMaterialTargets.length > MAX_FAILED_MATERIAL_TARGETS) failedMaterialTargets.shift();
      }
    }
  }
  failedMaterialTargets = failedMaterialTargets.filter((entry) => (
    entry.retryAt > currentTick
      && entry.retryAt - currentTick <= MATERIAL_TARGET_RETRY_TICKS
      && !civilizationMaterialTargetChanged(observation, entry.target)
  ));
  return civilizationPolicyMemory({ policy: memory.policy, failedMaterialTargets });
}

function civilizationMaterialTargetFromAction(
  goal: CivilizationGoal,
  _intent: CivilizationActionIntent,
): CivilizationMaterialTarget | null {
  switch (goal.kind) {
    case 'gatherMaterial':
      return Object.freeze({ kind: 'gather', item: goal.item, target: goal.target });
    case 'craftMaterial':
      return Object.freeze({ kind: 'craft', item: goal.item });
    case 'transferMaterial':
      return Object.freeze({
        kind: 'transfer', item: goal.item, direction: goal.direction, container: goal.container,
      });
    case 'buildOutpost':
      return Object.freeze({
        kind: 'build', blueprintId: goal.blueprintId, cellIndex: goal.cellIndex, target: goal.target,
      });
    case 'captureZone':
    case 'holdCaptureZone':
    case 'outpostComplete':
    case 'wait':
      return null;
  }
}

// Local resource lists omit distant or occluded targets, and team reports are consumed after each observation.
// Only affirmative inventory or blueprint evidence can invalidate a failed remote material target.
function civilizationMaterialTargetChanged(
  observation: CivilizationObservation,
  target: CivilizationMaterialTarget,
): boolean {
  switch (target.kind) {
    case 'gather': {
      if (observation.ownMaterials.kind === 'current') {
        const logs = totalMaterial(observation.ownMaterials.value, 'oak_log');
        const planks = totalMaterial(observation.ownMaterials.value, 'oak_planks');
        if (target.item === 'oak_planks' && planks >= OUTPOST_PLANKS_REQUIRED) return true;
        if (target.item === 'oak_log') {
          const requiredLogs = Math.ceil((OUTPOST_PLANKS_REQUIRED - planks) / OAK_PLANKS_PER_LOG);
          if (planks >= OUTPOST_PLANKS_REQUIRED || logs >= requiredLogs) return true;
        }
      }
      return false;
    }
    case 'transfer': {
      if (observation.ownMaterials.kind === 'current') {
        const ownCount = totalMaterial(observation.ownMaterials.value, target.item);
        if (target.direction === 'deposit' && ownCount === 0) return true;
        if (target.direction === 'withdraw' && ownCount > 0) return true;
      }
      return false;
    }
    case 'build': {
      if (observation.observedResources.kind !== 'current') return false;
      const cell = observation.observedResources.value.find((resource) => (
        resource.kind === 'outpostCell' && compareBlockPositions(resource.position, target.target) === 0
      ));
      return cell?.kind === 'outpostCell' && (cell.state !== 'air' || cell.support !== 'solid');
    }
    case 'craft': {
      if (observation.ownMaterials.kind !== 'current') return false;
      const logs = totalMaterial(observation.ownMaterials.value, 'oak_log');
      const planks = totalMaterial(observation.ownMaterials.value, 'oak_planks');
      return planks >= OUTPOST_PLANKS_REQUIRED || logs < Math.ceil((OUTPOST_PLANKS_REQUIRED - planks) / OAK_PLANKS_PER_LOG);
    }
  }
}

function decideGatherer(
  observation: CivilizationObservation,
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  position: BlockPosition,
): CivilizationDecision {
  if (observation.ownMaterials.kind !== 'current') {
    return civHold(baseline, memory, 'materialsUnknown');
  }
  const logs = totalMaterial(observation.ownMaterials.value, 'oak_log');
  const planks = totalMaterial(observation.ownMaterials.value, 'oak_planks');
  if (planks < OUTPOST_PLANKS_REQUIRED) {
    const resultCount = Math.ceil((OUTPOST_PLANKS_REQUIRED - planks) / OAK_PLANKS_PER_LOG) * OAK_PLANKS_PER_LOG;
    const logsRequired = resultCount / OAK_PLANKS_PER_LOG;
    const localPlanks = selectLocalMaterial(observation.observedResources, 'oak_planks', position, memory);
    if (localPlanks !== null) {
      return collectMaterial(baseline, memory, localPlanks, position, 'oak_planks');
    }
    if (hasCoolingDownLocalMaterial(observation.observedResources, 'oak_planks', memory)) {
      return civHold(baseline, memory, 'materialTargetCoolingDown');
    }
    const reportedPlanks = selectReportedResource(observation.teamMessages, ['oakPlankDrop'], position, memory, {
      kind: 'gather', item: 'oak_planks',
    });
    if (reportedPlanks !== null) {
      const goal: CivilizationGoal = {
        kind: 'gatherMaterial', item: 'oak_planks', target: reportedPlanks.position,
      };
      return civDecision(baseline, memory, goal, { kind: 'navigate', target: reportedPlanks.position });
    }
    if (hasCoolingDownReportedMaterial(observation.teamMessages, ['oakPlankDrop'], memory, 'oak_planks')) {
      return civHold(baseline, memory, 'materialTargetCoolingDown');
    }
    if (logs >= logsRequired) {
      const goal: CivilizationGoal = { kind: 'craftMaterial', item: 'oak_planks', resultCount };
      if (isCivilizationMaterialTargetCoolingDown(memory, { kind: 'craft', item: 'oak_planks' })) {
        return civHold(baseline, memory, 'materialTargetCoolingDown', goal);
      }
      return civDecision(baseline, memory, goal, {
        kind: 'craft', output: 'oak_planks', resultCount, table: null,
      });
    }

    const local = selectLocalMaterial(observation.observedResources, 'oak_log', position, memory);
    if (local !== null) {
      return collectMaterial(baseline, memory, local, position, 'oak_log');
    }
    if (hasCoolingDownLocalMaterial(observation.observedResources, 'oak_log', memory)) {
      return civHold(baseline, memory, 'materialTargetCoolingDown');
    }

    const reported = selectReportedResource(observation.teamMessages, ['oakLogBlock', 'oakLogDrop'], position, memory, {
      kind: 'gather', item: 'oak_log',
    });
    if (reported !== null) {
      const goal: CivilizationGoal = { kind: 'gatherMaterial', item: 'oak_log', target: reported.position };
      return civDecision(baseline, memory, goal, { kind: 'navigate', target: reported.position });
    }
    if (hasCoolingDownReportedMaterial(observation.teamMessages, ['oakLogBlock', 'oakLogDrop'], memory, 'oak_log')) {
      return civHold(baseline, memory, 'materialTargetCoolingDown');
    }
    if (observation.observedResources.kind !== 'current') {
      return civHold(baseline, memory, 'resourcesUnknown');
    }
    return civilizationDecision(baseline.goal, baseline.intent, memory);
  }

  return transferFromContainer(observation, baseline, memory, position, 'deposit', 'oak_planks', OUTPOST_PLANKS_REQUIRED)
    ?? civilizationDecision(baseline.goal, baseline.intent, memory);
}

function decideBuilder(
  context: CivilizationPolicyContext,
  observation: CivilizationObservation,
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  position: BlockPosition,
): CivilizationDecision {
  if (observation.ownMaterials.kind !== 'current') {
    return civHold(baseline, memory, 'materialsUnknown');
  }
  const planks = totalMaterial(observation.ownMaterials.value, 'oak_planks');
  const cells = civilizationOutpostCells(context.objective.outpost.anchor, context.objective.outpost.rotationDegrees);

  for (const cell of cells) {
    const observed = findOutpostCell(observation.observedResources, cell.position);
    const goal: CivilizationGoal = {
      kind: 'buildOutpost',
      blueprintId: OUTPOST_BLUEPRINT_ID,
      cellIndex: cell.index,
      target: cell.position,
    };
    if (observed === null) {
      return civDecision(baseline, memory, goal, { kind: 'navigate', target: cell.position });
    }
    if (observed.state === 'unloaded' || observed.support === 'unknown') {
      return civDecision(baseline, memory, goal, { kind: 'navigate', target: cell.position });
    }
    if (observed.state === 'oak_planks') {
      continue;
    }
    if (observed.state !== 'air' || observed.support !== 'solid') {
      return civHold(baseline, memory, 'blueprintObstructed', goal);
    }
    if (isCivilizationMaterialTargetCoolingDown(memory, {
      kind: 'build', blueprintId: OUTPOST_BLUEPRINT_ID, cellIndex: cell.index, target: cell.position,
    })) {
      return civHold(baseline, memory, 'materialTargetCoolingDown', goal);
    }
    if (planks < 1) {
      const transfer = transferFromContainer(
        observation, baseline, memory, position, 'withdraw', 'oak_planks', OUTPOST_PLANKS_REQUIRED,
      );
      if (transfer !== null) {
        return transfer;
      }
      const reported = selectReportedResource(observation.teamMessages, ['container'], position, memory, {
        kind: 'transfer', item: 'oak_planks', direction: 'withdraw',
      });
      if (reported !== null) {
        const storageGoal: CivilizationGoal = {
          kind: 'transferMaterial', item: 'oak_planks', count: 1,
          direction: 'withdraw', container: reported.position,
        };
        return civDecision(baseline, memory, storageGoal, { kind: 'navigate', target: reported.position });
      }
      if (hasCoolingDownReportedTransfer(observation.teamMessages, memory, 'oak_planks', 'withdraw')) {
        return civHold(baseline, memory, 'materialTargetCoolingDown', goal);
      }
      return civHold(baseline, memory, 'materialsUnavailable', goal);
    }
    if (squaredDistance(position, cell.position) > BLOCK_INTERACTION_DISTANCE_SQUARED) {
      return civDecision(baseline, memory, goal, { kind: 'navigate', target: cell.position });
    }
    return civDecision(baseline, memory, goal, {
      kind: 'placeBlock',
      target: cell.position,
      referencePosition: cell.supportPosition,
      face: 'up',
      item: 'oak_planks',
    });
  }

  return civDecision(baseline, memory, { kind: 'outpostComplete' }, { kind: 'hold', reason: 'blueprintComplete' });
}

function decideDefender(
  context: CivilizationPolicyContext,
  observation: CivilizationObservation,
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  position: BlockPosition,
): CivilizationDecision {
  const captureBox = context.objective.captureBox;
  if (isInsideCaptureBox(position, captureBox)) {
    return civDecision(baseline, memory, { kind: 'holdCaptureZone' }, { kind: 'hold', reason: 'captureZoneOccupied' });
  }
  const target = boxCenter(captureBox);
  return civDecision(baseline, memory, { kind: 'captureZone', target }, { kind: 'navigate', target });
}

function transferFromContainer(
  observation: CivilizationObservation,
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  position: BlockPosition,
  direction: 'deposit' | 'withdraw',
  item: MaterialItem,
  desiredCount: number,
): CivilizationDecision | null {
  if (observation.observedResources.kind !== 'current') {
    return null;
  }
  const containers = observation.observedResources.value
    .filter((resource): resource is Extract<CivilizationResourceObservation, { kind: 'container' }> => resource.kind === 'container')
    .sort((first, second) => {
      const firstDistance = squaredDistance(position, first.position);
      const secondDistance = squaredDistance(position, second.position);
      if (firstDistance !== secondDistance) return firstDistance < secondDistance ? -1 : 1;
      return compareBlockPositions(first.position, second.position);
    });
  for (const container of containers) {
    const materialTarget: CivilizationMaterialTarget = { kind: 'transfer', item, direction, container: container.position };
    if (isCivilizationMaterialTargetCoolingDown(memory, materialTarget)) {
      continue;
    }
    const goalBase = { item, direction, container: container.position } as const;
    if (squaredDistance(position, container.position) > CONTAINER_INTERACTION_DISTANCE_BLOCKS ** 2n) {
      const goal: CivilizationGoal = { kind: 'transferMaterial', ...goalBase, count: desiredCount };
      return civDecision(baseline, memory, goal, { kind: 'navigate', target: container.position });
    }
    if (container.contents.kind !== 'current') {
      const goal: CivilizationGoal = { kind: 'transferMaterial', ...goalBase, count: desiredCount };
      return civDecision(baseline, memory, goal, { kind: 'containerOpen', position: container.position });
    }
    const available = direction === 'deposit'
      ? observation.ownMaterials.kind === 'current'
        ? totalMaterial(observation.ownMaterials.value, item)
        : 0
      : totalMaterial(container.contents.value, item);
    const count = Math.min(available, desiredCount);
    if (count <= 0) {
      continue;
    }
    const goal: CivilizationGoal = { kind: 'transferMaterial', ...goalBase, count };
    return civDecision(baseline, memory, goal, {
      kind: 'containerTransfer', position: container.position, direction, item, count,
    });
  }
  if (containers.some((container) => isCivilizationMaterialTargetCoolingDown(memory, {
    kind: 'transfer', item, direction, container: container.position,
  }))) {
    return civHold(baseline, memory, 'materialTargetCoolingDown');
  }
  return null;
}

function selectLocalMaterial(
  resources: Knowledge<readonly CivilizationResourceObservation[]>,
  item: MaterialItem,
  position: BlockPosition,
  memory: CivilizationPolicyMemory,
): Extract<CivilizationResourceObservation, { kind: 'logBlock' | 'materialDrop' }> | null {
  if (resources.kind !== 'current') {
    return null;
  }
  const candidates = resources.value.filter((resource): resource is Extract<
    CivilizationResourceObservation,
    { kind: 'logBlock' | 'materialDrop' }
  > => (item === 'oak_log' && resource.kind === 'logBlock')
    || (resource.kind === 'materialDrop' && resource.item === item));
  candidates.sort((first, second) => {
    const firstDistance = squaredDistance(position, first.position);
    const secondDistance = squaredDistance(position, second.position);
    if (firstDistance !== secondDistance) return firstDistance < secondDistance ? -1 : 1;
    if (first.kind !== second.kind) return first.kind === 'logBlock' ? -1 : 1;
    if (first.kind === 'materialDrop' && second.kind === 'materialDrop') return first.entityId - second.entityId;
    return compareBlockPositions(first.position, second.position);
  });
  return candidates.find((candidate) => !isCivilizationMaterialTargetCoolingDown(memory, {
    kind: 'gather', item, target: candidate.position,
  })) ?? null;
}

function hasCoolingDownLocalMaterial(
  resources: Knowledge<readonly CivilizationResourceObservation[]>,
  item: MaterialItem,
  memory: CivilizationPolicyMemory,
): boolean {
  return resources.kind === 'current' && resources.value.some((resource) => (
    ((item === 'oak_log' && resource.kind === 'logBlock')
      || (resource.kind === 'materialDrop' && resource.item === item))
      && isCivilizationMaterialTargetCoolingDown(memory, { kind: 'gather', item, target: resource.position })
  ));
}

function collectMaterial(
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  resource: Extract<CivilizationResourceObservation, { kind: 'logBlock' | 'materialDrop' }>,
  position: BlockPosition,
  item: MaterialItem,
): CivilizationDecision {
  const goal: CivilizationGoal = { kind: 'gatherMaterial', item, target: resource.position };
  if (resource.kind === 'materialDrop') {
    const intent: Intent = squaredDistance(position, resource.position) <= CONTAINER_INTERACTION_DISTANCE_BLOCKS ** 2n
      ? { kind: 'dropCollect', entityId: resource.entityId }
      : { kind: 'navigate', target: resource.position };
    return civDecision(baseline, memory, goal, intent);
  }
  if (squaredDistance(position, resource.position) <= BLOCK_INTERACTION_DISTANCE_SQUARED) {
    return civDecision(baseline, memory, goal, {
      kind: 'mineBlock', position: resource.position, expectedBlock: 'oak_log',
    });
  }
  return civDecision(baseline, memory, goal, { kind: 'navigate', target: resource.position });
}

function selectReportedResource(
  messages: readonly CivilizationTeamMessage[],
  resources: readonly ReportedResource[],
  position: BlockPosition,
  memory: CivilizationPolicyMemory,
  target: CivilizationMaterialTargetTemplate,
): ResourceHint | null {
  const candidates = messages.flatMap((message, receiveOrder): ResourceHint[] => (
    message.kind === 'resourceSighting' && resources.includes(message.resource)
      ? [{
        position: message.position,
        resource: message.resource,
        declaredStale: message.declaredStale,
        sourceTick: message.sourceTick,
        receiveOrder,
      }]
      : []
  ));
  candidates.sort((first, second) => {
    if (first.declaredStale !== second.declaredStale) return first.declaredStale ? 1 : -1;
    if (first.sourceTick !== second.sourceTick) return first.sourceTick > second.sourceTick ? -1 : 1;
    const firstDistance = squaredDistance(position, first.position);
    const secondDistance = squaredDistance(position, second.position);
    if (firstDistance !== secondDistance) return firstDistance < secondDistance ? -1 : 1;
    return first.receiveOrder - second.receiveOrder;
  });
  return candidates.find((candidate) => !isCivilizationMaterialTargetCoolingDown(memory, target.kind === 'gather'
    ? { kind: 'gather', item: target.item, target: candidate.position }
    : { kind: 'transfer', item: target.item, direction: target.direction, container: candidate.position })) ?? null;
}

function hasCoolingDownReportedMaterial(
  messages: readonly CivilizationTeamMessage[],
  resources: readonly ReportedResource[],
  memory: CivilizationPolicyMemory,
  item: MaterialItem,
): boolean {
  return messages.some((message) => message.kind === 'resourceSighting'
    && resources.includes(message.resource)
    && isCivilizationMaterialTargetCoolingDown(memory, { kind: 'gather', item, target: message.position }));
}

function hasCoolingDownReportedTransfer(
  messages: readonly CivilizationTeamMessage[],
  memory: CivilizationPolicyMemory,
  item: MaterialItem,
  direction: 'deposit' | 'withdraw',
): boolean {
  return messages.some((message) => message.kind === 'resourceSighting'
    && message.resource === 'container'
    && isCivilizationMaterialTargetCoolingDown(memory, {
      kind: 'transfer', item, direction, container: message.position,
    }));
}

function findOutpostCell(
  resources: Knowledge<readonly CivilizationResourceObservation[]>,
  position: BlockPosition,
): OutpostCellObservation | null {
  if (resources.kind !== 'current') {
    return null;
  }
  const resource = resources.value.find((candidate) => (
    candidate.kind === 'outpostCell' && compareBlockPositions(candidate.position, position) === 0
  ));
  return resource?.kind === 'outpostCell' ? resource : null;
}

function totalMaterial(stacks: readonly { readonly item: MaterialItem; readonly count: number }[], item: MaterialItem): number {
  return stacks.reduce((total, stack) => total + (stack.item === item ? stack.count : 0), 0);
}

function civDecision(
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  goal: Goal | CivilizationGoal,
  intent: Intent | CivIntent,
): CivilizationDecision {
  return Object.freeze({
    goal: Object.freeze(goal),
    intent: Object.freeze(intent),
    memory: civilizationPolicyMemory({ ...memory, policy: baseline.memory }),
  });
}

function civHold(
  baseline: Decision,
  memory: CivilizationPolicyMemory,
  reason: CivilizationHoldReason,
  goal: Goal | CivilizationGoal = { kind: 'wait', reason },
): CivilizationDecision {
  return civDecision(baseline, memory, goal, { kind: 'hold', reason });
}

function civilizationDecision(
  goal: Goal | CivilizationGoal,
  intent: Intent | CivIntent,
  memory: CivilizationPolicyMemory,
): CivilizationDecision {
  return Object.freeze({ goal, intent, memory });
}

function isInsideCaptureBox(position: BlockPosition, box: CaptureBox): boolean {
  return position.x >= box.min.x && position.x <= box.max.x
    && position.y >= box.min.y && position.y <= box.max.y
    && position.z >= box.min.z && position.z <= box.max.z;
}

function boxCenter(box: CaptureBox): BlockPosition {
  const center = (minimum: number, maximum: number): number => Number(
    BigInt(minimum) + (BigInt(maximum) - BigInt(minimum)) / 2n,
  );
  return blockPosition(center(box.min.x, box.max.x), center(box.min.y, box.max.y), center(box.min.z, box.max.z));
}

function cloneObjective(value: CivilizationObjective): CivilizationObjective {
  assertExactKeys(value, ['captureBox', 'outpost'], 'civilization objective');
  assertExactKeys(value.captureBox, ['min', 'max'], 'capture box');
  const min = clonePosition(value.captureBox.min);
  const max = clonePosition(value.captureBox.max);
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new RangeError('capture box minimum must not exceed its maximum');
  }
  assertExactKeys(value.outpost, ['blueprintId', 'anchor', 'rotationDegrees'], 'outpost objective');
  if (value.outpost.blueprintId !== OUTPOST_BLUEPRINT_ID) {
    throw new TypeError(`unknown outpost blueprint: ${String(value.outpost.blueprintId)}`);
  }
  assertRotation(value.outpost.rotationDegrees);
  const anchor = clonePosition(value.outpost.anchor);
  civilizationOutpostCells(anchor, value.outpost.rotationDegrees);
  return Object.freeze({
    captureBox: Object.freeze({ min, max }),
    outpost: Object.freeze({
      blueprintId: OUTPOST_BLUEPRINT_ID,
      anchor,
      rotationDegrees: value.outpost.rotationDegrees,
    }),
  });
}

function cloneKnowledge<T>(
  knowledge: Knowledge<T>,
  cloneValue: (value: T) => T,
  currentTick: Tick,
  label: string,
): Knowledge<T> {
  if (knowledge.kind === 'unknown') {
    assertExactKeys(knowledge, ['kind'], `${label} knowledge`);
    return unknownKnowledge();
  }
  if (knowledge.kind === 'current') {
    assertExactKeys(knowledge, ['kind', 'value'], `${label} knowledge`);
    return currentKnowledge(cloneValue(knowledge.value));
  }
  if (knowledge.kind === 'stale') {
    assertExactKeys(knowledge, ['kind', 'value', 'observedAt'], `${label} knowledge`);
    const observedAt = tick(knowledge.observedAt);
    if (observedAt >= currentTick) {
      throw new RangeError(`${label} stale sample must be older than its observation tick`);
    }
    return Object.freeze({ kind: 'stale', value: cloneValue(knowledge.value), observedAt });
  }
  throw new TypeError(`${label} knowledge has an unknown state`);
}

function cloneMaterialStacks(values: readonly MaterialStack[]): readonly MaterialStack[] {
  if (!Array.isArray(values)) {
    throw new TypeError('own material stacks must be an array');
  }
  const slots = new Set<number>();
  const result = values.map((value) => {
    assertExactKeys(value, ['inventorySlot', 'item', 'count'], 'material stack');
    const stack = materialStack(value.inventorySlot, value.item, value.count);
    if (slots.has(stack.inventorySlot)) {
      throw new RangeError(`inventory slot ${stack.inventorySlot} appears more than once in material stacks`);
    }
    slots.add(stack.inventorySlot);
    return stack;
  });
  return Object.freeze(result);
}

function cloneStoredMaterialStacks(values: readonly StoredMaterialStack[]): readonly StoredMaterialStack[] {
  if (!Array.isArray(values)) {
    throw new TypeError('container material stacks must be an array');
  }
  const slots = new Set<number>();
  const result = values.map((value) => {
    assertExactKeys(value, ['slot', 'item', 'count'], 'stored material stack');
    const stack = storedMaterialStack(value.slot, value.item, value.count);
    if (slots.has(stack.slot)) {
      throw new RangeError(`container slot ${stack.slot} appears more than once`);
    }
    slots.add(stack.slot);
    return stack;
  });
  return Object.freeze(result);
}

function cloneResources(
  values: readonly CivilizationResourceObservation[],
  currentTick: Tick,
): readonly CivilizationResourceObservation[] {
  if (!Array.isArray(values)) {
    throw new TypeError('observed resources must be an array');
  }
  const positionsByKind = new Map<string, Set<string>>();
  const dropIds = new Set<number>();
  const result = values.map((value): CivilizationResourceObservation => {
    let resource: CivilizationResourceObservation;
    switch (value.kind) {
      case 'logBlock':
        assertExactKeys(value, ['kind', 'position'], 'observed log block');
        resource = Object.freeze({ kind: 'logBlock', position: clonePosition(value.position) });
        break;
      case 'materialDrop':
        assertExactKeys(value, ['kind', 'entityId', 'position', 'item'], 'observed material drop');
        assertMaterialItem(value.item);
        resource = Object.freeze({
          kind: 'materialDrop',
          entityId: entityId(value.entityId),
          position: clonePosition(value.position),
          item: value.item,
        });
        if (dropIds.has(resource.entityId)) {
          throw new RangeError(`material drop entity ${resource.entityId} appears more than once`);
        }
        dropIds.add(resource.entityId);
        break;
      case 'container':
        assertExactKeys(value, ['kind', 'position', 'contents'], 'observed container');
        resource = Object.freeze({
          kind: 'container',
          position: clonePosition(value.position),
          contents: cloneKnowledge(value.contents, cloneStoredMaterialStacks, currentTick, 'container contents'),
        });
        break;
      case 'outpostCell':
        assertExactKeys(value, ['kind', 'position', 'state', 'support'], 'observed outpost cell');
        resource = outpostCell(value.position, value.state, value.support);
        break;
      default:
        throw new TypeError(`unknown civilization resource kind: ${String((value as { kind?: unknown }).kind)}`);
    }
    const key = positionKey(resource.position);
    const positions = positionsByKind.get(resource.kind) ?? new Set<string>();
    if (resource.kind !== 'materialDrop' && positions.has(key)) {
      throw new RangeError(`duplicate ${resource.kind} observation at ${key}`);
    }
    if (resource.kind !== 'materialDrop') {
      positions.add(key);
    }
    positionsByKind.set(resource.kind, positions);
    return resource;
  });
  return Object.freeze(result);
}

function clonePosition(value: BlockPosition): BlockPosition {
  assertExactKeys(value, ['x', 'y', 'z'], 'block position');
  return blockPosition(value.x, value.y, value.z);
}

function makeCell(
  index: number,
  position: BlockPosition,
  layer: 'floor' | 'pillar',
  supportPosition = checkedOffset(position, 0, -1, 0),
): OutpostCell {
  return Object.freeze({ index, position, supportPosition, layer });
}

function checkedOffset(position: BlockPosition, dx: number, dy: number, dz: number): BlockPosition {
  const offset = offsetBlockPosition(position, dx, dy, dz);
  if (offset.ok === false) {
    throw new RangeError('outpost cell coordinate exceeds the safe integer range');
  }
  return offset.value;
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function assertMaterialItem(value: string): asserts value is MaterialItem {
  if (value !== 'oak_log' && value !== 'oak_planks') {
    throw new TypeError(`unknown civilization material: ${value}`);
  }
}

function assertStackCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 64) {
    throw new RangeError(`${label} must be between 1 and 64, received ${value}`);
  }
}

function assertCellState(value: string): asserts value is OutpostCellState {
  if (value !== 'unloaded' && value !== 'air' && value !== 'oak_planks' && value !== 'other') {
    throw new TypeError(`unknown outpost cell state: ${value}`);
  }
}

function assertSupportState(value: string): asserts value is OutpostSupportState {
  if (value !== 'unknown' && value !== 'solid' && value !== 'notSolid') {
    throw new TypeError(`unknown outpost support state: ${value}`);
  }
}

function assertReportedResource(value: string): asserts value is ReportedResource {
  if (value !== 'oakLogBlock' && value !== 'oakLogDrop' && value !== 'oakPlankDrop' && value !== 'container') {
    throw new TypeError(`unknown civilization reported resource: ${value}`);
  }
}

function assertRotation(value: number): asserts value is OutpostRotationDegrees {
  if (value !== 0 && value !== 180) {
    throw new RangeError(`outpost rotation must be 0 or 180 degrees, received ${value}`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length
      || actual.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

function assertDenseArray(value: readonly unknown[], label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${label} must not contain array holes`);
    }
  }
}
