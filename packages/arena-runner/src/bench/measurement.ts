import type { SampleSummary } from './stats.js';

export interface WorkerMeasurement {
  readonly worker: number;
  readonly seats: number;
  readonly eventLoopDelayMs: SampleSummary;
  readonly eventLoopUtilization: number | null;
  readonly arrivalToDecisionMs: SampleSummary;
  readonly decisionToExecutionMs: SampleSummary;
  readonly decisions: number;
  readonly cpuMs: number | null;
}

export interface RunMeasurement {
  readonly steadySeconds: number;
  readonly tickServiceMs: readonly number[] | null;
  readonly tpsPerSecond: readonly number[];
  readonly workers: readonly WorkerMeasurement[];
  readonly actors: Readonly<{
    expectedDecisions: number;
    usefulDecisions: number;
    waitingWithReason: number;
    aliveAtStart: number | null;
    aliveAtEnd: number | null;
  }>;
  readonly queueDepthSamples: readonly number[];
  readonly droppedOptionalMetrics: number | null;
  readonly criticalEvidenceLost: number;
  readonly actionOutcomes: Readonly<Record<string, number>>;
  readonly searchWork: number | null;
  readonly chunkGeneration: Readonly<{ count: number | null; milliseconds: number | null }>;
  readonly encodedBytes: number | null;
  readonly logBytesPerSecond: number | null;
  readonly serverCpuMs: number | null;
  readonly supervisorCpuMs: number | null;
  readonly operationalFailure?: string;
}
