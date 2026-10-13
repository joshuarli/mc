import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));

function runNamedTests(runner, suite, name) {
  const env = { ...process.env };
  // Node marks child test processes so a nested --test invocation is skipped.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, suite, name], { cwd: root, encoding: "utf8", env });
}

test("typescript build rejects an unknown target", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "typescript-build.mjs"), "unknown"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "typescript build: expected all, stack, control, owned-files, runtime, core, spec, bots, or runner\n");
});

test("named test runner dispatches suite files and rejects unknown cases", (context) => {
  const testDirectory = join(root, ".work", "build", "packages", "arena-core", "tests");
  const fixtureTitle = `named test dispatch ${randomUUID()}`;
  const fixturePath = join(testDirectory, `named-dispatch-${randomUUID()}.test.js`);
  mkdirSync(testDirectory, { recursive: true });
  writeFileSync(fixturePath, `import { test } from "node:test";\ntest(${JSON.stringify(fixtureTitle)}, () => {});\n`, { flag: "wx" });
  context.after(() => rmSync(fixturePath, { force: true }));

  const runner = join(root, "scripts", "run-named-tests.mjs");
  const dispatched = runNamedTests(runner, "core", fixtureTitle);
  assert.equal(dispatched.error, undefined);
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);
  assert.match(dispatched.stdout, new RegExp(`^ok \\d+ - ${fixtureTitle}$`, "m"));

  const missingTitle = `${fixtureTitle} missing`;
  const missing = runNamedTests(runner, "core", missingTitle);
  assert.equal(missing.error, undefined);
  assert.equal(missing.status, 2, missing.stderr || missing.stdout);
  assert.equal(missing.stdout.includes(`# Subtest: ${missingTitle}`), false);
  assert.match(missing.stderr, /no test ran with exact name/);
});
