import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;
import type { PolicyActivityEvent } from '../runtime/live-policy-loop.js';
import { summarize, type SampleSummary } from './stats.js';

export const MAX_DELAY_SAMPLES = 4096;

export interface WorkerTelemetry {
  readonly eventLoopDelayMs: Readonly<{ count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }>;
  readonly eventLoopUtilization: number | null;
  readonly arrivalToDecisionMs: readonly number[];
  readonly decisionToExecutionMs: readonly number[];
  readonly decisions: number;
  readonly useful: number;
  readonly waitingWithReason: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly cpuMs: number;
}

export class DelayTracker {
  readonly #histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  readonly #acceptedAt = new Map<string, bigint>();
  #arrivalToDecision: number[] = [];
  #decisionToExecution: number[] = [];
  #decisions = 0;
  #useful = 0;
  #waiting = 0;
  #outcomes = new Map<string, number>();
  #elu = performance.eventLoopUtilization();
  #cpu = process.cpuUsage();

  start(): void {
    this.#histogram.enable();
    this.reset();
  }

  stop(): void {
    this.#histogram.disable();
  }

  reset(): void {
    this.#histogram.reset();
    this.#acceptedAt.clear();
    this.#arrivalToDecision = [];
    this.#decisionToExecution = [];
    this.#decisions = 0;
    this.#useful = 0;
    this.#waiting = 0;
    this.#outcomes = new Map();
    this.#elu = performance.eventLoopUtilization();
    this.#cpu = process.cpuUsage();
  }

  onActivity(event: PolicyActivityEvent): void {
    if (event.kind === 'decision') {
      this.#decisions += 1;
      if (event.intent.kind === 'hold') this.#waiting += 1;
      else this.#useful += 1;
      push(this.#arrivalToDecision, Number(event.acceptedAtNs - event.tickReceivedAtNs) / 1e6);
      if (event.disposition.kind === 'start' || event.disposition.kind === 'replace') {
        this.#acceptedAt.set(event.sequence, event.acceptedAtNs);
      }
      return;
    }
    const outcome = event.kind === 'action' ? event.outcome.kind : 'failed_exception';
    this.#outcomes.set(outcome, (this.#outcomes.get(outcome) ?? 0) + 1);
    const accepted = this.#acceptedAt.get(event.actionSequence);
    this.#acceptedAt.delete(event.actionSequence);
    if (accepted !== undefined && event.startedAtNs !== null) {
      push(this.#decisionToExecution, Number(event.startedAtNs - accepted) / 1e6);
    }
  }

  noteDecision(useful: boolean): void {
    this.#decisions += 1;
    if (useful) this.#useful += 1;
    else this.#waiting += 1;
  }

  noteOutcome(kind: string): void {
    this.#outcomes.set(kind, (this.#outcomes.get(kind) ?? 0) + 1);
  }

  snapshot(): WorkerTelemetry {
    const h = this.#histogram;
    const count = h.count;
    const ms = (value: number): number => value / 1e6;
    const delta = performance.eventLoopUtilization(this.#elu);
    const cpu = process.cpuUsage(this.#cpu);
    return Object.freeze({
      eventLoopDelayMs: Object.freeze({
        count,
        p50: count === 0 ? null : ms(h.percentile(50)),
        p95: count < 20 ? null : ms(h.percentile(95)),
        p99: count < 100 ? null : ms(h.percentile(99)),
        max: count === 0 ? null : ms(h.max),
      }),
      eventLoopUtilization: Number.isFinite(delta.utilization) ? delta.utilization : null,
      arrivalToDecisionMs: Object.freeze([...this.#arrivalToDecision]),
      decisionToExecutionMs: Object.freeze([...this.#decisionToExecution]),
      decisions: this.#decisions,
      useful: this.#useful,
      waitingWithReason: this.#waiting,
      outcomes: Object.freeze(Object.fromEntries(this.#outcomes)),
      cpuMs: (cpu.user + cpu.system) / 1000,
    });
  }
}

function push(samples: number[], value: number): void {
  if (samples.length < MAX_DELAY_SAMPLES) samples.push(value);
}

export function summaryFromTelemetry(value: WorkerTelemetry['eventLoopDelayMs']): SampleSummary {
  const insufficient: ('p95' | 'p99')[] = [];
  if (value.count < 20) insufficient.push('p95');
  if (value.count < 100) insufficient.push('p99');
  return Object.freeze({ count: value.count, p50: value.p50, p95: value.p95, p99: value.p99, max: value.max,
    insufficient_samples: Object.freeze(insufficient) });
}

export function delaySummary(samples: readonly number[]): SampleSummary {
  return summarize(samples);
}
