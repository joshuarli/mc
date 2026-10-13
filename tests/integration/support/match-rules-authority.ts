import assert from "node:assert/strict";

import type { OutcomePayload } from "../../../packages/arena-runner/src/control/types.js";
import type { RuntimeAuthorityEvent } from "../../../packages/arena-runner/src/runtime/types.js";
import type { inspectOwnedAcceptanceRun, runOwnedAcceptanceScenario } from "./owned-run.js";

export interface ExpectedMatchStatistics {
  readonly competitorCount: number;
  readonly eliminationCount: number;
  readonly deathCount: number;
  readonly disconnectCount: number;
  readonly survivorSeats: readonly number[];
}

type AcceptanceRun = Awaited<ReturnType<typeof runOwnedAcceptanceScenario>>;
type AcceptanceInspection = Awaited<ReturnType<typeof inspectOwnedAcceptanceRun>>;

/** Checks terminal authority events and the independently reconstructed stopped-run report. */
export function assertCompletedMatchOutcome(
  run: AcceptanceRun,
  expected: OutcomePayload,
  statistics: ExpectedMatchStatistics,
): void {
  assert.deepStrictEqual(run.outcome, expected);
  assertMatchOutcomeEvents(run.events, expected, statistics);
  assertInspectedMatchOutcome(run.inspection, expected, statistics);
}

export function assertMatchOutcomeEvents(
  events: readonly RuntimeAuthorityEvent[],
  expected: OutcomePayload,
  statistics: ExpectedMatchStatistics,
): void {
  const outcomes = events.filter((event) => event.type === "outcome");
  assert.equal(outcomes.length, 1, "the authenticated event stream must contain one terminal outcome");
  assert.deepStrictEqual(outcomes[0]!.payload, expected);

  const terminalPhase = expected.kind === "abort" ? "aborted" : "finished";
  const terminalClock = events.findLast((event) => event.type === "public_clock"
    && event.payload.phase === terminalPhase);
  if (terminalClock?.type !== "public_clock") {
    throw new Error(`the authenticated event stream must end with phase ${terminalPhase}`);
  }
  assert.deepStrictEqual(terminalClock.payload.tick, expected.at);

  const eliminations = events.flatMap((event) => event.type === "elimination"
    ? event.payload.eliminations
    : []);
  assert.equal(eliminations.length, statistics.eliminationCount);
  assert.equal(eliminations.filter(({ cause }) => cause === "death").length, statistics.deathCount);
  assert.equal(eliminations.filter(({ cause }) => cause === "disconnect").length, statistics.disconnectCount);
}

export function assertInspectedMatchOutcome(
  inspection: AcceptanceInspection,
  expected: OutcomePayload,
  statistics: ExpectedMatchStatistics,
): void {
  const report = record(inspection.report, "arena inspect must include a reconstructed report");
  assert.equal(report.outcome_status, "reconstructed_from_authoritative_events");
  assert.deepStrictEqual(report.outcome, outcomeJson(expected));

  const inspectedStatistics = record(report.statistics, "arena inspect must include event-derived statistics");
  assert.deepStrictEqual(inspectedStatistics, {
    competitor_count: statistics.competitorCount,
    elimination_count: statistics.eliminationCount,
    death_count: statistics.deathCount,
    disconnect_count: statistics.disconnectCount,
    survivor_seats: statistics.survivorSeats,
  });
}

function outcomeJson(outcome: OutcomePayload): Readonly<Record<string, unknown>> {
  return {
    ...outcome,
    at: outcome.at === null
      ? null
      : { domain: outcome.at.domain, value: outcome.at.value.toString() },
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", message);
  return value as Record<string, unknown>;
}
