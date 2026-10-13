import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CivIntent,
  CivilizationFactionId,
  CivilizationGoal,
  CivilizationObservation,
  Goal,
  Intent,
  SkillOutcome,
} from "@arena/core";
import { civilizationOutpostCells } from "@arena/core";
import type { CivilizationScenarioIr } from "@arena/spec";
import type { MineflayerCivilizationClient } from "@arena/bots";
import type { PathDiagnosticRecord } from "@arena/bots";
import { readOwnedFile, MAX_OWNED_READ_BYTES } from "../../packages/arena-runner/src/owned-files/index.js";
import { runPreparedRun, type RunPreparedRunOptions } from "../../packages/arena-runner/src/runtime/run.js";
import { paperArguments, validateJavaTempDirectory } from "../../packages/arena-runner/src/runtime/server.js";
import { inspectOwnedAcceptanceRun, prepareOwnedAcceptanceRun } from "../integration/support/owned-run.js";
import type { AcceptanceEvaluator, AcceptanceRunContext } from "../integration/support/owned-run.js";
import type {
  CivilizationActionEvidence,
  CivilizationActionLayout,
  CivilizationFactionActionLayout,
} from "./civilization-action-evidence.js";
import type { CivilizationMaterialBaseline } from "./civilization-material-evidence.js";

const CENSUS_PROPERTY = "arena.civilization-evaluator";
const CENSUS_OPTION = `-D${CENSUS_PROPERTY}=true`;
const JAVA_OPTION_ENVIRONMENT = ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"] as const;
const RUN_STARTUP_TIMEOUT_MS = 30_000;
const OBSERVATION_TIMEOUT_MS = 10_000;
const OPPONENT_TIMEOUT_MS = 20_000;
const ELIMINATION_TIMEOUT_MS = 10_000;
const MAX_ATTACKS = 20;
const ATTACK_COOLDOWN_MS = 1_000;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type CivilizationGoalEvidence = Goal | CivilizationGoal;
export type CivilizationIntentEvidence = Intent | CivIntent;
export type CivilizationAcceptanceOptions = Readonly<{
  readonly competitorDriver?: NonNullable<RunPreparedRunOptions["competitorDriver"]>;
  readonly onPolicyActivity?: RunPreparedRunOptions["onPolicyActivity"];
  readonly onResourceSample?: RunPreparedRunOptions["onResourceSample"];
}>;

/** Runs one owned Civilization scenario with private census enabled only for its Paper child. */
export async function runOwnedCivilizationAcceptanceScenario(
  scenarioPath: string,
  runId: string,
  evaluate: AcceptanceEvaluator,
  signal: AbortSignal,
  options: CivilizationAcceptanceOptions = {},
) {
  const prepared = await prepareOwnedAcceptanceRun(scenarioPath, runId, signal);
  const javaTmpDir = validateJavaTempDirectory(prepared.ownedRoot);
  const suppliedArguments = paperArguments({ ...prepared, javaTmpDir }, 1, prepared.preparedRun.runId);
  assert.ok(
    suppliedArguments.every((argument) => !isCensusProperty(argument)),
    "the supplied Paper arguments must not override the evaluator-only material census property",
  );

  const inheritedOptions = new Map<string, string | undefined>(
    JAVA_OPTION_ENVIRONMENT.map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of inheritedOptions) {
    if (value !== undefined && tokenizeJavaOptions(value).some(isCensusProperty)) {
      throw new Error(`${name} already supplies -D${CENSUS_PROPERTY}; refusing an ambiguous Paper property`);
    }
  }

  const previousJavaToolOptions = process.env.JAVA_TOOL_OPTIONS;
  process.env.JAVA_TOOL_OPTIONS = previousJavaToolOptions === undefined || previousJavaToolOptions.length === 0
    ? CENSUS_OPTION
    : `${previousJavaToolOptions} ${CENSUS_OPTION}`;
  let completed: Awaited<ReturnType<typeof runPreparedRun>>;
  try {
    completed = await runPreparedRun({
      ...prepared,
      evaluate,
      competitorDriver: options.competitorDriver ?? "evaluator",
      ...(options.onPolicyActivity === undefined ? {} : { onPolicyActivity: options.onPolicyActivity }),
      ...(options.onResourceSample === undefined ? {} : { onResourceSample: options.onResourceSample }),
    });
  } finally {
    if (previousJavaToolOptions === undefined) delete process.env.JAVA_TOOL_OPTIONS;
    else process.env.JAVA_TOOL_OPTIONS = previousJavaToolOptions;
  }
  const inspection = await inspectOwnedAcceptanceRun(completed.runId);
  const logPath = Buffer.concat([
    prepared.preparedRun.runDirectoryPath,
    Buffer.from("/server/logs/latest.log", "ascii"),
  ]);
  const log = await readOwnedFile({
    helperPath: prepared.helperPath,
    ownedRoot: prepared.ownedRoot,
    relativePath: logPath,
    maxBytes: MAX_OWNED_READ_BYTES,
    signal,
  });
  return { ...completed, inspection, materialLog: UTF8.decode(log) };
}

/** Verifies that all six connected clients use the fixed scenario roles and factions. */
export function assertCivilizationRoster(active: AcceptanceRunContext): CivilizationScenarioIr {
  const scenario = active.preparedRun.scenario;
  if (scenario.mode !== "civilization") throw new Error("acceptance scenario must compile as Civilization");
  assert.equal(active.prepare.type, "prepare");
  assert.equal(active.prepare.payload.mode, "civilization");
  assert.equal(active.competitors.length, 6, "the acceptance run must connect exactly six competitors");
  assert.deepStrictEqual(
    active.competitors.map(({ seat }) => seat).sort((first, second) => first - second),
    [0, 1, 2, 3, 4, 5],
    "the live roster must contain every fixed competitor seat exactly once",
  );

  const configuredMembers = scenario.civilization.factions.flatMap(({ id, members }) =>
    members.map((member) => ({ faction: id, ...member })));
  assert.equal(configuredMembers.length, 6);
  for (const member of configuredMembers) {
    const gameplay = active.competitors.find(({ seat }) => seat === member.seat)?.gameplay;
    assert.ok(gameplay, `seat ${member.seat} must have an active civilization client`);
    assert.equal(gameplay.mode, "civilization", `seat ${member.seat} must use the civilization adapter`);
    if (gameplay.mode !== "civilization") throw new Error(`seat ${member.seat} is not a civilization client`);
    assert.equal(gameplay.context.seat, member.seat);
    assert.equal(gameplay.context.faction, member.faction);
    assert.equal(gameplay.context.role, member.role);
  }
  return scenario;
}

/** Returns the mode-specific client only after checking its runtime seat and adapter. */
export function civilizationClientForSeat(active: AcceptanceRunContext, seat: number): MineflayerCivilizationClient {
  const competitor = active.competitors.find((candidate) => candidate.seat === seat);
  assert.ok(competitor, `civilization runtime must contain seat ${seat}`);
  const gameplay = competitor.gameplay;
  assert.equal(gameplay.mode, "civilization", `seat ${seat} must use the civilization adapter`);
  if (gameplay.mode !== "civilization") throw new Error(`seat ${seat} is not a civilization client`);
  assert.equal(gameplay.context.seat, seat, `civilization client must match seat ${seat}`);
  return gameplay.client;
}

/** Resolves source logs, faction chests, and blueprint cells from the compiled run input. */
export function civilizationActionLayout(scenario: CivilizationScenarioIr): CivilizationActionLayout {
  const allSources = scenario.map.blocks
    .filter(({ block }) => block === "minecraft:oak_log")
    .map(({ position }) => position);
  const spawns = new Map(scenario.map.spawns.map((spawn) => [spawn.seat, spawn.position] as const));
  const layout: Partial<Record<CivilizationFactionId, CivilizationFactionActionLayout>> = {};

  for (const faction of scenario.civilization.factions) {
    const firstMember = faction.members[0];
    assert.ok(firstMember, `${faction.id} must declare a source seat`);
    const home = spawns.get(firstMember.seat);
    assert.ok(home, `${faction.id} source seat must have a compiled spawn`);
    const naturalOakLogSources = allSources
      .filter((position) => squaredDistance(position, home) < 64 * 64)
      .sort((first, second) => squaredDistance(first, home) - squaredDistance(second, home));
    assert.ok(naturalOakLogSources.length >= 5, `${faction.id} base must have five reachable natural oak logs`);
    const chest = [...scenario.map.lootContainers]
      .sort((first, second) => squaredDistance(first.position, home) - squaredDistance(second.position, home))[0];
    assert.ok(chest, `${faction.id} base must have a declared chest`);
    const anchor = scenario.civilization.blueprint.anchors[faction.id];
    layout[faction.id] = {
      naturalOakLogSources,
      chest: chest.position,
      outpostCells: civilizationOutpostCells(anchor.position, anchor.rotationDegrees),
    };
  }
  const ember = layout.ember;
  const tide = layout.tide;
  assert.ok(ember && tide, "the compiled scenario must include both civilization faction layouts");
  return { ember, tide };
}

/** Derives tracked starting stock from the compiled player kits and declared chest inventories. */
export function civilizationMaterialBaseline(scenario: CivilizationScenarioIr): CivilizationMaterialBaseline {
  const count = (item: "minecraft:oak_log" | "minecraft:oak_planks"): number => {
    const kitCount = scenario.civilization.startingKit.reduce(
      (total, stack) => total + (stack.item === item ? stack.count : 0),
      0,
    ) * scenario.roster.competitors;
    const chestCount = scenario.map.lootContainers.reduce(
      (total, chest) => total + chest.inventory.filter((entry) => entry === item).length,
      0,
    );
    return kitCount + chestCount;
  };
  return {
    naturalOakLogSources: scenario.map.blocks
      .filter(({ block }) => block === "minecraft:oak_log")
      .map(({ position }) => position),
    initialStock: { oakLogs: count("minecraft:oak_log"), oakPlanks: count("minecraft:oak_planks") },
    containerPositions: scenario.map.lootContainers.map(({ position }) => position),
  };
}

/** Assigns each evaluator skill call one monotonic interval and a unique local action id. */
export async function recordCivilizationAction(
  actions: CivilizationActionEvidence[],
  seat: number,
  goal: CivilizationGoalEvidence,
  intent: CivilizationIntentEvidence,
  invoke: () => Promise<SkillOutcome>,
): Promise<SkillOutcome> {
  const startedAtNs = process.hrtime.bigint();
  const outcome = await invoke();
  const settledAtNs = process.hrtime.bigint();
  actions.push({
    actionSequence: `evaluator-${actions.length + 1}`,
    seat,
    goal,
    intent,
    outcome,
    startedAtNs,
    settledAtNs,
  });
  return outcome;
}

export function currentCivilizationObservation(
  active: AcceptanceRunContext,
  client: MineflayerCivilizationClient,
): CivilizationObservation {
  return client.observe(currentMatchTick(active));
}

/** Waits for the public match clock or one client observation without substituting local state. */
export async function waitForCivilizationPhase(
  active: AcceptanceRunContext,
  phase: "grace" | "active" | "finished",
  signal: AbortSignal,
): Promise<void> {
  const timeout = phase === "active" ? 180_000 : RUN_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (active.events().some((event) => event.type === "public_clock" && event.payload.phase === phase)) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(`civilization match did not reach ${phase} within ${timeout} ms`);
}

export async function waitForCurrentCivilizationMaterials(
  active: AcceptanceRunContext,
  client: MineflayerCivilizationClient,
  signal: AbortSignal,
): Promise<CivilizationObservation> {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = currentCivilizationObservation(active, client);
    if (observation.ownMaterials.kind === "current") return observation;
    await delay(50, undefined, { signal });
  }
  throw new Error(`civilization inventory did not synchronize within ${OBSERVATION_TIMEOUT_MS} ms`);
}

/** Runs the fixed natural-log to chest to fifteen-block outpost chain with ordinary client skills. */
export async function completeCivilizationFactionMaterialChain(
  active: AcceptanceRunContext,
  gathererSeat: number,
  builderSeat: number,
  layout: CivilizationFactionActionLayout,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  await prepareCivilizationFactionMaterials(active, gathererSeat, layout, actions, signal);
  await buildCivilizationFactionOutpost(active, builderSeat, layout, actions, signal);
}

export async function prepareCivilizationFactionMaterials(
  active: AcceptanceRunContext,
  gathererSeat: number,
  layout: CivilizationFactionActionLayout,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const gatherer = civilizationClientForSeat(active, gathererSeat);
  let observation = await waitForCurrentCivilizationMaterials(active, gatherer, signal);
  assert.equal(materialCount(observation, "oak_log"), 0, `seat ${gathererSeat} must begin without natural logs`);

  for (const [index, position] of layout.naturalOakLogSources.slice(0, 5).entries()) {
    observation = await waitForCivilizationObservation(active, gatherer, signal, (current) =>
      current.observedResources.kind === "current"
      && current.observedResources.value.some((resource) => resource.kind === "logBlock"
        && samePosition(resource.position, position)));
    assert.equal(observation.observedResources.kind, "current");
    if (observation.observedResources.kind !== "current") throw new Error("natural log perception became unavailable");
    const stillPresent = observation.observedResources.value.some((resource) => resource.kind === "logBlock"
      && samePosition(resource.position, position));
    assert.ok(stillPresent, `seat ${gathererSeat} must observe the natural oak log at ${positionText(position)}`);
    const mineIntent = { kind: "mineBlock" as const, position, expectedBlock: "oak_log" as const };
    const mined = await recordCivilizationAction(actions, gathererSeat,
      { kind: "gatherMaterial", item: "oak_log", target: position }, mineIntent,
      () => runCivilizationSkill(gatherer, mineIntent, signal));
    assertSucceeded(mined, `seat ${gathererSeat} must mine natural oak log ${positionText(position)}`);

    const drop = await waitForCivilizationDrop(active, gatherer, position, signal);
    const collectIntent = { kind: "dropCollect" as const, entityId: drop.entityId };
    const collected = await recordCivilizationAction(actions, gathererSeat,
      { kind: "gatherMaterial", item: "oak_log", target: position }, collectIntent,
      () => runArenaSkill(gatherer, collectIntent, signal));
    assertSucceeded(collected, `seat ${gathererSeat} must collect the observed oak log drop`);
    observation = await waitForCivilizationObservation(active, gatherer, signal,
      (current) => current.ownMaterials.kind === "current"
        && materialCount(current, "oak_log") === index + 1);
  }

  observation = await waitForCurrentCivilizationMaterials(active, gatherer, signal);
  assert.equal(materialCount(observation, "oak_log"), 5, `seat ${gathererSeat} must carry five collected logs`);
  const craftIntent = { kind: "craft" as const, output: "oak_planks" as const, resultCount: 16, table: null };
  const crafted = await recordCivilizationAction(actions, gathererSeat,
    { kind: "craftMaterial", item: "oak_planks", resultCount: 16 }, craftIntent,
    () => runCivilizationSkill(gatherer, craftIntent, signal));
  assertSucceeded(crafted, `seat ${gathererSeat} must craft the ordinary sixteen-plank recipe`);
  observation = await waitForCivilizationObservation(active, gatherer, signal,
    (current) => current.ownMaterials.kind === "current"
      && materialCount(current, "oak_planks") === 16 && materialCount(current, "oak_log") === 1);

  const depositIntent = {
    kind: "containerTransfer" as const, position: layout.chest,
    direction: "deposit" as const, item: "oak_planks" as const, count: 16,
  };
  const deposited = await recordCivilizationAction(actions, gathererSeat,
    { kind: "transferMaterial", item: "oak_planks", count: 16, direction: "deposit", container: layout.chest },
    depositIntent, () => runCivilizationSkill(gatherer, depositIntent, signal));
  assertSucceeded(deposited, `seat ${gathererSeat} must deposit sixteen planks in its faction chest`);
}

export async function buildCivilizationFactionOutpost(
  active: AcceptanceRunContext,
  builderSeat: number,
  layout: CivilizationFactionActionLayout,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  await withdrawCivilizationOutpostMaterials(active, builderSeat, layout, actions, signal);
  await placeCivilizationFactionOutpost(active, builderSeat, layout, actions, signal);
}

export async function withdrawCivilizationOutpostMaterials(
  active: AcceptanceRunContext,
  builderSeat: number,
  layout: CivilizationFactionActionLayout,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const builder = civilizationClientForSeat(active, builderSeat);
  const observation = await waitForCurrentCivilizationMaterials(active, builder, signal);
  assert.equal(materialCount(observation, "oak_planks"), 0,
    `seat ${builderSeat} must hold no planks before its configured outpost withdrawal`);
  const withdrawIntent = {
    kind: "containerTransfer" as const, position: layout.chest,
    direction: "withdraw" as const, item: "oak_planks" as const, count: 15,
  };
  const withdrawn = await recordCivilizationAction(actions, builderSeat,
    { kind: "transferMaterial", item: "oak_planks", count: 15, direction: "withdraw", container: layout.chest },
    withdrawIntent, () => runCivilizationSkill(builder, withdrawIntent, signal));
  assertSucceeded(withdrawn, `seat ${builderSeat} must withdraw fifteen planks from its faction chest`);
  await waitForCivilizationObservation(active, builder, signal,
    (current) => current.ownMaterials.kind === "current" && materialCount(current, "oak_planks") === 15);
}

export async function placeCivilizationFactionOutpost(
  active: AcceptanceRunContext,
  builderSeat: number,
  layout: CivilizationFactionActionLayout,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const builder = civilizationClientForSeat(active, builderSeat);
  const observation = await waitForCurrentCivilizationMaterials(active, builder, signal);
  assert.ok(materialCount(observation, "oak_planks") >= 15,
    `seat ${builderSeat} must carry the fifteen planks required for its outpost`);
  for (const cell of layout.outpostCells) {
    const placeIntent = {
      kind: "placeBlock" as const, target: cell.position,
      referencePosition: cell.supportPosition, face: "up" as const, item: "oak_planks" as const,
    };
    const placed = await recordCivilizationAction(actions, builderSeat,
      { kind: "buildOutpost", blueprintId: "oak-outpost-v1", cellIndex: cell.index, target: cell.position },
      placeIntent, () => runCivilizationSkill(builder, placeIntent, signal));
    assertSucceeded(placed, `seat ${builderSeat} must place outpost cell ${cell.index}`);
  }
}

export async function waitForCivilizationDrop(
  active: AcceptanceRunContext,
  client: MineflayerCivilizationClient,
  source: Readonly<{ x: number; y: number; z: number }>,
  signal: AbortSignal,
): Promise<Readonly<{ entityId: number }>> {
  const observation = await waitForCivilizationObservation(active, client, signal, (current) =>
    current.observedResources.kind === "current"
    && current.observedResources.value.some((resource) => resource.kind === "materialDrop"
      && resource.item === "oak_log" && squaredDistance(resource.position, source) <= 4));
  if (observation.observedResources.kind !== "current") throw new Error("oak log drop observation became unavailable");
  const drop = observation.observedResources.value
    .filter((resource) => resource.kind === "materialDrop" && resource.item === "oak_log"
      && squaredDistance(resource.position, source) <= 4)
    .sort((first, second) => squaredDistance(first.position, source) - squaredDistance(second.position, source))[0];
  if (drop === undefined || drop.kind !== "materialDrop") {
    throw new Error(`no current oak log drop is visible beside ${positionText(source)}`);
  }
  return { entityId: drop.entityId };
}

export async function runCivilizationSkill(
  client: MineflayerCivilizationClient,
  intent: CivIntent,
  signal: AbortSignal,
): Promise<SkillOutcome> {
  signal.throwIfAborted();
  const outcome = await client.runCivilization(intent);
  signal.throwIfAborted();
  return outcome;
}

export async function runArenaSkill(
  client: MineflayerCivilizationClient,
  intent: Intent,
  signal: AbortSignal,
): Promise<SkillOutcome> {
  signal.throwIfAborted();
  const outcome = await client.run(intent);
  signal.throwIfAborted();
  return outcome;
}

export function currentMatchTick(active: AcceptanceRunContext): number {
  const clock = active.events().findLast((event) => event.type === "public_clock"
    && event.payload.tick?.domain === "match");
  assert.ok(clock && clock.type === "public_clock" && clock.payload.tick?.domain === "match",
    "civilization evaluator requires the authenticated match clock");
  const tick = Number(clock.payload.tick.value);
  if (!Number.isSafeInteger(tick)) throw new RangeError("civilization match tick exceeds the safe observation range");
  return tick;
}

export function assertSucceeded(outcome: SkillOutcome, description: string): void {
  assert.deepStrictEqual(outcome, { kind: "succeeded" }, description);
}

/** Runs ordinary client combat and retains the victim's own damage receipts. */
export async function eliminateCivilizationWithSkillAttacks(
  active: AcceptanceRunContext,
  attackerSeat: number,
  victimSeat: number,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<Readonly<{ attackerSeat: number; victimSeat: number }>> {
  const attacker = competitorForSeat(active, attackerSeat);
  const victim = competitorForSeat(active, victimSeat);
  assert.notEqual(attacker.identity.username, victim.identity.username);
  const client = civilizationClientForSeat(active, attackerSeat);
  const targetOnAttacker = () => {
    const entity = attacker.bot.players[victim.identity.username]?.entity;
    assert.ok(entity, `seat ${attackerSeat} must receive victim ${victim.identity.username} as a player entity`);
    return entity;
  };
  const healthBefore = victim.bot.health;
  let minimumHealth = healthBefore;
  let damageReceipts = 0;
  const onHealth = (): void => { minimumHealth = Math.min(minimumHealth, victim.bot.health); };
  const onHurt = (entity: typeof victim.bot.entity | undefined): void => {
    if (entity?.id === victim.bot.entity.id) damageReceipts += 1;
  };
  victim.bot.on("health", onHealth);
  victim.bot.on("entityHurt", onHurt);
  try {
    const initial = await waitForCivilizationObservation(active, client, signal, (observation) =>
      observation.base.agent.kind === "current");
    if (initial.base.agent.kind !== "current") throw new Error("attacker agent observation is not current");
    const weapon = initial.base.agent.value.upgrades.find(({ equipmentSlot }) => equipmentSlot === "weapon");
    if (weapon !== undefined) {
      const outcome = await recordCivilizationAction(actions, attackerSeat,
        { kind: "improveEquipment", inventorySlot: weapon.inventorySlot, equipmentSlot: "weapon", rating: weapon.rating }, {
          kind: "equip", inventorySlot: weapon.inventorySlot, equipmentSlot: "weapon", rating: weapon.rating,
        }, () => client.run({
          kind: "equip", inventorySlot: weapon.inventorySlot, equipmentSlot: "weapon", rating: weapon.rating,
        }));
      assertSucceeded(outcome, `seat ${attackerSeat} must equip its observed wooden sword`);
    }

    for (let attempt = 0; attempt < MAX_ATTACKS; attempt += 1) {
      signal.throwIfAborted();
      if (hasDeathElimination(active, victimSeat)) break;
      const observation = await waitForCivilizationObservation(active, client, signal, (current) => {
        const entity = attacker.bot.players[victim.identity.username]?.entity;
        return entity !== undefined && current.base.opponents.kind === "current"
          && current.base.opponents.value.some(({ id }) => id === entity.id);
      });
      if (observation.base.opponents.kind !== "current") {
        throw new Error(`seat ${attackerSeat} has no current opponent perception before attack ${attempt + 1}`);
      }
      const entity = targetOnAttacker();
      const visibleOpponent = observation.base.opponents.value.find(({ id }) => id === entity.id);
      assert.ok(visibleOpponent, `seat ${attackerSeat} must observe victim ${victimSeat} before attack ${attempt + 1}`);
      const goal = { kind: "engageVisibleOpponent" as const, target: visibleOpponent.id };
      if (squaredDistance(attacker.bot.entity.position, entity.position) > 9) {
        const approach = await recordCivilizationAction(actions, attackerSeat, goal,
          { kind: "approach", target: visibleOpponent.id }, () => client.run({
            kind: "approach", target: visibleOpponent.id,
          }));
        assertSucceeded(approach, `seat ${attackerSeat} must approach visible victim ${victimSeat}`);
      }
      const attack = await recordCivilizationAction(actions, attackerSeat, goal,
        { kind: "attack", target: visibleOpponent.id }, () => client.run({
          kind: "attack", target: visibleOpponent.id,
        }));
      assertSucceeded(attack, `seat ${attackerSeat} must land ordinary damage on victim ${victimSeat}`);
      if (await waitForCivilizationDeath(active, victimSeat, signal)) break;
      await delay(ATTACK_COOLDOWN_MS, undefined, { signal });
    }
  } finally {
    victim.bot.removeListener("health", onHealth);
    victim.bot.removeListener("entityHurt", onHurt);
  }
  if (!hasDeathElimination(active, victimSeat)) {
    throw new Error(`civilization victim seat ${victimSeat} survived ${MAX_ATTACKS} ordinary attacks`);
  }
  assert.ok(damageReceipts > 0, `victim seat ${victimSeat} must receive a player-caused damage event`);
  assert.ok(minimumHealth < healthBefore, `victim seat ${victimSeat} must observe health loss from combat`);
  return { attackerSeat, victimSeat };
}

export async function waitForCivilizationObservation(
  active: AcceptanceRunContext,
  client: MineflayerCivilizationClient,
  signal: AbortSignal,
  ready: (observation: CivilizationObservation) => boolean,
): Promise<CivilizationObservation> {
  const deadline = Date.now() + OPPONENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = currentCivilizationObservation(active, client);
    if (ready(observation)) return observation;
    await delay(50, undefined, { signal });
  }
  throw new Error(`civilization client observation did not become ready within ${OPPONENT_TIMEOUT_MS} ms`);
}

async function waitForCivilizationDeath(
  active: AcceptanceRunContext,
  seat: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + ELIMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (hasDeathElimination(active, seat)) return true;
    await delay(50, undefined, { signal });
  }
  return hasDeathElimination(active, seat);
}

function competitorForSeat(active: AcceptanceRunContext, seat: number) {
  const competitor = active.competitors.find((candidate) => candidate.seat === seat);
  assert.ok(competitor, `civilization runtime must contain competitor seat ${seat}`);
  return competitor;
}

function hasDeathElimination(active: AcceptanceRunContext, seat: number): boolean {
  return active.events().some((event) => event.type === "elimination"
    && event.payload.eliminations.some((elimination) => elimination.seat === seat && elimination.cause === "death"));
}

export function assertRouteAvoidsOutpost(
  records: readonly PathDiagnosticRecord[],
  fromIndex: number,
  layout: CivilizationFactionActionLayout,
): void {
  const updates = records.slice(fromIndex).filter((record) => record.kind === "pathUpdate");
  assert.ok(updates.length > 0, "post-placement route must record client path updates");
  const cells = new Set(layout.outpostCells.map(({ position }) => positionKey(position)));
  for (const update of updates) {
    for (const node of update.path.nodes) {
      assert.ok(!cells.has(positionKey(node)), "a route planned from received world state must avoid placed outpost cells");
      assert.equal(node.toBreakCount, 0, "the client must route around the outpost instead of breaking it");
    }
  }
}

export function assertInitialRouteUsesOutpostFootprint(
  records: readonly PathDiagnosticRecord[],
  layout: CivilizationFactionActionLayout,
): void {
  const occupied = new Set(layout.outpostCells.map(({ position }) => positionKey(position)));
  const pathUpdates = records.filter((record) => record.kind === "pathUpdate");
  assert.ok(
    pathUpdates.some(({ path }) => path.nodes.some((node) => occupied.has(positionKey(node)))),
    "the initial client route must cross the cells later changed by outpost construction",
  );
}

export function squaredDistance(
  first: Readonly<{ x: number; y: number; z: number }>,
  second: Readonly<{ x: number; y: number; z: number }>,
): number {
  const x = first.x - second.x;
  const y = first.y - second.y;
  const z = first.z - second.z;
  return x * x + y * y + z * z;
}

export function samePosition(
  first: Readonly<{ x: number; y: number; z: number }>,
  second: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function materialCount(observation: CivilizationObservation, item: "oak_log" | "oak_planks"): number {
  if (observation.ownMaterials.kind !== "current") {
    throw new Error(`civilization ${item} inventory is not current`);
  }
  return observation.ownMaterials.value.reduce(
    (total, stack) => total + (stack.item === item ? stack.count : 0),
    0,
  );
}

function positionText(position: Readonly<{ x: number; y: number; z: number }>): string {
  return `(${position.x}, ${position.y}, ${position.z})`;
}

function tokenizeJavaOptions(value: string): readonly string[] {
  return value.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) ?? [];
}

function isCensusProperty(argument: string): boolean {
  const normalized = argument.replace(/^["']|["']$/g, "");
  return normalized === `-D${CENSUS_PROPERTY}` || normalized.startsWith(`-D${CENSUS_PROPERTY}=`);
}

function positionKey(position: Readonly<{ x: number; y: number; z: number }>): string {
  return `${position.x},${position.y},${position.z}`;
}
