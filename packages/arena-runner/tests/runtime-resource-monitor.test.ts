import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';
import {
  startOwnedResourceMonitor,
  type ResourceMonitorEffects,
  type ResourceMonitorSampleEvent,
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

test('resource monitor emits opt-in samples with explicit injected-effect availability', async () => {
  const effects = createEffects([sample(), sample()]);
  const events: ResourceMonitorSampleEvent[] = [];
  let resolveSecondSample!: () => void;
  const secondSample = new Promise<void>((resolve) => { resolveSecondSample = resolve; });
  const monitor = await startOwnedResourceMonitor({
    javaPid: 1,
    effects,
    onSample: (event) => {
      events.push(event);
      if (events.length === 2) resolveSecondSample();
    },
  });

  effects.tick();
  await secondSample;
  await monitor.stop();

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.status, 'sampled');
    if (event.status !== 'sampled') continue;
    assert.equal(event.observation.source, 'injected_effects');
    assert.equal(event.observation.node.pid, process.pid);
    assert.equal(event.observation.node.rssBytes, 0);
    assert.equal(event.observation.java.pid, 1);
    assert.equal(event.observation.java.rssBytes, 128n * 1024n * 1024n);
    assert.deepEqual(event.observation.java.cpuTime, {
      status: 'unavailable',
      reason: 'injected_effects',
    });
    assert.deepEqual(event.observation.timing.commands, []);
  }
  assert.equal(events[0]?.status === 'sampled' ? events[0].observation.timing.pollTimerDelayNs : 1n, null);
  assert.equal(events[1]?.status === 'sampled' ? events[1].observation.timing.pollTimerDelayNs : 1n, null);
});

test('resource monitor surfaces sample callback failures', async () => {
  const effects = createEffects([sample()]);

  await assert.rejects(
    startOwnedResourceMonitor({
      javaPid: 1,
      effects,
      onSample: () => { throw new Error('diagnostic sink failed'); },
    }),
    (error: unknown) => error instanceof RunnerError
      && error.source.kind === 'resource_sample_callback_failed'
      && error.source.reason === 'diagnostic sink failed',
  );
});

test('Darwin host diagnostics parse current ps TIME output without a fallback', { skip: process.platform !== 'darwin' }, async (t) => {
  if (process.availableMemory() < Number(4n * GIB)) {
    t.skip('host available memory is below the monitor limit');
    return;
  }
  const scratch = mkdtempSync(join(process.cwd(), '.work', 'tmp', 'resource-monitor-ps-fixture-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakePs = join(scratch, 'ps');
  const fakeVmStat = join(scratch, 'vm_stat');
  writeFileSync(fakePs, '#!/bin/sh\nif [ "$ARENA_TEST_BAD_PS_TIME" = 1 ]; then\n  printf \' 2048 invalid-time\\n\'\nelse\n  printf \' 2048 1:02.34\\n\'\nfi\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(fakeVmStat, '#!/bin/sh\nprintf \'Pages free: 42.\\nSwapins: 0.\\nSwapouts: 0.\\n\'\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  chmodSync(fakePs, 0o700);
  chmodSync(fakeVmStat, 0o700);

  const originalPath = process.env.PATH;
  const originalBadTime = process.env.ARENA_TEST_BAD_PS_TIME;
  process.env.PATH = `${scratch}${delimiter}${originalPath ?? ''}`;
  delete process.env.ARENA_TEST_BAD_PS_TIME;
  let monitor: Awaited<ReturnType<typeof startOwnedResourceMonitor>> | undefined;
  try {
    const events: ResourceMonitorSampleEvent[] = [];
    monitor = await startOwnedResourceMonitor({ javaPid: 1, onSample: (event) => events.push(event) });
    const event = events[0];
    assert.ok(event?.status === 'sampled');
    assert.equal(event.observation.source, 'host');
    assert.equal(event.observation.java.rssBytes, 2_048n * 1_024n);
    assert.deepEqual(event.observation.java.cpuTime, { status: 'available', microseconds: 62_340_000n });
    const psObservation = event.observation.timing.commands.find((command) => command.command === 'ps');
    assert.ok(psObservation?.status === 'closed');
    assert.ok(psObservation.requestedAtNs <= psObservation.spawnedAtNs!);
    assert.ok(psObservation.spawnedAtNs! <= psObservation.closedAtNs);
    await monitor.stop();
    monitor = undefined;

    process.env.ARENA_TEST_BAD_PS_TIME = '1';
    const failedEvents: ResourceMonitorSampleEvent[] = [];
    await assert.rejects(
      startOwnedResourceMonitor({ javaPid: 1, onSample: (failed) => failedEvents.push(failed) }),
      (error: unknown) => error instanceof RunnerError && error.source.kind === 'invalid_process_metrics',
    );
    const failedEvent = failedEvents[0];
    assert.ok(failedEvent?.status === 'failed');
    assert.ok(failedEvent.timing.commands.some((command) => command.command === 'ps' && command.status === 'closed'));
  } finally {
    await monitor?.stop();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalBadTime === undefined) delete process.env.ARENA_TEST_BAD_PS_TIME;
    else process.env.ARENA_TEST_BAD_PS_TIME = originalBadTime;
  }
});

test('resource monitor times out, kills, and reaps a stalled host command', async (t) => {
  const scratch = mkdtempSync(join(process.cwd(), '.work', 'tmp', 'resource-monitor-command-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakePs = join(scratch, 'ps');
  const childPidPath = join(scratch, 'child.pid');
  const events: ResourceMonitorSampleEvent[] = [];
  writeFileSync(fakePs, '#!/bin/sh\nprintf \'%s\\n\' "$$" > "$ARENA_TEST_RESOURCE_PID_FILE"\nexec /bin/sleep 30\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
  chmodSync(fakePs, 0o700);

  const originalPath = process.env.PATH;
  const originalPidFile = process.env.ARENA_TEST_RESOURCE_PID_FILE;
  process.env.PATH = `${scratch}${delimiter}${originalPath ?? ''}`;
  process.env.ARENA_TEST_RESOURCE_PID_FILE = childPidPath;
  try {
    await assert.rejects(
      startOwnedResourceMonitor({ javaPid: 1, onSample: (event) => events.push(event) }),
      (error: unknown) => error instanceof RunnerError
        && error.source.kind === 'resource_command_timeout'
        && error.source.field === 'ps',
    );

    const failedSample = events.find((event) => event.status === 'failed');
    assert.ok(failedSample?.status === 'failed');
    const timedOutPs = failedSample.timing.commands.find((command) =>
      command.command === 'ps' && command.status === 'timed_out');
    assert.ok(timedOutPs?.status === 'timed_out');
    assert.ok(timedOutPs.requestedAtNs < timedOutPs.deadlineAtNs);
    assert.ok(timedOutPs.deadlineAtNs <= timedOutPs.timeoutFiredAtNs);
    assert.ok(timedOutPs.spawnedAtNs !== undefined);

    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'the stalled command must record its process id');
    assert.throws(() => process.kill(childPid, 0), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ESRCH');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPidFile === undefined) delete process.env.ARENA_TEST_RESOURCE_PID_FILE;
    else process.env.ARENA_TEST_RESOURCE_PID_FILE = originalPidFile;
  }
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
