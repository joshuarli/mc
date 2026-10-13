import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentObservation,
  agentState,
  blockPosition,
  civilizationObservation,
  civilizationOutpostCells,
  civilizationPolicyContext,
  civilizationProfileForSeat,
  CivilizationObservationError,
  currentKnowledge,
  createPolicyFeedback,
  decideCivilization,
  civilizationTeamMessage,
  emptyEquipment,
  emptyPolicyMemory,
  entityId,
  materialStack,
  observationSequence,
  outpostCell,
  PolicyParams,
  policyFeedbackBatch,
  RandomStream,
  DeterministicRandom,
  seatId,
  storedMaterialStack,
  tick,
  unknownKnowledge,
  worldBorder,
  visibleDrop,
  visibleOpponent,
  type AgentObservationInput,
  type CivilizationPolicyContext,
  type CivilizationResourceObservation,
  type CivilizationTeamMessage,
  type MaterialStack,
} from '../src/index.js';

const params = PolicyParams.baseline();
const random = () => DeterministicRandom.forStream(456n, RandomStream.search(seatId(0)));

const baseInput = (options: {
  readonly at?: number;
  readonly position?: ReturnType<typeof blockPosition>;
  readonly opponents?: AgentObservationInput['opponents'];
  readonly loot?: AgentObservationInput['loot'];
} = {}): AgentObservationInput => ({
  tick: tick(options.at ?? 20),
  sequence: observationSequence((options.at ?? 20) + 1),
  agent: currentKnowledge(agentState({
    position: options.position ?? blockPosition(0, 64, 0),
    healthHalfHearts: 40,
    hungerPoints: 20,
    foodStacks: [],
    equipped: emptyEquipment(),
    upgrades: [],
  })),
  border: currentKnowledge(worldBorder(0, 0, 96)),
  opponents: options.opponents ?? currentKnowledge([]),
  loot: options.loot ?? currentKnowledge([]),
});

const makeContext = (
  seat = 0,
  role?: 'gatherer_crafter' | 'builder' | 'defender_scout',
  objective = {
    captureBox: { min: blockPosition(10, 64, 10), max: blockPosition(12, 66, 12) },
    outpost: {
      blueprintId: 'oak-outpost-v1' as const,
      anchor: blockPosition(30, 64, 30),
      rotationDegrees: 0 as const,
    },
  },
): CivilizationPolicyContext => {
  const profile = civilizationProfileForSeat(seat);
  if (profile === null) throw new RangeError('unsupported civilization seat in test fixture');
  return civilizationPolicyContext({
    seat: profile.seat,
    faction: profile.faction,
    role: role ?? profile.role,
    objective,
  });
};

const makeObservation = (
  context: CivilizationPolicyContext,
  options: {
    readonly at?: number;
    readonly position?: ReturnType<typeof blockPosition>;
    readonly opponents?: AgentObservationInput['opponents'];
    readonly loot?: AgentObservationInput['loot'];
    readonly ownMaterials?: ReturnType<typeof currentKnowledge<readonly MaterialStack[]>>;
    readonly observedResources?: ReturnType<typeof currentKnowledge<readonly CivilizationResourceObservation[]>>;
    readonly teamMessages?: readonly CivilizationTeamMessage[];
  } = {},
) => civilizationObservation({
  base: agentObservation(baseInput(options)),
  ownMaterials: options.ownMaterials ?? currentKnowledge([]),
  observedResources: options.observedResources ?? currentKnowledge([]),
  teamMessages: options.teamMessages ?? [],
}, context);

test('civilization seat profiles use the closed role and faction mapping', () => {
  deepStrictEqual(civilizationProfileForSeat(0), { seat: 0, faction: 'ember', role: 'gatherer_crafter' });
  deepStrictEqual(civilizationProfileForSeat(1), { seat: 1, faction: 'ember', role: 'builder' });
  deepStrictEqual(civilizationProfileForSeat(2), { seat: 2, faction: 'ember', role: 'defender_scout' });
  deepStrictEqual(civilizationProfileForSeat(3), { seat: 3, faction: 'tide', role: 'gatherer_crafter' });
  deepStrictEqual(civilizationProfileForSeat(4), { seat: 4, faction: 'tide', role: 'builder' });
  deepStrictEqual(civilizationProfileForSeat(5), { seat: 5, faction: 'tide', role: 'defender_scout' });
  equal(civilizationProfileForSeat(6), null);
  equal(civilizationProfileForSeat(255), null);
});

test('outpost layout has fifteen canonical cells and both quarter-turn fixtures', () => {
  const north = civilizationOutpostCells(blockPosition(30, 64, 30), 0);
  const south = civilizationOutpostCells(blockPosition(30, 64, 30), 180);

  equal(north.length, 15);
  equal(new Set(north.map((cell) => `${cell.position.x},${cell.position.y},${cell.position.z}`)).size, 15);
  equal(north.filter((cell) => cell.layer === 'floor').length, 9);
  equal(north.filter((cell) => cell.layer === 'pillar').length, 6);
  deepStrictEqual(
    north.map((cell) => cell.position),
    south.map((cell) => cell.position),
    'the two opposing corner pillars are invariant under a 180 degree rotation',
  );
  deepStrictEqual(north[0]?.supportPosition, blockPosition(30, 63, 30));
  deepStrictEqual(north[9]?.supportPosition, north[0]?.position);
});

test('gatherer mines only a current, locally observed oak log block', () => {
  const context = makeContext();
  const target = blockPosition(2, 64, 0);
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      ownMaterials: currentKnowledge([]),
      observedResources: currentKnowledge([{ kind: 'logBlock', position: target }]),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.goal, { kind: 'gatherMaterial', item: 'oak_log', target });
  deepStrictEqual(decision.intent, { kind: 'mineBlock', position: target, expectedBlock: 'oak_log' });
});

test('same-faction sightings only steer navigation until the resource is locally observed', () => {
  const context = makeContext();
  const target = blockPosition(2, 64, 0);
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      ownMaterials: currentKnowledge([]),
      teamMessages: [civilizationTeamMessage({
        sender: seatId(1),
        sourceTick: tick(20),
        declaredStale: false,
        kind: 'resourceSighting',
        resource: 'oakLogBlock',
        position: target,
      })],
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.goal, { kind: 'gatherMaterial', item: 'oak_log', target });
  deepStrictEqual(decision.intent, { kind: 'navigate', target });
});

test('team sightings reject another faction, future ticks, expired reports, and an oversized queue', () => {
  const context = makeContext();
  const report = (sender: number, sourceTick: number) => civilizationTeamMessage({
    sender,
    sourceTick,
    declaredStale: false,
    kind: 'resourceSighting',
    resource: 'oakLogBlock',
    position: blockPosition(4, 64, 0),
  });

  throws(
    () => makeObservation(context, { teamMessages: [report(3, 20)] }),
    (error) => error instanceof CivilizationObservationError && error.code === 'message-from-other-faction',
  );
  throws(
    () => makeObservation(context, { teamMessages: [report(1, 21)] }),
    (error) => error instanceof CivilizationObservationError && error.code === 'future-message',
  );
  throws(
    () => makeObservation(context, { at: 221, teamMessages: [report(1, 20)] }),
    (error) => error instanceof CivilizationObservationError && error.code === 'expired-message',
  );
  throws(
    () => makeObservation(context, { teamMessages: Array.from({ length: 17 }, () => report(1, 20)) }),
    (error) => error instanceof CivilizationObservationError && error.code === 'invalid-team-queue',
  );
});

test('gatherer crafts exactly sixteen planks from four current oak logs', () => {
  const context = makeContext();
  const logs = [0, 1, 2, 3].map((slot) => materialStack(slot, 'oak_log', 1));
  const decision = decideCivilization(
    context,
    makeObservation(context, { ownMaterials: currentKnowledge(logs) }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.goal, { kind: 'craftMaterial', item: 'oak_planks', resultCount: 16 });
  deepStrictEqual(decision.intent, {
    kind: 'craft',
    output: 'oak_planks',
    resultCount: 16,
    table: null,
  });
});

test('unknown inventory does not become an empty inventory or trigger mining', () => {
  const context = makeContext();
  const target = blockPosition(2, 64, 0);
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      ownMaterials: unknownKnowledge(),
      observedResources: currentKnowledge([{ kind: 'logBlock', position: target }]),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.intent, { kind: 'hold', reason: 'materialsUnknown' });
});

test('builder places one supported, currently observed missing outpost cell', () => {
  const context = makeContext(1);
  const cells = civilizationOutpostCells(context.objective.outpost.anchor, 0);
  const resources = cells.map((cell) => outpostCell(cell.position, 'air', 'solid'));
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      position: blockPosition(30, 64, 30),
      ownMaterials: currentKnowledge([materialStack(5, 'oak_planks', 16)]),
      observedResources: currentKnowledge(resources),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );
  const first = cells[0];

  if (first === undefined) throw new RangeError('outpost test fixture has no cells');
  deepStrictEqual(decision.goal, {
    kind: 'buildOutpost',
    blueprintId: 'oak-outpost-v1',
    cellIndex: 0,
    target: first.position,
  });
  deepStrictEqual(decision.intent, {
    kind: 'placeBlock',
    target: first.position,
    referencePosition: first.supportPosition,
    face: 'up',
    item: 'oak_planks',
  });
});

test('builder never places into an unknown or obstructed blueprint cell', () => {
  const context = makeContext(1);
  const cells = civilizationOutpostCells(context.objective.outpost.anchor, 0);
  const resources = cells.map((cell, index) => outpostCell(
    cell.position,
    index === 0 ? 'unloaded' : 'air',
    index === 0 ? 'unknown' : 'solid',
  ));
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      ownMaterials: currentKnowledge([materialStack(5, 'oak_planks', 16)]),
      observedResources: currentKnowledge(resources),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.intent, { kind: 'navigate', target: cells[0]?.position });
});

test('gatherer and builder transfer exact observed plank counts through a local chest window', () => {
  const gatherer = makeContext(0);
  const chest = blockPosition(1, 64, 0);
  const deposit = decideCivilization(
    gatherer,
    makeObservation(gatherer, {
      ownMaterials: currentKnowledge([materialStack(4, 'oak_planks', 16)]),
      observedResources: currentKnowledge([{
        kind: 'container', position: chest, contents: currentKnowledge([]),
      }]),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(deposit.intent, {
    kind: 'containerTransfer', position: chest, direction: 'deposit', item: 'oak_planks', count: 16,
  });

  const builder = makeContext(1);
  const anchor = builder.objective.outpost.anchor;
  const resources: CivilizationResourceObservation[] = [
    outpostCell(anchor, 'air', 'solid'),
    {
      kind: 'container',
      position: blockPosition(31, 64, 30),
      contents: currentKnowledge([storedMaterialStack(0, 'oak_planks', 16)]),
    },
  ];
  const withdraw = decideCivilization(
    builder,
    makeObservation(builder, {
      position: anchor,
      ownMaterials: currentKnowledge([]),
      observedResources: currentKnowledge(resources),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(withdraw.intent, {
    kind: 'containerTransfer', position: blockPosition(31, 64, 30),
    direction: 'withdraw', item: 'oak_planks', count: 16,
  });
});

test('defender navigates to and holds the neutral capture box', () => {
  const context = makeContext(2);
  const center = blockPosition(11, 65, 11);
  const outside = decideCivilization(
    context,
    makeObservation(context, { position: blockPosition(0, 64, 0) }),
    emptyPolicyMemory(),
    params,
    random(),
  );
  const inside = decideCivilization(
    context,
    makeObservation(context, { position: center }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(outside.goal, { kind: 'captureZone', target: center });
  deepStrictEqual(outside.intent, { kind: 'navigate', target: center });
  deepStrictEqual(inside.goal, { kind: 'holdCaptureZone' });
  deepStrictEqual(inside.intent, { kind: 'hold', reason: 'captureZoneOccupied' });
});

test('visible combat still takes priority over a civilization role task', () => {
  const context = makeContext();
  const target = blockPosition(1, 64, 0);
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      opponents: currentKnowledge([{
        id: entityId(9),
        position: target,
        attackingAgent: false,
      }]),
      observedResources: currentKnowledge([{ kind: 'logBlock', position: blockPosition(2, 64, 0) }]),
      ownMaterials: currentKnowledge([]),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.intent, { kind: 'attack', target: entityId(9) });
});

test('civilization resource tasks can use a locally observed resource before generic chest looting', () => {
  const context = makeContext();
  const target = blockPosition(2, 64, 0);
  const decision = decideCivilization(
    context,
    makeObservation(context, {
      loot: currentKnowledge([{ kind: 'unopenedContainer', position: blockPosition(1, 64, 0) }]),
      observedResources: currentKnowledge([{ kind: 'logBlock', position: target }]),
    }),
    emptyPolicyMemory(),
    params,
    random(),
  );

  deepStrictEqual(decision.intent, { kind: 'mineBlock', position: target, expectedBlock: 'oak_log' });
});

test('civilization context rejects noncanonical role, faction, and leaked scenario fields', () => {
  const base = {
    seat: seatId(0),
    faction: 'ember' as const,
    role: 'gatherer_crafter' as const,
    objective: {
      captureBox: { min: blockPosition(10, 64, 10), max: blockPosition(12, 66, 12) },
      outpost: { blueprintId: 'oak-outpost-v1' as const, anchor: blockPosition(30, 64, 30), rotationDegrees: 0 as const },
    },
  };

  throws(() => civilizationPolicyContext({ ...base, role: 'builder' }));
  throws(() => civilizationPolicyContext({ ...base, faction: 'tide' }));
  throws(() => civilizationPolicyContext({ ...base, map: { hiddenBlocks: [] } } as never));
});

test('civilization forwards current policy feedback while preserving combat priority', () => {
  const context = makeContext();
  const drop = visibleDrop(entityId(33), blockPosition(5, 64, 0), { kind: 'food' });
  const initiatingObservation = makeObservation(context, {
    loot: currentKnowledge([drop]),
  });
  const first = decideCivilization(
    context,
    initiatingObservation,
    emptyPolicyMemory(),
    params,
    random(),
  );
  if (first.goal.kind !== 'loot' || first.intent.kind !== 'navigate') {
    throw new TypeError('visible food should produce a baseline loot navigation');
  }
  const feedback = createPolicyFeedback({
    initiatingObservation: initiatingObservation.base,
    goal: first.goal,
    intent: first.intent,
    outcome: { kind: 'failed', cause: 'noProgress' },
  });
  if (feedback === null) throw new TypeError('failed loot should produce policy feedback');

  const combat = decideCivilization(
    context,
    makeObservation(context, {
      at: 21,
      loot: currentKnowledge([drop]),
      opponents: currentKnowledge([{
        id: entityId(9),
        position: blockPosition(1, 64, 0),
        attackingAgent: false,
      }]),
      observedResources: currentKnowledge([{ kind: 'logBlock', position: blockPosition(2, 64, 0) }]),
    }),
    first.memory,
    params,
    random(),
    policyFeedbackBatch([feedback]),
  );

  deepStrictEqual(combat.goal, { kind: 'engageVisibleOpponent', target: entityId(9) });
  deepStrictEqual(combat.intent, { kind: 'attack', target: entityId(9) });
  deepStrictEqual(combat.memory.failedTargets, [feedback.target]);
});
