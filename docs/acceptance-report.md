# Acceptance report

**Status: stack, configured map reset, and the live duel/phase-guard case passed; remaining gameplay cases are unverified.** The isolated commit `6c553f2` passed the revised `stack` smoke after the Paper fixture set the actual spawn-radius game rule to zero. The same fix is present on the campaign mainline as `af84687`. At `a44e0ab`, the configured `maps-reset` case passed three independent runs, including ordinary loot, death, stopped stats, and clean resets. At `10d8a75`, the live `match-rules` case passed phase guards and an ordinary duel with independently reconstructed outcome and stats. Additional authority variants, fairness, legal player mechanics, and six-seat behavior still require live proof.

## Environment and selected stack

- Campaign host recorded at preflight: macOS arm64, 10 logical CPUs, 32 GiB RAM. This acceptance slice did not collect fresh host or resource measurements.
- Current foundation source candidate: Paper 26.1.2 build 74, protocol 775; Eclipse Temurin JDK 25.0.4.1+1; Node.js 24.21.0 and npm 11.19.0; Mineflayer 4.39.0 and `mineflayer-pathfinder` 2.4.5.
- The Mineflayer release lists 26.1 support and Minecraft data maps 26.1.2 to protocol 775. These upstream declarations do not prove the locked Paper build works with Arena's plugin or Mineflayer clients.
- Exact verified acceptance commit: `6c553f2` (based on `19a72f5`, with the fixture-only spawn-radius rule fix); the equivalent mainline fixture fix is `af84687`.
- Live command: `./arena test --suite integration --case stack`.
- Live stack result: pass for Paper 26.1.2 build 74 / protocol 775 and Mineflayer 4.39.0. It verified per-client chunk receipt, movement, chest interaction, ordinary damage, disconnect outcome, and rejection of a wrong-protocol client.
- The initial attempt exposed that the `spawn-radius=0` property did not change Paper's world spawn-radius game rule. The fixture now sets `GameRule.SPAWN_RADIUS` to zero; no assertion was relaxed.

## Required behavior status

| Case | Status | Evidence or blocker |
| --- | --- | --- |
| `stack` | Pass | `./arena test --suite integration --case stack` on isolated commit `6c553f2`; includes ordinary two-client actions, per-client receipt checks, damage/disconnect outcome, and wrong-protocol rejection. |
| `maps-reset` | Pass | `./arena test --suite integration --case maps-reset` at `a44e0ab` passed all three runs: both clients observed the declared blocks, spawns, and chest contents; ordinary collection and fall death occurred; stopped inspection recorded the death; both subsequent clones had empty inventories and zero deaths. |
| `match-rules` | Partial pass | `./arena test --suite integration --case match-rules` at `10d8a75` passed waiting/countdown movement and chest guards, active movement and looting, and an ordinary equipped duel with death, winner, independently reconstructed outcome, and stopped stats. Its source now also attacks during grace and checks the target receives no damage before proving active-phase damage; that extension is unverified. Named source selectors cover border death, disconnect, tick-limit draw, operator abort, spectator identity separation, duplicate identity login, eliminated reconnect, and symmetric same-tick zero-survivor border deaths. These variants have not run against Paper and remain unverified. The runtime exposes competitor reconnect but no in-run Paper restart operation, so restart recovery is not claimed. |
| `legal-player` | Pending retry | The fourth live attempt (`ca55ec94-4219-4c3f-8751-cf9a1aa8be73`) completed 22,017 cm of ordinary sprinting and recorded eight real jump takeoffs, but the 45-second food window ended at food 20, saturation 0, and exhaustion 3.617. With initial saturation 5, food needed 24 total exhaustion to decrease; the attempt missed that threshold by 0.383. Cleanup succeeded after the server stopped. The bounded food window is now 60 seconds; this source change has not been validated live, and the later loot, eating, and combat assertions remain unverified. |
| `fairness` | Pending retry | The initial run failed when the fixture died at the border. After the final-ring fix at `9a75be2`, the baseline (`aa134240-444d-4b9e-b164-c5cf7a51bed7`) and perturbed (`4e00efc4-4cee-49bf-9dc0-05f639f4e5d7`) runs both drew, but the old cross-run receipt-order comparison failed because asynchronous chunk arrival order differed. The corrected oracle keeps raw event order and checks hidden data per run; the retry has not run, so fairness remains unproven. |
| `hunger-six` | Parked | Not run. Acceptance will assert all six bot seats, an automated spectator outside the competitor roster, and death/reconnect seat outcomes. |
| `replay-report`, `faults`, civilization, policy comparison, and benchmarks | Parked | No revised live or acceptance run was performed. |
| Linux x86_64 | Unverified | No Linux run was performed. |

All acceptance cases are unattended and headless, using bot clients for every participant.

## Source checks versus live proof

The Java plugin emits startup diagnostics for the prepared map and server readiness. Those diagnostics are useful for locating startup failures, but a marker alone does not prove generated blocks, chest contents, reset behavior, a legal action, or an authoritative match result. Acceptance cases must read block and inventory state through Mineflayer and consume the plugin's typed outcome stream. Match actions must use ordinary client mechanics; no administrative damage or injected live inventory is accepted.

The TypeScript support oracle compares the full declared block sequence, client-observed spawn positions in seat order, and all 27 slots of every declared chest against a compiled map. Both competitors passed these comparisons across three runs at `a44e0ab`. The first run collected bread and a stone sword, recorded an ordinary fall death, and exposed its death counter through stopped inspection. Both subsequent clones matched the initial world and reset inventories and death counters. `arena inspect --run-id` reads stopped-run stats for the same offline UUID from `<run>/server/world/players/stats/<offline-uuid>.json`. Tests consume `inspect` output rather than probing server files directly.

Four earlier attempts exposed adapter startup before plugin injection, stale inventory reads, stale full-window resync receipts, and an unreliable void-fall fixture. The reset fixture now uses a lower landing deck and ordinary fall damage. The adapter waits for a full server snapshot confirming both inventory gain and chest loss. Error mapping preserves bounded messages and native causes; cleanup compares error identity and cause chains. Focused regressions passed, and the completed live retry exercised the fixes. Historical failure artifacts retain their original contents, including the second attempt's incorrect cleanup field.

The passing runs in `verify-live-m1` are `maps-reset-first-dc582f54-71fa-42a4-b872-ba2171612e55`, `maps-reset-second-60b19df5-ebae-4b77-b540-f67c1f81bfe8`, and `maps-reset-third-1610de8d-237f-4ef2-92a3-6c684ee73daf`. Each published a completed authority trace after its JVM stopped.

At `1cd0a60`, the strict TypeScript stack build and `all live acceptance scenario and policy sources compile offline` passed. This check compiles every live fixture's scenario, referenced map, and policy. It caught malformed recording fields and a border end tick equal to the match limit before a server was started. The native helper's strict C build and 19 owned-file cases also passed, including bounded resource accounting and rejection of symlinked work roots. These are offline checks.

At `e6357db`, the five focused Java test classes passed all 44 cases, including the pre-release phase policy. The plugin now freezes competitive positions and blocks inventory actions before release; the live `match-rules` case at `10d8a75` subsequently verified the Bukkit phase guards and ordinary duel wiring.

## Contract changes and measurements

The runtime exposes `run --scenario`, read-only `validate --scenario`, stopped-run inspection, and explicit selected-run `gc --dry-run` / `gc --apply`. Scripted acceptance cases select an evaluator driver; normal Hunger runs retain the baseline policy and configured strategy cadence. Conflict and cancellation errors use exits 4 and 130, including independent cleanup failures. Evaluators may finish their assertions after outcome before cancellation, and baseline policy actions stop on actual death or spectator mode. Configured reset and stopped inspection passed. No six-seat or performance gate measurements were collected.

## Remaining prerequisites

1. Verify configured-world startup, bounded shutdown, and stopped-run stats through `arena inspect`.
2. Run `match-rules` and `match-rules-border-death`, `match-rules-disconnect`, `match-rules-timeout`, `match-rules-abort`, `match-rules-spectator-identity`, `match-rules-duplicate-identity`, `match-rules-eliminated-reconnect`, and `match-rules-same-tick-zero-survivors` through `./arena test --suite integration --case <selector>` against genuine Mineflayer observations, then retain exact commands and results here.

The passing duel run in `verify-live-m1` is `match-rules-57a09553-1557-406c-ad87-cf5da6680846`. The first duel attempt exposed a mirrored client pitch calculation and hotbar restoration undoing a successful weapon equip. Focused regressions covered both fixes; ordinary look operations now respect Mineflayer physics rotation pacing. The retry passed with these fixes and a stopped JVM. This is functional evidence, not a performance measurement.
