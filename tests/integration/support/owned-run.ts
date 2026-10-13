import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { prepareRun } from "../../../packages/arena-runner/src/prepare.js";
import { runPreparedRun } from "../../../packages/arena-runner/src/runtime/run.js";

type EvaluateRun = NonNullable<Parameters<typeof runPreparedRun>[0]["evaluate"]>;

/** Prepares one fresh run and delegates its world clone, server, and bot cleanup to the runtime. */
export async function runOwnedAcceptanceScenario(
  scenarioPath: string,
  runId: string,
  evaluate: EvaluateRun,
  signal: AbortSignal,
) {
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
  const preparedRun = await prepareRun(
    helperPath,
    ownedRoot,
    Buffer.from(scenarioPath, "utf8"),
    runId,
    signal,
  );
  return await runPreparedRun({
    preparedRun,
    helperPath,
    ownedRoot,
    javaExecutable,
    paperJarPath,
    pluginJarPath,
    signal,
    evaluate,
  });
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
