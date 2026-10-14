import assert from "node:assert/strict";

import type { AgentObservation } from "@arena/core";

export function assertSamePolicyObservation(
  first: AgentObservation,
  second: AgentObservation,
  message: string,
): void {
  assert.deepStrictEqual(policyInputs(first), policyInputs(second), message);
}

function policyInputs(observation: AgentObservation) {
  return {
    tick: observation.tick,
    agent: observation.agent,
    border: observation.border,
    opponents: observation.opponents,
    loot: observation.loot,
  };
}
