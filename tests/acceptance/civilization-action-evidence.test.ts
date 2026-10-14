import assert from "node:assert/strict";
import test from "node:test";
import {
  blockPosition,
  entityId,
  civilizationOutpostCells,
  type CivilizationGoal,
  type Goal,
  type Intent,
  type CivIntent,
} from "@arena/core";
import type { CivilizationFactionIr } from "@arena/spec";

import {
  assertBothFactionsCompletedMaterialChain,
  assertCivilizationRoleContributions,
  assertCrossFactionCombat,
  type CivilizationActionEvidence,
  type CivilizationActionLayout,
  type CivilizationFactionActionLayout,
} from "./civilization-action-evidence.js";

test("civilization usefulness requires both factions to settle the legal material chain", () => {
  const layout = actionLayout();
  assertBothFactionsCompletedMaterialChain([
    ...factionChain(0, layout.ember, 1n),
    ...factionChain(3, layout.tide, 100n),
  ], layout);
});

test("civilization usefulness ignores unsuccessful skills and requires the missing action", () => {
  const layout = actionLayout();
  const actions = [...factionChain(0, layout.ember, 1n), ...factionChain(3, layout.tide, 100n)];
  const incomplete = actions.filter((action) => !(action.seat === 3 && action.intent.kind === "craft"));

  assert.throws(
    () => assertBothFactionsCompletedMaterialChain(incomplete, layout),
    /tide must complete the four-log to sixteen-plank recipe/,
  );
});

test("civilization usefulness requires all six configured roles to contribute", () => {
  const layout = actionLayout();
  const factions = factionRoster();
  const actions = [...factionChain(0, layout.ember, 1n), ...factionChain(3, layout.tide, 100n)];
  assertCivilizationRoleContributions(actions, factions, layout);
  assert.throws(
    () => assertCivilizationRoleContributions(
      actions.filter((entry) => !(entry.seat === 5 && entry.goal.kind === "captureZone")),
      factions,
      layout,
    ),
    /tide defender\/scout must navigate to its configured capture objective/,
  );
});

test("civilization combat requires an observed opponent hit", () => {
  assertCrossFactionCombat([{ attackerSeat: 1, victimSeat: 3 }]);
  assertCrossFactionCombat([
    { attackerSeat: 0, victimSeat: 1 },
    { attackerSeat: 1, victimSeat: 3 },
  ]);
  assert.throws(() => assertCrossFactionCombat([{ attackerSeat: 0, victimSeat: 1 }]), /opposing-faction hit/);
  assert.throws(() => assertCrossFactionCombat([{ attackerSeat: 4, victimSeat: 4 }]), /same attacker and victim/);
  assert.throws(() => assertCrossFactionCombat([]), /observed player hit/);
  assert.throws(() => assertCrossFactionCombat([{ attackerSeat: 6, victimSeat: 1 }]), /invalid seat/);
});

function factionChain(
  firstSeat: number,
  layout: CivilizationFactionActionLayout,
  start: bigint,
): CivilizationActionEvidence[] {
  const actions: CivilizationActionEvidence[] = [];
  let at = start;
  for (let index = 0; index < 4; index += 1) {
    const position = layout.naturalOakLogSources[index];
    assert.ok(position);
    actions.push(action(firstSeat, at++, { kind: "gatherMaterial", item: "oak_log", target: position }, {
      kind: "mineBlock", position, expectedBlock: "oak_log",
    }));
  }
  actions.push(action(firstSeat, at++, { kind: "gatherMaterial", item: "oak_log", target: layout.naturalOakLogSources[0]! }, {
    kind: "dropCollect", entityId: entityId(80 + firstSeat),
  }));
  actions.push(action(firstSeat, at++, { kind: "craftMaterial", item: "oak_planks", resultCount: 16 }, {
    kind: "craft", output: "oak_planks", resultCount: 16, table: null,
  }));
  actions.push(action(firstSeat, at++, {
    kind: "transferMaterial", item: "oak_planks", count: 16, direction: "deposit", container: layout.chest,
  }, {
    kind: "containerTransfer", position: layout.chest, direction: "deposit", item: "oak_planks", count: 16,
  }));
  actions.push(action(firstSeat + 1, at++, {
    kind: "transferMaterial", item: "oak_planks", count: 15, direction: "withdraw", container: layout.chest,
  }, {
    kind: "containerTransfer", position: layout.chest, direction: "withdraw", item: "oak_planks", count: 15,
  }));
  for (const cell of layout.outpostCells) {
    actions.push(action(firstSeat + 1, at++, {
      kind: "buildOutpost", blueprintId: "oak-outpost-v1", cellIndex: cell.index, target: cell.position,
    }, {
      kind: "placeBlock", target: cell.position, referencePosition: cell.supportPosition, face: "up", item: "oak_planks",
    }));
  }
  actions.push(action(firstSeat + 2, at++, {
    kind: "captureZone", target: blockPosition(95, 65, 95),
  }, {
    kind: "navigate", target: blockPosition(95, 65, 95),
  }));
  return actions;
}

function factionRoster(): readonly CivilizationFactionIr[] {
  return [
    { id: "ember", members: [
      { seat: 0, role: "gatherer_crafter" },
      { seat: 1, role: "builder" },
      { seat: 2, role: "defender_scout" },
    ] },
    { id: "tide", members: [
      { seat: 3, role: "gatherer_crafter" },
      { seat: 4, role: "builder" },
      { seat: 5, role: "defender_scout" },
    ] },
  ];
}

function actionLayout(): CivilizationActionLayout {
  const sources = Array.from({ length: 4 }, (_, index) => blockPosition(54, 65 + index, 86))
    .concat(Array.from({ length: 4 }, (_, index) => blockPosition(54, 65 + index, 106)))
    .concat(Array.from({ length: 4 }, (_, index) => blockPosition(137, 65 + index, 86)))
    .concat(Array.from({ length: 4 }, (_, index) => blockPosition(137, 65 + index, 106)));
  return {
    ember: {
      naturalOakLogSources: sources.slice(0, 8),
      chest: blockPosition(30, 65, 94),
      outpostCells: civilizationOutpostCells(blockPosition(38, 65, 92), 0),
    },
    tide: {
      naturalOakLogSources: sources.slice(8),
      chest: blockPosition(161, 65, 94),
      outpostCells: civilizationOutpostCells(blockPosition(151, 65, 92), 180),
    },
  };
}

function action(
  seat: number,
  sequence: bigint,
  goal: Goal | CivilizationGoal,
  intent: Intent | CivIntent,
): CivilizationActionEvidence {
  return {
    actionSequence: sequence.toString(),
    seat,
    goal,
    intent,
    outcome: { kind: "succeeded" },
    startedAtNs: sequence * 10n,
    settledAtNs: sequence * 10n + 1n,
  };
}
