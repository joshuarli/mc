import type {
  BlockPosition,
  CivIntent,
  CivilizationFactionId,
  CivilizationGoal,
  CivilizationRole,
  Goal,
  Intent,
  OutpostCell,
  SkillOutcome,
} from "@arena/core";
import type { CivilizationFactionIr } from "@arena/spec";

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

/** Requires the configured gatherer, builder, and defender on each faction to contribute. */
export function assertCivilizationRoleContributions(
  actions: readonly CivilizationActionEvidence[],
  factions: readonly CivilizationFactionIr[],
  layout: CivilizationActionLayout,
): void {
  if (factions.length !== 2) throw new Error("civilization role evidence requires both configured factions");
  const seats = new Set<number>();
  for (const faction of factions) {
    const memberForRole = new Map(faction.members.map(({ seat, role }) => [role, seat] as const));
    if (memberForRole.size !== 3 || faction.members.length !== 3) {
      throw new Error(`${faction.id} must have one configured member for each civilization role`);
    }
    for (const { seat } of faction.members) {
      if (!Number.isSafeInteger(seat) || seat < 0 || seat > 5 || seats.has(seat)) {
        throw new Error("civilization role evidence has an invalid or repeated configured seat");
      }
      seats.add(seat);
    }

    const gatherer = requiredRoleSeat(memberForRole, "gatherer_crafter", faction.id);
    const builder = requiredRoleSeat(memberForRole, "builder", faction.id);
    const defender = requiredRoleSeat(memberForRole, "defender_scout", faction.id);
    const factionLayout = layout[faction.id];
    const successfulBySeat = (seat: number) => actions.filter((action) => action.seat === seat
      && action.outcome.kind === "succeeded");
    const gathererActions = successfulBySeat(gatherer);
    const builderActions = successfulBySeat(builder);
    const defenderActions = successfulBySeat(defender);

    requireAction(gathererActions, ({ goal, intent }) => goal.kind === "gatherMaterial"
      && goal.item === "oak_log" && intent.kind === "mineBlock" && intent.expectedBlock === "oak_log",
    `${faction.id} gatherer must mine a declared natural oak log`);
    requireAction(gathererActions, ({ goal, intent }) => goal.kind === "gatherMaterial"
      && goal.item === "oak_log" && intent.kind === "dropCollect",
    `${faction.id} gatherer must collect an observed oak log drop`);
    requireAction(gathererActions, ({ goal, intent }) => goal.kind === "craftMaterial"
      && goal.item === "oak_planks" && goal.resultCount === 16 && intent.kind === "craft"
      && intent.output === "oak_planks" && intent.resultCount === 16,
    `${faction.id} gatherer must craft sixteen planks from the ordinary recipe`);
    requireAction(gathererActions, ({ goal, intent }) => goal.kind === "transferMaterial"
      && goal.direction === "deposit" && goal.item === "oak_planks" && goal.count === 16
      && samePosition(goal.container, factionLayout.chest)
      && intent.kind === "containerTransfer" && intent.direction === "deposit"
      && intent.item === "oak_planks" && intent.count === 16
      && samePosition(intent.position, factionLayout.chest),
    `${faction.id} gatherer must deposit all sixteen planks in its declared chest`);

    requireAction(builderActions, ({ goal, intent }) => goal.kind === "transferMaterial"
      && goal.direction === "withdraw" && goal.item === "oak_planks" && goal.count === 15
      && samePosition(goal.container, factionLayout.chest)
      && intent.kind === "containerTransfer" && intent.direction === "withdraw"
      && intent.item === "oak_planks" && intent.count === 15
      && samePosition(intent.position, factionLayout.chest),
    `${faction.id} builder must withdraw fifteen planks from its declared chest`);
    const expectedCells = new Map(factionLayout.outpostCells.map((cell) => [positionKey(cell.position), cell] as const));
    const builtCells = new Set<string>();
    for (const action of builderActions) {
      if (action.goal.kind !== "buildOutpost" || action.goal.blueprintId !== "oak-outpost-v1"
        || action.intent.kind !== "placeBlock" || action.intent.item !== "oak_planks") continue;
      const cell = expectedCells.get(positionKey(action.goal.target));
      if (cell !== undefined && action.goal.cellIndex === cell.index
        && samePosition(action.intent.target, cell.position)
        && samePosition(action.intent.referencePosition, cell.supportPosition)
        && action.intent.face === "up") {
        builtCells.add(positionKey(cell.position));
      }
    }
    if (builtCells.size !== 15) {
      throw new Error(`${faction.id} builder must place all fifteen declared outpost cells`);
    }

    requireAction(defenderActions, ({ goal, intent }) => goal.kind === "captureZone"
      && intent.kind === "navigate" && samePosition(goal.target, intent.target),
    `${faction.id} defender/scout must navigate to its configured capture objective`);
  }
  if (seats.size !== 6) throw new Error("civilization role evidence must cover all six fixed seats");
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

function requiredRoleSeat(
  members: ReadonlyMap<CivilizationRole, number>,
  role: CivilizationRole,
  faction: string,
): number {
  const seat = members.get(role);
  if (seat === undefined) throw new Error(`${faction} has no configured ${role} seat`);
  return seat;
}

function requireAction(
  actions: readonly CivilizationActionEvidence[],
  predicate: (action: CivilizationActionEvidence) => boolean,
  message: string,
): void {
  if (!actions.some(predicate)) throw new Error(message);
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
