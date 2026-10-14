import { isWithinMeleeReach, MELEE_REACH_BLOCKS } from './combat.js';
import { blockPosition, offsetBlockPosition, squaredDistance, type BlockPosition } from './geometry.js';
import {
  seatId,
  type AgentObservation,
  type AgentState,
  type EntityId,
  type VisibleOpponent,
} from './observation.js';
import {
  emptyPolicyMemory,
  policyMemory,
  type Decision,
  type Goal,
  type Intent,
  type OpeningDecision,
  type OpeningPolicyContext,
  type PolicyFeedbackBatch,
  type PolicyMemory,
  type WaitReason,
} from './policy.js';
import { baselineExplanation } from './policy-v5.js';
import { DeterministicRandom, RandomStream } from './random.js';
import { compileCandidate } from './candidates.js';

export const DUEL_POOL_VERSION = 1;

export const DUEL_POOL_IDS = [
  'stationary-dummy',
  'strafer',
  'aggressive-rusher',
  'bow-kiter',
  'shield-user',
  'baseline',
] as const;

export type DuelPoolId = typeof DUEL_POOL_IDS[number];

export const DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS = 10;

const MELEE_LIMIT = BigInt(MELEE_REACH_BLOCKS) * BigInt(MELEE_REACH_BLOCKS);

export interface DuelPoolMember {
  readonly id: DuelPoolId;
  readonly semanticId: string;
  readonly decide: (observation: AgentObservation) => Intent;
}

type ScriptedDuelPoolId = Exclude<DuelPoolId, 'baseline'>;

const baselineCandidate = compileCandidate('baseline');

const MEMBERS: readonly DuelPoolMember[] = Object.freeze(DUEL_POOL_IDS.map((id) => Object.freeze({
  id,
  semanticId: id === 'baseline'
    ? baselineCandidate.semanticId
    : `${id}@${DUEL_POOL_VERSION}`,
  decide: (observation: AgentObservation) => (id === 'baseline'
    ? baselineCandidate.decide(
      observation,
      emptyPolicyMemory(),
      baselineRandom(),
    ).intent
    : scriptedIntent(id, observation)),
})));

export function isDuelPoolId(value: string): value is DuelPoolId {
  return (DUEL_POOL_IDS as readonly string[]).includes(value);
}

export function duelPoolMembers(): readonly DuelPoolMember[] {
  return MEMBERS;
}

export function duelPoolMember(id: DuelPoolId): DuelPoolMember {
  const member = MEMBERS.find((entry) => entry.id === id);
  if (member === undefined) throw new TypeError(`unknown duel pool partner: ${id}`);
  return member;
}

export function decideDuelPool(
  id: DuelPoolId,
  observation: AgentObservation,
  memory: PolicyMemory,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): Decision {
  if (id === 'baseline') return baselineCandidate.decide(observation, memory, random, feedback);
  return scriptedDecision(id, observation, memory);
}

export function decideDuelPoolOpening(
  id: DuelPoolId,
  observation: AgentObservation,
  memory: PolicyMemory,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
  context: OpeningPolicyContext,
): OpeningDecision {
  if (id === 'baseline') return baselineCandidate.decideOpening(observation, memory, random, feedback, context);
  return Object.freeze({ ...scriptedDecision(id, observation, memory), openingState: context.state });
}

export function explainDuelPool(
  id: DuelPoolId,
  observation: AgentObservation,
  memory: PolicyMemory,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): { readonly decision: Decision; readonly explanation: ReturnType<typeof baselineExplanation> } {
  if (id === 'baseline') return baselineCandidate.explain(observation, memory, random, feedback);
  const decision = scriptedDecision(id, observation, memory);
  return Object.freeze({ decision, explanation: baselineExplanation(observation, decision) });
}

function baselineRandom(): DeterministicRandom {
  return DeterministicRandom.forStream(0n, RandomStream.policy(seatId(0)));
}

function scriptedDecision(id: ScriptedDuelPoolId, observation: AgentObservation, memory: PolicyMemory): Decision {
  const intent = scriptedIntent(id, observation);
  const goal = goalFor(id, intent, observation);
  return Object.freeze({ goal, intent, memory: remember(memory, goal) });
}

function scriptedIntent(id: ScriptedDuelPoolId, observation: AgentObservation): Intent {
  const held = heldAgent(observation);
  if (held !== null) return held;
  const self = observation.agent.kind === 'current' ? observation.agent.value : null;
  if (self === null) return hold('agentStateUnknown');
  const opponent = visibleOpponent(observation, self.position);
  const here = blockPosition(self.position.x, self.position.y, self.position.z);
  switch (id) {
    case 'stationary-dummy':
      if (opponent !== null && inMelee(self, opponent)) return attack(opponent.id);
      return navigate(here);
    case 'strafer':
      if (opponent === null) return navigate(here);
      if (inMelee(self, opponent)) return attack(opponent.id);
      return navigate(orbitBlock(self.position, opponent.position));
    case 'aggressive-rusher':
      if (opponent === null) return navigate(here);
      if (inMelee(self, opponent)) return attack(opponent.id);
      return approach(opponent.id);
    case 'bow-kiter':
      if (opponent === null) return navigate(here);
      return navigate(kiteBlock(self.position, opponent.position));
    case 'shield-user':
      if (opponent === null) return navigate(here);
      if (self.healthHalfHearts <= DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS) {
        return navigate(away(self.position, opponent.position, 1));
      }
      return attack(opponent.id);
  }
}

function goalFor(id: ScriptedDuelPoolId, intent: Intent, observation: AgentObservation): Goal {
  if (intent.kind === 'hold') return Object.freeze({ kind: 'wait', reason: intent.reason });
  if (intent.kind === 'attack' || intent.kind === 'approach') {
    return Object.freeze({ kind: 'engageVisibleOpponent', target: intent.target });
  }
  if (intent.kind !== 'navigate') throw new TypeError(`duel pool partner emitted ${intent.kind}`);
  const self = observation.agent.kind === 'current' ? observation.agent.value : null;
  const opponent = self === null ? null : visibleOpponent(observation, self.position);
  if (opponent !== null && (id === 'bow-kiter' || (id === 'shield-user'
      && self !== null
      && self.healthHalfHearts <= DUEL_POOL_SHIELD_RETREAT_HEALTH_HALF_HEARTS))) {
    return Object.freeze({ kind: 'retreatFromOpponent', target: opponent.id });
  }
  if (opponent !== null && id === 'strafer') {
    return Object.freeze({ kind: 'engageVisibleOpponent', target: opponent.id });
  }
  return Object.freeze({ kind: 'explore' });
}

function heldAgent(observation: AgentObservation): Intent | null {
  if (observation.agent.kind === 'unknown') return hold('agentStateUnknown');
  if (observation.agent.kind === 'stale') return hold('agentStateStale');
  if (observation.agent.value.healthHalfHearts === 0) return hold('agentEliminated');
  return null;
}

function visibleOpponent(observation: AgentObservation, origin: BlockPosition): VisibleOpponent | null {
  if (observation.opponents.kind !== 'current' || observation.opponents.value.length === 0) return null;
  return nearestOpponent(origin, observation.opponents.value);
}

function nearestOpponent(origin: BlockPosition, opponents: readonly VisibleOpponent[]): VisibleOpponent {
  let best = opponents[0]!;
  let bestDistance = squaredDistance(origin, best.position);
  for (const opponent of opponents.slice(1)) {
    const distance = squaredDistance(origin, opponent.position);
    if (distance < bestDistance || (distance === bestDistance && opponent.id < best.id)) {
      best = opponent;
      bestDistance = distance;
    }
  }
  return best;
}

function inMelee(agent: AgentState, opponent: VisibleOpponent): boolean {
  if (agent.combat !== undefined && opponent.combat !== undefined) {
    return isWithinMeleeReach(agent.combat, opponent.combat);
  }
  return squaredDistance(agent.position, opponent.position) <= MELEE_LIMIT;
}

function orbitBlock(agent: BlockPosition, opponent: BlockPosition): BlockPosition {
  const step = perpendicular(agent.x - opponent.x, agent.z - opponent.z);
  const placed = place(opponent, step.x, agent.y - opponent.y, step.z);
  if (placed.x !== agent.x || placed.y !== agent.y || placed.z !== agent.z) return placed;
  return place(opponent, -step.x, agent.y - opponent.y, -step.z);
}

function perpendicular(dx: number, dz: number): { readonly x: number; readonly z: number } {
  const radius = MELEE_REACH_BLOCKS;
  if (dx === 0 && dz === 0) return { x: radius, z: 0 };
  if (dx === 0) return { x: dz > 0 ? -radius : radius, z: 0 };
  if (dz === 0) return { x: 0, z: dx > 0 ? radius : -radius };
  const len = Math.hypot(dx, dz);
  const px = Math.round((-dz / len) * radius);
  const pz = Math.round((dx / len) * radius);
  if (px === 0 && pz === 0) return { x: radius, z: 0 };
  return { x: px, z: pz };
}

function kiteBlock(agent: BlockPosition, opponent: BlockPosition): BlockPosition {
  if (squaredDistance(agent, opponent) > MELEE_LIMIT) return agent;
  return away(agent, opponent, MELEE_REACH_BLOCKS + 1);
}

function away(agent: BlockPosition, opponent: BlockPosition, blocks: number): BlockPosition {
  const dx = agent.x - opponent.x;
  const dz = agent.z - opponent.z;
  if (dx === 0 && dz === 0) return place(agent, blocks, 0, 0);
  if (Math.abs(dx) >= Math.abs(dz)) return place(agent, dx > 0 ? blocks : -blocks, 0, 0);
  return place(agent, 0, 0, dz > 0 ? blocks : -blocks);
}

function place(position: BlockPosition, dx: number, dy: number, dz: number): BlockPosition {
  const next = offsetBlockPosition(position, dx, dy, dz);
  return next.ok ? next.value : blockPosition(position.x, position.y, position.z);
}

function remember(memory: PolicyMemory, goal: Goal): PolicyMemory {
  return policyMemory({
    lastGoal: goal,
    lastOpponent: memory.lastOpponent,
    failedTargets: memory.failedTargets,
    ...(memory.knowledge === undefined ? {} : { knowledge: memory.knowledge }),
  });
}

function navigate(target: BlockPosition): Intent {
  return Object.freeze({ kind: 'navigate', target });
}

function attack(target: EntityId): Intent {
  return Object.freeze({ kind: 'attack', target });
}

function approach(target: EntityId): Intent {
  return Object.freeze({ kind: 'approach', target });
}

function hold(reason: WaitReason): Intent {
  return Object.freeze({ kind: 'hold', reason });
}
