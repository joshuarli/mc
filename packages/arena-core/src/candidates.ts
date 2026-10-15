import { isNearOrOutsideBorder, offsetBlockPosition, squaredDistance, type BlockPosition } from './geometry.js';
import {
  agentObservation,
  currentKnowledge,
  type AgentObservation,
  type AgentState,
  type VisibleOpponent,
} from './observation.js';
import {
  PolicyParams,
  decide,
  decideOpening,
  policyMemory,
  type Decision,
  type Goal,
  type OpeningDecision,
  type OpeningPolicyContext,
  type OpeningPolicyState,
  type OpeningStyle,
  type PolicyFeedbackBatch,
  type PolicyMemory,
  type PolicyParamValues,
} from './policy.js';
import {
  baselineExplanation,
  decideOpeningV5,
  decideV5,
  type DecisionExplanation,
  type ExplainedDecision,
  type ExplainedOpeningDecision,
} from './policy-v5.js';
import { frontierDecisionExplanation, stepAgent, type AgentStep, type AgentStepInput } from './policy-v6.js';
import { DeterministicRandom, RandomStream } from './random.js';

export const CANDIDATE_IDS = [
  'baseline',
  'cautious-survivor',
  'equipment-skirmisher',
  'melee-duelist',
  'ranged-kiter',
  'improved',
  'frontier-v1',
] as const;

export type CandidateId = typeof CANDIDATE_IDS[number];
export type CandidateImplementationId = 'policy-v4' | 'policy-v5' | 'tactical-v1' | 'policy-v6';

export const CANDIDATE_TUNABLES = [
  'eatAtHungerOrBelow',
  'retreatAtHealthHalfHeartsOrBelow',
  'borderMarginBlocks',
  'fightRangeBlocks',
  'opponentMemoryTicks',
  'lootHysteresisBlocks',
  'searchRadiusBlocks',
  'lootFirstRangeBlocks',
  'kiteRangeBlocks',
] as const;

export type CandidateTunable = typeof CANDIDATE_TUNABLES[number];
export type CandidateParamValues = Readonly<Record<CandidateTunable, number>>;

export const CANDIDATE_PARAMETER_RANGES: Readonly<Record<CandidateTunable, { readonly min: number; readonly max: number }>> =
  Object.freeze({
    eatAtHungerOrBelow: Object.freeze({ min: 1, max: 20 }),
    retreatAtHealthHalfHeartsOrBelow: Object.freeze({ min: 1, max: 39 }),
    borderMarginBlocks: Object.freeze({ min: 0, max: 8 }),
    fightRangeBlocks: Object.freeze({ min: 1, max: 8 }),
    opponentMemoryTicks: Object.freeze({ min: 1, max: 100 }),
    lootHysteresisBlocks: Object.freeze({ min: 0, max: 16 }),
    searchRadiusBlocks: Object.freeze({ min: 1, max: 16 }),
    lootFirstRangeBlocks: Object.freeze({ min: 0, max: 8 }),
    kiteRangeBlocks: Object.freeze({ min: 0, max: 4 }),
  });

interface CandidateDefinition {
  readonly version: number;
  readonly implementation: CandidateImplementationId;
  readonly defaults: CandidateParamValues;
}

const KITE_STEP_BLOCKS = 4;

const DEFINITIONS: Readonly<Record<CandidateId, CandidateDefinition>> = Object.freeze({
  baseline: Object.freeze({
    version: 1,
    implementation: 'policy-v4' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 8,
      retreatAtHealthHalfHeartsOrBelow: 8,
      borderMarginBlocks: 2,
      fightRangeBlocks: 4,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 2,
      searchRadiusBlocks: 8,
      lootFirstRangeBlocks: 0,
      kiteRangeBlocks: 0,
    }),
  }),
  improved: Object.freeze({
    version: 1,
    implementation: 'policy-v5' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 8,
      retreatAtHealthHalfHeartsOrBelow: 8,
      borderMarginBlocks: 2,
      fightRangeBlocks: 4,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 2,
      searchRadiusBlocks: 8,
      lootFirstRangeBlocks: 0,
      kiteRangeBlocks: 0,
    }),
  }),
  'cautious-survivor': Object.freeze({
    version: 1,
    implementation: 'tactical-v1' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 12,
      retreatAtHealthHalfHeartsOrBelow: 14,
      borderMarginBlocks: 4,
      fightRangeBlocks: 3,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 2,
      searchRadiusBlocks: 8,
      lootFirstRangeBlocks: 0,
      kiteRangeBlocks: 0,
    }),
  }),
  'equipment-skirmisher': Object.freeze({
    version: 1,
    implementation: 'tactical-v1' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 8,
      retreatAtHealthHalfHeartsOrBelow: 10,
      borderMarginBlocks: 2,
      fightRangeBlocks: 4,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 6,
      searchRadiusBlocks: 12,
      lootFirstRangeBlocks: 2,
      kiteRangeBlocks: 0,
    }),
  }),
  'melee-duelist': Object.freeze({
    version: 1,
    implementation: 'tactical-v1' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 6,
      retreatAtHealthHalfHeartsOrBelow: 5,
      borderMarginBlocks: 2,
      fightRangeBlocks: 7,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 1,
      searchRadiusBlocks: 8,
      lootFirstRangeBlocks: 0,
      kiteRangeBlocks: 0,
    }),
  }),
  'ranged-kiter': Object.freeze({
    version: 1,
    implementation: 'tactical-v1' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 8,
      retreatAtHealthHalfHeartsOrBelow: 9,
      borderMarginBlocks: 3,
      fightRangeBlocks: 4,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 4,
      searchRadiusBlocks: 10,
      lootFirstRangeBlocks: 3,
      kiteRangeBlocks: 3,
    }),
  }),
  'frontier-v1': Object.freeze({
    version: 1,
    implementation: 'policy-v6' as const,
    defaults: Object.freeze({
      eatAtHungerOrBelow: 8,
      retreatAtHealthHalfHeartsOrBelow: 8,
      borderMarginBlocks: 2,
      fightRangeBlocks: 4,
      opponentMemoryTicks: 100,
      lootHysteresisBlocks: 2,
      searchRadiusBlocks: 8,
      lootFirstRangeBlocks: 0,
      kiteRangeBlocks: 0,
    }),
  }),
});

export interface CompiledCandidate {
  readonly id: CandidateId;
  readonly version: number;
  readonly implementation: CandidateImplementationId;
  readonly params: CandidateParamValues;
  readonly semanticId: string;
  decide(
    observation: AgentObservation,
    memory: PolicyMemory,
    random: DeterministicRandom,
    feedback?: PolicyFeedbackBatch,
  ): Decision;
  decideOpening(
    observation: AgentObservation,
    memory: PolicyMemory,
    random: DeterministicRandom,
    feedback: PolicyFeedbackBatch,
    context: OpeningPolicyContext,
  ): OpeningDecision;
  explain(
    observation: AgentObservation,
    memory: PolicyMemory,
    random: DeterministicRandom,
    feedback?: PolicyFeedbackBatch,
  ): ExplainedDecision;
  explainOpening(
    observation: AgentObservation,
    memory: PolicyMemory,
    random: DeterministicRandom,
    feedback: PolicyFeedbackBatch,
    context: OpeningPolicyContext,
  ): ExplainedOpeningDecision;
}

export interface CompiledFrontierCandidate extends CompiledCandidate {
  readonly id: 'frontier-v1';
  step(input: FrontierStepInput): AgentStep;
  stepOpening(input: FrontierOpeningStepInput): AgentStep;
}

export type FrontierStepInput = Pick<AgentStepInput, 'observation' | 'memory' | 'random' | 'feedback' | 'task'>;

export interface FrontierOpeningStepInput extends FrontierStepInput {
  readonly style: OpeningStyle;
  readonly openingState: OpeningPolicyState;
}

export class InvalidCandidateError extends RangeError {
  constructor(readonly code: 'unknown-candidate' | 'unknown-parameter' | 'parameter-out-of-range' | 'frozen-candidate', detail: string) {
    super(`invalid candidate: ${code}: ${detail}`);
    this.name = 'InvalidCandidateError';
  }
}

export function candidateDefaults(id: CandidateId): CandidateParamValues {
  return definition(id).defaults;
}

export function candidateVersion(id: CandidateId): number {
  return definition(id).version;
}

export function candidateSemanticId(id: CandidateId, params: CandidateParamValues): string {
  const entry = definition(id);
  const values = CANDIDATE_TUNABLES.map((name) => `${name}=${params[name]}`).join(',');
  return `${id}@${entry.version}/${entry.implementation}/${values}`;
}

export function validateCandidateParams(
  id: CandidateId,
  overrides: Readonly<Partial<Record<string, number>>> = {},
): CandidateParamValues {
  const entry = definition(id);
  const merged: Record<CandidateTunable, number> = { ...entry.defaults };
  for (const [name, value] of Object.entries(overrides)) {
    if (!(CANDIDATE_TUNABLES as readonly string[]).includes(name)) {
      throw new InvalidCandidateError('unknown-parameter', name);
    }
    const range = CANDIDATE_PARAMETER_RANGES[name as CandidateTunable];
    if (!Number.isSafeInteger(value) || value! < range.min || value! > range.max) {
      throw new InvalidCandidateError('parameter-out-of-range', `${name}=${String(value)}`);
    }
    merged[name as CandidateTunable] = value!;
  }
  if (id === 'baseline') {
    for (const name of CANDIDATE_TUNABLES) {
      if (merged[name] !== entry.defaults[name]) throw new InvalidCandidateError('frozen-candidate', name);
    }
  }
  if (entry.implementation !== 'tactical-v1' && (merged.lootFirstRangeBlocks !== 0 || merged.kiteRangeBlocks !== 0)) {
    throw new InvalidCandidateError('frozen-candidate', `${entry.implementation} has no tactical knobs`);
  }
  return Object.freeze(merged);
}

export function compileCandidate(
  id: 'frontier-v1',
  overrides?: Readonly<Partial<Record<string, number>>>,
): CompiledFrontierCandidate;
export function compileCandidate(
  id: CandidateId,
  overrides?: Readonly<Partial<Record<string, number>>>,
): CompiledCandidate;
export function compileCandidate(
  id: CandidateId,
  overrides: Readonly<Partial<Record<string, number>>> = {},
): CompiledCandidate {
  const entry = definition(id);
  const params = validateCandidateParams(id, overrides);
  const policyParams = PolicyParams.create(policyValues(params));
  const implementation = IMPLEMENTATIONS[entry.implementation];
  const compiled: CompiledCandidate = {
    id,
    version: entry.version,
    implementation: entry.implementation,
    params,
    semanticId: candidateSemanticId(id, params),
    decide: (observation, memory, random, feedback = []) => (
      implementation.decide(observation, memory, policyParams, params, random, feedback)
    ),
    decideOpening: (observation, memory, random, feedback, context) => (
      implementation.decideOpening(observation, memory, policyParams, params, random, feedback, context)
    ),
    explain: (observation, memory, random, feedback = []) => (
      implementation.explain(observation, memory, policyParams, params, random, feedback)
    ),
    explainOpening: (observation, memory, random, feedback, context) => (
      implementation.explainOpening(observation, memory, policyParams, params, random, feedback, context)
    ),
  };
  if (id !== 'frontier-v1') return Object.freeze(compiled);
  return Object.freeze({
    ...compiled,
    step: (input: FrontierStepInput) => stepAgent({ ...input, params: policyParams }),
    stepOpening: (input: FrontierOpeningStepInput) => stepAgent({ ...input, params: policyParams }),
  });
}

interface CandidateImplementation {
  decide(
    observation: AgentObservation,
    memory: PolicyMemory,
    policyParams: PolicyParams,
    params: CandidateParamValues,
    random: DeterministicRandom,
    feedback: PolicyFeedbackBatch,
  ): Decision;
  decideOpening(
    observation: AgentObservation,
    memory: PolicyMemory,
    policyParams: PolicyParams,
    params: CandidateParamValues,
    random: DeterministicRandom,
    feedback: PolicyFeedbackBatch,
    context: OpeningPolicyContext,
  ): OpeningDecision;
  explain(
    observation: AgentObservation,
    memory: PolicyMemory,
    policyParams: PolicyParams,
    params: CandidateParamValues,
    random: DeterministicRandom,
    feedback: PolicyFeedbackBatch,
  ): ExplainedDecision;
  explainOpening(
    observation: AgentObservation,
    memory: PolicyMemory,
    policyParams: PolicyParams,
    params: CandidateParamValues,
    random: DeterministicRandom,
    feedback: PolicyFeedbackBatch,
    context: OpeningPolicyContext,
  ): ExplainedOpeningDecision;
}

type PlainImplementation = Pick<CandidateImplementation, 'decide' | 'decideOpening'>;

function withBaselineExplanations(plain: PlainImplementation): CandidateImplementation {
  return {
    ...plain,
    explain: (observation, memory, policyParams, params, random, feedback) => {
      const decision = plain.decide(observation, memory, policyParams, params, random, feedback);
      return Object.freeze({ decision, explanation: baselineExplanation(observation, decision) });
    },
    explainOpening: (observation, memory, policyParams, params, random, feedback, context) => {
      const decision = plain.decideOpening(observation, memory, policyParams, params, random, feedback, context);
      return Object.freeze({ decision, explanation: baselineExplanation(observation, decision) });
    },
  };
}

const IMPLEMENTATIONS: Readonly<Record<CandidateImplementationId, CandidateImplementation>> = {
  'policy-v4': withBaselineExplanations({
    decide: (observation, memory, policyParams, _params, random, feedback) => (
      decide(observation, memory, policyParams, random, feedback)
    ),
    decideOpening: (observation, memory, policyParams, _params, random, feedback, context) => (
      decideOpening(observation, memory, policyParams, random, feedback, context)
    ),
  }),
  'policy-v5': {
    decide: (observation, memory, policyParams, _params, random, feedback) => (
      decideV5(observation, memory, policyParams, random, feedback).decision
    ),
    decideOpening: (observation, memory, policyParams, _params, random, feedback, context) => (
      decideOpeningV5(observation, memory, policyParams, random, feedback, context).decision
    ),
    explain: (observation, memory, policyParams, _params, random, feedback) => (
      decideV5(observation, memory, policyParams, random, feedback)
    ),
    explainOpening: (observation, memory, policyParams, _params, random, feedback, context) => (
      decideOpeningV5(observation, memory, policyParams, random, feedback, context)
    ),
  },
  'tactical-v1': withBaselineExplanations({
    decide: (observation, memory, policyParams, params, random, feedback) => {
      const decision = decide(lootFirstView(observation, params), memory, policyParams, random, feedback);
      return kite(observation, decision, params, policyParams.values);
    },
    decideOpening: (observation, memory, policyParams, params, random, feedback, context) => {
      const decision = decideOpening(lootFirstView(observation, params), memory, policyParams, random, feedback, context);
      const kited = kite(observation, decision, params, policyParams.values);
      return kited === decision ? decision : Object.freeze({ ...kited, openingState: decision.openingState });
    },
  }),
  'policy-v6': {
    decide: (observation, memory, policyParams, _params, random, feedback) => stepAgent({
      observation, memory, params: policyParams, random, feedback, task: null,
    }).decision,
    decideOpening: (observation, memory, policyParams, _params, random, feedback, context) => {
      const step = stepAgent({
        observation, memory, params: policyParams, random, feedback, task: null,
        style: context.style, openingState: context.state,
      });
      return Object.freeze({ ...step.decision, openingState: step.openingState });
    },
    explain: (observation, memory, policyParams, _params, random, feedback) => {
      const step = stepAgent({
        observation, memory, params: policyParams, random, feedback, task: null,
      });
      return Object.freeze({ decision: step.decision, explanation: frontierDecisionExplanation(step) });
    },
    explainOpening: (observation, memory, policyParams, _params, random, feedback, context) => {
      const step = stepAgent({
        observation, memory, params: policyParams, random, feedback, task: null,
        style: context.style, openingState: context.state,
      });
      return Object.freeze({
        decision: Object.freeze({ ...step.decision, openingState: step.openingState }),
        explanation: frontierDecisionExplanation(step),
      });
    },
  },
};

function lootFirstView(observation: AgentObservation, params: CandidateParamValues): AgentObservation {
  const range = params.lootFirstRangeBlocks;
  if (range === 0 || observation.agent.kind !== 'current' || observation.opponents.kind !== 'current'
      || observation.loot.kind !== 'current' || observation.loot.value.length === 0) {
    return observation;
  }
  const agent = observation.agent.value;
  const limit = BigInt(range) ** 2n;
  const kept = observation.opponents.value.filter((opponent) => (
    opponent.attackingAgent || squaredDistance(agent.position, opponent.position) <= limit
  ));
  if (kept.length === observation.opponents.value.length) return observation;
  return agentObservation({
    tick: observation.tick,
    sequence: observation.sequence,
    agent: observation.agent,
    border: observation.border,
    opponents: currentKnowledge(kept),
    loot: observation.loot,
  });
}

function kite<T extends Decision>(
  observation: AgentObservation,
  decision: T,
  params: CandidateParamValues,
  policy: PolicyParamValues,
): T {
  const range = params.kiteRangeBlocks;
  if (range === 0 || decision.goal.kind !== 'engageVisibleOpponent') return decision;
  if (observation.agent.kind !== 'current' || observation.opponents.kind !== 'current'
      || observation.border.kind !== 'current') return decision;
  const agent = observation.agent.value;
  if (agent.ranged === undefined || agent.ranged.arrows < 1) return decision;
  if (isNearOrOutsideBorder(observation.border.value, agent.position, policy.borderMarginBlocks)) return decision;
  const threat = nearestWithin(agent, observation.opponents.value, range);
  if (threat === null) return decision;
  const retreat = awayFrom(agent.position, threat.position);
  if (retreat === null) return decision;
  const goal: Goal = Object.freeze({ kind: 'retreatFromOpponent', target: threat.id });
  return Object.freeze({
    ...decision,
    goal,
    intent: Object.freeze({ kind: 'navigate', target: retreat }),
    memory: policyMemory({ ...decision.memory, lastGoal: goal }),
  }) as T;
}

function nearestWithin(agent: AgentState, opponents: readonly VisibleOpponent[], range: number): VisibleOpponent | null {
  const limit = BigInt(range) ** 2n;
  let best: VisibleOpponent | null = null;
  let bestDistance = 0n;
  for (const opponent of opponents) {
    const distance = squaredDistance(agent.position, opponent.position);
    if (distance > limit) continue;
    if (best === null || distance < bestDistance || (distance === bestDistance && opponent.id < best.id)) {
      best = opponent;
      bestDistance = distance;
    }
  }
  return best;
}

function awayFrom(position: BlockPosition, threat: BlockPosition): BlockPosition | null {
  let dx = Math.sign(position.x - threat.x);
  const dz = Math.sign(position.z - threat.z);
  if (dx === 0 && dz === 0) dx = 1;
  const moved = offsetBlockPosition(position, dx * KITE_STEP_BLOCKS, 0, dz * KITE_STEP_BLOCKS);
  return moved.ok ? moved.value : null;
}

function policyValues(params: CandidateParamValues): PolicyParamValues {
  return {
    version: 1,
    eatAtHungerOrBelow: params.eatAtHungerOrBelow,
    retreatAtHealthHalfHeartsOrBelow: params.retreatAtHealthHalfHeartsOrBelow,
    borderMarginBlocks: params.borderMarginBlocks,
    fightRangeBlocks: params.fightRangeBlocks,
    opponentMemoryTicks: params.opponentMemoryTicks,
    lootHysteresisBlocks: params.lootHysteresisBlocks,
    searchRadiusBlocks: params.searchRadiusBlocks,
  };
}

function definition(id: CandidateId): CandidateDefinition {
  const entry = (DEFINITIONS as Record<string, CandidateDefinition | undefined>)[id];
  if (entry === undefined) throw new InvalidCandidateError('unknown-candidate', String(id));
  return entry;
}

const SEARCH_ROUNDS_MAX = 8;

export function coordinateSearchProposals(
  id: CandidateId,
  current: CandidateParamValues,
  seed: bigint,
  round: number,
  maxProposals: number,
): readonly CandidateParamValues[] {
  if (id === 'baseline') throw new InvalidCandidateError('frozen-candidate', 'baseline is not tunable');
  if (!Number.isSafeInteger(round) || round < 0 || round >= SEARCH_ROUNDS_MAX) {
    throw new RangeError(`search round must be between 0 and ${SEARCH_ROUNDS_MAX - 1}`);
  }
  if (!Number.isSafeInteger(maxProposals) || maxProposals < 1 || maxProposals > 64) {
    throw new RangeError('maxProposals must be between 1 and 64');
  }
  const random = DeterministicRandom.forStream(seed, RandomStream.setup());
  for (let skip = 0; skip < round * 7; skip += 1) random.nextU64();
  const order = shuffled(CANDIDATE_TUNABLES, random);
  const seen = new Set<string>([candidateSemanticId(id, current)]);
  const proposals: CandidateParamValues[] = [];
  for (const name of order) {
    const range = CANDIDATE_PARAMETER_RANGES[name];
    const step = Math.max(1, Math.round((range.max - range.min) / 2 ** (round + 3)));
    for (const direction of [1, -1] as const) {
      const value = Math.min(range.max, Math.max(range.min, current[name] + direction * step));
      if (value === current[name]) continue;
      const candidate = validateCandidateParams(id, { ...current, [name]: value });
      const key = candidateSemanticId(id, candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push(candidate);
      if (proposals.length >= maxProposals) return Object.freeze(proposals);
    }
  }
  return Object.freeze(proposals);
}

export function randomSearchProposals(
  id: CandidateId,
  seed: bigint,
  count: number,
): readonly CandidateParamValues[] {
  if (id === 'baseline') throw new InvalidCandidateError('frozen-candidate', 'baseline is not tunable');
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new RangeError('count must be between 1 and 64');
  const random = DeterministicRandom.forStream(seed, RandomStream.setup());
  const proposals: CandidateParamValues[] = [];
  for (let index = 0; index < count; index += 1) {
    const sampled: Record<string, number> = {};
    for (const name of CANDIDATE_TUNABLES) {
      const range = CANDIDATE_PARAMETER_RANGES[name];
      sampled[name] = range.min + Number(random.nextU64() % BigInt(range.max - range.min + 1));
    }
    proposals.push(validateCandidateParams(id, sampled));
  }
  return Object.freeze(proposals);
}

function shuffled<T>(values: readonly T[], random: DeterministicRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Number(random.nextU64() % BigInt(index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export interface DecisionDiffInput {
  readonly label: string;
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly random: () => DeterministicRandom;
  readonly feedback?: PolicyFeedbackBatch;
}

export interface DecisionDiffSide {
  readonly goal: Goal['kind'];
  readonly intent: Decision['intent']['kind'];
  readonly reason: DecisionExplanation['reason'];
  readonly explanation: DecisionExplanation;
}

export interface DecisionDiffEntry {
  readonly label: string;
  readonly tick: number;
  readonly baseline: DecisionDiffSide;
  readonly improved: DecisionDiffSide;
}

export interface DecisionDiffReport {
  readonly compared: number;
  readonly entries: readonly DecisionDiffEntry[];
}

export function decisionDiff(
  baselineCandidate: CompiledCandidate,
  improvedCandidate: CompiledCandidate,
  inputs: readonly DecisionDiffInput[],
): DecisionDiffReport {
  const entries: DecisionDiffEntry[] = [];
  for (const input of inputs) {
    const feedback = input.feedback ?? [];
    const first = baselineCandidate.explain(input.observation, input.memory, input.random(), feedback);
    const second = improvedCandidate.explain(input.observation, input.memory, input.random(), feedback);
    if (JSON.stringify(first.decision) === JSON.stringify(second.decision)) continue;
    entries.push(Object.freeze({
      label: input.label,
      tick: input.observation.tick,
      baseline: diffSide(first),
      improved: diffSide(second),
    }));
  }
  return Object.freeze({ compared: inputs.length, entries: Object.freeze(entries) });
}

function diffSide(explained: ExplainedDecision): DecisionDiffSide {
  return Object.freeze({
    goal: explained.decision.goal.kind,
    intent: explained.decision.intent.kind,
    reason: explained.explanation.reason,
    explanation: explained.explanation,
  });
}
