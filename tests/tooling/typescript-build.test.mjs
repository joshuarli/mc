import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("arena wrapper dispatches garbage collection to runner validation", () => {
  const result = spawnSync(join(root, "arena"), ["gc", "--dry-run"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const failure = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));
  assert.equal(failure.error.category, "invalid_input");
  assert.equal(failure.error.source.kind, "gc_requires_run_id");
});

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

test("fault integration selectors dispatch their exact standalone cases", (context) => {
  const faultsSource = readFileSync(join(root, "tests", "integration", "faults.ts"), "utf8");
  const runnerSource = readFileSync(join(root, "scripts", "run-named-tests.mjs"), "utf8");
  const arenaSource = readFileSync(join(root, "arena"), "utf8");
  const operationsSource = readFileSync(join(root, "docs", "operations.md"), "utf8");
  const faultSelectors = [...faultsSource.matchAll(/^\s*selector: "([^"]+)"/gm)].map((match) => match[1]);
  assert.equal(faultSelectors.length, 5, "the independent runtime fault proofs must remain individually selectable");
  assert.equal(new Set(faultSelectors).size, faultSelectors.length, "fault selectors must be unique");
  assert.ok(faultsSource.includes("test(faultCase.selector"), "each fault case must register as a top-level test");

  const expectedCommands = ["faults", ...faultSelectors].sort();
  const runnerCommands = [...runnerSource.matchAll(/^\s*\["(faults(?:-[a-z-]+)?)", "faults\.js"\],?$/gm)]
    .map((match) => match[1])
    .sort();
  const arenaCommands = [...arenaSource.matchAll(/integration:(faults(?:-[a-z-]+)?)/g)]
    .map((match) => match[1])
    .sort();
  const documentedCommands = [...operationsSource.matchAll(/--case (faults(?:-[a-z-]+)?)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(runnerCommands, expectedCommands, "the named-test registry must map every fault selector to faults.js");
  assert.deepEqual(arenaCommands, expectedCommands, "the arena wrapper must prepare the shared faults.ts suite for every selector");
  assert.deepEqual(documentedCommands, expectedCommands, "operations docs must list each standalone and aggregate fault command");
  assert.ok(faultsSource.includes('test("faults"'), "the sequential aggregate fault case must remain available");

  const scratch = join(root, ".work", "tmp");
  mkdirSync(scratch, { recursive: true });
  const fixtureRoot = mkdtempSync(join(scratch, "arena-fault-selector-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixtureRunner = join(fixtureRoot, "scripts", "run-named-tests.mjs");
  const fixtureTests = join(fixtureRoot, ".work", "build", "tests", "integration", "faults.js");
  mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
  mkdirSync(join(fixtureRoot, ".work", "build", "tests", "integration"), { recursive: true });
  copyFileSync(join(root, "scripts", "run-named-tests.mjs"), fixtureRunner);

  const standalone = faultSelectors.map((selector) => (
    `test(${JSON.stringify(selector)}, () => process.stdout.write(${JSON.stringify(`FAULT_SELECTOR_EXECUTED:${selector}\n`)}));`
  ));
  const aggregate = [
    'test("faults", () => {',
    ...faultSelectors.map((selector) => `  process.stdout.write(${JSON.stringify(`FAULT_SELECTOR_EXECUTED:${selector}\n`)});`),
    "});",
  ];
  writeFileSync(fixtureTests, [
    'import { test } from "node:test";',
    ...standalone,
    ...aggregate,
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx" });

  for (const selector of [...faultSelectors, "faults"]) {
    const dispatched = runNamedTests(fixtureRunner, "integration", selector);
    assert.equal(dispatched.error, undefined);
    assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);
    const executed = [...(dispatched.stdout ?? "").matchAll(/FAULT_SELECTOR_EXECUTED:(faults-[a-z-]+)/g)]
      .map((match) => match[1]);
    assert.deepEqual(executed, selector === "faults" ? faultSelectors : [selector]);
  }
});
