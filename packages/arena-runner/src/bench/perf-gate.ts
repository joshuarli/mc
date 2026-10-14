import { execFile } from 'node:child_process';

export interface PerfGate {
  ready(): Promise<boolean | 'unavailable'>;
  settled(): Promise<boolean | 'unavailable'>;
}

export function commandPerfGate(command = 'perf-gate-ready'): PerfGate {
  const run = (args: readonly string[]): Promise<boolean | 'unavailable'> => new Promise((resolve) => {
    execFile(command, [...args], (error) => {
      if (error === null) resolve(true);
      else if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve('unavailable');
      else resolve(false);
    });
  });
  return { ready: () => run([]), settled: () => run(['-1']) };
}

export type BracketedRun<T> =
  | Readonly<{ kind: 'valid'; value: T }>
  | Readonly<{ kind: 'discarded'; value: T }>
  | Readonly<{ kind: 'deferred'; reason: 'host_busy' | 'perf_gate_unavailable' }>;

export async function bracketTimedRun<T>(gate: PerfGate, measure: () => Promise<T>): Promise<BracketedRun<T>> {
  const before = await gate.ready();
  if (before === 'unavailable') return { kind: 'deferred', reason: 'perf_gate_unavailable' };
  if (before === false) return { kind: 'deferred', reason: 'host_busy' };
  const value = await measure();
  const after = await gate.settled();
  return after === true ? { kind: 'valid', value } : { kind: 'discarded', value };
}
