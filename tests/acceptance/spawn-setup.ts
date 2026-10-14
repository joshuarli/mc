import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { prepareOwnedAcceptanceRun } from "../integration/support/owned-run.js";
import { runPreparedRun } from "../../packages/arena-runner/src/runtime/run.js";

const PROBE_COMPLETE = "spawn-setup-probe-complete";
const DEFAULT_SCENARIOS = ["hunger-six", "hunger-12", "hunger-24"];
const DEFAULT_SEEDS = [
  ...Array.from({ length: 6 }, (_, index) => 481516 + index),
  ...Array.from({ length: 12 }, (_, index) => 500001 + index),
  ...Array.from({ length: 24 }, (_, index) => 600001 + index),
];

const scenarios = process.env.ARENA_SETUP_SCENARIOS?.split(",").map((value) => value.trim()) ?? DEFAULT_SCENARIOS;
const seeds = process.env.ARENA_SETUP_SEEDS?.split(",").map((value) => Number(value.trim())) ?? DEFAULT_SEEDS;

test("spawn-setup", { timeout: 7_200_000 }, async (t) => {
  const directory = join(process.cwd(), ".work", "tmp", "setup-scenarios");
  mkdirSync(directory, { recursive: true });
  const rows: string[] = [];
  for (const name of scenarios) {
    const source = readFileSync(join(process.cwd(), "scenarios", `${name}.toml`), "utf8");
    for (const seed of seeds) {
      const probeName = `setup-${name}-${seed}`;
      const text = source
        .replace(/^seed = \d+$/m, `seed = ${seed}`)
        .replace(/^name = ".*"$/m, `name = "${probeName}"`)
        .replace(/^map = "\.\.\/maps\//m, 'map = "../../../maps/')
        .replace(/^policy = "\.\.\/policies\//m, 'policy = "../../../policies/');
      const relative = join(".work", "tmp", "setup-scenarios", `${probeName}.toml`);
      writeFileSync(join(process.cwd(), relative), text);
      const started = Date.now();
      let row = "";
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        try {
          const prepared = await prepareOwnedAcceptanceRun(relative, probeName.slice(0, 20), t.signal);
          const positions: string[] = [];
          try {
            await runPreparedRun({
              ...prepared,
              competitorDriver: "evaluator",
              evaluate: async (active) => {
                for (const competitor of active.competitors) {
                  const position = competitor.bot.entity.position;
                  positions.push(`${competitor.seat}:${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`);
                }
                throw new Error(PROBE_COMPLETE);
              },
            });
            row = `SETUP|${name}|${seed}|unexpected-completion|`;
          } catch (error) {
            row = positions.length > 0
              ? `SETUP|${name}|${seed}|resolved|${((Date.now() - started) / 1000).toFixed(0)}s|${positions.join(";")}`
              : `SETUP|${name}|${seed}|failed|${JSON.stringify(error, Object.getOwnPropertyNames(error as object)).slice(0, 700)}`;
          }
        } catch (error) {
          row = `SETUP|${name}|${seed}|prepare-failed|${String(error).slice(0, 300)}`;
        }
        if (!row.includes("paper_port_bind_failed")) break;
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
      rows.push(row);
      console.log(row);
    }
  }
  writeFileSync(join(process.cwd(), ".work", "tmp", "spawn-setup-table.txt"), rows.join("\n") + "\n");
});
