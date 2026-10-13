import { deepStrictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  entityId,
  emptyEquipment,
  foodStack,
  ObservationValidationError,
  observationSequence,
  staleKnowledge,
  tick,
  unknownKnowledge,
  visibleOpponent,
  worldBorder,
  type AgentObservationInput,
} from '../src/index.js';

const validInput = (): AgentObservationInput => ({
  tick: tick(10),
  sequence: observationSequence(1),
  agent: currentKnowledge(agentState({
    position: blockPosition(0, 64, 0),
    healthHalfHearts: 40,
    hungerPoints: 20,
    foodStacks: [],
    equipped: emptyEquipment(),
    upgrades: [],
  })),
  border: currentKnowledge(worldBorder(0, 0, 100)),
  opponents: currentKnowledge([]),
  loot: unknownKnowledge(),
});

test('observation sequences must be nonzero and agent values stay bounded', () => {
  throws(() => observationSequence(0));
  throws(() => agentState({
    position: blockPosition(0, 64, 0),
    healthHalfHearts: 41,
    hungerPoints: 20,
    foodStacks: [],
    equipped: emptyEquipment(),
    upgrades: [],
  }));
});

test('stale fields must describe an earlier tick', () => {
  const input: AgentObservationInput = {
    ...validInput(),
    opponents: staleKnowledge([], tick(10)),
  };

  throws(
    () => agentObservation(input),
    (error) => error instanceof ObservationValidationError
      && error.code === 'stale-sample-not-older'
      && error.field === 'opponents',
  );
});

test('opponent lists reject duplicate entity IDs', () => {
  const opponent = visibleOpponent(entityId(7), blockPosition(1, 64, 0), false);
  const input: AgentObservationInput = {
    ...validInput(),
    opponents: currentKnowledge([opponent, opponent]),
  };

  throws(
    () => agentObservation(input),
    (error) => error instanceof ObservationValidationError
      && error.code === 'duplicate-opponent-id'
      && error.field === 'opponents',
  );
});

test('confirmed armor remains represented by independent equipment slots', () => {
  const equipped = {
    ...emptyEquipment(),
    helmet: 1,
    leggings: 3,
  } as const;
  const state = agentState({
    position: blockPosition(0, 64, 0),
    healthHalfHearts: 40,
    hungerPoints: 20,
    foodStacks: [],
    equipped,
    upgrades: [],
  });

  deepStrictEqual(state.equipped, {
    weapon: null,
    helmet: 1,
    chestplate: null,
    leggings: 3,
    boots: null,
  });
});

test('confirmed food stacks retain inventory slot and count', () => {
  const state = agentState({
    position: blockPosition(0, 64, 0),
    healthHalfHearts: 40,
    hungerPoints: 20,
    foodStacks: [foodStack(7, 3)],
    equipped: emptyEquipment(),
    upgrades: [],
  });

  deepStrictEqual(state.foodStacks, [{ inventorySlot: 7, count: 3 }]);
});

test('loot identity distinguishes drop entities from chest block positions', () => {
  const input: AgentObservationInput = {
    ...validInput(),
    loot: currentKnowledge([
      { kind: 'visibleDrop', entityId: entityId(12), position: blockPosition(1, 64, 0), item: { kind: 'food' } },
      { kind: 'unopenedContainer', position: blockPosition(2, 64, 0) },
    ]),
  };

  const observation = agentObservation(input);

  deepStrictEqual(observation.loot, input.loot);
});

test('loot lists reject repeated chest block positions', () => {
  const position = blockPosition(2, 64, 0);
  const input: AgentObservationInput = {
    ...validInput(),
    loot: currentKnowledge([
      { kind: 'unopenedContainer', position },
      { kind: 'unopenedContainer', position },
    ]),
  };

  throws(
    () => agentObservation(input),
    (error) => error instanceof ObservationValidationError
      && error.code === 'duplicate-container-position'
      && error.field === 'loot',
  );
});
