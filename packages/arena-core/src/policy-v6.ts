import { MELEE_REACH_BLOCKS, isWithinMeleeReach } from './combat.js';
import {
  borderCenter,
  isNearOrOutsideBorder,
  isOutsideBorder,
  manhattanDistance,
  offsetBlockPosition,
  squaredDistance,
  type BlockPosition,
  type WorldBorder,
} from './geometry.js';
import {
  assertValidatedAgentObservation,
  entityId,
  lootTarget,
  type AgentObservation,
  type AgentState,
  type EntityId,
  type InventorySlot,
  type LootOpportunity,
  type LootTarget,
  type Tick,
  type VisibleOpponent,
} from './observation.js';
import {
  DECISION_EXPLANATION_VERSION,
  MAX_EXPLANATION_ALTERNATIVES,
  type AlternativeCondition,
  type AlternativeKind,
  type DecisionExplanation,
  type DecisionReason,
} from './policy-v5.js';
import {
  openingPolicyState,
  policyFeedbackBatch,
  policyMemory,
  type Decision,
  type FailedTargetEvidence,
  type Goal,
  type Intent,
  type OpeningDecision,
  type OpeningPolicyState,
  type OpeningStyle,
  type PolicyFeedbackBatch,
  type PolicyMemory,
  type PolicyParams,
  type RememberedOpponent,
  type WaitReason,
} from './policy.js';
import type { DeterministicRandom } from './random.js';

export const FRONTIER_GOALS = ['escapeBorder', 'heal', 'loot', 'engage', 'explore'] as const;
export type FrontierGoalName = typeof FRONTIER_GOALS[number];

export type FrontierMode =
  | { readonly kind: 'escaping' }
  | { readonly kind: 'healing'; readonly inventorySlot: InventorySlot }
  | { readonly kind: 'looting'; readonly target: LootTarget }
  | { readonly kind: 'engaging'; readonly target: EntityId; readonly side: 'press' | 'evade' }
  | { readonly kind: 'exploring'; readonly target: BlockPosition };

export interface FrontierCooldown {
  readonly goal: FrontierGoalName;
  readonly key: string;
  readonly untilTick: number;
}

export interface FrontierTask {
  readonly goal: FrontierGoalName;
  readonly mode: FrontierMode;
  readonly startedAtTick: number;
  readonly commitUntilTick: number;
  readonly attempt: number;
  readonly fingerprint: string;
  readonly cooldowns: readonly FrontierCooldown[];
}

export type FrontierRejection = 'outranked' | 'committed' | 'cooldown';

export interface FrontierProposal {
  readonly goal: FrontierGoalName;
  readonly utility: number;
  readonly rejection: FrontierRejection | null;
}

export interface FrontierExplanation {
  readonly proposals: readonly FrontierProposal[];
}

export type FrontierSkillOwner = 'navigation' | 'eat' | 'loot' | 'attack' | 'hold';

export interface FrontierCommand {
  readonly owner: FrontierSkillOwner;
  readonly intent: Intent;
}

export interface FrontierBelief {
  readonly tick: Tick;
  readonly agent: AgentState | null;
  readonly agentKnowledge: AgentObservation['agent']['kind'];
  readonly border: WorldBorder | null;
  readonly borderKnowledge: AgentObservation['border']['kind'];
  readonly opponents: readonly VisibleOpponent[];
  readonly opponentsKnowledge: AgentObservation['opponents']['kind'];
  readonly opponentsObservedAt: Tick | null;
  readonly staleOpponents: readonly VisibleOpponent[];
  readonly loot: readonly LootOpportunity[];
  readonly lootKnowledge: AgentObservation['loot']['kind'];
  readonly remembered: RememberedOpponent | null;
}

export interface AgentStep {
  readonly belief: FrontierBelief;
  readonly task: FrontierTask | null;
  readonly commands: readonly FrontierCommand[];
  readonly explanation: FrontierExplanation;
  readonly decision: Decision;
  readonly openingState: OpeningPolicyState;
  readonly restarted: boolean;
}

export interface AgentStepInput {
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly params: PolicyParams;
  readonly random: DeterministicRandom;
  readonly feedback?: PolicyFeedbackBatch;
  readonly task: FrontierTask | null;
  readonly style?: OpeningStyle;
  readonly openingState?: OpeningPolicyState;
}

const BORDER_SCORE = 1000;
const LETHAL_SCORE = 800;
const HEAL_SCORE = 500;
const LOOT_SCORE = 120;
const ENGAGE_SCORE = 100;
const EXPLORE_SCORE = 30;
const HUNTER_BIAS = 150;
const SCAVENGER_BIAS = 160;
const EXPLORER_BIAS = 40;
const EXPLORER_LOOT_PENALTY = 80;
const COMMIT_TICKS = 40;
const COOLDOWN_TICKS = 20;
const HUNT_BLOCKS = 12;
const THREAT_BLOCKS = 8;
const BOW_BLOCKS = 16;
const LOW_ARROWS = 16;
const LOOT_REACH_BLOCKS = 3n;
const EXPLORE_ARRIVAL_BLOCKS = 1n;
const AWAY_STEP_BLOCKS = 4;
const MAX_FAILED_TARGETS = 16;
const RING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

interface Planned {
  readonly goal: FrontierGoalName;
  readonly utility: number;
  readonly rejection: 'cooldown' | null;
  readonly mode: FrontierMode;
}

export function frontierBelief(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
): FrontierBelief {
  assertValidatedAgentObservation(observation);
  const values = params.values;
  const agent = observation.agent.kind === 'current' ? observation.agent.value : null;
  const border = observation.border.kind === 'current' ? observation.border.value : null;
  const opponents = observation.opponents.kind === 'current' ? observation.opponents.value : [];
  const staleOpponents = observation.opponents.kind === 'stale' ? observation.opponents.value : [];
  const loot = observation.loot.kind === 'current' ? observation.loot.value : [];
  const remembered = rememberedThreat(memory, observation.tick, values.opponentMemoryTicks);
  return Object.freeze({
    tick: observation.tick,
    agent,
    agentKnowledge: observation.agent.kind,
    border,
    borderKnowledge: observation.border.kind,
    opponents,
    opponentsKnowledge: observation.opponents.kind,
    opponentsObservedAt: observation.opponents.kind === 'stale' ? observation.opponents.observedAt : null,
    staleOpponents,
    loot,
    lootKnowledge: observation.loot.kind,
    remembered,
  });
}

export function stepAgent(input: AgentStepInput): AgentStep {
  if (typeof input.random?.nextU64 !== 'function') {
    throw new TypeError('frontier step requires a deterministic random');
  }
  const style = input.style;
  if (style !== undefined && style !== 'explorer' && style !== 'scavenger' && style !== 'hunter') {
    throw new TypeError(`unknown opening style: ${String(style)}`);
  }
  const params = input.params;
  if (params?.values === undefined) throw new TypeError('frontier step requires policy parameters');
  const observation = input.observation;
  const memory = input.memory;
  const feedback = policyFeedbackBatch(input.feedback ?? []);
  const belief = frontierBelief(observation, memory, params);
  const openingState = nextOpeningState(style, input.openingState, feedback);
  if (input.task !== null) assertTask(input.task);
  const settlement = settle(input.task, belief, params, feedback);
  const blocked = blockReason(belief);
  if (blocked !== null) {
    return finishStep(belief, settlement.task, false, [], blocked, memory, feedback, openingState);
  }
  const planned = planGoals(belief, memory, params, input.random, style, openingState, settlement.task, settlement.cooldowns);
  const materialSame = settlement.task !== null && settlement.task.fingerprint === fingerprint(belief);
  const chosen = choose(planned, settlement.task, belief.tick, materialSame);
  const task = chosen.mode === null
    ? null
    : nextTask(settlement.task, chosen.mode, belief, settlement.cooldowns);
  const restarted = task !== null && settlement.task !== null && modeKey(task.mode) !== modeKey(settlement.task.mode);
  const hold = task === null
    ? planned.some((proposal) => proposal.rejection === 'cooldown') ? 'failedTargetsExhausted' : 'noReachableFrontier'
    : null;
  return finishStep(belief, task, restarted, chosen.proposals, hold, memory, feedback, openingState);
}

export function frontierDecisionExplanation(step: AgentStep): DecisionExplanation {
  const selected = step.explanation.proposals.find((proposal) => proposal.rejection === null) ?? null;
  const alternatives = step.explanation.proposals.flatMap((proposal) => {
    const goal = alternativeKind(proposal.goal);
    if (goal === null) return [];
    const condition: AlternativeCondition = proposal.rejection === null
      ? 'chosen'
      : proposal.rejection === 'cooldown' ? 'targetFailedBefore' : 'outranked';
    return [Object.freeze({ goal, score: proposal.utility, condition })];
  });
  const agent = step.belief.agent;
  const border = step.belief.border;
  const center = agent === null || border === null ? null : borderCenter(border, agent.position.y);
  return Object.freeze({
    version: DECISION_EXPLANATION_VERSION,
    reason: decisionReason(step),
    delegatedGoal: step.decision.goal.kind,
    alternatives: Object.freeze(alternatives.slice(0, MAX_EXPLANATION_ALTERNATIVES)),
    nearestCacheBlocks: nearestBlocks(agent, step.belief.loot.filter((opportunity) => opportunity.kind === 'unopenedContainer').map((opportunity) => opportunity.position)),
    nearestOpponentBlocks: nearestBlocks(agent, step.belief.opponents.map((opponent) => opponent.position)),
    borderCenterBlocks: agent === null || center === null ? null : blocks(manhattanDistance(agent.position, center)),
    armed: agent === null ? null : agent.equipped.weapon !== null,
  });
}

function finishStep(
  belief: FrontierBelief,
  task: FrontierTask | null,
  restarted: boolean,
  proposals: readonly FrontierProposal[],
  hold: WaitReason | null,
  memory: PolicyMemory,
  feedback: PolicyFeedbackBatch,
  openingState: OpeningPolicyState,
): AgentStep {
  const command = hold === null && task !== null ? commandFor(task.mode, belief) : holdCommand(hold ?? 'noReachableFrontier');
  if (command.intent.kind === 'attack' || command.intent.kind === 'shoot') {
    const target = command.intent.target;
    if (belief.opponentsKnowledge !== 'current' || !belief.opponents.some((opponent) => opponent.id === target)) {
      throw new TypeError('frontier attack requires a current visible target');
    }
  }
  const commands = Object.freeze([command]);
  const decision = decisionFor(task, command.intent, memory, belief, feedback);
  const explanation = Object.freeze({ proposals: Object.freeze([...proposals]) });
  return Object.freeze({
    belief,
    task,
    commands,
    explanation,
    decision,
    openingState,
    restarted,
  });
}

function blockReason(belief: FrontierBelief): WaitReason | null {
  if (belief.agentKnowledge === 'unknown') return 'agentStateUnknown';
  if (belief.agentKnowledge === 'stale') return 'agentStateStale';
  if (belief.agent === null) return 'agentStateUnknown';
  if (belief.agent.healthHalfHearts === 0) return 'agentEliminated';
  if (belief.borderKnowledge === 'unknown') return 'borderUnknown';
  if (belief.borderKnowledge === 'stale') return 'borderStale';
  if (belief.border === null) return 'borderUnknown';
  return null;
}

function settle(
  task: FrontierTask | null,
  belief: FrontierBelief,
  params: PolicyParams,
  feedback: PolicyFeedbackBatch,
): { readonly task: FrontierTask | null; readonly cooldowns: readonly FrontierCooldown[] } {
  if (task === null) return { task: null, cooldowns: [] };
  const matched = feedback.filter((event) => feedbackMatches(task, event.target));
  const failed = matched.some((event) => event.kind === 'failed');
  const succeeded = !failed && matched.some((event) => event.kind === 'succeeded');
  const geometricFailure = matched.length === 0 && goalFailed(task, belief);
  const geometricSuccess = matched.length === 0 && !geometricFailure && goalSucceeded(task, belief, params);
  if (!failed && !succeeded && !geometricFailure && !geometricSuccess) {
    return { task, cooldowns: task.cooldowns };
  }
  const key = modeKey(task.mode);
  const cooldowns = failed || geometricFailure || task.goal === 'explore'
    ? addCooldown(task.cooldowns, task.goal, key, belief.tick)
    : task.cooldowns;
  return { task: null, cooldowns };
}

function goalSucceeded(task: FrontierTask, belief: FrontierBelief, params: PolicyParams): boolean {
  const agent = belief.agent;
  const border = belief.border;
  if (agent === null || border === null) return false;
  if (task.mode.kind === 'escaping') return !borderDanger(belief, params);
  if (task.mode.kind === 'healing') return agent.hungerPoints > params.values.eatAtHungerOrBelow;
  if (task.mode.kind === 'looting') {
    const target = task.mode.target;
    return belief.lootKnowledge === 'current' && !belief.loot.some((opportunity) => sameLoot(lootTarget(opportunity), target));
  }
  if (task.mode.kind === 'engaging' && task.mode.side === 'press') {
    const target = task.mode.target;
    return belief.opponentsKnowledge === 'current' && !belief.opponents.some((opponent) => opponent.id === target);
  }
  if (task.mode.kind === 'engaging' && task.mode.side === 'evade') return lethalThreat(belief, params) === null;
  if (task.mode.kind === 'exploring') return manhattanDistance(agent.position, task.mode.target) <= EXPLORE_ARRIVAL_BLOCKS;
  return false;
}

function goalFailed(task: FrontierTask, belief: FrontierBelief): boolean {
  if (task.mode.kind === 'engaging' && task.mode.side === 'press' && belief.opponentsKnowledge !== 'current') return true;
  if (task.mode.kind === 'looting' && belief.lootKnowledge === 'unknown') return true;
  if (task.mode.kind === 'exploring' && belief.border !== null && isOutsideBorder(belief.border, task.mode.target)) return true;
  return false;
}

function planGoals(
  belief: FrontierBelief,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  style: OpeningStyle | undefined,
  openingState: OpeningPolicyState,
  task: FrontierTask | null,
  cooldowns: readonly FrontierCooldown[],
): readonly Planned[] {
  const agent = belief.agent;
  const border = belief.border;
  if (agent === null || border === null) throw new TypeError('frontier planning requires a current agent and border');
  const planned: Planned[] = [];
  if (borderDanger(belief, params)) {
    planned.push(cooled(cooldowns, belief.tick, {
      goal: 'escapeBorder',
      utility: BORDER_SCORE,
      rejection: null,
      mode: Object.freeze({ kind: 'escaping' }),
    }));
  }
  const heal = planHeal(belief, params);
  if (heal !== null) {
    planned.push(cooled(cooldowns, belief.tick, {
      goal: 'heal',
      utility: HEAL_SCORE,
      rejection: null,
      mode: Object.freeze({ kind: 'healing', inventorySlot: heal }),
    }));
  }
  const loot = planLoot(belief, memory, params, task);
  if (loot !== null) {
    const utility = LOOT_SCORE + loot.item * 10 - penalty(loot.distance) + lootBias(style, openingState);
    if (utility > 0) {
      planned.push(cooled(cooldowns, belief.tick, {
        goal: 'loot',
        utility,
        rejection: null,
        mode: Object.freeze({ kind: 'looting', target: loot.target }),
      }));
    }
  }
  const engage = planEngage(belief, params, style);
  if (engage !== null) planned.push(cooled(cooldowns, belief.tick, engage));
  const explore = planExplore(belief, memory, params, random, task, cooldowns);
  if (explore !== null) {
    planned.push(cooled(cooldowns, belief.tick, {
      goal: 'explore',
      utility: EXPLORE_SCORE + (style === 'explorer' ? EXPLORER_BIAS : 0),
      rejection: null,
      mode: Object.freeze({ kind: 'exploring', target: explore }),
    }));
  }
  return planned;
}

function choose(
  planned: readonly Planned[],
  task: FrontierTask | null,
  tick: number,
  materialSame: boolean,
): { readonly mode: FrontierMode | null; readonly proposals: readonly FrontierProposal[] } {
  const open = (proposal: Planned) => proposal.rejection === null;
  const continuing = task === null ? null : planned.find((proposal) => open(proposal) && proposal.goal === task.goal) ?? null;
  const interrupt = planned.some((proposal) => (
    open(proposal) && proposal.utility >= LETHAL_SCORE && (task === null || proposal.goal !== task.goal)
  ));
  const keep = continuing !== null && task !== null && (materialSame || tick <= task.commitUntilTick) && !interrupt;
  const chosen = keep
    ? continuing
    : planned.filter(open).reduce<Planned | null>((best, proposal) => (
      best === null || proposal.utility > best.utility || (proposal.utility === best.utility && goalIndex(proposal.goal) < goalIndex(best.goal))
        ? proposal
        : best
    ), null);
  const proposals = planned.map((proposal) => Object.freeze({
    goal: proposal.goal,
    utility: proposal.utility,
    rejection: proposal.rejection === 'cooldown'
      ? 'cooldown' as const
      : chosen !== null && proposal.goal === chosen.goal
        ? null
        : keep && chosen !== null && proposal.utility > chosen.utility
          ? 'committed' as const
          : 'outranked' as const,
  }));
  return { mode: chosen?.mode ?? null, proposals };
}

function nextTask(
  previous: FrontierTask | null,
  mode: FrontierMode,
  belief: FrontierBelief,
  cooldowns: readonly FrontierCooldown[],
): FrontierTask {
  const goal = goalOf(mode);
  const pruned = cooldowns.filter((entry) => entry.untilTick > belief.tick);
  if (previous !== null && modeKey(previous.mode) === modeKey(mode)) {
    return Object.freeze({ ...previous, mode, goal, fingerprint: fingerprint(belief), cooldowns: Object.freeze(pruned) });
  }
  return Object.freeze({
    goal,
    mode,
    startedAtTick: belief.tick,
    commitUntilTick: belief.tick + COMMIT_TICKS,
    attempt: previous !== null && previous.goal === goal ? previous.attempt + 1 : 0,
    fingerprint: fingerprint(belief),
    cooldowns: Object.freeze(pruned),
  });
}

function planHeal(belief: FrontierBelief, params: PolicyParams): InventorySlot | null {
  const agent = belief.agent;
  if (agent === null || belief.opponentsKnowledge !== 'current' || belief.opponents.length > 0) return null;
  if (agent.hungerPoints > params.values.eatAtHungerOrBelow || agent.foodStacks.length === 0) return null;
  if (belief.remembered !== null && agent !== null
      && manhattanDistance(agent.position, belief.remembered.position) <= BigInt(params.values.fightRangeBlocks) * 2n) {
    return null;
  }
  let slot = agent.foodStacks[0]!.inventorySlot;
  for (const stack of agent.foodStacks) {
    if (stack.inventorySlot < slot) slot = stack.inventorySlot;
  }
  return slot;
}

function planLoot(
  belief: FrontierBelief,
  memory: PolicyMemory,
  params: PolicyParams,
  task: FrontierTask | null,
): { readonly target: LootTarget; readonly item: number; readonly distance: bigint } | null {
  const agent = belief.agent;
  if (agent === null || belief.lootKnowledge !== 'current') return null;
  const choices: { readonly target: LootTarget; readonly item: number; readonly distance: bigint }[] = [];
  for (const opportunity of belief.loot) {
    const target = lootTarget(opportunity);
    if (memory.failedTargets.some((failed) => failed.kind === 'loot' && sameLoot(failed.target, target))) continue;
    const item = itemUtility(opportunity, agent);
    if (item <= 0) continue;
    choices.push({ target, item, distance: manhattanDistance(agent.position, opportunity.position) });
  }
  choices.sort((first, second) => (
    second.item - first.item
    || (first.distance < second.distance ? -1 : first.distance > second.distance ? 1 : 0)
    || lootOrder(first.target, second.target)
  ));
  const best = choices[0];
  if (best === undefined) return null;
  if (task?.mode.kind === 'looting') {
    const target = task.mode.target;
    const held = choices.find((choice) => sameLoot(choice.target, target));
    if (held !== undefined && held.item === best.item
        && held.distance <= best.distance + BigInt(params.values.lootHysteresisBlocks)) {
      return held;
    }
  }
  return best;
}

function planEngage(
  belief: FrontierBelief,
  params: PolicyParams,
  style: OpeningStyle | undefined,
): Planned | null {
  const agent = belief.agent;
  const border = belief.border;
  if (agent === null || border === null) return null;
  const threat = lethalThreat(belief, params);
  if (threat !== null) {
    return {
      goal: 'engage',
      utility: LETHAL_SCORE,
      rejection: null,
      mode: Object.freeze({ kind: 'engaging', target: entityId(threat.id), side: 'evade' }),
    };
  }
  if (belief.opponentsKnowledge !== 'current' || agent.healthHalfHearts <= params.values.retreatAtHealthHalfHeartsOrBelow) {
    return null;
  }
  const fight = BigInt(params.values.fightRangeBlocks) ** 2n;
  const hunt = BigInt(HUNT_BLOCKS) ** 2n;
  const visible = belief.opponents.filter((opponent) => {
    if (isOutsideBorder(border, opponent.position)) return false;
    const distance = squaredDistance(agent.position, opponent.position);
    return distance <= fight || (style === 'hunter' && distance <= hunt);
  });
  const target = preferOpponent(agent, visible);
  if (target === null) return null;
  const distance = manhattanDistance(agent.position, target.position);
  const hunted = style === 'hunter' && squaredDistance(agent.position, target.position) <= hunt;
  const utility = ENGAGE_SCORE + (target.attackingAgent ? 25 : 0) + (hunted ? HUNTER_BIAS : 0) - penalty(distance);
  if (utility <= 0) return null;
  return {
    goal: 'engage',
    utility,
    rejection: null,
    mode: Object.freeze({ kind: 'engaging', target: target.id, side: 'press' }),
  };
}

function planExplore(
  belief: FrontierBelief,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  task: FrontierTask | null,
  cooldowns: readonly FrontierCooldown[],
): BlockPosition | null {
  const agent = belief.agent;
  const border = belief.border;
  if (agent === null || border === null) return null;
  if (task?.mode.kind === 'exploring' && exploreAllowed(task.mode.target, belief, memory, cooldowns)) {
    return task.mode.target;
  }
  if (agent.directions !== undefined) {
    const supported = agent.directions.flatMap((direction) => (
      direction.kind === 'supported' && !direction.hazard ? [direction.support] : []
    )).filter((position) => exploreAllowed(position, belief, memory, cooldowns));
    supported.sort((first, second) => {
      const left = manhattanDistance(agent.position, first);
      const right = manhattanDistance(agent.position, second);
      return left < right ? -1 : left > right ? 1 : first.x - second.x || first.y - second.y || first.z - second.z;
    });
    return supported[0] ?? null;
  }
  const radius = params.values.searchRadiusBlocks;
  const start = random.nextEightWay();
  for (let offset = 0; offset < RING.length; offset += 1) {
    const [dx, dz] = RING[(start + offset) % RING.length]!;
    const moved = offsetBlockPosition(agent.position, dx * radius, 0, dz * radius);
    if (!moved.ok || !exploreAllowed(moved.value, belief, memory, cooldowns)) continue;
    return moved.value;
  }
  return null;
}

function exploreAllowed(
  position: BlockPosition,
  belief: FrontierBelief,
  memory: PolicyMemory,
  cooldowns: readonly FrontierCooldown[],
): boolean {
  if (belief.border === null || isOutsideBorder(belief.border, position)) return false;
  if (memory.failedTargets.some((failed) => failed.kind === 'explore' && sameBlock(failed.target, position))) return false;
  return !cooling(cooldowns, 'explore', `explore:${position.x},${position.y},${position.z}`, belief.tick);
}

function lethalThreat(
  belief: FrontierBelief,
  params: PolicyParams,
): { readonly id: EntityId; readonly position: BlockPosition } | null {
  const agent = belief.agent;
  if (agent === null || agent.healthHalfHearts > params.values.retreatAtHealthHalfHeartsOrBelow) return null;
  const near = (position: BlockPosition) => manhattanDistance(agent.position, position) <= BigInt(THREAT_BLOCKS);
  const attacker = belief.opponents.find((opponent) => opponent.attackingAgent);
  if (attacker !== undefined) return attacker;
  const close = preferOpponent(agent, belief.opponents.filter((opponent) => near(opponent.position)));
  if (close !== null) return close;
  if (belief.remembered !== null && near(belief.remembered.position)) return belief.remembered;
  if (belief.opponentsKnowledge !== 'stale' || !staleFresh(belief, params.values.opponentMemoryTicks)) return null;
  return preferOpponent(agent, belief.staleOpponents.filter((opponent) => near(opponent.position)));
}

function commandFor(mode: FrontierMode, belief: FrontierBelief): FrontierCommand {
  const agent = belief.agent;
  const border = belief.border;
  if (agent === null || border === null) throw new TypeError('frontier command requires a current agent and border');
  if (mode.kind === 'escaping') {
    return navigation(borderCenter(border, agent.position.y));
  }
  if (mode.kind === 'healing') {
    if (!agent.foodStacks.some((stack) => stack.inventorySlot === mode.inventorySlot)) {
      throw new TypeError('frontier heal slot is not in the current inventory');
    }
    return Object.freeze({ owner: 'eat', intent: Object.freeze({ kind: 'eat', inventorySlot: mode.inventorySlot }) });
  }
  if (mode.kind === 'looting') {
    const opportunity = belief.loot.find((candidate) => sameLoot(lootTarget(candidate), mode.target));
    if (opportunity === undefined) throw new TypeError('frontier loot target is not current');
    if (manhattanDistance(agent.position, opportunity.position) > LOOT_REACH_BLOCKS) return navigation(opportunity.position);
    const intent: Intent = opportunity.kind === 'visibleDrop'
      ? Object.freeze({ kind: 'dropCollect', entityId: opportunity.entityId })
      : Object.freeze({ kind: 'containerOpen', position: opportunity.position });
    return Object.freeze({ owner: 'loot', intent });
  }
  if (mode.kind === 'engaging' && mode.side === 'evade') {
    const threat = threatPosition(mode.target, belief);
    if (threat === null) throw new TypeError('frontier evade has no threat position');
    const away = awayFrom(agent.position, threat, border);
    if (away === null) return holdCommand('unrepresentableTarget');
    return navigation(away);
  }
  if (mode.kind === 'engaging') {
    const opponent = belief.opponents.find((candidate) => candidate.id === mode.target);
    if (opponent === undefined) throw new TypeError('frontier engage has no current target');
    if (meleeReach(agent, opponent)) {
      return Object.freeze({ owner: 'attack', intent: Object.freeze({ kind: 'attack', target: opponent.id }) });
    }
    if (agent.ranged !== undefined && agent.ranged.arrows > 0
        && squaredDistance(agent.position, opponent.position) <= BigInt(BOW_BLOCKS) ** 2n) {
      return Object.freeze({ owner: 'attack', intent: Object.freeze({ kind: 'shoot', target: opponent.id }) });
    }
    return Object.freeze({ owner: 'attack', intent: Object.freeze({ kind: 'approach', target: opponent.id }) });
  }
  return navigation(mode.target);
}

function decisionFor(
  task: FrontierTask | null,
  intent: Intent,
  memory: PolicyMemory,
  belief: FrontierBelief,
  feedback: PolicyFeedbackBatch,
): Decision {
  const goal: Goal = task === null || intent.kind === 'hold'
    ? Object.freeze({ kind: 'wait', reason: intent.kind === 'hold' ? intent.reason : 'noReachableFrontier' })
    : adapterGoal(task.mode);
  const nearest = belief.opponents.length === 0 || belief.agent === null
    ? null
    : preferOpponent(belief.agent, belief.opponents);
  return Object.freeze({
    goal,
    intent,
    memory: policyMemory({
      lastGoal: goal,
      lastOpponent: nearest === null ? memory.lastOpponent : Object.freeze({
        id: nearest.id,
        position: nearest.position,
        observedAt: belief.tick,
      }),
      failedTargets: rememberFeedback(memory, feedback),
      ...(memory.knowledge === undefined ? {} : { knowledge: memory.knowledge }),
    }),
  });
}

function adapterGoal(mode: FrontierMode): Goal {
  if (mode.kind === 'escaping') return Object.freeze({ kind: 'escapeBorder' });
  if (mode.kind === 'healing') return Object.freeze({ kind: 'recoverHunger' });
  if (mode.kind === 'looting') return Object.freeze({ kind: 'loot', target: mode.target });
  if (mode.kind === 'engaging' && mode.side === 'evade') {
    return Object.freeze({ kind: 'retreatFromOpponent', target: mode.target });
  }
  if (mode.kind === 'engaging') return Object.freeze({ kind: 'engageVisibleOpponent', target: mode.target });
  return Object.freeze({ kind: 'explore' });
}

function decisionReason(step: AgentStep): DecisionReason {
  const mode = step.task?.mode;
  if (mode === undefined) {
    return step.decision.goal.kind === 'wait' && step.decision.goal.reason === 'noReachableFrontier'
      ? 'directionsBlockedTravelToCenter'
      : 'delegatedBaselineRules';
  }
  if (mode.kind === 'escaping') return 'travelToBorderCenter';
  if (mode.kind === 'healing') return 'eatUnderPressure';
  if (mode.kind === 'looting') return 'lootBeforeUnarmedFight';
  if (mode.kind === 'exploring') return 'travelToBorderCenter';
  if (mode.side === 'evade') return 'disengageWhenBehind';
  if (step.decision.intent.kind === 'shoot') return 'bowOpening';
  if (step.decision.intent.kind === 'attack') return 'steadyMeleeEngagement';
  return 'huntVisibleOpponentArmed';
}

function alternativeKind(goal: FrontierGoalName): AlternativeKind | null {
  if (goal === 'loot') return 'loot';
  if (goal === 'engage') return 'engageVisibleOpponent';
  if (goal === 'explore') return 'explore';
  return null;
}

function nextOpeningState(
  style: OpeningStyle | undefined,
  state: OpeningPolicyState | undefined,
  feedback: PolicyFeedbackBatch,
): OpeningPolicyState {
  const current = state ?? Object.freeze({ cacheTakenAt: null });
  if (style !== 'scavenger' || current.cacheTakenAt !== null) return current;
  for (const event of feedback) {
    if (event.kind === 'succeeded' && event.target.kind === 'loot' && event.target.target.kind === 'container') {
      return openingPolicyState({ cacheTakenAt: event.target.target.position });
    }
  }
  return current;
}

function lootBias(style: OpeningStyle | undefined, openingState: OpeningPolicyState): number {
  if (style === 'scavenger' && openingState.cacheTakenAt === null) return SCAVENGER_BIAS;
  if (style === 'explorer') return -EXPLORER_LOOT_PENALTY;
  return 0;
}

function rememberedThreat(memory: PolicyMemory, now: number, maxAge: number): RememberedOpponent | null {
  const last = memory.lastOpponent;
  if (last === null || now < last.observedAt || now - last.observedAt > maxAge) return null;
  return last;
}

function staleFresh(belief: FrontierBelief, maxAge: number): boolean {
  const observedAt = belief.opponentsObservedAt;
  return observedAt !== null && belief.tick >= observedAt && belief.tick - observedAt <= maxAge;
}

function preferOpponent(agent: AgentState, opponents: readonly VisibleOpponent[]): VisibleOpponent | null {
  let best: VisibleOpponent | null = null;
  for (const opponent of opponents) {
    if (best === null) {
      best = opponent;
      continue;
    }
    if (opponent.attackingAgent !== best.attackingAgent) {
      if (opponent.attackingAgent) best = opponent;
      continue;
    }
    const left = squaredDistance(agent.position, opponent.position);
    const right = squaredDistance(agent.position, best.position);
    if (left < right || (left === right && opponent.id < best.id)) best = opponent;
  }
  return best;
}

function threatPosition(target: EntityId, belief: FrontierBelief): BlockPosition | null {
  const current = belief.opponents.find((opponent) => opponent.id === target);
  if (current !== undefined) return current.position;
  const stale = belief.staleOpponents.find((opponent) => opponent.id === target);
  if (stale !== undefined) return stale.position;
  if (belief.remembered !== null && belief.remembered.id === target) return belief.remembered.position;
  return null;
}

function awayFrom(position: BlockPosition, threat: BlockPosition, border: WorldBorder): BlockPosition | null {
  let dx = Math.sign(position.x - threat.x);
  const dz = Math.sign(position.z - threat.z);
  if (dx === 0 && dz === 0) dx = 1;
  const moved = offsetBlockPosition(position, dx * AWAY_STEP_BLOCKS, 0, dz * AWAY_STEP_BLOCKS);
  if (!moved.ok || isOutsideBorder(border, moved.value)) return position;
  return moved.value;
}

function meleeReach(agent: AgentState, opponent: VisibleOpponent): boolean {
  if (agent.combat !== undefined && opponent.combat !== undefined) return isWithinMeleeReach(agent.combat, opponent.combat);
  return squaredDistance(agent.position, opponent.position) <= BigInt(MELEE_REACH_BLOCKS) ** 2n;
}

function itemUtility(opportunity: LootOpportunity, agent: AgentState): number {
  if (opportunity.kind === 'unopenedContainer') return 1;
  if (opportunity.item.kind === 'food') return agent.foodStacks.length === 0 ? 2 : 0;
  if (opportunity.item.kind === 'rangedWeapon') return agent.ranged === undefined ? 2 : 0;
  if (opportunity.item.kind === 'ammunition') return agent.ranged !== undefined && agent.ranged.arrows < LOW_ARROWS ? 2 : 0;
  if (opportunity.item.kind === 'weapon') return opportunity.item.rating > (agent.equipped.weapon ?? 0) ? 3 : 0;
  if (opportunity.item.kind === 'armor') {
    return opportunity.item.rating > (agent.equipped[opportunity.item.equipmentSlot] ?? 0) ? 3 : 0;
  }
  throw new TypeError('unknown loot item');
}

function borderDanger(belief: FrontierBelief, params: PolicyParams): boolean {
  if (belief.agent === null || belief.border === null) return false;
  return isNearOrOutsideBorder(belief.border, belief.agent.position, params.values.borderMarginBlocks);
}

function navigation(target: BlockPosition): FrontierCommand {
  return Object.freeze({ owner: 'navigation', intent: Object.freeze({ kind: 'navigate', target }) });
}

function holdCommand(reason: WaitReason): FrontierCommand {
  return Object.freeze({ owner: 'hold', intent: Object.freeze({ kind: 'hold', reason }) });
}

function cooled(cooldowns: readonly FrontierCooldown[], tick: number, planned: Planned): Planned {
  if (!cooling(cooldowns, planned.goal, modeKey(planned.mode), tick)) return planned;
  return { ...planned, rejection: 'cooldown' };
}

function cooling(cooldowns: readonly FrontierCooldown[], goal: FrontierGoalName, key: string, tick: number): boolean {
  return cooldowns.some((entry) => entry.goal === goal && entry.key === key && entry.untilTick > tick);
}

function addCooldown(
  cooldowns: readonly FrontierCooldown[],
  goal: FrontierGoalName,
  key: string,
  tick: number,
): readonly FrontierCooldown[] {
  return Object.freeze([
    ...cooldowns.filter((entry) => entry.untilTick > tick && !(entry.goal === goal && entry.key === key)),
    Object.freeze({ goal, key, untilTick: tick + COOLDOWN_TICKS }),
  ]);
}

function feedbackMatches(task: FrontierTask, target: FailedTargetEvidence): boolean {
  if (task.mode.kind === 'looting' && target.kind === 'loot') return sameLoot(task.mode.target, target.target);
  if (task.mode.kind === 'exploring' && target.kind === 'explore') return sameBlock(task.mode.target, target.target);
  if (task.mode.kind === 'engaging' && target.kind === 'searchLastKnown') return task.mode.target === target.target;
  return false;
}

function rememberFeedback(memory: PolicyMemory, feedback: PolicyFeedbackBatch): readonly FailedTargetEvidence[] {
  let failed = [...memory.failedTargets];
  for (const event of feedback) {
    failed = failed.filter((existing) => JSON.stringify(existing) !== JSON.stringify(event.target));
    if (event.kind === 'failed') {
      failed.push(event.target);
      if (failed.length > MAX_FAILED_TARGETS) failed.shift();
    }
  }
  return failed;
}

function fingerprint(belief: FrontierBelief): string {
  const agent = belief.agent;
  return JSON.stringify({
    agent: agent === null ? null : {
      position: agent.position,
      health: agent.healthHalfHearts,
      hunger: agent.hungerPoints,
      food: agent.foodStacks.map((stack) => [stack.inventorySlot, stack.count, stack.restores ?? null]),
      equipped: agent.equipped,
      arrows: agent.ranged?.arrows ?? null,
      directions: agent.directions ?? null,
    },
    agentKnowledge: belief.agentKnowledge,
    border: belief.border,
    borderKnowledge: belief.borderKnowledge,
    opponents: belief.opponents.map((opponent) => [opponent.id, opponent.position, opponent.attackingAgent]),
    opponentsKnowledge: belief.opponentsKnowledge,
    opponentsObservedAt: belief.opponentsObservedAt,
    stale: belief.staleOpponents.map((opponent) => [opponent.id, opponent.position, opponent.attackingAgent]),
    loot: belief.loot,
    lootKnowledge: belief.lootKnowledge,
    remembered: belief.remembered === null ? null : [belief.remembered.id, belief.remembered.position],
  });
}

function goalOf(mode: FrontierMode): FrontierGoalName {
  if (mode.kind === 'escaping') return 'escapeBorder';
  if (mode.kind === 'healing') return 'heal';
  if (mode.kind === 'looting') return 'loot';
  if (mode.kind === 'engaging') return 'engage';
  return 'explore';
}

function goalIndex(goal: FrontierGoalName): number {
  return FRONTIER_GOALS.indexOf(goal);
}

function modeKey(mode: FrontierMode): string {
  if (mode.kind === 'escaping') return 'escapeBorder';
  if (mode.kind === 'healing') return `heal:${mode.inventorySlot}`;
  if (mode.kind === 'looting') return `loot:${lootKey(mode.target)}`;
  if (mode.kind === 'engaging') return `engage:${mode.side}:${mode.target}`;
  return `explore:${mode.target.x},${mode.target.y},${mode.target.z}`;
}

function lootKey(target: LootTarget): string {
  return target.kind === 'drop' ? `drop:${target.entityId}` : `container:${target.position.x},${target.position.y},${target.position.z}`;
}

function lootOrder(first: LootTarget, second: LootTarget): number {
  if (first.kind !== second.kind) return first.kind === 'drop' ? -1 : 1;
  if (first.kind === 'drop' && second.kind === 'drop') return first.entityId - second.entityId;
  if (first.kind === 'container' && second.kind === 'container') {
    return first.position.x - second.position.x || first.position.y - second.position.y || first.position.z - second.position.z;
  }
  throw new TypeError('loot target kinds are inconsistent');
}

function sameLoot(first: LootTarget, second: LootTarget): boolean {
  return lootOrder(first, second) === 0;
}

function sameBlock(first: BlockPosition, second: BlockPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function penalty(distance: bigint): number {
  if (distance > 10_000n) return 10_000;
  return Number(distance);
}

function blocks(distance: bigint): number {
  if (distance > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('frontier distance exceeds a safe integer');
  return Number(distance);
}

function nearestBlocks(agent: AgentState | null, positions: readonly BlockPosition[]): number | null {
  if (agent === null || positions.length === 0) return null;
  let best = manhattanDistance(agent.position, positions[0]!);
  for (const position of positions.slice(1)) {
    const distance = manhattanDistance(agent.position, position);
    if (distance < best) best = distance;
  }
  return blocks(best);
}

function assertTask(task: FrontierTask): void {
  if (task.goal !== goalOf(task.mode)) throw new TypeError('frontier task goal does not match its mode');
  if (!Number.isSafeInteger(task.startedAtTick) || !Number.isSafeInteger(task.commitUntilTick) || !Number.isSafeInteger(task.attempt)) {
    throw new RangeError('frontier task ticks must be safe integers');
  }
  if (!Array.isArray(task.cooldowns)) throw new TypeError('frontier task cooldowns must be an array');
  for (const entry of task.cooldowns) {
    if (!FRONTIER_GOALS.includes(entry.goal) || typeof entry.key !== 'string' || !Number.isSafeInteger(entry.untilTick)) {
      throw new TypeError('frontier cooldown is invalid');
    }
  }
}
