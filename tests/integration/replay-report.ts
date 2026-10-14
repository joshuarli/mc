import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../packages/arena-runner/src/cli.js";
import { reconstructEventResult } from "../../packages/arena-runner/src/event-report.js";
import type { OutcomePayload, PreparePayload } from "../../packages/arena-runner/src/control/types.js";
import { runOwnedAcceptanceScenario } from "./support/owned-run.js";

const scenarioPath = "tests/acceptance/fixtures/maps-reset-scenario.toml";

test("replay-report", { timeout: 300_000 }, async (t) => {
  let prepare: PreparePayload | undefined;
  const run = await runOwnedAcceptanceScenario(
    scenarioPath,
    "replay-report",
    async (active) => {
      assert.equal(active.prepare.type, "prepare");
      prepare = active.prepare.payload;
      await active.start();
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "baselinePolicy" },
  );

  assert.notEqual(run.outcome.kind, "abort", "the replay source must be a completed policy-driven match");
  if (prepare === undefined) throw new Error("the live runner must provide the prepared roster for independent reconstruction");

  const tracePaths = run.trace.segments.map(({ relativePath }) => relativePath.toString("utf8"));
  const originalReplay = await successfulJsonCommand(["replay-policy", ...tracePaths]);
  const summary = objectValue(originalReplay);
  assert.equal(summary.run_id, run.runId);
  assert.ok(numberField(summary, "decision_count") > 0, "the real run must record at least one policy decision");
  assert.ok(numberField(summary, "effect_count") > 0, "the real run must record at least one completed policy effect");

  for (let replay = 1; replay < 3; replay += 1) {
    assert.deepStrictEqual(
      await successfulJsonCommand(["replay-policy", ...tracePaths]),
      originalReplay,
      `policy replay ${replay + 1} must reproduce the same verified decisions`,
    );
  }

  const reportOutput = await successfulJsonCommand(["report", ...tracePaths]);
  const report = objectValue(reportOutput);
  assert.deepStrictEqual(report.outcome, jsonOutcome(run.outcome), "the report must match the live terminal outcome");
  assert.deepStrictEqual(
    {
      outcome: report.outcome,
      outcome_status: report.outcome_status,
      statistics: report.statistics,
    },
    reconstructEventResult(run.runId, prepare, run.events),
    "the file-based report must match independent reconstruction of the returned authoritative events",
  );

  const scratchRoot = join(process.cwd(), ".work", "tmp");
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(scratchRoot, "replay-report-"));
  try {
    const alteredTimePaths: string[] = [];
    const sourceBytes: Buffer[] = [];
    for (const [index, sourcePath] of tracePaths.entries()) {
      const bytes = await readFile(sourcePath);
      sourceBytes.push(bytes);
      const copiedPath = join(scratch, `trace-${index + 1}.json`);
      await writeFile(copiedPath, bytes, { flag: "wx", mode: 0o600 });
      const originalStat = await stat(sourcePath);
      const changedTime = new Date(Date.UTC(2001, 0, 1) + index * 60_000);
      await utimes(copiedPath, originalStat.atime, changedTime);
      assert.notEqual((await stat(copiedPath)).mtimeMs, originalStat.mtimeMs,
        "the copied trace must have a changed filesystem timestamp");
      assert.deepStrictEqual(await readFile(copiedPath), bytes, "timestamp perturbation must preserve trace bytes");
      alteredTimePaths.push(copiedPath);
    }

    assert.deepStrictEqual(
      await successfulJsonCommand(["replay-policy", ...alteredTimePaths]),
      originalReplay,
      "filesystem timestamps must not change replay output",
    );
    assert.deepStrictEqual(
      await successfulJsonCommand(["report", ...alteredTimePaths]),
      reportOutput,
      "filesystem timestamps must not change report output",
    );

    const truncatedPath = join(scratch, "truncated.json");
    const finalSegment = sourceBytes.at(-1);
    if (finalSegment === undefined || finalSegment.length < 2) {
      throw new Error("the completed run must provide a nonempty final trace segment");
    }
    await writeFile(truncatedPath, finalSegment.subarray(0, finalSegment.length - 1), { flag: "wx", mode: 0o600 });
    await assertCorruptEvidence(["replay-policy", ...alteredTimePaths.slice(0, -1), truncatedPath]);

    const firstSegment = JSON.parse(sourceBytes[0]!.toString("utf8")) as Record<string, unknown>;
    const schemaMismatch = join(scratch, "schema-mismatch.json");
    await writeFile(schemaMismatch, JSON.stringify({ ...firstSegment, schema: 999 }), { flag: "wx", mode: 0o600 });
    await assertCorruptEvidence(["report", schemaMismatch, ...alteredTimePaths.slice(1)]);

    const unsupportedVerbosity = join(scratch, "unsupported-verbosity.json");
    await writeFile(unsupportedVerbosity, JSON.stringify({ ...firstSegment, verbosity: "debug" }), {
      flag: "wx",
      mode: 0o600,
    });
    await assertCorruptEvidence(["report", unsupportedVerbosity, ...alteredTimePaths.slice(1)]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

async function successfulJsonCommand(args: readonly string[]): Promise<string> {
  const result = await runCli(args);
  if (result.kind === "failure") throw new Error(`arena ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

async function assertCorruptEvidence(args: readonly string[]): Promise<void> {
  const result = await runCli(args);
  if (result.kind === "success") throw new Error(`arena ${args[0]} must reject malformed trace input`);
  assert.equal(result.exitCode, 5, "malformed traces must use the evidence error status");
}

function objectValue(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  assert.equal(typeof result, "number", `result.${field} must be numeric`);
  return result as number;
}

function jsonOutcome(outcome: OutcomePayload): unknown {
  return {
    ...outcome,
    at: outcome.at === null ? null : { domain: outcome.at.domain, value: outcome.at.value.toString() },
  };
}
