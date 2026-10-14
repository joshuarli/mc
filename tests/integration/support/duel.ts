import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ArenaSkillIntent, MineflayerArenaClient } from "@arena/bots";
import type { BlockPosition, SkillOutcome } from "@arena/core";

import { runOwnedAcceptanceScenario } from "./owned-run.js";
import type { AcceptanceRunContext } from "./owned-run.js";

const ACTIVE_PHASE_TIMEOUT_MS = 20_000;
const AGENT_OBSERVATION_TIMEOUT_MS = 5_000;
const OPPONENT_VISIBILITY_TIMEOUT_MS = 20_000;
const ELIMINATION_TIMEOUT_MS = 3_000;
const MAX_ATTACKS = 20;
const ATTACK_COOLDOWN_MS = 700;

/** Runtime shutdown can settle a skill as cancelled; keep its initiating failure ahead of success assertions. */
export async function runEvaluatorSkill(
  client: Pick<MineflayerArenaClient, "run">,
  intent: ArenaSkillIntent,
  signal: AbortSignal,
): Promise<SkillOutcome> {
  signal.throwIfAborted();
  const outcome = await client.run(intent);
  signal.throwIfAborted();
  return outcome;
}

export function competitorForSeat(active: AcceptanceRunContext, seat: number) {
  assert.equal(active.prepare.type, "prepare");
  const planned = active.prepare.payload.roster.find((competitor) => competitor.seat === seat);
  assert.ok(planned, `prepared roster must contain competitor seat ${seat}`);
  const handle = active.competitors.find(({ identity }) => identity.username === planned.username);
  assert.ok(handle, `runtime must connect prepared competitor ${planned.username}`);
  assert.equal(handle.identity.offlineUuid, planned.offline_uuid);
  return handle;
}

export function assertDeathWinner(
  run: Awaited<ReturnType<typeof runOwnedAcceptanceScenario>>,
  winnerSeat: number,
  eliminatedSeat: number,
  competitorCount: number,
): void {
  assert.ok(
    run.events.some((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ seat, cause }) => seat === eliminatedSeat && cause === "death")),
    `the authenticated event stream must record seat ${eliminatedSeat}'s ordinary death`,
  );
  assert.ok(
    run.events.some((event) => event.type === "outcome" && event.payload.kind === "winner"
      && event.payload.winner_seat === winnerSeat),
    `the authenticated event stream must award the match to seat ${winnerSeat}`,
  );
  assert.equal(run.outcome.kind, "winner", "the configured match must end with a winner");
  if (run.outcome.kind === "winner") {
    assert.equal(run.outcome.winner_seat, winnerSeat);
    assert.deepStrictEqual(run.outcome.survivors, [winnerSeat]);
  }

  const report = object(run.inspection.report, "arena inspect report must be an object");
  assert.equal(report.outcome_status, "reconstructed_from_authoritative_events");
  const outcome = object(report.outcome, "arena inspect must include the reconstructed outcome");
  assert.equal(outcome.kind, "winner");
  assert.equal(outcome.winner_seat, winnerSeat);
  assert.deepStrictEqual(outcome.survivors, [winnerSeat]);

  const eventOutcome = run.events.find((event) => event.type === "outcome");
  assert.ok(eventOutcome, "the authenticated event stream must include its terminal outcome");
  assert.equal(eventOutcome.payload.kind, "winner", "the authenticated outcome must be a winner result");
  if (eventOutcome.payload.kind !== "winner") throw new Error("winner assertion did not narrow the outcome");
  const inspectedAt = object(outcome.at, "arena inspect winner must include its event time");
  assert.equal(inspectedAt.domain, eventOutcome.payload.at.domain);
  assert.equal(inspectedAt.value, eventOutcome.payload.at.value.toString());

  const statistics = object(report.statistics, "arena inspect must include event-derived statistics");
  assert.equal(statistics.competitor_count, competitorCount);
  assert.equal(statistics.elimination_count, 1);
  assert.equal(statistics.death_count, 1);
  assert.equal(statistics.disconnect_count, 0);
  assert.deepStrictEqual(statistics.survivor_seats, [winnerSeat]);
}

export async function waitForActivePhase(active: AcceptanceRunContext, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + ACTIVE_PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (active.events().some((event) => event.type === "public_clock" && event.payload.phase === "active")) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(`duel did not reach the active phase within ${ACTIVE_PHASE_TIMEOUT_MS} ms`);
}

/** Uses ordinary block navigation and verifies the competitor reaches the selected staging tile. */
export async function stageOpponentForCombat(
  active: AcceptanceRunContext,
  opponentSeat: number,
  destination: BlockPosition,
  signal: AbortSignal,
): Promise<void> {
  const opponent = competitorForSeat(active, opponentSeat);
  assert.deepStrictEqual(
    await runEvaluatorSkill(opponent.client, { kind: "navigateToBlock", target: destination }, signal),
    { kind: "succeeded" },
    `the Mineflayer skill client must stage seat ${opponentSeat} at the selected combat tile`,
  );
  const position = opponent.bot.entity.position;
  assert.deepStrictEqual(
    { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
    destination,
    `seat ${opponentSeat} must arrive at the selected combat tile before attacks begin`,
  );
}

interface DuelCombatMarker {
  mark(kind: string, data?: Readonly<Record<string, unknown>>): void;
}

/** Eliminates a stationary competitor using visible upgrades, opponents, and Mineflayer skills. */
export async function eliminateOpponentWithSkillAttacks(
  active: AcceptanceRunContext,
  attackerSeat: number,
  targetSeat: number,
  signal: AbortSignal,
  diagnostics?: DuelCombatMarker,
): Promise<void> {
  const attacker = competitorForSeat(active, attackerSeat);
  const target = competitorForSeat(active, targetSeat);
  assert.notEqual(attacker.identity.username, target.identity.username);

  const gameplay = attacker.gameplay;
  if (gameplay.mode !== "hunger_games") throw new Error("duel evaluator requires Hunger Games");
  const agent = await waitForCurrentAgent(gameplay.client, signal);
  const weaponUpgrade = agent.value.upgrades.find(({ equipmentSlot }) => equipmentSlot === "weapon");
  if (weaponUpgrade) {
    assert.deepStrictEqual(
      await runEvaluatorSkill(attacker.client, {
        kind: "equip",
        inventorySlot: weaponUpgrade.inventorySlot,
        equipmentSlot: weaponUpgrade.equipmentSlot,
        rating: weaponUpgrade.rating,
      }, signal),
      { kind: "succeeded" },
      "the Mineflayer skill client must equip its currently observed weapon upgrade",
    );
  }

  for (let attack = 0; attack < MAX_ATTACKS; attack += 1) {
    signal.throwIfAborted();
    if (hasDeathElimination(active, targetSeat)) {
      diagnostics?.mark("targetEliminated", { attack: attack + 1 });
      return;
    }
    diagnostics?.mark("attackIterationStarted", { attack: attack + 1 });
    const currentTargetEntity = targetEntityFor(attacker.bot, target.identity.username);
    await attacker.bot.lookAt(currentTargetEntity.position.offset(0, currentTargetEntity.height * 0.6, 0), true);
    const observation = await waitForOpponentObservation(active, attackerSeat, targetSeat, signal);
    assert.equal(observation.opponents.kind, "current");
    const visibleTarget = observation.opponents.value.find(({ id }) => id === currentTargetEntity.id);
    assert.ok(visibleTarget, "the attacker's complete current perception must identify its opponent before each attack");
    diagnostics?.mark("approachStarted", { attack: attack + 1, targetEntityId: visibleTarget.id });
    const approachOutcome = await runEvaluatorSkill(attacker.client, { kind: "approach", target: visibleTarget.id }, signal);
    diagnostics?.mark("approachCompleted", { attack: attack + 1, outcome: approachOutcome });
    assert.deepStrictEqual(
      approachOutcome,
      { kind: "succeeded" },
      `the Mineflayer skill client must approach the currently visible opponent before attack ${attack + 1}`,
    );
    const currentTarget = targetEntityFor(attacker.bot, target.identity.username);
    await attacker.bot.lookAt(currentTarget.position.offset(0, currentTarget.height * 0.6, 0), true);
    diagnostics?.mark("attackStarted", {
      attack: attack + 1,
      targetEntityId: visibleTarget.id,
      attackerPosition: { x: attacker.bot.entity.position.x, y: attacker.bot.entity.position.y, z: attacker.bot.entity.position.z },
      targetPosition: { x: currentTarget.position.x, y: currentTarget.position.y, z: currentTarget.position.z },
    });
    const attackOutcome = await runEvaluatorSkill(attacker.client, { kind: "attack", target: visibleTarget.id }, signal);
    diagnostics?.mark("attackCompleted", { attack: attack + 1, outcome: attackOutcome });
    assert.deepStrictEqual(
      attackOutcome,
      { kind: "succeeded" },
      `ordinary Mineflayer attack ${attack + 1} must produce server-observed damage`,
    );
    const eliminated = await waitForDeathElimination(active, targetSeat, signal);
    diagnostics?.mark("deathWaitCompleted", { attack: attack + 1, eliminated });
    if (eliminated) return;
    diagnostics?.mark("attackCooldownStarted", { attack: attack + 1, cooldownMs: ATTACK_COOLDOWN_MS });
    await delay(ATTACK_COOLDOWN_MS, undefined, { signal });
    diagnostics?.mark("attackCooldownCompleted", { attack: attack + 1 });
  }
  throw new Error(`seat ${targetSeat} survived ${MAX_ATTACKS} ordinary Mineflayer attacks`);
}

async function waitForCurrentAgent(
  client: Extract<AcceptanceRunContext["competitors"][number]["gameplay"], { readonly mode: "hunger_games" }>["client"],
  signal: AbortSignal,
) {
  const deadline = Date.now() + AGENT_OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = client.observe(0);
    if (observation.agent.kind === "current") return observation.agent;
    await delay(50, undefined, { signal });
  }
  throw new Error(`attacker agent observation did not become current within ${AGENT_OBSERVATION_TIMEOUT_MS} ms`);
}

function targetEntityFor(bot: AcceptanceRunContext["competitors"][number]["bot"], username: string) {
  const entity = bot.players[username]?.entity;
  assert.ok(entity, `Mineflayer client has not received opponent entity ${username}`);
  return entity;
}

async function waitForOpponentObservation(
  active: AcceptanceRunContext,
  observerSeat: number,
  targetSeat: number,
  signal: AbortSignal,
) {
  const observer = competitorForSeat(active, observerSeat);
  const target = competitorForSeat(active, targetSeat);
  const targetEntity = targetEntityFor(observer.bot, target.identity.username);
  const deadline = Date.now() + OPPONENT_VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const gameplay = observer.gameplay;
    if (gameplay.mode !== "hunger_games") throw new Error("opponent visibility evaluator requires Hunger Games");
    const observation = gameplay.client.observe(0);
    if (observation.opponents.kind === "current"
        && observation.opponents.value.some(({ id }) => id === targetEntity.id)) {
      return observation;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`seat ${targetSeat} did not enter seat ${observerSeat}'s current permitted perception`);
}

async function waitForDeathElimination(
  active: AcceptanceRunContext,
  targetSeat: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + ELIMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (hasDeathElimination(active, targetSeat)) return true;
    await delay(50, undefined, { signal });
  }
  return false;
}

function hasDeathElimination(active: AcceptanceRunContext, targetSeat: number): boolean {
  return active.events().some((event) => event.type === "elimination"
    && event.payload.eliminations.some(({ seat, cause }) => seat === targetSeat && cause === "death"));
}

function object(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", description);
  return value as Record<string, unknown>;
}
