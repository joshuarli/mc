import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("typescript build rejects an unknown target", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "typescript-build.mjs"), "unknown"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "typescript build: expected all, stack, control, core, spec, bots, or runner\n");
});
