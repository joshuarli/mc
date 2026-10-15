import { deepStrictEqual, equal, notDeepStrictEqual, ok, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  CANDIDATE_IDS,
  CANDIDATE_PARAMETER_RANGES,
  CANDIDATE_TUNABLES,
  candidateDefaults,
  compileCandidate,
  coordinateSearchProposals,
  currentKnowledge,
  decide,
  decideOpening,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  equipmentUpgrade,
  foodStack,
  InvalidCandidateError,
  observationSequence,
  openingPolicyState,
  PolicyParams,
  randomSearchProposals,
  RandomStream,
  seatId,
  tick,
  unopenedContainer,
  visibleOpponent,
  worldBorder,
  type AgentObservation,
  type CandidateId,
  type EquipmentSlot,
  type EquipmentSnapshot,
} from '../src/index.js';

interface Scenario {
  readonly tick: number;
  readonly position: readonly [number, number, number];
  readonly healthHalfHearts: number;
  readonly hungerPoints: number;
  readonly foodStacks: readonly (readonly [number, number])[];
  readonly equipped: EquipmentSnapshot;
  readonly upgrades: readonly (readonly [number, EquipmentSlot, number])[];
  readonly border: { readonly centerX: number; readonly centerZ: number; readonly radiusBlocks: number };
  readonly opponents: readonly { readonly id: number; readonly position: readonly [number, number, number]; readonly attackingAgent: boolean }[];
  readonly loot: readonly { readonly position: readonly [number, number, number] }[];
  readonly randomSeed: string;
}

const scenarios = JSON.parse(readFileSync(
  resolve(process.cwd(), 'fixtures/policy-curriculum/observations.json'),
  'utf8',
)) as Record<string, Scenario>;

const pos = (value: readonly [number, number, number]) => blockPosition(value[0], value[1], value[2]);

function fixtureObservation(scenario: Scenario): AgentObservation {
  return agentObservation({
    tick: tick(scenario.tick),
    sequence: observationSequence(scenario.tick + 1),
    agent: currentKnowledge(agentState({
      position: pos(scenario.position),
      healthHalfHearts: scenario.healthHalfHearts,
      hungerPoints: scenario.hungerPoints,
      foodStacks: scenario.foodStacks.map(([slot, count]) => foodStack(slot, count)),
      equipped: scenario.equipped,
      upgrades: scenario.upgrades.map(([slot, equipmentSlot, rating]) => equipmentUpgrade(slot, equipmentSlot, rating)),
    })),
    border: currentKnowledge(worldBorder(scenario.border.centerX, scenario.border.centerZ, scenario.border.radiusBlocks)),
    opponents: currentKnowledge(scenario.opponents.map((opponent) => (
      visibleOpponent(entityId(opponent.id), pos(opponent.position), opponent.attackingAgent)
    ))),
    loot: currentKnowledge(scenario.loot.map((opportunity) => unopenedContainer(pos(opportunity.position)))),
  });
}

interface Setup {
  readonly health?: number;
  readonly hunger?: number;
  readonly position?: readonly [number, number, number];
  readonly foods?: readonly ReturnType<typeof foodStack>[];
  readonly arrows?: number;
  readonly opponents?: readonly { readonly id: number; readonly at: readonly [number, number, number]; readonly attacking?: boolean }[];
  readonly containers?: readonly (readonly [number, number, number])[];
  readonly weapon?: number | null;
}

function situation(setup: Setup): AgentObservation {
  return agentObservation({
    tick: tick(300),
    sequence: observationSequence(301),
    agent: currentKnowledge(agentState({
      position: pos(setup.position ?? [0, 64, 0]),
      ...(setup.arrows === undefined ? {} : { ranged: { arrows: setup.arrows } }),
      healthHalfHearts: setup.health ?? 40,
      hungerPoints: setup.hunger ?? 20,
      foodStacks: setup.foods ?? [],
      equipped: { ...emptyEquipment(), weapon: setup.weapon === undefined ? 1 : setup.weapon },
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge((setup.opponents ?? []).map((opponent) => (
      visibleOpponent(entityId(opponent.id), pos(opponent.at), opponent.attacking ?? false)
    ))),
    loot: currentKnowledge((setup.containers ?? []).map((container) => unopenedContainer(pos(container)))),
  });
}

const stream = (seed = 7n) => DeterministicRandom.forStream(seed, RandomStream.policy(seatId(0)));
const ask = (id: CandidateId, observation: AgentObservation) => compileCandidate(id).decide(
  observation,
  emptyPolicyMemory(),
  stream(),
);
const baselineAsk = (observation: AgentObservation) => decide(
  observation,
  emptyPolicyMemory(),
  PolicyParams.baseline(),
  stream(),
);

test('the frozen baseline candidate decides byte-identically to the core baseline on every recorded scenario', () => {
  const baseline = compileCandidate('baseline');
  for (const [name, scenario] of Object.entries(scenarios)) {
    const observation = fixtureObservation(scenario);
    const seed = BigInt(scenario.randomSeed);
    const expected = decide(observation, emptyPolicyMemory(), PolicyParams.baseline(), new DeterministicRandom(seed));
    const actual = baseline.decide(observation, emptyPolicyMemory(), new DeterministicRandom(seed));
    equal(JSON.stringify(actual), JSON.stringify(expected), name);
    for (const style of ['explorer', 'scavenger', 'hunter'] as const) {
      const context = { style, state: openingPolicyState({ cacheTakenAt: null }) };
      equal(
        JSON.stringify(baseline.decideOpening(observation, emptyPolicyMemory(), new DeterministicRandom(seed), [], context)),
        JSON.stringify(decideOpening(observation, emptyPolicyMemory(), PolicyParams.baseline(), new DeterministicRandom(seed), [], context)),
        `${name}/${style}`,
      );
    }
  }
});

test('candidate parameters are bounded, versioned and semantically identified', () => {
  for (const id of CANDIDATE_IDS) {
    const compiled = compileCandidate(id);
    equal(compiled.version, 1);
    ok(compiled.semanticId.startsWith(`${id}@1/`));
    for (const name of CANDIDATE_TUNABLES) {
      const range = CANDIDATE_PARAMETER_RANGES[name];
      ok(compiled.params[name] >= range.min && compiled.params[name] <= range.max, `${id}.${name}`);
    }
  }
  equal(new Set(CANDIDATE_IDS.map((id) => compileCandidate(id).semanticId)).size, CANDIDATE_IDS.length);
  throws(() => compileCandidate('ranged-kiter', { kiteRangeBlocks: 9 }), InvalidCandidateError);
  throws(() => compileCandidate('ranged-kiter', { speed: 1 }), InvalidCandidateError);
  throws(() => compileCandidate('baseline', { retreatAtHealthHalfHeartsOrBelow: 9 }), InvalidCandidateError);
  throws(() => compileCandidate('nope' as CandidateId), InvalidCandidateError);
  equal(compileCandidate('cautious-survivor', { retreatAtHealthHalfHeartsOrBelow: 16 }).params.retreatAtHealthHalfHeartsOrBelow, 16);
});

test('cautious-survivor retreats at a health the baseline still fights from', () => {
  const observation = situation({ health: 12, opponents: [{ id: 5, at: [2, 64, 0], attacking: true }] });
  equal(baselineAsk(observation).goal.kind, 'engageVisibleOpponent');
  equal(ask('cautious-survivor', observation).goal.kind, 'retreatFromOpponent');
});

test('cautious-survivor leaves the border earlier than the baseline', () => {
  const observation = situation({ position: [96, 64, 0] });
  notDeepStrictEqual(baselineAsk(observation).goal.kind, 'escapeBorder');
  equal(ask('cautious-survivor', observation).goal.kind, 'escapeBorder');
});

test('equipment-skirmisher takes a visible cache before engaging a bystander the baseline would fight', () => {
  const observation = situation({
    weapon: null,
    opponents: [{ id: 5, at: [4, 64, 0] }],
    containers: [[0, 64, 2]],
  });
  equal(baselineAsk(observation).goal.kind, 'engageVisibleOpponent');
  const skirmisher = ask('equipment-skirmisher', observation);
  equal(skirmisher.goal.kind, 'loot');
  const attacked = situation({
    weapon: null,
    opponents: [{ id: 5, at: [4, 64, 0], attacking: true }],
    containers: [[0, 64, 2]],
  });
  equal(ask('equipment-skirmisher', attacked).goal.kind, 'engageVisibleOpponent');
});

test('melee-duelist engages from farther away than the baseline', () => {
  const observation = situation({ opponents: [{ id: 5, at: [6, 64, 0] }] });
  notDeepStrictEqual(baselineAsk(observation).goal.kind, 'engageVisibleOpponent');
  deepStrictEqual(ask('melee-duelist', observation).intent, { kind: 'approach', target: 5 });
});

test('ranged-kiter backs away from a close opponent only while it holds arrows', () => {
  const close = { opponents: [{ id: 5, at: [2, 64, 0] as const }] };
  const armed = situation({ ...close, arrows: 12 });
  equal(baselineAsk(armed).intent.kind, 'attack');
  const kiting = ask('ranged-kiter', armed);
  equal(kiting.goal.kind, 'retreatFromOpponent');
  deepStrictEqual(kiting.intent, { kind: 'navigate', target: blockPosition(-4, 64, 0) });
  const dry = situation({ ...close, arrows: 0 });
  equal(ask('ranged-kiter', dry).goal.kind, 'engageVisibleOpponent');
});

test('every candidate keeps border escape and eating ahead of tactical bias', () => {
  for (const id of CANDIDATE_IDS) {
    const outside = situation({ position: [101, 64, 0], opponents: [{ id: 5, at: [100, 64, 0], attacking: true }], arrows: 5 });
    equal(ask(id, outside).goal.kind, 'escapeBorder', id);
    const hungry = situation({ hunger: 1, foods: [foodStack(9, 3)] });
    equal(ask(id, hungry).goal.kind, 'recoverHunger', id);
  }
});

test('candidates use only the observation they are given', () => {
  const visible = situation({ opponents: [{ id: 5, at: [3, 64, 0] }], containers: [[0, 64, 2]], arrows: 4 });
  for (const id of CANDIDATE_IDS) {
    const first = ask(id, visible);
    const second = ask(id, visible);
    equal(JSON.stringify(second), JSON.stringify(first), id);
  }
});

test('search proposals are deterministic, bounded, valid and never move the frozen baseline', () => {
  const start = candidateDefaults('cautious-survivor');
  const first = coordinateSearchProposals('cautious-survivor', start, 99n, 0, 6);
  const again = coordinateSearchProposals('cautious-survivor', start, 99n, 0, 6);
  deepStrictEqual(first, again);
  ok(first.length >= 1 && first.length <= 6);
  for (const proposal of first) {
    deepStrictEqual(proposal, compileCandidate('cautious-survivor', proposal).params);
    notDeepStrictEqual(proposal, start);
  }
  notDeepStrictEqual(coordinateSearchProposals('cautious-survivor', start, 100n, 0, 6), first);
  const sampled = randomSearchProposals('ranged-kiter', 5n, 10);
  equal(sampled.length, 10);
  deepStrictEqual(sampled, randomSearchProposals('ranged-kiter', 5n, 10));
  throws(() => coordinateSearchProposals('baseline', candidateDefaults('baseline'), 1n, 0, 4), InvalidCandidateError);
  throws(() => randomSearchProposals('baseline', 1n, 4), InvalidCandidateError);
});

test('policy-v6 search proposals leave tactical-only parameters unchanged', () => {
  const start = candidateDefaults('frontier-v1');
  const proposals = [
    ...coordinateSearchProposals('frontier-v1', start, 500_001n, 0, 12),
    ...randomSearchProposals('frontier-v1', 500_001n, 12),
  ];
  ok(proposals.length > 0);
  for (const proposal of proposals) {
    equal(proposal.lootFirstRangeBlocks, start.lootFirstRangeBlocks);
    equal(proposal.kiteRangeBlocks, start.kiteRangeBlocks);
    deepStrictEqual(proposal, compileCandidate('frontier-v1', proposal).params);
  }
});

test('baseline@1 decisions on every recorded scenario match the committed golden record', () => {
  const golden = JSON.parse(readFileSync(
    resolve(process.cwd(), 'fixtures/policy-curriculum/baseline-v1-golden.json'),
    'utf8',
  )) as Record<string, unknown>;
  const baseline = compileCandidate('baseline');
  const actual: Record<string, unknown> = {};
  for (const [name, scenario] of Object.entries(scenarios)) {
    const observation = fixtureObservation(scenario);
    const seed = BigInt(scenario.randomSeed);
    actual[name] = baseline.decide(observation, emptyPolicyMemory(), new DeterministicRandom(seed));
    for (const style of ['explorer', 'scavenger', 'hunter'] as const) {
      const context = { style, state: openingPolicyState({ cacheTakenAt: null }) };
      actual[`${name}/${style}`] = baseline.decideOpening(
        observation, emptyPolicyMemory(), new DeterministicRandom(seed), [], context,
      );
    }
  }
  deepStrictEqual(JSON.parse(JSON.stringify(actual)), golden);
});
