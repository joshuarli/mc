import { RunnerError } from '../errors.js';

export type RuntimeDeadlinePhase = 'cold_start' | 'wall_clock';
export const COLD_START_TIMEOUT_MS = 180_000;

export interface RuntimeDeadline {
  readonly failure: Promise<never>;
  readonly error: RunnerError | undefined;
  clear(): void;
}

export function armRuntimeDeadline(
  controller: AbortController,
  phase: RuntimeDeadlinePhase,
  timeoutMs: number,
): RuntimeDeadline {
  let error: RunnerError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      error = new RunnerError('runtime_failure', 'arena run', {
        kind: 'runtime_timeout',
        field: phase,
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  void failure.catch(() => {});
  return Object.freeze({
    failure,
    get error() { return error; },
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });
}
