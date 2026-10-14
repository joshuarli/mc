import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { decodeCheckpoint } from "../../packages/arena-runner/src/control/checkpoint.js";
import { loadCheckpoint } from "../../packages/arena-runner/src/checkpoint/persist.js";
import { readSaveResult, requestSave } from "../../packages/arena-runner/src/checkpoint/save-request.js";
import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import { prepareRun } from "../../packages/arena-runner/src/prepare.js";
import { runPreparedRun } from "../../packages/arena-runner/src/runtime/run.js";
import type { RunPreparedRunOptions } from "../../packages/arena-runner/src/runtime/run.js";

const FIXTURE_DIRECTORY = ".work/tmp/checkpoint-resume-fixture";
const SCENARIO_PATH = `${FIXTURE_DIRECTORY}/scenario.toml`;
const CHECKPOINT_AFTER_TICK = 600;
const ROW_TIMEOUT_MS = 600_000;

interface Stack {
  readonly helperPath: string;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
}

test("checkpoint-resume", { timeout: 3_000_000 }, async (t) => {
  writeFixture();
  const stack = resolveStack();
  const ownedRoot = Buffer.from(process.cwd(), "utf8");
  const files = (runId: string) => ({
    helperPath: stack.helperPath, ownedRoot, runDirectoryPath: Buffer.from(`.work/arena/runs/${runId}`),
  });
  const base = async (name: string, signal: AbortSignal) => {
    const runId = `ckpt-${name}-${randomUUID()}`.slice(0, 60);
    const preparedRun = await prepareRun(stack.helperPath, ownedRoot, Buffer.from(SCENARIO_PATH), runId, signal);
    const options: RunPreparedRunOptions = {
      preparedRun, helperPath: stack.helperPath, ownedRoot, javaExecutable: stack.javaExecutable,
      paperJarPath: stack.paperJarPath, pluginJarPath: stack.pluginJarPath, acceptMinecraftEula: true,
      checkpointing: true, checkpointScenario: { externalSeat: null }, signal,
    };
    return { runId, options };
  };

  let checkpointId = "";
  await t.test("a running match saves at a barrier and resumes in the next epoch", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const { runId, options } = await base("save", row.signal);
    checkpointId = `${runId}-cp`.slice(0, 63);
    let requested = false;
    const saved = await runPreparedRun({
      ...options,
      onPolicyActivity: (event) => {
        if (requested || event.kind !== "decision" || event.tick < CHECKPOINT_AFTER_TICK) return;
        requested = true;
        void requestSave(files(runId), checkpointId);
      },
    });
    assert.ok(saved.checkpoint, "the run must end with a checkpoint instead of an outcome");
    const result = await readSaveResult(files(runId));
    assert.equal(result?.status, "saved");
    assert.equal(saved.checkpoint.epoch, 0);
    assert.ok(BigInt(saved.checkpoint.match_tick) >= BigInt(CHECKPOINT_AFTER_TICK));

    const loaded = await loadCheckpoint({ helperPath: stack.helperPath, ownedRoot, checkpointId });
    const decoded = decodeCheckpoint(readFileSync(join(process.cwd(), loaded.recordPath.toString("utf8"))));
    assert.equal(decoded.digest, loaded.manifest.record.digest);
    const living = loaded.record.seats.filter((seat) => seat.alive).map((seat) => seat.seat);
    assert.ok(living.length >= 2);

    const resumedRun = await base("resume", row.signal);
    const alive: number[][] = [];
    const first = { tick: undefined as bigint | undefined };
    const resumed = await runPreparedRun({
      ...resumedRun.options,
      resume: loaded,
      onPhase: () => undefined,
    });
    for (const event of resumed.events) {
      if (event.type === "public_state") alive.push([...event.payload.alive_seats]);
      if (event.type === "public_clock" && event.payload.tick !== null && first.tick === undefined) first.tick = event.payload.tick.value;
    }
    assert.ok(first.tick !== undefined && first.tick >= BigInt(loaded.manifest.match_tick), "the match tick must continue");
    assert.ok(alive.length > 0);
    const dead = new Set(loaded.record.seats.filter((seat) => !seat.alive).map((seat) => seat.seat));
    for (const seats of alive) {
      for (const seat of seats) assert.equal(dead.has(seat), false, `eliminated seat ${seat} must stay out of play`);
      assert.ok(seats.every((seat) => living.includes(seat)));
    }
    assert.ok(resumed.outcome.kind === "winner" || resumed.outcome.kind === "draw");
  });

  await t.test("a tampered or truncated checkpoint is refused before Paper starts", { timeout: 60_000 }, async () => {
    assert.ok(checkpointId, "the save row must have produced a checkpoint");
    const loaded = await loadCheckpoint({ helperPath: stack.helperPath, ownedRoot, checkpointId });
    const original = readFileSync(join(process.cwd(), loaded.recordPath.toString("utf8")));
    assert.throws(() => decodeCheckpoint(original.subarray(0, original.length - 30)));
    await assert.rejects(loadCheckpoint({ helperPath: stack.helperPath, ownedRoot, checkpointId: "no-such-checkpoint" }),
      (error: unknown) => error instanceof RunnerError && error.category === "missing_prerequisite");
  });

  await t.test("a resume with the wrong digest or epoch is rejected by the plugin", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const loaded = await loadCheckpoint({ helperPath: stack.helperPath, ownedRoot, checkpointId });
    const wrongDigest = {
      ...loaded,
      manifest: { ...loaded.manifest, record: { ...loaded.manifest.record, digest: "0".repeat(64) } },
    };
    const wrongEpoch = { ...loaded, record: { ...loaded.record, epoch: loaded.record.epoch + 1 } };
    for (const [name, resume] of [["digest", wrongDigest], ["epoch", wrongEpoch]] as const) {
      const attempt = await base(`bad-${name}`, row.signal);
      await assert.rejects(runPreparedRun({ ...attempt.options, resume }), (error: unknown) =>
        error instanceof RunnerError && error.source.kind === "plugin_rejected_command");
    }
  });

  await t.test("a checkpoint requested before the grace period is rejected and the run keeps going", { timeout: ROW_TIMEOUT_MS }, async (row) => {
    const { runId, options } = await base("early", row.signal);
    const abort = new AbortController();
    const outcome = runPreparedRun({
      ...options,
      signal: AbortSignal.any([row.signal, abort.signal]),
      onRosterReady: () => { void requestSave(files(runId), `${runId}-cp`.slice(0, 63)); },
      onPhase: (phase) => { if (phase === "active") setTimeout(() => abort.abort(new RunnerError("cancelled", "arena run", { kind: "cancelled" })), 3_000); },
    }).then(() => undefined, (error: unknown) => error);
    const failure = await outcome;
    assert.ok(failure instanceof RunnerError && failure.category === "cancelled");
    const result = await readSaveResult(files(runId));
    assert.equal(result?.status, "failed");
    assert.equal(result.reason, "checkpoint_requires_grace_or_active");
  });
});

function writeFixture(): void {
  const root = process.cwd();
  const scenario = readFileSync(join(root, "scenarios/hunger-12.toml"), "utf8");
  const map = readFileSync(join(root, "maps/hunger-12.toml"), "utf8");
  mkdirSync(join(root, FIXTURE_DIRECTORY), { recursive: true });
  const text = [
    ['map = "../maps/hunger-12.toml"', 'map = "map.toml"'],
    ['policy = "../policies/baseline.toml"', 'policy = "../../../policies/baseline.toml"'],
    ["countdown_ticks = 100", "countdown_ticks = 40"],
    ["grace_ticks = 200", "grace_ticks = 100"],
    ["authoritative_max_ticks = 7200", "authoritative_max_ticks = 1800"],
    ["shrink_start_tick = 1200", "shrink_start_tick = 1500"],
    ["shrink_end_tick = 6000", "shrink_end_tick = 1780"],
  ].reduce((current, [from, to]) => {
    assert.ok(current.includes(from!), `scenario source must contain ${from}`);
    return current.replace(from!, to!);
  }, scenario);
  writeFileSync(join(root, FIXTURE_DIRECTORY, "map.toml"), map);
  writeFileSync(join(root, SCENARIO_PATH), text);
}

function resolveStack(): Stack {
  const repositoryRoot = process.cwd();
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome, "the pinned JDK must be configured by the arena test selector");
  const lock = readFileSync(join(repositoryRoot, "versions.lock.toml"), "utf8");
  const paperFile = /\[paper\][^[]*?server_file = "([^"]+)"/s.exec(lock)?.[1];
  assert.ok(paperFile, "versions.lock.toml must name the Paper server file");
  const stack: Stack = {
    helperPath: process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs"),
    javaExecutable: join(javaHome, "bin/java"),
    paperJarPath: join(repositoryRoot, ".work/arena/downloads", paperFile),
    pluginJarPath: join(repositoryRoot, ".work/arena/gradle-build/libs/arena-plugin-0.1.0.jar"),
  };
  for (const path of Object.values(stack)) {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `required stack file must be a regular file: ${path}`);
  }
  return stack;
}
