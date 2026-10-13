import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const suites = new Map([
  ["core", join(root, ".work", "build", "packages", "arena-core", "tests")],
  ["spec", join(root, ".work", "build", "packages", "arena-spec", "tests")],
  ["bots", join(root, ".work", "build", "packages", "arena-bots", "tests")],
  ["runner", join(root, ".work", "build", "packages", "arena-runner", "tests")],
  ["tooling", join(root, "tests", "tooling", "typescript-build.test.mjs")]
]);
const integrationCases = new Map([
  ["stack", "stack.js"],
  ["maps-reset", "maps-reset.js"],
  ["match-rules", "match-rules.js"],
  ["legal-player", "legal-player.js"],
  ["fairness", "fairness.js"]
]);
const acceptanceCases = new Map([
  ["hunger-six", "hunger.js"]
]);

function fail(message) {
  process.stderr.write(`arena tests: ${message}\n`);
  process.exit(2);
}

function compiledTestFiles(directory, pattern, missingMessage) {
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") fail(missingMessage);
    throw error;
  }
  if (files.length === 0) fail(missingMessage);
  return files;
}

const suite = process.argv[2];
const name = process.argv[3];
if (!name) fail("test name is required");
let target = suites.get(suite);
let targets;
if (suite === "integration") {
  const testFile = integrationCases.get(name);
  if (!testFile) fail("unknown integration case");
  target = join(root, ".work", "build", "tests", "integration", testFile);
  targets = [target];
} else if (suite === "acceptance") {
  const testFile = acceptanceCases.get(name);
  if (!testFile) fail("unknown acceptance case");
  target = join(root, ".work", "build", "tests", "acceptance", testFile);
  targets = [target];
} else if (suite === "protocol") {
  const testDirectory = join(root, ".work", "build", "packages", "arena-runner", "tests");
  targets = compiledTestFiles(testDirectory, /^control-.*\.test\.js$/, "control test output is unavailable; build the control target first");
} else if (target && suite !== "tooling") {
  targets = compiledTestFiles(target, /\.test\.js$/, `no compiled ${suite} tests are available; build the ${suite} target first`);
} else if (target) {
  targets = [target];
}
if (!targets) fail("unknown package suite");

const exactName = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const result = spawnSync(process.execPath, [
  "--test",
  "--test-reporter=tap",
  `--test-name-pattern=${exactName}`,
  ...targets
], { cwd: root, encoding: "utf8" });

if (result.error) fail(`could not start the Node test runner: ${result.error.message}`);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);

const exactStatus = new RegExp(`^(ok|not ok) \\d+ - ${exactName.slice(1, -1)}(?: # .*)?$`);
const namedResults = (result.stdout ?? "").split(/\r?\n/)
  .map((line) => line.trimStart())
  .filter((line) => exactStatus.test(line));
if (namedResults.length === 0) fail(`no test ran with exact name ${JSON.stringify(name)}`);
if (namedResults.length > 1) {
  fail(`expected one TAP result for exact test ${JSON.stringify(name)}, found ${namedResults.length}`);
}
if (!namedResults[0].startsWith("ok ") || / # (?:SKIP|TODO)\b/.test(namedResults[0])) {
  fail(`exact test did not pass: ${JSON.stringify(name)}`);
}
