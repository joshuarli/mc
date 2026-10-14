import {
  decide,
  decideOpening,
  normalizeOpeningPolicyReplayInput,
  normalizePolicyReplayInput,
  type AgentObservation,
  type Decision,
  type DeterministicRandom,
  type OpeningPolicyContext,
  type OpeningPolicyState,
  type OpeningStyle as CoreOpeningStyle,
  type OpeningStyleCycle as CoreOpeningStyleCycle,
  type PolicyMemory,
  type PolicyParams,
  type PolicyReplayInputV2,
  type PolicyFeedbackBatch,
} from '@arena/core';

export interface RuntimePolicyDecision {
  readonly input: PolicyReplayInputV2;
  readonly decision: Decision;
  readonly rngStateAfter: bigint;
}

export interface RuntimeOpeningPolicyDecision {
  readonly input: import('@arena/core').PolicyReplayInputV3;
  readonly decision: Decision;
  readonly openingState: OpeningPolicyState;
  readonly rngStateAfter: bigint;
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
  const input = normalizePolicyReplayInput({ observation, memory, params, random, feedback });
  const decision = decide(observation, memory, params, random, feedback);
  return Object.freeze({ input, decision, rngStateAfter: random.snapshotState() });
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
  const input = normalizeOpeningPolicyReplayInput({ observation, memory, feedback, params, random,
    opening: { seed: assignment.seed, style: assignment.style, cycle: assignment.cycle, state: assignment.state } });
  const result = decideOpening(observation, memory, params, random, feedback, opening);
  const { openingState, ...decision } = result;
  return Object.freeze({ input, decision, openingState, rngStateAfter: random.snapshotState() });
}
