import {
  decide,
  decideOpening,
  normalizeOpeningPolicyReplayInputV4,
  normalizePolicyReplayInputV4,
  PolicyParams as CorePolicyParams,
  type AgentObservation,
  type CompiledCandidate,
  compileCandidate,
  DeterministicRandom as CoreDeterministicRandom,
  type DecisionExplanation,
  type Decision,
  type DeterministicRandom,
  type OpeningPolicyContext,
  type OpeningPolicyState,
  type OpeningStyle as CoreOpeningStyle,
  type OpeningStyleCycle as CoreOpeningStyleCycle,
  type PolicyMemory,
  type PolicyParams,
  type PolicyReplayInputV4,
  type PolicyFeedbackBatch,
  explainDuelPool,
  type DuelPoolId,
} from '@arena/core';

export interface RuntimePolicyDecision {
  readonly input: PolicyReplayInputV4;
  readonly decision: Decision;
  readonly rngStateAfter: bigint;
  explanation(): DecisionExplanation;
}

export interface RuntimeOpeningPolicyDecision {
  readonly input: PolicyReplayInputV4;
  readonly decision: Decision;
  readonly openingState: OpeningPolicyState;
  readonly rngStateAfter: bigint;
  explanation(): DecisionExplanation;
}

let baselineExplainer: CompiledCandidate | undefined;
function baselineCandidate(): CompiledCandidate {
  baselineExplainer ??= compileCandidate('baseline');
  return baselineExplainer;
}

export function isStrategyDecisionTick(tick: bigint, intervalTicks: bigint): boolean {
  return tick % intervalTicks === 0n;
}

export function decideRuntimePolicy(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): RuntimePolicyDecision {
  const input = normalizePolicyReplayInputV4({ observation, memory, params, random, feedback });
  const before = random.snapshotState();
  const decision = decide(observation, memory, params, random, feedback);
  return Object.freeze({
    input, decision, rngStateAfter: random.snapshotState(),
    explanation: () => baselineCandidate().explain(observation, memory, CoreDeterministicRandom.fromState(before), feedback).explanation,
  });
}

export function decideRuntimeOpeningPolicy(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
  assignment: Readonly<{
    readonly seed: bigint;
    readonly seat: number;
    readonly style: CoreOpeningStyle;
    readonly cycle: CoreOpeningStyleCycle;
    readonly state: OpeningPolicyState;
  }>,
): RuntimeOpeningPolicyDecision {
  const opening: OpeningPolicyContext = { style: assignment.style, state: assignment.state };
  const input = normalizeOpeningPolicyReplayInputV4({ observation, memory, feedback, params, random,
    opening: { seed: assignment.seed, style: assignment.style, cycle: assignment.cycle, state: assignment.state } });
  const before = random.snapshotState();
  const result = decideOpening(observation, memory, params, random, feedback, opening);
  const { openingState, ...decision } = result;
  return Object.freeze({
    input, decision, openingState, rngStateAfter: random.snapshotState(),
    explanation: () => baselineCandidate().explainOpening(observation, memory, CoreDeterministicRandom.fromState(before),
      feedback, opening).explanation,
  });
}

const candidateParams = new Map<string, CorePolicyParams>();

export function candidatePolicyParams(candidate: CompiledCandidate): CorePolicyParams {
  let params = candidateParams.get(candidate.semanticId);
  if (params === undefined) {
    const values = candidate.params;
    params = CorePolicyParams.create({
      version: 1,
      eatAtHungerOrBelow: values.eatAtHungerOrBelow,
      retreatAtHealthHalfHeartsOrBelow: values.retreatAtHealthHalfHeartsOrBelow,
      borderMarginBlocks: values.borderMarginBlocks,
      fightRangeBlocks: values.fightRangeBlocks,
      opponentMemoryTicks: values.opponentMemoryTicks,
      lootHysteresisBlocks: values.lootHysteresisBlocks,
      searchRadiusBlocks: values.searchRadiusBlocks,
    });
    candidateParams.set(candidate.semanticId, params);
  }
  return params;
}

export function decideRuntimeCandidatePolicy(
  candidate: CompiledCandidate,
  observation: AgentObservation,
  memory: PolicyMemory,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): RuntimePolicyDecision {
  const input = normalizePolicyReplayInputV4({
    observation, memory, params: candidatePolicyParams(candidate), random, feedback,
  });
  const { decision, explanation } = candidate.explain(observation, memory, random, feedback);
  return Object.freeze({ input, decision, rngStateAfter: random.snapshotState(), explanation: () => explanation });
}

export function decideRuntimeDuelPool(
  id: DuelPoolId,
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch = [],
): RuntimePolicyDecision {
  const input = normalizePolicyReplayInputV4({ observation, memory, params, random, feedback });
  const explained = explainDuelPool(id, observation, memory, random, feedback);
  return Object.freeze({
    input, decision: explained.decision, rngStateAfter: random.snapshotState(), explanation: () => explained.explanation,
  });
}

export function decideRuntimeDuelPoolOpening(
  id: DuelPoolId,
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
  assignment: Readonly<{
    readonly seed: bigint;
    readonly seat: number;
    readonly style: CoreOpeningStyle;
    readonly cycle: CoreOpeningStyleCycle;
    readonly state: OpeningPolicyState;
  }>,
): RuntimeOpeningPolicyDecision {
  const input = normalizeOpeningPolicyReplayInputV4({
    observation, memory, feedback, params, random,
    opening: { seed: assignment.seed, style: assignment.style, cycle: assignment.cycle, state: assignment.state },
  });
  const explained = explainDuelPool(id, observation, memory, random, feedback);
  return Object.freeze({
    input, decision: explained.decision, openingState: assignment.state, rngStateAfter: random.snapshotState(),
    explanation: () => explained.explanation,
  });
}

export function decideRuntimeCandidateOpening(
  candidate: CompiledCandidate,
  observation: AgentObservation,
  memory: PolicyMemory,
  random: DeterministicRandom,
  feedback: PolicyFeedbackBatch,
  assignment: Readonly<{
    readonly seed: bigint;
    readonly seat: number;
    readonly style: CoreOpeningStyle;
    readonly cycle: CoreOpeningStyleCycle;
    readonly state: OpeningPolicyState;
  }>,
): RuntimeOpeningPolicyDecision {
  const input = normalizeOpeningPolicyReplayInputV4({
    observation, memory, feedback, params: candidatePolicyParams(candidate), random,
    opening: { seed: assignment.seed, style: assignment.style, cycle: assignment.cycle, state: assignment.state },
  });
  const explained = candidate.explainOpening(observation, memory, random, feedback,
    { style: assignment.style, state: assignment.state });
  const { openingState, ...decision } = explained.decision;
  return Object.freeze({
    input, decision, openingState, rngStateAfter: random.snapshotState(), explanation: () => explained.explanation,
  });
}
