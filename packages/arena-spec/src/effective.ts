import { createHash } from "node:crypto";

import { SpecError, SpecErrorKind } from "./errors.js";
import type { SemanticId } from "./hash.js";
import { EXTERNAL_USERNAME_PATTERN, GameMode, isReservedRunnerUsername } from "./scenario.js";
import type { ScenarioIr, SeatIr } from "./scenario.js";

const EFFECTIVE_IDENTITY_DOMAIN = "arena.scenario.effective-roster.v1\0";

export interface ExternalSeatRequest {
  readonly seat: number;
  readonly username: string;
}

/**
 * Returns a scenario whose bot seat is replaced by a reserved external seat. The new
 * semantic ID is SHA-256 over the domain, the source scenario ID, the seat, and the username.
 */
export function withExternalSeat(scenario: ScenarioIr, request: ExternalSeatRequest): ScenarioIr {
  const path = "external_seat";
  if (scenario.mode !== GameMode.HungerGames) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "external seats require Hunger Games");
  }
  if (scenario.map.terrain !== "vanilla") {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "external seats require natural terrain");
  }
  if (!Number.isSafeInteger(request.seat) || request.seat < 0 || request.seat >= scenario.roster.competitors) {
    throw new SpecError(SpecErrorKind.Range, `${path}.seat`, "seat is outside the roster");
  }
  if (!EXTERNAL_USERNAME_PATTERN.test(request.username)) {
    throw new SpecError(SpecErrorKind.InvalidValue, `${path}.username`, "must be 3 to 16 ASCII letters, digits, or underscores");
  }
  if (isReservedRunnerUsername(request.username)) {
    throw new SpecError(SpecErrorKind.Conflict, `${path}.username`, "collides with the runner's bot and spectator identity space");
  }
  if (scenario.roster.seats[request.seat]?.controller.kind !== "bot") {
    throw new SpecError(SpecErrorKind.Conflict, `${path}.seat`, "seat is already assigned to an external client");
  }
  const folded = request.username.toLowerCase();
  for (const { controller } of scenario.roster.seats) {
    if (controller.kind === "external" && controller.username.toLowerCase() === folded) {
      throw new SpecError(SpecErrorKind.Conflict, `${path}.username`, "external usernames must be unique ignoring case");
    }
  }

  const seats: readonly SeatIr[] = Object.freeze(scenario.roster.seats.map((entry) => entry.seat === request.seat
    ? Object.freeze({
      seat: entry.seat,
      controller: Object.freeze({ kind: "external" as const, username: request.username }),
    })
    : entry));
  const hash = createHash("sha256");
  hash.update(EFFECTIVE_IDENTITY_DOMAIN, "utf8");
  hash.update(scenario.semanticId, "utf8");
  hash.update(`\0${request.seat}\0${request.username}`, "utf8");
  return Object.freeze({
    ...scenario,
    roster: Object.freeze({ ...scenario.roster, seats }),
    semanticId: hash.digest("hex") as SemanticId,
  });
}
