import assert from "node:assert/strict";
import { test } from "node:test";

import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import type { ResourceMonitorSampleEvent } from "../../packages/arena-runner/src/runtime/resource-monitor.js";
import { withHungerResourceDiagnostic } from "./hunger-resource-diagnostic.js";

const context = {
  helperPath: "owned-helper",
  ownedRoot: Buffer.from("repository"),
  preparedRun: { runId: "hunger-first-seed", runDirectoryPath: Buffer.from(".work/arena/runs/hunger-first-seed") },
  seed: 481516n,
};

function failedSample(): Extract<ResourceMonitorSampleEvent, { status: "failed" }> {
  return {
    status: "failed",
    source: new RunnerError("runtime_failure", "runtime resource monitor", {
      kind: "resource_command_timeout", field: "vm_stat",
    }),
    timing: {
      sampleStartedAtNs: 90071992547409930n,
      sampleCompletedAtNs: 90071996547409930n,
      pollTimerDelayNs: 123456789n,
      commands: [{
        status: "timed_out", command: "vm_stat", requestedAtNs: 90071992547409931n,
        spawnedAtNs: 90071992547409932n, deadlineAtNs: 90071994547409931n,
        timeoutFiredAtNs: 90071996547409931n,
        exit: { atNs: 90071996547409932n, code: 0, signal: null },
        close: { atNs: 90071996547409933n, code: 0, signal: null },
      }],
    },
  };
}

test("hunger resource diagnostic retains first raw startup failure after cleanup", async () => {
  const first = failedSample();
  const initiatingError = first.source;
  const mutableCommands = [...first.timing.commands];
  let runtimeCleaned = false;
  let stageCount = 0;
  await assert.rejects(withHungerResourceDiagnostic(context, async (onSample) => {
    onSample({ ...first, timing: { ...first.timing, commands: mutableCommands } });
    mutableCommands.length = 0;
    onSample({ ...first, timing: { ...first.timing, sampleStartedAtNs: 1n } });
    runtimeCleaned = true;
    throw initiatingError;
  }, async (request) => {
    stageCount += 1;
    assert.ok(runtimeCleaned);
    assert.equal(request.relativePath.toString(), ".work/arena/runs/hunger-first-seed/hunger-resource-failure-v1.json");
    assert.ok(request.signal);
    assert.equal(request.signal.aborted, false, "run cancellation must not cancel post-cleanup staging");
    assert.ok(request.contents.length <= request.maxBytes);
    assert.deepEqual(JSON.parse(request.contents.toString()), {
      schema: 1, run_id: context.preparedRun.runId, seed: "481516",
      event: JSON.parse(JSON.stringify({
        ...first, source: { category: first.source.category, resource: first.source.resource, source: first.source.source },
      }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)),
    });
  }), (error) => error === initiatingError);
  assert.equal(stageCount, 1);
});

test("hunger resource diagnostic preserves cancellation identity without failed samples", async () => {
  const cancellation = new Error("cancelled");
  await assert.rejects(withHungerResourceDiagnostic(context, async () => { throw cancellation; }, async () => {
    assert.fail("no failed sample means no diagnostic artifact");
  }), (error) => error === cancellation);
});

test("hunger resource diagnostic aggregates staging failure after awaiting it", async () => {
  const event = failedSample();
  const stagingFailure = new Error("owned stage failed");
  let stagingSettled = false;
  await assert.rejects(withHungerResourceDiagnostic(context, async (onSample) => {
    onSample(event);
    throw event.source;
  }, async () => {
    await Promise.resolve();
    stagingSettled = true;
    throw stagingFailure;
  }), (error) => {
    assert.ok(stagingSettled);
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, event.source);
    assert.deepEqual(error.errors, [event.source, stagingFailure]);
    return true;
  });
});

test("hunger resource diagnostic rejects command count and byte overflow without changing runtime failure", async () => {
  const first = failedSample();
  for (const event of [
    { ...first, timing: { ...first.timing, commands: Array(3).fill(first.timing.commands[0]) } },
    { ...first, timing: { ...first.timing, sampleStartedAtNs: BigInt("9".repeat(20_000)) } },
  ]) {
    let staged = false;
    await assert.rejects(withHungerResourceDiagnostic(context, async (onSample) => {
      assert.doesNotThrow(() => onSample(event));
      throw first.source;
    }, async () => { staged = true; }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, first.source);
      assert.equal(error.errors[0], first.source);
      assert.ok(error.errors[1] instanceof RangeError);
      return true;
    });
    assert.equal(staged, false);
  }
});

test("hunger resource diagnostic owns callbacks emitted during runtime cancellation cleanup", async () => {
  const controller = new AbortController();
  const cancellation = new Error("owner cancelled");
  const event = failedSample();
  controller.abort(cancellation);
  let staged = false;
  await assert.rejects(withHungerResourceDiagnostic(context, async (onSample) => {
    try { controller.signal.throwIfAborted(); }
    finally { onSample(event); }
  }, async () => { staged = true; }), (error) => error === cancellation);
  assert.ok(staged);
});

test("hunger resource diagnostic bounds staging and clears its deadline after settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const event = failedSample();
  let stageStarted!: () => void;
  const started = new Promise<void>((resolve) => { stageStarted = resolve; });
  const pending = withHungerResourceDiagnostic(context, async (onSample) => {
    onSample(event);
    throw event.source;
  }, async (request) => {
    assert.ok(request.signal);
    const signal = request.signal;
    stageStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const rejected = assert.rejects(pending, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, event.source);
    assert.equal(error.errors[0], event.source);
    assert.ok(error.errors[1] instanceof Error);
    assert.equal(error.errors[1].name, "TimeoutError");
    return true;
  });
  await started;
  t.mock.timers.tick(10_000);
  await rejected;

  let completedSignal: AbortSignal | undefined;
  await assert.rejects(withHungerResourceDiagnostic(context, async (onSample) => {
    onSample(event);
    throw event.source;
  }, async (request) => { completedSignal = request.signal; }), (error) => error === event.source);
  t.mock.timers.tick(10_000);
  assert.ok(completedSignal);
  assert.equal(completedSignal.aborted, false, "settled staging must clear its owned deadline");
});
