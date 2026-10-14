import assert from "node:assert/strict";
import test from "node:test";

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  emptyEquipment,
  entityId,
  observationSequence,
  tick,
  unopenedContainer,
  visibleOpponent,
  worldBorder,
  type AgentObservation,
  type LootOpportunity,
  type VisibleOpponent,
} from "@arena/core";

import { assertSamePolicyObservation } from "./fairness-oracle.js";

test("fairness oracle rejects a leaked hidden opponent or chest target", () => {
  const completeObservation = makeObservation(1);
  assertSamePolicyObservation(
    completeObservation,
    makeObservation(2),
    "sequence changes do not change policy inputs",
  );

  const leakedOpponent = makeObservation(2, {
    opponents: [visibleOpponent(entityId(2), blockPosition(115, 65, 64), false)],
  });
  assert.throws(
    () => assertSamePolicyObservation(completeObservation, leakedOpponent, "opponent leak must fail"),
  );

  const leakedChest = makeObservation(2, {
    loot: [unopenedContainer(blockPosition(114, 65, 64))],
  });
  assert.throws(
    () => assertSamePolicyObservation(completeObservation, leakedChest, "chest leak must fail"),
  );
});

function makeObservation(
  sequence: number,
  fields: {
    readonly opponents?: readonly VisibleOpponent[];
    readonly loot?: readonly LootOpportunity[];
  } = {},
): AgentObservation {
  return agentObservation({
    tick: tick(0),
    sequence: observationSequence(sequence),
    agent: currentKnowledge(agentState({
      position: blockPosition(12, 65, 64),
      healthHalfHearts: 20,
      hungerPoints: 20,
      foodStacks: [],
      equipped: emptyEquipment(),
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(64, 64, 40)),
    opponents: currentKnowledge(fields.opponents ?? []),
    loot: currentKnowledge(fields.loot ?? []),
  });
}
