import { RunnerError } from '../errors.js';

export const MAX_WORKERS = 16;

export function parseWorkerCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKERS) {
    throw new RunnerError('invalid_input', 'worker count', { kind: 'invalid_worker_count' });
  }
  return value;
}

export function workerForSeat(seat: number, workerCount: number): number {
  return seat % workerCount;
}

export function partitionSeats(seats: readonly number[], workerCount: number): readonly (readonly number[])[] {
  const cohorts: number[][] = Array.from({ length: workerCount }, () => []);
  for (const seat of seats) cohorts[workerForSeat(seat, workerCount)]!.push(seat);
  return Object.freeze(cohorts.map((cohort) => Object.freeze(cohort)));
}
