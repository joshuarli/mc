import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';
import {
  startOwnedResourceMonitor,
  type ResourceMonitorEffects,
  type RuntimeResourceSample,
} from '../src/runtime/resource-monitor.js';

const GIB = 1024n * 1024n * 1024n;

test('resource monitor rejects the initial sample when owned RSS exceeds 8 GiB', async () => {
  const effects = createEffects([sample({ ownedRssBytes: 8n * GIB + 1n })]);

  await assert.rejects(
    startOwnedResourceMonitor({ javaPid: 1, effects }),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'owned_rss_limit_exceeded',
  );
});

test('resource monitor uses process-available memory from its host effects', async () => {
  const effects = createEffects([sample({ availableMemoryBytes: 16n * GIB })]);
  const monitor = await startOwnedResourceMonitor({ javaPid: 1, effects });

  assert.equal(effects.availableMemoryReadCount, 1);
  await monitor.stop();
});

test('resource monitor aborts after process-available memory falls below 4 GiB', async () => {
  const effects = createEffects([
    sample({ availableMemoryBytes: 4n * GIB }),
    sample({ availableMemoryBytes: 4n * GIB - 1n }),
  ]);
  const monitor = await startOwnedResourceMonitor({ javaPid: 1, effects });

  effects.tick();
  const failure = await monitor.failure;
  assert.equal(failure.source.kind, 'available_memory_limit_exceeded');
  await monitor.stop();
});

test('resource monitor aborts when swap counters advance', async () => {
  const effects = createEffects([
    sample({ swapIns: 10n, swapOuts: 4n }),
    sample({ swapIns: 10n, swapOuts: 5n }),
  ]);
  const monitor = await startOwnedResourceMonitor({ javaPid: 1, effects });

  effects.tick();
  const failure = await monitor.failure;
  assert.equal(failure.source.kind, 'system_swapping_detected');
  assert.equal(failure.source.field, 'swap_outs');
  await monitor.stop();
});

test('resource monitor stops its pending poll without starting another sample', async () => {
  const effects = createEffects([sample()]);
  const monitor = await startOwnedResourceMonitor({ javaPid: 1, effects });

  await monitor.stop();
  assert.equal(effects.sampleCount, 1);
});

test('resource monitor reports unavailable measurements without a fallback', async () => {
  const effects: ResourceMonitorEffects = {
    readJavaRssBytes: async () => 128n * 1024n * 1024n,
    readSwapCounters: async () => {
      throw new RunnerError('missing_prerequisite', 'runtime resource monitor', {
        kind: 'swap_counters_unavailable',
      });
    },
    nodeRssBytes: () => 0,
    availableMemoryBytes: () => Number(16n * GIB),
    wait: async () => {},
  };

  await assert.rejects(
    startOwnedResourceMonitor({ javaPid: 1, effects }),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'swap_counters_unavailable',
  );
});

function sample(overrides: Partial<RuntimeResourceSample> = {}): RuntimeResourceSample {
  return Object.freeze({
    ownedRssBytes: 128n * 1024n * 1024n,
    availableMemoryBytes: 16n * GIB,
    swapIns: 0n,
    swapOuts: 0n,
    ...overrides,
  });
}

function createEffects(samples: readonly RuntimeResourceSample[]): ResourceMonitorEffects & {
  readonly sampleCount: number;
  readonly availableMemoryReadCount: number;
  tick(): void;
} {
  let nextSample = 0;
  let currentSample: RuntimeResourceSample | undefined;
  let availableMemoryReadCount = 0;
  const waiters: Array<() => void> = [];
  const effects: ResourceMonitorEffects & {
    sampleCount: number;
    availableMemoryReadCount: number;
    tick(): void;
  } = {
    readJavaRssBytes: async () => {
      const value = samples[nextSample];
      nextSample += 1;
      if (value === undefined) throw new Error('test sample exhausted');
      currentSample = value;
      return value.ownedRssBytes;
    },
    readSwapCounters: async () => {
      assert.ok(currentSample, 'Java RSS read selects a sample first');
      return { swapIns: currentSample.swapIns, swapOuts: currentSample.swapOuts };
    },
    nodeRssBytes: () => 0,
    availableMemoryBytes: () => {
      assert.ok(currentSample, 'Java RSS read selects a sample first');
      availableMemoryReadCount += 1;
      return Number(currentSample.availableMemoryBytes);
    },
    wait: (_intervalMs, signal) => new Promise<void>((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      waiters.push(finish);
    }),
    get sampleCount() { return nextSample; },
    get availableMemoryReadCount() { return availableMemoryReadCount; },
    tick: () => {
      const wake = waiters.shift();
      assert.ok(wake, 'monitor is waiting for its next sample');
      wake();
    },
  };
  return effects;
}
