import type {
  BlockPosition,
  CivIntent,
  CivilizationFactionId,
  CivilizationGoal,
  Goal,
  Intent,
  OutpostCell,
  SkillOutcome,
} from "@arena/core";

export interface CivilizationFactionActionLayout {
  readonly naturalOakLogSources: readonly BlockPosition[];
  readonly chest: BlockPosition;
  readonly outpostCells: readonly OutpostCell[];
}

export type CivilizationActionLayout = Readonly<Record<CivilizationFactionId, CivilizationFactionActionLayout>>;

export interface CivilizationActionEvidence {
  readonly actionSequence: string;
  readonly seat: number;
  readonly goal: Goal | CivilizationGoal;
  readonly intent: Intent | CivIntent;
  readonly outcome: SkillOutcome;
  readonly startedAtNs: bigint | null;
  readonly settledAtNs: bigint;
}

export interface CivilizationCombatEngagement {
  readonly attackerSeat: number;
  readonly victimSeat: number;
}

/** Requires both fixed factions to complete the same real-material action chain. */
export function assertBothFactionsCompletedMaterialChain(
  actions: readonly CivilizationActionEvidence[],
  layout: CivilizationActionLayout,
): void {
  const actionSequences = new Set<string>();
  for (const action of actions) {
    if (!Number.isSafeInteger(action.seat) || action.seat < 0 || action.seat > 5) {
      throw new RangeError("civilization action evidence references an invalid seat");
    }
    if (action.actionSequence.length === 0 || actionSequences.has(action.actionSequence)) {
      throw new Error("civilization action evidence has an empty or repeated action sequence");
    }
    actionSequences.add(action.actionSequence);
    if (action.startedAtNs !== null && action.settledAtNs < action.startedAtNs) {
      throw new RangeError(`civilization action ${action.actionSequence} settled before it started`);
    }
  }

  assertFactionMaterialChain(actions, "ember", layout.ember);
  assertFactionMaterialChain(actions, "tide", layout.tide);
}

/** Checks client-observed hit receipts against the fixed faction roster. */
export function assertCrossFactionCombat(engagements: readonly CivilizationCombatEngagement[]): void {
  if (engagements.length === 0) throw new Error("civilization combat requires an observed player hit");
  let crossFactionHit = false;
  for (const engagement of engagements) {
    const { attackerSeat: attacker, victimSeat: victim } = engagement;
    if (![attacker, victim].every((seat) => Number.isSafeInteger(seat) && seat >= 0 && seat <= 5)) {
      throw new RangeError("civilization hit receipt references an invalid seat");
    }
    if (attacker === victim) throw new Error("civilization hit receipt has the same attacker and victim");
    if (factionForSeat(attacker) !== factionForSeat(victim)) crossFactionHit = true;
  }
  if (!crossFactionHit) throw new Error("civilization combat requires an opposing-faction hit");
}

function assertFactionMaterialChain(
  actions: readonly CivilizationActionEvidence[],
  factionName: "ember" | "tide",
  layout: CivilizationFactionActionLayout,
): void {
  if (layout.outpostCells.length !== 15) {
    throw new Error(`${factionName} outpost layout must contain the fifteen declared blueprint cells`);
  }
  const sourcePositions = new Set(layout.naturalOakLogSources.map(positionKey));
  const cellByIndex = new Map(layout.outpostCells.map((cell) => [cell.index, cell] as const));
  if (sourcePositions.size !== layout.naturalOakLogSources.length
    || cellByIndex.size !== layout.outpostCells.length
    || new Set(layout.outpostCells.map(({ position }) => positionKey(position))).size !== layout.outpostCells.length) {
    throw new Error(`${factionName} action layout contains duplicate source or blueprint positions`);
  }
  const factionActions = actions
    .filter(({ seat }) => factionForSeat(seat) === factionName)
    .filter(({ outcome }) => outcome.kind === "succeeded")
    .sort((first, second) => first.settledAtNs < second.settledAtNs ? -1
      : first.settledAtNs > second.settledAtNs ? 1 : 0);
  const mines = factionActions.filter((action) => action.intent.kind === "mineBlock"
    && action.intent.expectedBlock === "oak_log"
    && sourcePositions.has(positionKey(action.intent.position))
    && action.goal.kind === "gatherMaterial" && action.goal.item === "oak_log");
  const drops = factionActions.filter((action) => action.intent.kind === "dropCollect"
    && action.goal.kind === "gatherMaterial" && action.goal.item === "oak_log");
  const crafts = factionActions.filter((action) => action.intent.kind === "craft"
    && action.intent.output === "oak_planks" && action.intent.resultCount === 16 && action.intent.table === null
    && action.goal.kind === "craftMaterial" && action.goal.item === "oak_planks" && action.goal.resultCount === 16);
  const deposits = factionActions.filter((action) => action.intent.kind === "containerTransfer"
    && action.intent.direction === "deposit" && action.intent.item === "oak_planks" && action.intent.count > 0
    && samePosition(action.intent.position, layout.chest)
    && action.goal.kind === "transferMaterial" && action.goal.direction === "deposit" && action.goal.item === "oak_planks"
    && samePosition(action.goal.container, layout.chest));
  const withdrawals = factionActions.filter((action) => action.intent.kind === "containerTransfer"
    && action.intent.direction === "withdraw" && action.intent.item === "oak_planks" && action.intent.count > 0
    && samePosition(action.intent.position, layout.chest)
    && action.goal.kind === "transferMaterial" && action.goal.direction === "withdraw" && action.goal.item === "oak_planks"
    && samePosition(action.goal.container, layout.chest));
  const placements = factionActions.flatMap((action) => {
    if (action.intent.kind !== "placeBlock" || action.intent.item !== "oak_planks"
      || action.goal.kind !== "buildOutpost" || action.goal.blueprintId !== "oak-outpost-v1") return [];
    const expectedCell = cellByIndex.get(action.goal.cellIndex);
    return expectedCell !== undefined
      && samePosition(action.goal.target, expectedCell.position)
      && samePosition(action.intent.target, expectedCell.position)
      && samePosition(action.intent.referencePosition, expectedCell.supportPosition)
      && action.intent.face === "up"
      ? [action]
      : [];
  });

  if (uniqueMinedPositions(mines) < 4) {
    throw new Error(`${factionName} must successfully mine four distinct natural oak logs`);
  }
  if (drops.length === 0) throw new Error(`${factionName} must successfully collect an observed oak log drop`);
  if (crafts.length === 0) throw new Error(`${factionName} must complete the four-log to sixteen-plank recipe`);
  if (deposits.length === 0 || withdrawals.length === 0) {
    throw new Error(`${factionName} must complete both plank deposit and withdrawal from a chest`);
  }
  if (uniquePlacementTargets(placements) !== 15) {
    throw new Error(`${factionName} must successfully place all fifteen declared outpost cells`);
  }

  const lastGather = [...mines, ...drops].reduce(
    (latest, { settledAtNs }) => settledAtNs > latest ? settledAtNs : latest,
    0n,
  );
  const firstCraft = earliest(crafts);
  const firstDeposit = earliest(deposits);
  const firstWithdrawal = earliest(withdrawals);
  const firstPlacement = earliest(placements);
  if (lastGather >= firstCraft.settledAtNs
    || firstCraft.settledAtNs >= firstDeposit.settledAtNs
    || firstDeposit.settledAtNs >= firstWithdrawal.settledAtNs
    || firstWithdrawal.settledAtNs >= firstPlacement.settledAtNs) {
    throw new Error(`${factionName} material actions must settle in gather, craft, chest, build order`);
  }
}

function uniqueMinedPositions(actions: readonly CivilizationActionEvidence[]): number {
  const positions = new Set<string>();
  for (const action of actions) {
    if (action.intent.kind !== "mineBlock") continue;
    positions.add(positionKey(action.intent.position));
  }
  return positions.size;
}

function uniquePlacementTargets(actions: readonly CivilizationActionEvidence[]): number {
  const targets = new Set<string>();
  for (const action of actions) {
    if (action.intent.kind !== "placeBlock") continue;
    targets.add(positionKey(action.intent.target));
  }
  return targets.size;
}

function earliest(actions: readonly CivilizationActionEvidence[]): CivilizationActionEvidence {
  const action = actions[0];
  if (action === undefined) throw new Error("required successful civilization action is missing");
  return action;
}

function positionKey(position: Readonly<{ x: number; y: number; z: number }>): string {
  return `${position.x},${position.y},${position.z}`;
}

function samePosition(first: BlockPosition, second: BlockPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function factionForSeat(seat: number): "ember" | "tide" {
  return seat < 3 ? "ember" : "tide";
}
