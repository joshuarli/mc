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
  type Decision,
  type Goal,
  type Intent,
  type PolicyMemory,
  type PolicyFeedbackBatch,
  type PolicyParams,
} from './policy.js';
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
  | 'captureZoneOccupied';

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

export interface CivilizationDecision {
  readonly goal: Goal | CivilizationGoal;
  readonly intent: Intent | CivIntent;
  readonly memory: PolicyMemory;
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
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): CivilizationDecision {
  assertValidatedCivilizationContext(context);
  assertValidatedCivilizationObservation(observation);

  const baseline = decide(observation.base, memory, params, random, feedback);
  if (isSharedPriorityGoal(baseline.goal)) {
    return baseline;
  }
  const agent = observation.base.agent.kind === 'current' ? observation.base.agent.value : null;
  if (agent === null) {
    return baseline;
  }

  switch (context.role) {
    case 'gatherer_crafter':
      return decideGatherer(observation, baseline, agent.position);
    case 'builder':
      return decideBuilder(context, observation, baseline, agent.position);
    case 'defender_scout':
      return decideDefender(context, observation, baseline, agent.position);
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

function decideGatherer(
  observation: CivilizationObservation,
  baseline: Decision,
  position: BlockPosition,
): CivilizationDecision {
  if (observation.ownMaterials.kind !== 'current') {
    return civHold(baseline, 'materialsUnknown');
  }
  const logs = totalMaterial(observation.ownMaterials.value, 'oak_log');
  const planks = totalMaterial(observation.ownMaterials.value, 'oak_planks');
  if (planks < OUTPOST_PLANKS_REQUIRED) {
    const resultCount = Math.ceil((OUTPOST_PLANKS_REQUIRED - planks) / OAK_PLANKS_PER_LOG) * OAK_PLANKS_PER_LOG;
    const logsRequired = resultCount / OAK_PLANKS_PER_LOG;
    const localPlanks = selectLocalMaterial(observation.observedResources, 'oak_planks', position);
    if (localPlanks !== null) {
      return collectMaterial(baseline, localPlanks, position, 'oak_planks');
    }
    const reportedPlanks = selectReportedResource(observation.teamMessages, ['oakPlankDrop'], position);
    if (reportedPlanks !== null) {
      const goal: CivilizationGoal = {
        kind: 'gatherMaterial', item: 'oak_planks', target: reportedPlanks.position,
      };
      return civDecision(baseline, goal, { kind: 'navigate', target: reportedPlanks.position });
    }
    if (logs >= logsRequired) {
      const goal: CivilizationGoal = { kind: 'craftMaterial', item: 'oak_planks', resultCount };
      return civDecision(baseline, goal, {
        kind: 'craft', output: 'oak_planks', resultCount, table: null,
      });
    }

    const local = selectLocalMaterial(observation.observedResources, 'oak_log', position);
    if (local !== null) {
      return collectMaterial(baseline, local, position, 'oak_log');
    }

    const reported = selectReportedResource(observation.teamMessages, ['oakLogBlock', 'oakLogDrop'], position);
    if (reported !== null) {
      const goal: CivilizationGoal = { kind: 'gatherMaterial', item: 'oak_log', target: reported.position };
      return civDecision(baseline, goal, { kind: 'navigate', target: reported.position });
    }
    if (observation.observedResources.kind !== 'current') {
      return civHold(baseline, 'resourcesUnknown');
    }
    return baseline;
  }

  return transferFromContainer(observation, baseline, position, 'deposit', 'oak_planks', OUTPOST_PLANKS_REQUIRED)
    ?? baseline;
}

function decideBuilder(
  context: CivilizationPolicyContext,
  observation: CivilizationObservation,
  baseline: Decision,
  position: BlockPosition,
): CivilizationDecision {
  if (observation.ownMaterials.kind !== 'current') {
    return civHold(baseline, 'materialsUnknown');
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
      return civDecision(baseline, goal, { kind: 'navigate', target: cell.position });
    }
    if (observed.state === 'unloaded' || observed.support === 'unknown') {
      return civDecision(baseline, goal, { kind: 'navigate', target: cell.position });
    }
    if (observed.state === 'oak_planks') {
      continue;
    }
    if (observed.state !== 'air' || observed.support !== 'solid') {
      return civHold(baseline, 'blueprintObstructed', goal);
    }
    if (planks < 1) {
      const transfer = transferFromContainer(
        observation, baseline, position, 'withdraw', 'oak_planks', OUTPOST_PLANKS_REQUIRED,
      );
      if (transfer !== null) {
        return transfer;
      }
      const reported = selectReportedResource(observation.teamMessages, ['container'], position);
      if (reported !== null) {
        const storageGoal: CivilizationGoal = {
          kind: 'transferMaterial', item: 'oak_planks', count: 1,
          direction: 'withdraw', container: reported.position,
        };
        return civDecision(baseline, storageGoal, { kind: 'navigate', target: reported.position });
      }
      return civHold(baseline, 'materialsUnavailable', goal);
    }
    if (squaredDistance(position, cell.position) > BLOCK_INTERACTION_DISTANCE_SQUARED) {
      return civDecision(baseline, goal, { kind: 'navigate', target: cell.position });
    }
    return civDecision(baseline, goal, {
      kind: 'placeBlock',
      target: cell.position,
      referencePosition: cell.supportPosition,
      face: 'up',
      item: 'oak_planks',
    });
  }

  return civDecision(baseline, { kind: 'outpostComplete' }, { kind: 'hold', reason: 'blueprintComplete' });
}

function decideDefender(
  context: CivilizationPolicyContext,
  observation: CivilizationObservation,
  baseline: Decision,
  position: BlockPosition,
): CivilizationDecision {
  const captureBox = context.objective.captureBox;
  if (isInsideCaptureBox(position, captureBox)) {
    return civDecision(baseline, { kind: 'holdCaptureZone' }, { kind: 'hold', reason: 'captureZoneOccupied' });
  }
  const target = boxCenter(captureBox);
  return civDecision(baseline, { kind: 'captureZone', target }, { kind: 'navigate', target });
}

function transferFromContainer(
  observation: CivilizationObservation,
  baseline: Decision,
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
    const goalBase = { item, direction, container: container.position } as const;
    if (squaredDistance(position, container.position) > CONTAINER_INTERACTION_DISTANCE_BLOCKS ** 2n) {
      const goal: CivilizationGoal = { kind: 'transferMaterial', ...goalBase, count: desiredCount };
      return civDecision(baseline, goal, { kind: 'navigate', target: container.position });
    }
    if (container.contents.kind !== 'current') {
      const goal: CivilizationGoal = { kind: 'transferMaterial', ...goalBase, count: desiredCount };
      return civDecision(baseline, goal, { kind: 'containerOpen', position: container.position });
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
    return civDecision(baseline, goal, {
      kind: 'containerTransfer', position: container.position, direction, item, count,
    });
  }
  return null;
}

function selectLocalMaterial(
  resources: Knowledge<readonly CivilizationResourceObservation[]>,
  item: MaterialItem,
  position: BlockPosition,
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
  return candidates[0] ?? null;
}

function collectMaterial(
  baseline: Decision,
  resource: Extract<CivilizationResourceObservation, { kind: 'logBlock' | 'materialDrop' }>,
  position: BlockPosition,
  item: MaterialItem,
): CivilizationDecision {
  const goal: CivilizationGoal = { kind: 'gatherMaterial', item, target: resource.position };
  if (resource.kind === 'materialDrop') {
    const intent: Intent = squaredDistance(position, resource.position) <= CONTAINER_INTERACTION_DISTANCE_BLOCKS ** 2n
      ? { kind: 'dropCollect', entityId: resource.entityId }
      : { kind: 'navigate', target: resource.position };
    return civDecision(baseline, goal, intent);
  }
  if (squaredDistance(position, resource.position) <= BLOCK_INTERACTION_DISTANCE_SQUARED) {
    return civDecision(baseline, goal, {
      kind: 'mineBlock', position: resource.position, expectedBlock: 'oak_log',
    });
  }
  return civDecision(baseline, goal, { kind: 'navigate', target: resource.position });
}

function selectReportedResource(
  messages: readonly CivilizationTeamMessage[],
  resources: readonly ReportedResource[],
  position: BlockPosition,
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
  return candidates[0] ?? null;
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
  goal: Goal | CivilizationGoal,
  intent: Intent | CivIntent,
): CivilizationDecision {
  return Object.freeze({ goal: Object.freeze(goal), intent: Object.freeze(intent), memory: baseline.memory });
}

function civHold(
  baseline: Decision,
  reason: CivilizationHoldReason,
  goal: Goal | CivilizationGoal = { kind: 'wait', reason },
): CivilizationDecision {
  return civDecision(baseline, goal, { kind: 'hold', reason });
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}
