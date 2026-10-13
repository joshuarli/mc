import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { runCli } from "../../packages/arena-runner/src/cli.js";
import {
  listOwnedRuns,
  MAX_OWNED_READ_BYTES,
  readOwnedFile,
} from "../../packages/arena-runner/src/owned-files/index.js";
import { runPreparedRun } from "../../packages/arena-runner/src/runtime/run.js";
import type { CompletedOwnedRun } from "../../packages/arena-runner/src/runtime/types.js";
import { parseSegment } from "../../packages/arena-runner/src/trace.js";
import { prepareOwnedAcceptanceRun } from "./support/owned-run.js";

const ROOT = process.cwd();
const GAME_PORT = 25565;
const CYCLE_COUNT = 10;
const ARCHIVE_BATCH_SIZE = 2;
const SCENARIO_SOURCE = "tests/acceptance/fixtures/maps-reset-scenario.toml";

test("lifecycle-smoke", { timeout: 120_000 }, async (t) => {
  const scenario = createLifecycleScenario();
  t.after(() => rmSync(scenario.directory, { recursive: true, force: true }));
  await archiveCompletedCycles([await runLifecycleCycle(scenario.path, 1, t.signal)]);
});

test("lifecycle", { timeout: 900_000 }, async (t) => {
  const scenario = createLifecycleScenario();
  t.after(() => rmSync(scenario.directory, { recursive: true, force: true }));

  let batch: CompletedCycle[] = [];
  for (let cycle = 1; cycle <= CYCLE_COUNT; cycle += 1) {
    try {
      const completed = await runLifecycleCycle(scenario.path, cycle, t.signal);
      batch.push(completed);
      if (batch.length === ARCHIVE_BATCH_SIZE) {
        await archiveCompletedCycles(batch);
        batch = [];
      }
    } catch (cause) {
      throw new Error(`lifecycle start-stop cycle ${cycle} failed`, { cause });
    }
  }
  if (batch.length > 0) await archiveCompletedCycles(batch);
});

interface CompletedCycle {
  readonly prepared: Awaited<ReturnType<typeof prepareOwnedAcceptanceRun>>;
  readonly completed: CompletedOwnedRun;
}

async function runLifecycleCycle(
  scenarioPath: string,
  cycle: number,
  signal: AbortSignal,
): Promise<CompletedCycle> {
  const prepared = await prepareOwnedAcceptanceRun(scenarioPath, `lifecycle-${cycle}`, signal);
  const beforeServers = activeResourceCount("TCPServerWrap");
  const beforeSockets = activeResourceCount("TCPSocketWrap");
  const completed = await runPreparedRun({
    ...prepared,
    competitorDriver: "evaluator",
    evaluate: async (active) => {
      assert.equal(
        activeResourceCount("TCPServerWrap"),
        beforeServers,
        "the authenticated control listener must already be closed",
      );
      assert.ok(
        activeResourceCount("TCPSocketWrap") > beforeSockets,
        "the lifecycle probe must observe live control and bot sockets",
      );
      await active.start();
      await active.waitForOutcome();
    },
  });

  assert.equal(completed.outcome.kind, "draw", "the short no-fight match must finish at its tick limit");
  assert.ok(completed.events.some((event) => event.type === "outcome"));
  assert.ok(completed.trace.segments.length > 0);
  assert.equal(ownedJavaProcesses(completed.runId).length, 0, "the runtime must reap its Paper process");
  await nextTurn();
  assert.equal(activeResourceCount("TCPServerWrap"), beforeServers, "the control listener must be closed");
  assert.equal(activeResourceCount("TCPSocketWrap"), beforeSockets, "the runtime must close its control and bot sockets");
  await assertGamePortReleased();
  return { prepared, completed };
}

async function archiveCompletedCycles(cycles: readonly CompletedCycle[]): Promise<void> {
  assert.ok(cycles.length > 0 && cycles.length <= ARCHIVE_BATCH_SIZE);
  const helperPath = cycles[0]!.prepared.helperPath;
  assert.ok(cycles.every(({ prepared }) => prepared.helperPath === helperPath));
  const selectedRuns = cycles.flatMap(({ completed }) => ["--run-id", completed.runId]);
  const preview = await runCliWithHelper(helperPath, ["gc", "--dry-run", ...selectedRuns]);
  if (preview.kind !== "success") throw new Error(`GC preflight failed: ${preview.stderr}`);
  assert.equal(preview.kind, "success");
  const previewResult = parseJsonObject(preview.stdout, "GC preflight must return a JSON object");
  assert.equal(previewResult.mode, "dry_run");
  assert.ok(Array.isArray(previewResult.runs));
  const previewDecisions = previewResult.runs as readonly Record<string, unknown>[];
  assert.equal(previewDecisions.length, cycles.length);
  for (const { completed } of cycles) {
    const decision = previewDecisions.find((row) => row.run_id === completed.runId);
    assert.ok(decision, `GC preflight must report lifecycle run ${completed.runId}`);
    assert.equal(decision.status, "eligible", "GC must identify the completed run as eligible before apply");
    assert.equal(decision.reason, "completed_success");
    assert.equal(decision.outcome_kind, completed.outcome.kind);
  }

  const args = ["gc", "--apply", ...selectedRuns];
  const gc = await runCliWithHelper(helperPath, args);
  if (gc.kind !== "success") throw new Error(`GC failed: ${gc.stderr}`);
  assert.equal(gc.kind, "success");
  const result = parseJsonObject(gc.stdout, "GC must return a JSON object");
  assert.equal(result.mode, "apply");
  assert.ok(Array.isArray(result.runs));
  const decisions = result.runs as readonly Record<string, unknown>[];
  assert.equal(decisions.length, cycles.length);

  for (const { prepared, completed } of cycles) {
    const decision = decisions.find((row) => row.run_id === completed.runId);
    assert.ok(decision, `GC must report lifecycle run ${completed.runId}`);
    assert.equal(decision.status, "removed", "GC must remove a completed lifecycle run");
    assert.equal(decision.reason, "completed_success");
    assert.equal(decision.outcome_kind, completed.outcome.kind);
    assert.equal(typeof decision.evidence_path, "string");

    const inspected = await runCliWithHelper(prepared.helperPath, ["inspect", "--run-id", completed.runId]);
    if (inspected.kind !== "success") throw new Error(`archived run inspection failed: ${inspected.stderr}`);
    assert.equal(inspected.kind, "success");
    const archive = parseJsonObject(inspected.stdout, "archive inspection must return a JSON object");
    assert.equal(archive.run_id, completed.runId);
    assert.ok(archive.report !== null && typeof archive.report === "object");
    assert.ok(Array.isArray(archive.stats), "the archived stopped stats must remain readable");
    assert.equal(archive.stats.length, completed.competitors.length);
    assert.equal(JSON.stringify(archive.stats), JSON.stringify(completed.stats));

    let archivedByteLength = 0;
    let archivedOutcome = false;
    for (const segment of completed.trace.segments) {
      const filename = segment.relativePath.toString("utf8").split("/").at(-1);
      assert.ok(filename, "completed trace segments must have a filename");
      const contents = await readOwnedFile({
        helperPath: prepared.helperPath,
        ownedRoot: prepared.ownedRoot,
        relativePath: Buffer.from(`.work/arena/traces/${completed.runId}/${filename}`, "ascii"),
        maxBytes: MAX_OWNED_READ_BYTES,
      });
      const parsed = parseSegment(contents);
      assert.equal(parsed.runId, completed.runId);
      assert.equal(parsed.byteLength, segment.byteLength);
      archivedByteLength += parsed.byteLength;
      archivedOutcome ||= parsed.records.some((record) => {
        const envelope = record as Record<string, unknown>;
        return envelope.direction === "plugin" && envelope.type === "outcome";
      });
    }
    assert.equal(archivedByteLength, completed.trace.totalByteLength);
    assert.equal(archivedOutcome, true, "the archived trace must retain the terminal plugin outcome");
  }

  const liveRuns = await listOwnedRuns({
    helperPath,
    ownedRoot: Buffer.from(ROOT, "utf8"),
  });
  for (const { completed } of cycles) {
    assert.ok(!liveRuns.some((run) => run.runId === completed.runId), "GC must remove the live run after archival");
  }
}

async function runCliWithHelper(helperPath: string, args: readonly string[]) {
  const previousHelperPath = process.env.ARENA_FS_HELPER;
  process.env.ARENA_FS_HELPER = helperPath;
  try {
    return await runCli(args);
  } finally {
    if (previousHelperPath === undefined) delete process.env.ARENA_FS_HELPER;
    else process.env.ARENA_FS_HELPER = previousHelperPath;
  }
}

function createLifecycleScenario(): Readonly<{ directory: string; path: string }> {
  const directory = mkdtempSync(join(ROOT, ".work", "tmp", "arena-lifecycle-scenario-"));
  const absolutePath = join(directory, "scenario.toml");
  let source = readFileSync(join(ROOT, SCENARIO_SOURCE), "utf8");
  for (const [expected, replacement] of [
    ['map = "maps-reset-map.toml"', 'map = "../../../tests/acceptance/fixtures/maps-reset-map.toml"'],
    ['policy = "../../../policies/baseline.toml"', 'policy = "../../../policies/baseline.toml"'],
    ["countdown_ticks = 20", "countdown_ticks = 0"],
    ["grace_ticks = 20", "grace_ticks = 0"],
    ["authoritative_max_ticks = 600", "authoritative_max_ticks = 2"],
    ["shrink_start_tick = 230", "shrink_start_tick = 0"],
    ["shrink_end_tick = 250", "shrink_end_tick = 1"],
  ] as const) {
    source = replaceExactlyOnce(source, expected, replacement);
  }
  writeFileSync(absolutePath, source, { encoding: "utf8", flag: "wx" });
  return Object.freeze({
    directory,
    path: relative(ROOT, absolutePath).split("\\").join("/"),
  });
}

function replaceExactlyOnce(source: string, expected: string, replacement: string): string {
  assert.equal(source.split(expected).length - 1, 1, `expected exactly one scenario field ${expected}`);
  return source.replace(expected, replacement);
}

function parseJsonObject(source: string, message: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), message);
  return parsed as Record<string, unknown>;
}

function activeResourceCount(resourceName: string): number {
  return process.getActiveResourcesInfo().filter((name) => name === resourceName).length;
}

function assertGamePortReleased(): Promise<void> {
  const probe = createServer();
  return new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: GAME_PORT, exclusive: true }, () => {
      probe.removeAllListeners("error");
      probe.close((error) => error === undefined ? resolve() : reject(error));
    });
  });
}

function ownedJavaProcesses(runId: string): readonly Readonly<{ pid: number; ppid: number; command: string }>[] {
  const listing = execFileSync("ps", ["-ww", "-A", "-o", "pid=", "-o", "ppid=", "-o", "command="], {
    encoding: "utf8",
  });
  const marker = `-Darena.run-id=${runId}`;
  const matches: { pid: number; ppid: number; command: string }[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null || match[3] === undefined || !match[3].includes(marker)) continue;
    matches.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return matches;
}
