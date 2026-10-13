import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import { decodeControlEnvelope } from "../../packages/arena-runner/src/control/index.js";
import { reconstruct, reconstructRunEvidence } from "../../packages/arena-runner/src/evidence.js";
import {
  acquireOwnedRunLease,
  MAX_OWNED_READ_BYTES,
  OwnedFilesError,
  readOwnedFile,
} from "../../packages/arena-runner/src/owned-files/index.js";
import { readOperationalFailureArtifact } from "../../packages/arena-runner/src/runtime/failure-artifact.js";
import { runPreparedRun } from "../../packages/arena-runner/src/runtime/run.js";
import { parseSegment } from "../../packages/arena-runner/src/trace.js";
import type { TraceSegment } from "../../packages/arena-runner/src/trace.js";
import { prepareOwnedAcceptanceRun } from "./support/owned-run.js";

const ROOT = process.cwd();
const GAME_PORT = 25565;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;

interface FaultScenario {
  readonly directory: string;
  readonly path: string;
}

interface FaultCase {
  readonly selector: string;
  readonly description: string;
  readonly timeoutMs: number;
  readonly run: (scenario: FaultScenario, testContext: TestContext) => Promise<void>;
}

const faultCases = [
  {
    selector: "faults-port-conflict",
    description: "occupied game port is reported as an owner conflict without stopping its owner",
    timeoutMs: 120_000,
    run: runOccupiedPortConflict,
  },
  {
    selector: "faults-second-owner",
    description: "a second runtime owner is rejected by the native run lease",
    timeoutMs: 60_000,
    run: runSecondOwnerConflict,
  },
  {
    selector: "faults-plugin-identity",
    description: "the runtime rejects a loaded plugin with the wrong identity",
    timeoutMs: 180_000,
    run: runWrongPluginIdentity,
  },
  {
    selector: "faults-server-crash",
    description: "a Paper crash closes control and leaves only a truthful partial trace",
    timeoutMs: 180_000,
    run: runPaperCrash,
  },
  {
    selector: "faults-sigint",
    description: "Ctrl-C returns exit 130 with a partial trace and no fabricated outcome",
    timeoutMs: 180_000,
    run: runSigint,
  },
] satisfies readonly FaultCase[];

for (const faultCase of faultCases) {
  test(faultCase.selector, { timeout: faultCase.timeoutMs }, async (testContext) => {
    const scenario = createLongRunningScenario();
    testContext.after(() => rmSync(scenario.directory, { recursive: true, force: true }));
    await faultCase.run(scenario, testContext);
  });
}

test("faults", { timeout: 900_000 }, async (testContext) => {
  const scenario = createLongRunningScenario();
  testContext.after(() => rmSync(scenario.directory, { recursive: true, force: true }));

  for (const faultCase of faultCases) {
    await testContext.test(faultCase.description, { timeout: faultCase.timeoutMs }, (caseTest) =>
      faultCase.run(scenario, caseTest));
  }
});

test("interrupted traces retain only requested operator aborts", () => {
  const segment = parseSegment(readFileSync(join(ROOT, "tests/fixtures/operator-abort/trace-v2-000001.json")));
  assert.doesNotThrow(() => assertInterruptedTrace([segment], "cancelled"));
  assert.throws(() => assertInterruptedTrace([segment], "runtime_failure"));
  const unsolicited = {
    ...segment,
    records: segment.records.filter((record) => record.direction !== "runner" || record.type !== "abort"),
  };
  assert.throws(() => assertInterruptedTrace([unsolicited], "cancelled"));
  const wrongReason = {
    ...segment,
    records: segment.records.map((record) => record.direction === "runner" && record.type === "abort"
      ? { ...record, payload: { reason: "wall_timeout" } }
      : record),
  };
  assert.throws(() => assertInterruptedTrace([wrongReason], "cancelled"));
});

async function runOccupiedPortConflict(scenario: FaultScenario, testContext: TestContext): Promise<void> {
  const prepared = await prepareOwnedAcceptanceRun(scenario.path, "fault-port-conflict", testContext.signal);
  const blocker = createServer();
  await listenOnGamePort(blocker);
  try {
    const failure = await expectRunnerFailure(runPreparedRun(prepared));
    assert.equal(failure.category, "owner_conflict");
    assert.equal(failure.source.kind, "paper_port_bind_failed");
    assert.equal(blocker.listening, true, "the runtime must leave the unrelated listener alive");
  } finally {
    await closeServer(blocker);
  }
}

async function runSecondOwnerConflict(scenario: FaultScenario, testContext: TestContext): Promise<void> {
  const prepared = await prepareOwnedAcceptanceRun(scenario.path, "fault-second-owner", testContext.signal);
  const owner = await acquireOwnedRunLease({
    helperPath: prepared.helperPath,
    ownedRoot: prepared.ownedRoot,
    relativePath: prepared.preparedRun.runDirectoryPath,
    signal: testContext.signal,
  });
  try {
    const failure = await expectRunnerFailure(runPreparedRun(prepared));
    assert.equal(failure.category, "owner_conflict");
    assert.equal(failure.source.kind, "owner_conflict");
  } finally {
    await owner.release();
  }
}

async function runWrongPluginIdentity(scenario: FaultScenario, testContext: TestContext): Promise<void> {
  const prepared = await prepareOwnedAcceptanceRun(scenario.path, "fault-plugin-identity", testContext.signal);
  const scratch = mkdtempSync(join(ROOT, ".work", "tmp", "arena-plugin-identity-"));
  try {
    const mismatchedPluginJar = replacePluginIdentity(prepared.pluginJarPath, prepared.javaExecutable, scratch);
    const failure = await expectRunnerFailure(runPreparedRun({
      ...prepared,
      pluginJarPath: mismatchedPluginJar,
    }));
    assert.equal(failure.category, "runtime_failure");
    assert.equal(failure.source.kind, "plugin_identity_mismatch");
    const artifact = await readOperationalFailureArtifact({
      helperPath: prepared.helperPath,
      ownedRoot: prepared.ownedRoot,
      runId: prepared.preparedRun.runId,
    });
    assert.equal(artifact.primary.source.kind, "plugin_identity_mismatch");
    await assertGamePortReleased();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function runPaperCrash(scenario: FaultScenario, testContext: TestContext): Promise<void> {
  const prepared = await prepareOwnedAcceptanceRun(scenario.path, "fault-server-crash", testContext.signal);
  const failure = await expectRunnerFailure(runPreparedRun({
    ...prepared,
    evaluate: async (active, signal) => {
      await active.start();
      await waitForTraceCheckpoint({
        helperPath: prepared.helperPath,
        ownedRoot: prepared.ownedRoot,
        runId: prepared.preparedRun.runId,
      }, signal, 90_000);
      const server = await waitForOwnedJavaProcess(prepared.preparedRun.runId, process.pid, signal, 10_000);
      process.kill(server.pid, "SIGKILL");
      await active.waitForOutcome();
    },
  }));
  assert.equal(failure.category, "runtime_failure");
  assert.ok(
    failure.source.kind === "server_exited_before_shutdown"
      || failure.source.kind === "control_disconnected"
      || failure.source.kind === "control_protocol",
    `unexpected server/control failure: ${failure.source.kind}`,
  );
  await assertInterruptedEvidence(prepared.helperPath, prepared.ownedRoot, prepared.preparedRun.runId, "runtime_failure");
  assert.equal(ownedJavaProcesses(prepared.preparedRun.runId).length, 0, "the crashed Paper process must be reaped");
  await assertGamePortReleased();
}

async function runSigint(scenario: FaultScenario, testContext: TestContext): Promise<void> {
  const runId = `fault-sigint-${randomUUID()}`;
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(ROOT, ".work/arena-fs/arena-fs");
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome, "the pinned JDK must be configured by the integration selector");
  const paperJarPath = join(ROOT, ".work", "arena", "downloads", lockedPaperFile());
  const pluginJarPath = join(ROOT, ".work", "arena", "gradle-build", "libs", "arena-plugin-0.1.0.jar");
  const javaExecutable = join(javaHome, "bin", "java");
  const cliPath = join(ROOT, ".work", "build", "packages", "arena-runner", "src", "cli.js");
  const marker = `ARENA_FAULT_RESULT_${runId}:`;
  const args = ["run", "--scenario", scenario.path, "--run-id", runId];
  const childSource = [
    `import { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};`,
    `const result = await runCli(${JSON.stringify(args)});`,
    `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(result) + "\\n");`,
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: ROOT,
    env: {
      ...process.env,
      ARENA_FS_HELPER: helperPath,
      ARENA_JAVA_HOME: javaHome,
      ARENA_JAVA_TMPDIR: join(ROOT, ".work", "tmp"),
      ARENA_PAPER_JAR: paperJarPath,
      ARENA_PLUGIN_JAR: pluginJarPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const captured = captureChildOutput(child);
  const closed = childExit(child);
  let finished = false;
  try {
    await once(child, "spawn");
    const childPid = child.pid;
    assert.ok(childPid, "the pinned Node child must expose its process id");
    await waitForTraceCheckpoint(
      { helperPath, ownedRoot: Buffer.from(ROOT, "utf8"), runId },
      testContext.signal,
      90_000,
      () => captured.status,
    );
    await waitForOwnedJavaProcess(runId, childPid, testContext.signal, 10_000);
    assert.equal(child.kill("SIGINT"), true, "the runtime child must still be running when Ctrl-C is sent");
    const status = await withTimeout(closed, 60_000, "Ctrl-C runtime cleanup");
    finished = true;
    assert.equal(status.code, 130, "the CLI child must preserve operator cancellation as exit 130");
    const result = parseChildResult(captured.output(), marker);
    assert.equal(result.kind, "failure");
    assert.equal(result.exitCode, 130);
    const error = parseCliError(result.stderr);
    assert.equal(error.category, "cancelled");
    assert.equal(error.source.kind, "cancelled");
    assert.equal(error.source.run_id, runId);

    const ownedRoot = Buffer.from(ROOT, "utf8");
    await assertInterruptedEvidence(helperPath, ownedRoot, runId, "cancelled");
    assert.equal(ownedJavaProcesses(runId).length, 0, "Ctrl-C cleanup must reap the Paper process");
    await assertGamePortReleased();
  } finally {
    if (!finished && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      await withTimeout(closed, 30_000, "interrupt failed CLI child").catch(() => {
        child.kill("SIGKILL");
        return closed;
      });
    }
  }
}

function createLongRunningScenario(): Readonly<{ directory: string; path: string }> {
  const directory = mkdtempSync(join(ROOT, ".work", "tmp", "arena-runtime-fault-scenario-"));
  const path = join(directory, "scenario.toml");
  const relativePath = relative(ROOT, path).split("\\").join("/");
  const source = readFileSync(join(ROOT, "tests", "acceptance", "fixtures", "maps-reset-scenario.toml"), "utf8");
  let adjusted = source;
  for (const [expected, replacement] of [
    ['map = "maps-reset-map.toml"', 'map = "map.toml"'],
    ['policy = "../../../policies/baseline.toml"', 'policy = "policy.toml"'],
    ['view_distance_chunks = 6', 'view_distance_chunks = 2'],
    ['simulation_distance_chunks = 5', 'simulation_distance_chunks = 2'],
    ["competitors = 2", "competitors = 3"],
    ["countdown_ticks = 20", "countdown_ticks = 1"],
    ["grace_ticks = 20", "grace_ticks = 1"],
    ["authoritative_max_ticks = 600", "authoritative_max_ticks = 10000"],
    ["initial_diameter_blocks = 62", "initial_diameter_blocks = 124"],
    ["shrink_start_tick = 230", "shrink_start_tick = 9000"],
    ["shrink_end_tick = 250", "shrink_end_tick = 9500"],
    ["final_diameter_blocks = 52", "final_diameter_blocks = 120"],
    ["strategy_interval_ticks = 4", "strategy_interval_ticks = 1"],
  ] as const) {
    adjusted = replaceExactlyOnce(adjusted, expected, replacement);
  }
  writeFileSync(path, adjusted, { encoding: "utf8", flag: "wx" });
  writeFileSync(join(directory, "map.toml"), faultMapSource(), { encoding: "utf8", flag: "wx" });
  const baselinePolicy = readFileSync(join(ROOT, "policies", "baseline.toml"), "utf8");
  writeFileSync(join(directory, "policy.toml"), baselinePolicy
    .replace("fight_range_blocks = 4", "fight_range_blocks = 1")
    .replace("search_radius_blocks = 8", "search_radius_blocks = 1"), { encoding: "utf8", flag: "wx" });
  return Object.freeze({ directory, path: relativePath });
}

function faultMapSource(): string {
  return [
    "schema = 1",
    'name = "runtime-faults"',
    "",
    "[dimensions]",
    "width = 128",
    "depth = 128",
    "min_y = 0",
    "max_y = 128",
    "",
    "[[operations]]",
    'kind = "cuboid"',
    "from = { x = 0, y = 64, z = 0 }",
    "to = { x = 127, y = 64, z = 127 }",
    'block = "minecraft:stone"',
    "",
    "[[operations]]",
    'kind = "spawn"',
    "seat = 0",
    "position = { x = 20, y = 65, z = 20 }",
    "",
    "[[operations]]",
    'kind = "spawn"',
    "seat = 1",
    "position = { x = 107, y = 65, z = 107 }",
    "",
    "[[operations]]",
    'kind = "spawn"',
    "seat = 2",
    "position = { x = 20, y = 65, z = 107 }",
    "",
    "[[operations]]",
    'kind = "loot_container"',
    "position = { x = 64, y = 65, z = 64 }",
    'inventory = ["minecraft:bread"]',
    "",
  ].join("\n");
}

// Paper resolves the world generator by plugin name, so vary the version to reach the identity check.
function replacePluginIdentity(pluginJarPath: string, javaExecutable: string, scratch: string): string {
  const jarPath = join(scratch, "wrong-plugin.jar");
  copyFileSync(pluginJarPath, jarPath);
  const jarDirectory = join(scratch, "descriptor");
  mkdirSync(jarDirectory);
  const jarExecutable = join(dirname(javaExecutable), "jar");
  execFileSync(jarExecutable, ["xf", jarPath, "plugin.yml"], {
    cwd: jarDirectory,
    encoding: "utf8",
  });

  const descriptorPath = join(jarDirectory, "plugin.yml");
  const descriptor = readFileSync(descriptorPath, "utf8");
  const versionLine = /^version: ([A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/m;
  const mismatch = descriptor.replace(versionLine, "version: 0.1.0-wrong");
  assert.notEqual(mismatch, descriptor, "the packaged plugin descriptor must contain one supported version line");

  writeFileSync(descriptorPath, mismatch, { encoding: "utf8", flag: "w" });
  execFileSync(jarExecutable, ["--update", "--file", jarPath, "-C", jarDirectory, "plugin.yml"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return jarPath;
}

async function expectRunnerFailure(operation: Promise<unknown>): Promise<RunnerError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof RunnerError, "runtime operations must return structured runner errors");
    return error;
  }
  assert.fail("the runtime operation unexpectedly completed");
}

async function assertInterruptedEvidence(
  helperPath: string,
  ownedRoot: Buffer,
  runId: string,
  category: "cancelled" | "runtime_failure",
): Promise<void> {
  const artifact = await readOperationalFailureArtifact({ helperPath, ownedRoot, runId });
  assert.equal(artifact.primary.category, category);
  assert.ok(artifact.trace_checkpoint_segments.length > 0, "the interrupted run must retain a real trace checkpoint");
  const segments: TraceSegment[] = [];
  for (const segment of artifact.trace_checkpoint_segments) {
    const parsed = parseSegment(await readOwnedFile({
      helperPath,
      ownedRoot,
      relativePath: Buffer.from(segment.path, "utf8"),
      maxBytes: MAX_OWNED_READ_BYTES,
    }));
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.byteLength, segment.byte_length);
    segments.push(parsed);
  }
  assertInterruptedTrace(segments, category);
}

function assertInterruptedTrace(segments: readonly TraceSegment[], category: "cancelled" | "runtime_failure"): void {
  const evidence = reconstruct(segments);
  const outcomeIndex = evidence.records.findIndex((record) => record.direction === "plugin" && record.type === "outcome");
  if (outcomeIndex < 0) return;
  assert.equal(category, "cancelled", "a crashed server must not claim a terminal plugin outcome");
  const abortIndex = evidence.records.findIndex((record) => record.direction === "runner" && record.type === "abort");
  assert.ok(abortIndex >= 0 && abortIndex < outcomeIndex, "an operator abort must follow its recorded runner command");
  const { direction: _direction, ...abortEnvelope } = evidence.records[abortIndex]!;
  const abortCommand = decodeControlEnvelope(JSON.stringify(abortEnvelope));
  assert.ok(abortCommand.type === "abort");
  assert.equal(abortCommand.payload.reason, "operator");
  const { report } = reconstructRunEvidence(evidence);
  assert.equal(report.outcome.kind, "abort", "cancellation must not claim a winner or draw");
  assert.equal(report.outcome.reason, "operator");
}

async function waitForTraceCheckpoint(
  run: Readonly<{ helperPath: string; ownedRoot: Buffer; runId: string }>,
  signal: AbortSignal,
  timeoutMs: number,
  completed?: () => Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | undefined,
): Promise<void> {
  const relativePath = Buffer.from(`.work/arena/runs/${run.runId}/trace-v2-000001.json`, "ascii");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (completed !== undefined) {
      const status = completed();
      if (status !== undefined) throw new Error(`runtime child exited before a trace checkpoint (${status.code ?? status.signal})`);
    }
    try {
      const bytes = await readOwnedFile({
        helperPath: run.helperPath,
        ownedRoot: run.ownedRoot,
        relativePath,
        maxBytes: MAX_OWNED_READ_BYTES,
        signal,
      });
      const parsed = parseSegment(bytes);
      assert.equal(parsed.runId, run.runId);
      return;
    } catch (error) {
      if (!(error instanceof OwnedFilesError) || error.category !== "not_found") throw error;
    }
    await delay(250, undefined, { signal });
  }
  throw new Error(`run ${run.runId} did not stage its first trace checkpoint within ${timeoutMs} ms`);
}

async function waitForOwnedJavaProcess(
  runId: string,
  parentPid: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Readonly<{ pid: number; ppid: number; command: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const process = ownedJavaProcesses(runId).find((candidate) => candidate.ppid === parentPid);
    if (process !== undefined) return process;
    await delay(250, undefined, { signal });
  }
  throw new Error(`run ${runId} did not expose an owned Paper child within ${timeoutMs} ms`);
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

async function listenOnGamePort(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: GAME_PORT, exclusive: true }, () => resolve());
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function assertGamePortReleased(): Promise<void> {
  const probe = createServer();
  await listenOnGamePort(probe);
  await closeServer(probe);
}

function captureChildOutput(child: ReturnType<typeof spawn>): {
  readonly output: () => string;
  readonly status: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
} {
  const output: Buffer[] = [];
  let byteLength = 0;
  let status: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const collect = (chunk: Buffer): void => {
    const copy = Buffer.from(chunk);
    output.push(copy);
    byteLength += copy.length;
    while (byteLength > MAX_CHILD_OUTPUT_BYTES) {
      const excess = byteLength - MAX_CHILD_OUTPUT_BYTES;
      const first = output[0];
      assert.ok(first, "captured child output must retain its bounded prefix");
      if (first.length <= excess) {
        output.shift();
        byteLength -= first.length;
      } else {
        output[0] = first.subarray(excess);
        byteLength -= excess;
      }
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  void child.once("close", (code, signal) => {
    status = Object.freeze({ code, signal: signal === null ? null : signal as NodeJS.Signals });
  });
  return {
    output: () => Buffer.concat(output).toString("utf8"),
    get status() { return status; },
  };
}

function childExit(child: ReturnType<typeof spawn>): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(Object.freeze({
      code,
      signal: signal === null ? null : signal as NodeJS.Signals,
    })));
  });
}

function parseChildResult(output: string, marker: string): Readonly<{
  kind: string;
  exitCode: number;
  stderr: string;
}> {
  const start = output.lastIndexOf(marker);
  assert.ok(start >= 0, "the CLI child must emit its structured result marker");
  const line = output.slice(start + marker.length).split(/\r?\n/, 1)[0];
  assert.ok(line, "the CLI child result marker must be followed by JSON");
  const parsed: unknown = JSON.parse(line);
  assert.ok(parsed !== null && typeof parsed === "object");
  const result = parsed as Record<string, unknown>;
  assert.equal(typeof result.kind, "string");
  assert.equal(typeof result.exitCode, "number");
  assert.equal(typeof result.stderr, "string");
  return result as { kind: string; exitCode: number; stderr: string };
}

function parseCliError(stderr: string): Readonly<{
  category: string;
  source: Readonly<Record<string, unknown>>;
}> {
  const parsed: unknown = JSON.parse(stderr);
  assert.ok(parsed !== null && typeof parsed === "object");
  const error = (parsed as Record<string, unknown>).error;
  assert.ok(error !== null && typeof error === "object");
  const document = error as Record<string, unknown>;
  assert.equal(typeof document.category, "string");
  assert.ok(document.source !== null && typeof document.source === "object");
  return { category: document.category as string, source: document.source as Record<string, unknown> };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function lockedPaperFile(): string {
  const source = readFileSync(join(ROOT, "versions.lock.toml"), "utf8");
  let inPaper = false;
  const values: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("[")) inPaper = line === "[paper]";
    else if (inPaper && line.startsWith("server_file = ")) {
      const value = line.slice("server_file = ".length).trim();
      assert.ok(value.startsWith('"') && value.endsWith('"'), "the Paper server file must be a quoted lock value");
      values.push(value.slice(1, -1));
    }
  }
  assert.equal(values.length, 1, "versions.lock.toml must define one [paper].server_file");
  return values[0]!;
}

function replaceExactlyOnce(source: string, expected: string, replacement: string): string {
  assert.equal(source.split(expected).length - 1, 1, `scenario fixture must contain exactly one ${expected}`);
  return source.replace(expected, replacement);
}
