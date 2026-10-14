import type { RuntimeAuthorityEvent } from "../../packages/arena-runner/src/runtime/types.js";

export function hasEliminatedSeatEvidence(
  events: readonly RuntimeAuthorityEvent[],
  seat: number,
  afterEventCount?: number,
): boolean {
  const latest = events.findLast((event) => event.type === "public_state");
  if (latest === undefined || latest.payload.alive_seats.includes(seat)) return false;
  if (afterEventCount === undefined) return true;
  const afterReconnect = events.slice(afterEventCount);
  return afterReconnect.some((event) => event.type === "public_clock" && event.payload.tick?.domain === "match")
    && afterReconnect.every((event) => event.type !== "public_state" || !event.payload.alive_seats.includes(seat));
}
