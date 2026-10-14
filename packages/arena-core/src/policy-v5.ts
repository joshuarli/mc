import {
  blockPosition,
  borderCenter,
  isNearOrOutsideBorder,
  isOutsideBorder,
  manhattanDistance,
  type BlockPosition,
  type WorldBorder,
} from './geometry.js';
import {
  lootTarget,
  type AgentObservation,
  type AgentState,
  type Knowledge,
  type LootOpportunity,
  type VisibleOpponent,
} from './observation.js';
import {
  decide,
  policyMemory,
  type Decision,
  type Goal,
  type Intent,
  type OpeningDecision,
  type OpeningPolicyContext,
  type PolicyFeedbackBatch,
  type PolicyMemory,
  type PolicyParams,
} from './policy.js';
import type { DeterministicRandom } from './random.js';

export const DECISION_EXPLANATION_VERSION = 1;
export const MAX_EXPLANATION_ALTERNATIVES = 4;

const CACHE_INTERACTION_BLOCKS = 3n;
const HUNT_RANGE_BLOCKS = 16n;
const HUNT_MIN_HEALTH_HALF_HEARTS = 12;
const TRAVEL_STEP_BLOCKS = 12;
const ORBIT_ENTRY_BLOCKS = 8;
const ORBIT_RING_BLOCKS = 10;
const ORBIT_DWELL_TICKS = 60;
const EXPLORE_BORDER_MARGIN_BLOCKS = 3;
const REGION_SIZE_BLOCKS = 16;
const CONFINED_AFTER_TICKS = 300;
const CONFINED_MAX_REGIONS = 4;
const CONFINED_DWELL_TICKS = 120;
const CONFINED_PROBE_BLOCKS = 24;

export type DecisionReason =
  | 'delegatedBaselineRules'
  | 'cacheResumedOutOfSight'
  | 'lootBeforeUnarmedFight'
  | 'huntVisibleOpponentArmed'
  | 'travelToBorderCenter'
  | 'orbitBorderCenter'
  | 'confinedProbeFarTarget'
  | 'directionsBlockedTravelToCenter';

export type AlternativeCondition =
  | 'chosen'
  | 'noTargetKnown'
  | 'unarmedNotAttacked'
  | 'targetFailedBefore'
  | 'outranked';

export type AlternativeKind = 'loot' | 'engageVisibleOpponent' | 'searchLastKnown' | 'explore';

export interface ScoredAlternative {
  readonly goal: AlternativeKind;
  readonly score: number;
  readonly condition: AlternativeCondition;
}

export interface DecisionExplanation {
  readonly version: typeof DECISION_EXPLANATION_VERSION;
  readonly reason: DecisionReason;
  readonly delegatedGoal: Goal['kind'];
  readonly alternatives: readonly ScoredAlternative[];
  readonly nearestCacheBlocks: number | null;
  readonly nearestOpponentBlocks: number | null;
  readonly borderCenterBlocks: number | null;
  readonly armed: boolean | null;
}

export interface ExplainedDecision {
  readonly decision: Decision;
  readonly explanation: DecisionExplanation;
}

export interface ExplainedOpeningDecision {
  readonly decision: OpeningDecision;
  readonly explanation: DecisionExplanation;
}

const GOAL_SCORE: Readonly<Record<AlternativeKind, number>> = Object.freeze({
  engageVisibleOpponent: 60,
  loot: 50,
  searchLastKnown: 40,
  explore: 20,
});

const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

interface Facts {
  readonly agent: AgentState;
  readonly border: WorldBorder;
  readonly tick: number;
  readonly caches: readonly LootOpportunity[];
  readonly opponents: readonly VisibleOpponent[];
  readonly nearestCache: { readonly opportunity: LootOpportunity; readonly distance: bigint } | null;
  readonly nearestOpponent: { readonly opponent: VisibleOpponent; readonly distance: bigint } | null;
  readonly armed: boolean;
  readonly cacheNeeded: boolean;
}

export function decideV5(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
): ExplainedDecision {
  const base = decide(observation, memory, params, random, feedback);
  const facts = gatherFacts(observation);
  if (facts === null) return delegated(base, null);
  const retreatAt = params.values.retreatAtHealthHalfHeartsOrBelow;
  const override = chooseOverride(base, memory, facts, retreatAt);
  if (override === null) return delegated(base, facts);
  const goal = override.goal;
  const decision: Decision = Object.freeze({
    goal,
    intent: override.intent,
    memory: policyMemory({ ...base.memory, lastGoal: goal }),
  });
  return explain(decision, override.reason, base.goal.kind, facts, base.memory);
}

export function decideOpeningV5(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
  context: OpeningPolicyContext,
): ExplainedOpeningDecision {
  const { decision, explanation } = decideV5(observation, memory, params, random, feedback);
  return Object.freeze({
    decision: Object.freeze({ ...decision, openingState: context.state }),
    explanation,
  });
}

export function baselineExplanation(
  observation: AgentObservation,
  decision: Decision,
): DecisionExplanation {
  const facts = gatherFacts(observation);
  return explain(decision, 'delegatedBaselineRules', decision.goal.kind, facts, decision.memory).explanation;
}

interface Override {
  readonly goal: Goal;
  readonly intent: Intent;
  readonly reason: DecisionReason;
}

function chooseOverride(
  base: Decision,
  priorMemory: PolicyMemory,
  facts: Facts,
  retreatAt: number,
): Override | null {
  const { agent, nearestCache, nearestOpponent } = facts;
  if (base.goal.kind === 'engageVisibleOpponent') {
    if (!facts.armed && facts.cacheNeeded && nearestCache !== null
        && !isFailedLoot(base.memory, nearestCache.opportunity)
        && nearestOpponent !== null && !nearestOpponent.opponent.attackingAgent
        && base.intent.kind !== 'attack') {
      return lootOverride(nearestCache.opportunity, facts, 'lootBeforeUnarmedFight');
    }
    return null;
  }
  const exploring = base.goal.kind === 'explore'
    || (base.goal.kind === 'wait' && isExplorationWait(base.goal.reason));
  if (!exploring && base.goal.kind !== 'searchLastKnown') return null;

  if (facts.armed && agent.healthHalfHearts > Math.max(retreatAt, HUNT_MIN_HEALTH_HALF_HEARTS)
      && facts.opponents.length === 1 && nearestOpponent !== null
      && nearestOpponent.distance <= HUNT_RANGE_BLOCKS
      && !isOutsideBorder(facts.border, nearestOpponent.opponent.position)) {
    const target = nearestOpponent.opponent;
    return {
      goal: Object.freeze({ kind: 'engageVisibleOpponent', target: target.id }),
      intent: { kind: 'approach', target: target.id },
      reason: 'huntVisibleOpponentArmed',
    };
  }

  if (!exploring) return null;

  const resumed = resumableCache(priorMemory, base.memory, facts);
  if (resumed !== null) {
    return {
      goal: Object.freeze({ kind: 'loot', target: Object.freeze({ kind: 'container', position: resumed }) }),
      intent: { kind: 'navigate', target: resumed },
      reason: 'cacheResumedOutOfSight',
    };
  }

  const travel = centerTarget(facts, base.memory);
  const allBlocked = agent.directions !== undefined
    && agent.directions.every((direction) => direction.kind !== 'supported');
  return {
    goal: Object.freeze({ kind: 'explore' }),
    intent: { kind: 'navigate', target: travel.target },
    reason: travel.confined
      ? 'confinedProbeFarTarget'
      : travel.orbiting
        ? 'orbitBorderCenter'
        : allBlocked ? 'directionsBlockedTravelToCenter' : 'travelToBorderCenter',
  };
}

function isExplorationWait(reason: string): boolean {
  return reason === 'noReachableFrontier' || reason === 'failedTargetsExhausted' || reason === 'unrepresentableTarget';
}

function lootOverride(opportunity: LootOpportunity, facts: Facts, reason: DecisionReason): Override {
  const target = lootTarget(opportunity);
  const near = manhattanDistance(facts.agent.position, opportunity.position) <= CACHE_INTERACTION_BLOCKS;
  const intent: Intent = near
    ? (opportunity.kind === 'visibleDrop'
      ? { kind: 'dropCollect', entityId: opportunity.entityId }
      : { kind: 'containerOpen', position: opportunity.position })
    : { kind: 'navigate', target: opportunity.position };
  return { goal: Object.freeze({ kind: 'loot', target }), intent, reason };
}

function resumableCache(prior: PolicyMemory, current: PolicyMemory, facts: Facts): BlockPosition | null {
  const last = prior.lastGoal;
  if (last === null || last.kind !== 'loot' || last.target.kind !== 'container') return null;
  const position = last.target.position;
  if (facts.caches.some((cache) => sameBlock(cache.position, position))) return null;
  if (current.failedTargets.some((failed) => (
    failed.kind === 'loot' && failed.target.kind === 'container' && sameBlock(failed.target.position, position)
  ))) return null;
  if (manhattanDistance(facts.agent.position, position) <= CACHE_INTERACTION_BLOCKS) return null;
  if (isOutsideBorder(facts.border, position)) return null;
  return position;
}

function centerTarget(
  facts: Facts,
  memory: PolicyMemory,
): { readonly target: BlockPosition; readonly orbiting: boolean; readonly confined: boolean } {
  const { agent, border } = facts;
  const center = borderCenter(border, agent.position.y);
  const dx = center.x - agent.position.x;
  const dz = center.z - agent.position.z;
  const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
  const failed = memory.failedTargets.filter((entry) => entry.kind === 'explore').map((entry) => entry.target);
  const usable = (candidate: BlockPosition): boolean => (
    !failed.some((position) => sameBlock(position, candidate))
    && !isNearOrOutsideBorder(border, candidate, EXPLORE_BORDER_MARGIN_BLOCKS)
  );
  const at = (x: number, z: number) => blockPosition(x, agent.position.y, z);

  const regions = memory.knowledge?.visitedRegions.length ?? 0;
  if (chebyshev > ORBIT_ENTRY_BLOCKS && facts.tick >= CONFINED_AFTER_TICKS && regions <= CONFINED_MAX_REGIONS) {
    const ranked = DIRECTIONS.map((direction, index) => ({
      index,
      alignment: direction[0] * dx + direction[1] * dz,
      candidate: at(
        agent.position.x + direction[0] * CONFINED_PROBE_BLOCKS,
        agent.position.z + direction[1] * CONFINED_PROBE_BLOCKS,
      ),
    })).sort((first, second) => second.alignment - first.alignment || first.index - second.index);
    const start = Math.floor(facts.tick / CONFINED_DWELL_TICKS);
    for (let offset = 0; offset < ranked.length; offset += 1) {
      const entry = ranked[(start + offset) % ranked.length]!;
      if (usable(entry.candidate)) return { target: entry.candidate, orbiting: false, confined: true };
    }
  }

  if (chebyshev > ORBIT_ENTRY_BLOCKS) {
    const toward = DIRECTIONS.map((direction, index) => ({
      index,
      alignment: direction[0] * dx + direction[1] * dz,
      candidate: at(
        agent.position.x + direction[0] * TRAVEL_STEP_BLOCKS,
        agent.position.z + direction[1] * TRAVEL_STEP_BLOCKS,
      ),
    })).sort((first, second) => second.alignment - first.alignment || first.index - second.index);
    const step = Math.min(chebyshev, TRAVEL_STEP_BLOCKS);
    const direct = at(
      agent.position.x + Math.round((dx * step) / chebyshev),
      agent.position.z + Math.round((dz * step) / chebyshev),
    );
    if (usable(direct)) return { target: direct, orbiting: false, confined: false };
    for (const entry of toward) {
      if (entry.alignment > 0 && usable(entry.candidate)) return { target: entry.candidate, orbiting: false, confined: false };
    }
    return { target: center, orbiting: false, confined: false };
  }

  const start = Math.floor(facts.tick / ORBIT_DWELL_TICKS) % DIRECTIONS.length;
  const visited = memory.knowledge?.visitedRegions ?? [];
  const isVisited = (candidate: BlockPosition): boolean => visited.some((region) => (
    region.x === Math.floor(candidate.x / REGION_SIZE_BLOCKS) && region.z === Math.floor(candidate.z / REGION_SIZE_BLOCKS)
  ));
  const ring: BlockPosition[] = [];
  for (let offset = 0; offset < DIRECTIONS.length; offset += 1) {
    const direction = DIRECTIONS[(start + offset) % DIRECTIONS.length]!;
    const candidate = at(
      center.x + direction[0] * ORBIT_RING_BLOCKS,
      center.z + direction[1] * ORBIT_RING_BLOCKS,
    );
    if (usable(candidate)) ring.push(candidate);
  }
  const chosen = ring.find((candidate) => !isVisited(candidate)) ?? ring[0];
  return { target: chosen ?? center, orbiting: true, confined: false };
}

function gatherFacts(observation: AgentObservation): Facts | null {
  const agent = current(observation.agent);
  const border = current(observation.border);
  if (agent === null || border === null || agent.healthHalfHearts === 0) return null;
  const caches = (current(observation.loot) ?? []).filter((opportunity) => opportunity.kind === 'unopenedContainer');
  const opponents = current(observation.opponents) ?? [];
  let nearestCache: Facts['nearestCache'] = null;
  for (const opportunity of caches) {
    const distance = manhattanDistance(agent.position, opportunity.position);
    if (nearestCache === null || distance < nearestCache.distance) nearestCache = { opportunity, distance };
  }
  let nearestOpponent: Facts['nearestOpponent'] = null;
  for (const opponent of opponents) {
    const distance = manhattanDistance(agent.position, opponent.position);
    if (nearestOpponent === null || distance < nearestOpponent.distance
        || (distance === nearestOpponent.distance && opponent.id < nearestOpponent.opponent.id)) {
      nearestOpponent = { opponent, distance };
    }
  }
  return {
    agent,
    border,
    tick: observation.tick,
    caches,
    opponents,
    nearestCache,
    nearestOpponent,
    armed: agent.equipped.weapon !== null,
    cacheNeeded: agent.foodStacks.length === 0
      || (['weapon', 'helmet', 'chestplate', 'leggings', 'boots'] as const).some((slot) => agent.equipped[slot] === null),
  };
}

function delegated(base: Decision, facts: Facts | null): ExplainedDecision {
  return explain(base, 'delegatedBaselineRules', base.goal.kind, facts, base.memory);
}

function explain(
  decision: Decision,
  reason: DecisionReason,
  delegatedGoal: Goal['kind'],
  facts: Facts | null,
  memory: PolicyMemory,
): ExplainedDecision {
  const chosen = alternativeOf(decision.goal.kind);
  const alternatives: ScoredAlternative[] = [];
  if (facts !== null) {
    const lootFailed = facts.nearestCache !== null && isFailedLoot(memory, facts.nearestCache.opportunity);
    alternatives.push(scored('loot', chosen, facts.nearestCache === null ? 'noTargetKnown' : lootFailed ? 'targetFailedBefore' : 'outranked',
      facts.nearestCache === null || lootFailed ? 0 : GOAL_SCORE.loot - distancePenalty(facts.nearestCache.distance)));
    alternatives.push(scored('engageVisibleOpponent', chosen,
      facts.nearestOpponent === null ? 'noTargetKnown'
        : !facts.armed && !facts.nearestOpponent.opponent.attackingAgent ? 'unarmedNotAttacked' : 'outranked',
      facts.nearestOpponent === null ? 0 : GOAL_SCORE.engageVisibleOpponent - distancePenalty(facts.nearestOpponent.distance)));
    alternatives.push(scored('searchLastKnown', chosen, memory.lastOpponent === null ? 'noTargetKnown' : 'outranked',
      memory.lastOpponent === null ? 0 : GOAL_SCORE.searchLastKnown));
    alternatives.push(scored('explore', chosen, 'outranked', GOAL_SCORE.explore));
  }
  alternatives.sort((first, second) => (
    Number(second.condition === 'chosen') - Number(first.condition === 'chosen') || second.score - first.score
  ));
  const center = facts === null ? null : borderCenter(facts.border, facts.agent.position.y);
  return Object.freeze({
    decision,
    explanation: Object.freeze({
      version: DECISION_EXPLANATION_VERSION,
      reason,
      delegatedGoal,
      alternatives: Object.freeze(alternatives.slice(0, MAX_EXPLANATION_ALTERNATIVES)),
      nearestCacheBlocks: facts?.nearestCache === null || facts === null ? null : Number(facts.nearestCache.distance),
      nearestOpponentBlocks: facts?.nearestOpponent === null || facts === null ? null : Number(facts.nearestOpponent.distance),
      borderCenterBlocks: facts === null || center === null ? null : Number(manhattanDistance(facts.agent.position, center)),
      armed: facts === null ? null : facts.armed,
    }),
  });
}

function scored(
  goal: AlternativeKind,
  chosen: AlternativeKind | null,
  rejection: AlternativeCondition,
  score: number,
): ScoredAlternative {
  return Object.freeze({ goal, score, condition: goal === chosen ? 'chosen' : rejection });
}

function alternativeOf(kind: Goal['kind']): AlternativeKind | null {
  switch (kind) {
    case 'loot':
    case 'engageVisibleOpponent':
    case 'searchLastKnown':
    case 'explore':
      return kind;
    default:
      return null;
  }
}

function distancePenalty(distance: bigint): number {
  return Math.min(30, Number(distance));
}

function isFailedLoot(memory: PolicyMemory, opportunity: LootOpportunity): boolean {
  const target = lootTarget(opportunity);
  return memory.failedTargets.some((failed) => (
    failed.kind === 'loot'
    && failed.target.kind === target.kind
    && (target.kind === 'container'
      ? failed.target.kind === 'container' && sameBlock(failed.target.position, target.position)
      : failed.target.kind === 'drop' && failed.target.entityId === target.entityId)
  ));
}

function sameBlock(first: BlockPosition, second: BlockPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function current<T>(knowledge: Knowledge<T>): T | null {
  return knowledge.kind === 'current' ? knowledge.value : null;
}
