import {
  decide,
  normalizePolicyReplayInput,
  type AgentObservation,
  type Decision,
  type DeterministicRandom,
  type PolicyMemory,
  type PolicyParams,
  type PolicyReplayInputV1,
} from '@arena/core';

export interface RuntimePolicyDecision {
  readonly input: PolicyReplayInputV1;
  readonly decision: Decision;
  readonly rngStateAfter: bigint;
}

/** Compares the public match tick to the configured cadence without rounding u64 values. */
export function isStrategyDecisionTick(tick: bigint, intervalTicks: bigint): boolean {
  return tick % intervalTicks === 0n;
}

/** Captures replay inputs before the policy consumes any exploration draws. */
export function decideRuntimePolicy(
  observation: AgentObservation,
  memory: PolicyMemory,
  params: PolicyParams,
  random: DeterministicRandom,
): RuntimePolicyDecision {
  const input = normalizePolicyReplayInput({ observation, memory, params, random });
  const decision = decide(observation, memory, params, random);
  return Object.freeze({ input, decision, rngStateAfter: random.snapshotState() });
}
