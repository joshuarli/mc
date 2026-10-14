const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Defines the ASCII run directory name accepted by preparation and stopped-run lookup. */
export function isValidRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}
