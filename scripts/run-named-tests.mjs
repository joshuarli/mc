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
  ["hunger-six", "hunger.js"],
  ["play-seats", "seats.js"]
]);

function fail(message) {
  process.stderr.write(`arena tests: ${message}\n`);
  process.exit(2);
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
} else if (suite === "acceptance") {
  const testFile = acceptanceCases.get(name);
  if (!testFile) fail("unknown acceptance case");
  target = join(root, ".work", "build", "tests", "acceptance", testFile);
} else if (suite === "protocol") {
  const testDirectory = join(root, ".work", "build", "packages", "arena-runner", "tests");
  let testFiles;
  try {
    testFiles = readdirSync(testDirectory).filter((file) => /^control-.*\.test\.js$/.test(file));
  } catch (error) {
    if (error.code === "ENOENT") fail("control test output is unavailable; build the control target first");
    throw error;
  }
  if (testFiles.length === 0) fail("no compiled control tests are available");
  targets = testFiles.map((file) => join(testDirectory, file));
}
if (!target && !targets) fail("unknown package suite");

const exactName = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const result = spawnSync(process.execPath, [
  "--test",
  "--test-reporter=tap",
  `--test-name-pattern=${exactName}`,
  ...(targets ?? [target])
], { cwd: root, encoding: "utf8" });

if (result.error) fail(`could not start the Node test runner: ${result.error.message}`);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);

const summary = result.stdout?.match(/\n# tests (\d+)\n(?:# suites \d+\n)?# pass (\d+)\n# fail (\d+)\n# cancelled (\d+)\n/);
if (!summary) fail("Node did not emit the expected TAP summary");
const [, , passed, failed, cancelled] = summary;
if (passed !== "1" || failed !== "0" || cancelled !== "0") {
  fail(`expected exactly one passing named test; TAP reported ${passed} pass, ${failed} fail, ${cancelled} cancelled`);
}
