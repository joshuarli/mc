import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { runOwnedAcceptanceScenario } from "./owned-run.js";
import type { AcceptanceRunContext } from "./owned-run.js";

const ACTIVE_PHASE_TIMEOUT_MS = 20_000;
const OPPONENT_VISIBILITY_TIMEOUT_MS = 20_000;
const ELIMINATION_TIMEOUT_MS = 3_000;
const MAX_ATTACKS = 20;
const ATTACK_COOLDOWN_MS = 700;

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

/** Eliminates a stationary competitor using only the attacker's visible opponent and Mineflayer skills. */
export async function eliminateOpponentWithSkillAttacks(
  active: AcceptanceRunContext,
  attackerSeat: number,
  targetSeat: number,
  signal: AbortSignal,
): Promise<void> {
  const attacker = competitorForSeat(active, attackerSeat);
  const target = competitorForSeat(active, targetSeat);
  assert.notEqual(attacker.identity.username, target.identity.username);

  const initialTarget = targetEntityFor(attacker.bot, target.identity.username);
  await attacker.bot.lookAt(initialTarget.position.offset(0, initialTarget.height * 0.6, 0), true);
  const observation = await waitForOpponentObservation(active, attackerSeat, targetSeat, signal);
  assert.equal(observation.opponents.kind, "current");
  const visibleTarget = observation.opponents.value.find(({ id }) => id === initialTarget.id);
  assert.ok(visibleTarget, "the attacker's complete current perception must identify its opponent");

  assert.deepStrictEqual(
    await attacker.client.run({ kind: "approach", target: visibleTarget.id }),
    { kind: "succeeded" },
    "the Mineflayer skill client must approach the visible opponent",
  );

  for (let attack = 0; attack < MAX_ATTACKS; attack += 1) {
    signal.throwIfAborted();
    if (hasDeathElimination(active, targetSeat)) return;
    const currentTarget = targetEntityFor(attacker.bot, target.identity.username);
    await attacker.bot.lookAt(currentTarget.position.offset(0, currentTarget.height * 0.6, 0), true);
    assert.deepStrictEqual(
      await attacker.client.run({ kind: "attack", target: visibleTarget.id }),
      { kind: "succeeded" },
      `ordinary Mineflayer attack ${attack + 1} must produce server-observed damage`,
    );
    if (await waitForDeathElimination(active, targetSeat, signal)) return;
    await delay(ATTACK_COOLDOWN_MS, undefined, { signal });
  }
  throw new Error(`seat ${targetSeat} survived ${MAX_ATTACKS} ordinary Mineflayer attacks`);
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
    const observation = observer.client.observe(0);
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
