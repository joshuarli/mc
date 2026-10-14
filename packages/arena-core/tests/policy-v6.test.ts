import { deepStrictEqual, equal, notDeepStrictEqual, ok } from 'node:assert/strict';
import { test } from 'node:test';

import {
  CANDIDATE_IDS,
  DeterministicRandom,
  FRONTIER_GOALS,
  PolicyParams,
  RandomStream,
  agentObservation,
  agentState,
  blockPosition,
  compileCandidate,
  currentKnowledge,
  decide,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  equipmentUpgrade,
  foodStack,
  observationSequence,
  openingPolicyState,
  seatId,
  staleKnowledge,
  stepAgent,
  tick,
  unknownKnowledge,
  unopenedContainer,
  visibleOpponent,
  worldBorder,
  type AgentObservation,
  type AgentStep,
  type FrontierTask,
  type PolicyFeedbackBatch,
} from '../src/index.js';

const params = PolicyParams.baseline();
const memory = emptyPolicyMemory();
const stream = (seed = 11n) => DeterministicRandom.forStream(seed, RandomStream.policy(seatId(0)));

const foreignLoot: PolicyFeedbackBatch = [{
  kind: 'succeeded',
  target: {
    kind: 'loot',
    target: { kind: 'container', position: blockPosition(9000, 64, 9000) },
    opportunity: unopenedContainer(blockPosition(9000, 64, 9000)),
  },
}];

function observe(input: {
  readonly at?: readonly [number, number, number];
  readonly tick?: number;
  readonly health?: number;
  readonly hunger?: number;
  readonly food?: boolean;
  readonly weapon?: number | null;
  readonly upgrade?: boolean;
  readonly radius?: number;
  readonly opponents?: 'current' | 'stale' | 'unknown';
  readonly opponentAt?: readonly [number, number, number];
  readonly attacking?: boolean;
  readonly loot?: readonly [number, number, number] | null;
  readonly arrows?: number;
}): AgentObservation {
  const at = input.at ?? [0, 64, 0];
  const now = input.tick ?? 300;
  const opponents = input.opponentAt === undefined ? [] : [visibleOpponent(
    entityId(5),
    blockPosition(input.opponentAt[0], input.opponentAt[1], input.opponentAt[2]),
    input.attacking ?? false,
  )];
  const knowledge = input.opponents ?? 'current';
  return agentObservation({
    tick: tick(now),
    sequence: observationSequence(now),
    agent: currentKnowledge(agentState({
      position: blockPosition(at[0], at[1], at[2]),
      ...(input.arrows === undefined ? {} : { ranged: { arrows: input.arrows } }),
      healthHalfHearts: input.health ?? 40,
      hungerPoints: input.hunger ?? 20,
      foodStacks: input.food === false ? [] : [foodStack(4, 2)],
      equipped: { ...emptyEquipment(), weapon: input.weapon === undefined ? 1 : input.weapon },
      upgrades: input.upgrade === true ? [equipmentUpgrade(2, 'weapon', 3)] : [],
    })),
    border: currentKnowledge(worldBorder(0, 0, input.radius ?? 100)),
    opponents: knowledge === 'unknown'
      ? unknownKnowledge()
      : knowledge === 'stale'
        ? staleKnowledge(opponents, tick(now - 1))
        : currentKnowledge(opponents),
    loot: input.loot === undefined || input.loot === null
      ? currentKnowledge([])
      : currentKnowledge([unopenedContainer(blockPosition(input.loot[0], input.loot[1], input.loot[2]))]),
  });
}

function act(observation: AgentObservation, task: FrontierTask | null = null, seed = 11n, style?: 'explorer' | 'scavenger' | 'hunter'): AgentStep {
  return stepAgent({
    observation,
    memory,
    params,
    random: stream(seed),
    feedback: [],
    task,
    openingState: openingPolicyState({ cacheTakenAt: null }),
    ...(style === undefined ? {} : { style }),
  });
}

function selected(step: AgentStep) {
  const proposal = step.explanation.proposals.find((entry) => entry.rejection === null);
  if (proposal === undefined) throw new Error('expected a selected proposal');
  return proposal;
}

test('improved delegates to the baseline when the v5 override does not fire', () => {
  deepStrictEqual([...CANDIDATE_IDS], [
    'baseline',
    'cautious-survivor',
    'equipment-skirmisher',
    'melee-duelist',
    'ranged-kiter',
    'improved',
    'frontier-v1',
  ]);
  equal(compileCandidate('baseline').implementation, 'policy-v4');
  equal(compileCandidate('improved').implementation, 'policy-v5');
  equal(compileCandidate('frontier-v1').implementation, 'policy-v6');
  const observation = observe({ weapon: null, upgrade: true, food: false, hunger: 20, health: 40 });
  const improved = compileCandidate('improved');
  deepStrictEqual(
    improved.decide(observation, memory, stream()),
    decide(observation, memory, PolicyParams.baseline(), stream()),
  );
  equal(improved.explain(observation, memory, stream()).explanation.reason, 'delegatedBaselineRules');
});

test('frontier-v1 diverges across opening styles that improved ignores', () => {
  const observation = observe({
    loot: [0, 64, 3],
    opponentAt: [10, 64, 0],
    health: 40,
    hunger: 20,
  });
  const improved = compileCandidate('improved');
  const hunterState = openingPolicyState({ cacheTakenAt: null });
  const scavengerState = openingPolicyState({ cacheTakenAt: null });
  const hunter = improved.decideOpening(observation, memory, stream(), [], { style: 'hunter', state: hunterState });
  const scavenger = improved.decideOpening(observation, memory, stream(), [], { style: 'scavenger', state: scavengerState });
  deepStrictEqual(hunter.goal, scavenger.goal);
  deepStrictEqual(hunter.intent, scavenger.intent);
  equal(hunter.openingState, hunterState);
  equal(scavenger.openingState, scavengerState);
  const frontier = compileCandidate('frontier-v1');
  const hunting = frontier.decideOpening(observation, memory, stream(), [], { style: 'hunter', state: hunterState });
  const scavenging = frontier.decideOpening(observation, memory, stream(), [], { style: 'scavenger', state: scavengerState });
  notDeepStrictEqual(
    { goal: hunting.goal, intent: hunting.intent },
    { goal: scavenging.goal, intent: scavenging.intent },
  );
  equal(hunting.goal.kind, 'engageVisibleOpponent');
  equal(hunting.intent.kind, 'approach');
  equal(scavenging.goal.kind, 'loot');
  equal(scavenging.intent.kind, 'containerOpen');
});

test('frontier-v1 selects the scored proposal', () => {
  const border = act(observe({ at: [120, 64, 0], hunger: 1, health: 40 }));
  equal(selected(border).goal, 'escapeBorder');
  equal(border.decision.goal.kind, 'escapeBorder');
  equal(border.decision.intent.kind, 'navigate');
  ok(border.explanation.proposals.some((proposal) => proposal.goal === 'heal' && proposal.rejection === 'outranked'));
  ok(border.explanation.proposals.every((proposal) => (
    proposal.goal === selected(border).goal || proposal.utility < selected(border).utility
  )));
  equal(new Set(border.explanation.proposals.map((proposal) => proposal.goal)).size, border.explanation.proposals.length);
  ok(border.explanation.proposals.every((proposal) => (FRONTIER_GOALS as readonly string[]).includes(proposal.goal)));

  const heal = act(observe({ hunger: 1, health: 40 }));
  equal(selected(heal).goal, 'heal');
  deepStrictEqual(heal.decision.goal, { kind: 'recoverHunger' });
  deepStrictEqual(heal.decision.intent, { kind: 'eat', inventorySlot: 4 });
  equal(heal.explanation.proposals.some((proposal) => proposal.goal === 'engage'), false);

  const lethal = act(observe({
    health: 4,
    hunger: 20,
    opponentAt: [2, 64, 0],
    attacking: true,
    loot: [0, 64, 2],
  }));
  equal(selected(lethal).goal, 'engage');
  equal(lethal.task?.mode.kind, 'engaging');
  if (lethal.task?.mode.kind === 'engaging') equal(lethal.task.mode.side, 'evade');
  equal(lethal.decision.goal.kind, 'retreatFromOpponent');
  equal(lethal.decision.intent.kind, 'navigate');
  ok(lethal.explanation.proposals.some((proposal) => proposal.goal === 'loot' && proposal.utility < selected(lethal).utility));

  const stale = act(observe({ opponents: 'stale', opponentAt: [2, 64, 0], attacking: true, health: 40 }));
  const unknown = act(observe({ opponents: 'unknown', health: 40 }));
  equal(stale.decision.intent.kind === 'attack' || stale.decision.intent.kind === 'shoot', false);
  equal(unknown.decision.intent.kind === 'attack' || unknown.decision.intent.kind === 'shoot', false);

  const explore = act(observe({ hunger: 20, health: 40 }));
  equal(selected(explore).goal, 'explore');
  const committed = act(observe({ tick: 301, hunger: 20, health: 40, loot: [0, 64, 2] }), explore.task, 19n);
  equal(committed.restarted, false);
  equal(committed.task?.goal, 'explore');
  equal(committed.task?.startedAtTick, explore.task?.startedAtTick);
  ok(committed.explanation.proposals.some((proposal) => proposal.goal === 'loot' && proposal.rejection === 'committed'));
  ok(selected(committed).utility < (committed.explanation.proposals.find((proposal) => proposal.goal === 'loot')?.utility ?? 0));

  const replaced = act(observe({
    tick: 400,
    health: 40,
    hunger: 20,
    opponentAt: [2, 64, 0],
    attacking: true,
  }), explore.task, 23n);
  equal(replaced.task?.goal, 'engage');
  const again = stream(29n);
  const state = again.snapshotState();
  const shared = {
    observation: observe({ tick: 400, health: 40, hunger: 20, opponentAt: [2, 64, 0], attacking: true }),
    memory,
    params,
    task: replaced.task,
    openingState: openingPolicyState({ cacheTakenAt: null }),
  };
  const settled = stepAgent({ ...shared, random: DeterministicRandom.fromState(state), feedback: foreignLoot });
  const plain = stepAgent({ ...shared, random: DeterministicRandom.fromState(state), feedback: [] });
  deepStrictEqual(settled.task?.mode, replaced.task?.mode);
  deepStrictEqual(settled.task, plain.task);
  deepStrictEqual(settled.commands, plain.commands);
  equal(settled.task?.startedAtTick, replaced.task?.startedAtTick);
});

test('frontier-v1 steps stay deterministic across seeded sequences', () => {
  const trace = (seed: bigint): string => {
    const random = DeterministicRandom.forStream(seed, RandomStream.policy(seatId(0)));
    let task: FrontierTask | null = null;
    let carried = memory;
    const lines: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      const observation = sequenceObservation(seed, step);
      const result = stepAgent({
        observation, memory: carried, params, random, feedback: [], task, openingState: { cacheTakenAt: null },
      });
      const intent = result.decision.intent;
      if (intent.kind === 'attack' || intent.kind === 'shoot') {
        equal(observation.opponents.kind, 'current');
        if (observation.opponents.kind === 'current') {
          ok(observation.opponents.value.some((opponent) => opponent.id === intent.target));
        }
      }
      equal(result.commands.length, 1);
      const names = result.explanation.proposals.map((proposal) => proposal.goal);
      equal(new Set(names).size, names.length);
      for (const name of names) ok((FRONTIER_GOALS as readonly string[]).includes(name));
      const winners = result.explanation.proposals.filter((proposal) => proposal.rejection === null);
      if (result.explanation.proposals.length > 0) {
        equal(winners.length, result.task === null ? 0 : 1);
        const winner = winners[0];
        if (winner !== undefined && !result.explanation.proposals.some((proposal) => proposal.rejection === 'committed')) {
          for (const proposal of result.explanation.proposals) {
            if (proposal.rejection !== 'cooldown') ok(winner.utility >= proposal.utility);
          }
        }
      }
      const continued = stepAgent({
        observation, memory: carried, params, random, feedback: [], task: result.task,
        openingState: { cacheTakenAt: null },
      });
      equal(continued.restarted, false);
      equal(continued.task?.goal, result.task?.goal);
      equal(continued.task?.startedAtTick, result.task?.startedAtTick);
      deepStrictEqual(continued.commands, result.commands);
      const fork = random.snapshotState();
      const withSettlement = stepAgent({
        observation, memory: carried, params, random: DeterministicRandom.fromState(fork), feedback: foreignLoot,
        task: result.task, openingState: { cacheTakenAt: null },
      });
      const withoutSettlement = stepAgent({
        observation, memory: carried, params, random: DeterministicRandom.fromState(fork), feedback: [],
        task: result.task, openingState: { cacheTakenAt: null },
      });
      deepStrictEqual(withSettlement.task, withoutSettlement.task);
      deepStrictEqual(withSettlement.commands, withoutSettlement.commands);
      lines.push(JSON.stringify({
        task: result.task,
        commands: result.commands,
        goal: result.decision.goal,
        intent: result.decision.intent,
      }));
      task = result.task;
      carried = result.decision.memory;
    }
    return lines.join('\n');
  };
  for (let seed = 0; seed < 100; seed += 1) {
    equal(trace(BigInt(seed)), trace(BigInt(seed)), `seed ${seed}`);
  }
});

function sequenceObservation(seed: bigint, step: number): AgentObservation {
  const random = DeterministicRandom.forStream(seed, RandomStream.search(seatId(1)));
  for (let skip = 0; skip < step * 6; skip += 1) random.nextU64();
  const now = 80 + step;
  const health = Number(random.nextU64() % 41n);
  const hunger = Number(random.nextU64() % 21n);
  const x = Number(random.nextU64() % 121n) - 60;
  const agentRoll = Number(random.nextU64() % 5n);
  const borderRoll = Number(random.nextU64() % 5n);
  const opponentRoll = Number(random.nextU64() % 3n);
  const includeLoot = Number(random.nextU64() % 2n) === 0;
  const agent = agentState({
    position: blockPosition(x, 64, 0),
    healthHalfHearts: health,
    hungerPoints: hunger,
    foodStacks: [foodStack(4, 1)],
    equipped: { ...emptyEquipment(), weapon: 1 },
    upgrades: [],
  });
  const border = worldBorder(0, 0, 40);
  const opponents = [visibleOpponent(entityId(7), blockPosition(x + 2, 64, 0), health <= 8)];
  const loot = includeLoot ? [unopenedContainer(blockPosition(x, 64, 2))] : [];
  return agentObservation({
    tick: tick(now),
    sequence: observationSequence(now),
    agent: agentRoll === 0 ? unknownKnowledge() : agentRoll === 1 ? staleKnowledge(agent, tick(now - 1)) : currentKnowledge(agent),
    border: borderRoll === 0 ? unknownKnowledge() : borderRoll === 1 ? staleKnowledge(border, tick(now - 1)) : currentKnowledge(border),
    opponents: opponentRoll === 0
      ? unknownKnowledge()
      : opponentRoll === 1 ? staleKnowledge(opponents, tick(now - 1)) : currentKnowledge(opponents),
    loot: currentKnowledge(loot),
  });
}
