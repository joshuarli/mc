import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runCli } from "../../../packages/arena-runner/src/cli.js";
import { prepareRun } from "../../../packages/arena-runner/src/prepare.js";
import { runPreparedRun } from "../../../packages/arena-runner/src/runtime/run.js";
import type { RunPreparedRunOptions } from "../../../packages/arena-runner/src/runtime/run.js";
import type { StoppedPlayerStats } from "../../../packages/arena-runner/src/runtime/observations.js";

export type AcceptanceEvaluator = NonNullable<Parameters<typeof runPreparedRun>[0]["evaluate"]>;
export type AcceptanceRunContext = Parameters<AcceptanceEvaluator>[0];

/** Prepares an owned run and resolves the pinned runtime artifacts used by acceptance cases. */
export async function prepareOwnedAcceptanceRun(
  scenarioPath: string,
  runId: string,
  signal: AbortSignal,
): Promise<RunPreparedRunOptions> {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs");
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome, "the pinned JDK must be configured by the arena test selector");
  const paperJarPath = join(repositoryRoot, ".work/arena/downloads", lockedString("paper", "server_file"));
  const pluginJarPath = join(repositoryRoot, ".work/arena/gradle-build/libs/arena-plugin-0.1.0.jar");
  const javaExecutable = join(javaHome, "bin/java");
  for (const path of [helperPath, paperJarPath, pluginJarPath, javaExecutable]) {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `required stack file must be a regular file: ${path}`);
  }

  const ownedRoot = Buffer.from(repositoryRoot, "utf8");
  const ownedRunId = `${runId.slice(0, 20)}-${randomUUID()}`;
  const preparedRun = await prepareRun(
    helperPath,
    ownedRoot,
    Buffer.from(scenarioPath, "utf8"),
    ownedRunId,
    signal,
  );
  return {
    preparedRun,
    helperPath,
    ownedRoot,
    javaExecutable,
    paperJarPath,
    pluginJarPath,
    acceptMinecraftEula: true,
    signal,
  };
}

/** Prepares one fresh run and delegates its world clone, server, and bot cleanup to the runtime. */
export async function runOwnedAcceptanceScenario(
  scenarioPath: string,
  runId: string,
  evaluate: AcceptanceEvaluator,
  signal: AbortSignal,
  options: Readonly<{
    competitorDriver?: NonNullable<Parameters<typeof runPreparedRun>[0]["competitorDriver"]>;
    onPolicyActivity?: RunPreparedRunOptions["onPolicyActivity"];
  }> = {},
) {
  const prepared = await prepareOwnedAcceptanceRun(scenarioPath, runId, signal);
  const completed = await runPreparedRun({
    ...prepared,
    evaluate,
    competitorDriver: options.competitorDriver ?? "baselinePolicy",
    ...(options.onPolicyActivity === undefined ? {} : { onPolicyActivity: options.onPolicyActivity }),
  });
  const inspection = await inspectCompletedRun(prepared.helperPath, completed.runId);
  return { ...completed, inspection };
}

async function inspectCompletedRun(helperPath: string, runId: string): Promise<{
  readonly schema: 1;
  readonly run_id: string;
  readonly report: unknown;
  readonly stats: readonly StoppedPlayerStats[];
}> {
  const previousHelperPath = process.env.ARENA_FS_HELPER;
  process.env.ARENA_FS_HELPER = helperPath;
  let result: Awaited<ReturnType<typeof runCli>>;
  try {
    result = await runCli(["inspect", "--run-id", runId]);
  } finally {
    if (previousHelperPath === undefined) delete process.env.ARENA_FS_HELPER;
    else process.env.ARENA_FS_HELPER = previousHelperPath;
  }
  if (result.kind !== "success") throw new Error(`arena inspect failed: ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(parsed !== null && typeof parsed === "object", "arena inspect must return a JSON object");
  const document = parsed as Record<string, unknown>;
  assert.equal(document.schema, 1, "arena inspect schema must be supported by the acceptance harness");
  assert.equal(document.run_id, runId, "arena inspect must return the requested stopped run");
  assert.ok(document.report !== null && typeof document.report === "object", "arena inspect must include its report");
  assert.ok(Array.isArray(document.stats), "arena inspect must return stopped player stats");
  return parsed as {
    readonly schema: 1;
    readonly run_id: string;
    readonly report: unknown;
    readonly stats: readonly StoppedPlayerStats[];
  };
}

/** Inspects a stopped run whose runner returned early after an authoritative abort. */
export async function inspectOwnedAcceptanceRun(runId: string) {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs");
  return await inspectCompletedRun(helperPath, runId);
}

function lockedString(section: string, key: string): string {
  const values: string[] = [];
  let active = false;
  for (const line of readFileSync(join(process.cwd(), "versions.lock.toml"), "utf8").split(/\r?\n/)) {
    if (line.startsWith("[")) {
      active = line === `[${section}]`;
    } else if (active && line.startsWith(`${key} = `)) {
      const value = line.slice(key.length + 3).trim();
      if (value.startsWith('"') && value.endsWith('"')) values.push(value.slice(1, -1));
      else throw new Error(`versions.lock.toml ${section}.${key} must be a quoted string`);
    }
  }
  assert.equal(values.length, 1, `versions.lock.toml must define one ${section}.${key}`);
  return values[0]!;
}
