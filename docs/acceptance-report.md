# Acceptance report

**Status: revised P0 is unverified.** No revised Mineflayer/Paper live case or build was run for this report. Upstream version-support data and the current in-progress lock candidate are source checks only; they do not establish Arena interoperability, gameplay, reset, or fairness.

## Environment and selected stack

- Campaign host recorded at preflight: macOS arm64, 10 logical CPUs, 32 GiB RAM. This acceptance slice did not collect fresh host or resource measurements.
- Current foundation source candidate: Paper 26.1.2 build 74, protocol 775; Eclipse Temurin JDK 25.0.4.1+1; Node.js 24.21.0 and npm 11.19.0; Mineflayer 4.39.0 and `mineflayer-pathfinder` 2.4.5.
- The Mineflayer release lists 26.1 support and Minecraft data maps 26.1.2 to protocol 775. These upstream declarations do not prove the locked Paper build works with Arena's plugin or Mineflayer clients.
- Exact verified revised commit: none. No live run, typecheck, build, or test command was executed in this slice.

## Required behavior status

| Case | Status | Evidence or blocker |
| --- | --- | --- |
| `stack` | Parked | Not run. The revised two-client Mineflayer/Paper proof still needs the locked server and wrong-protocol control. |
| `maps-reset` | Parked | Not run. A real prepared-map lifecycle must expose independent world observations and a reset that discards prior player inventory and death state. The completed-run stats read must come from the stopped server's owned run data; smoke-world readiness markers cannot establish this. |
| `match-rules` | Parked | Not run. The authenticated control and typed terminal outcome path is still being implemented. No ordinary two-client duel or independently reconstructed result was observed. |
| `legal-player` | Parked | Not run. The client skill path and a configured route/container fixture are not yet integrated. |
| `fairness` | Parked | Not run. Separate client receipt histories and a live hidden-state perturbation remain unproven. |
| `hunger-six`, `play-seats`, `replay-report`, `faults`, civilization, policy comparison, and benchmarks | Parked | No revised live or acceptance run was performed. |
| Graphical client and Metal rendering | Unverified | No graphical client or renderer run was performed. |
| Linux x86_64 | Unverified | No Linux run was performed. |

## Source checks versus live proof

The in-progress Java plugin emits startup diagnostics for the prepared map and server readiness. Those diagnostics are useful for locating startup failures, but a marker alone does not prove generated blocks, chest contents, reset behavior, a legal action, or an authoritative match result. Acceptance cases must read block and inventory state through Mineflayer and consume the plugin's typed outcome stream. Match actions must use ordinary client mechanics; no administrative damage or injected live inventory is accepted.

The TypeScript support oracle in this change compares the full declared block sequence, client-observed spawn positions in seat order, and all 27 slots of every declared chest against a compiled map. It also requires a recorded death before reset and zero deaths afterward. None of these assertions has been exercised against a live client observation. The runner's stopped-run stats read is still being implemented; the planned check uses the completed run's server stats for the same offline UUID. The oracle's existence is not acceptance evidence.

## Contract changes and measurements

This slice adds only private test-support types and assertions; no product API, schema, rule, permission, or transaction contract is changed. No runtime, binary-size, startup, six-seat, or performance measurements were collected.

## Remaining prerequisites

1. Merge the F0 stack/selector and authenticated fixture seam, then run the exact-version two-client smoke.
2. Integrate the configured-world runner lifecycle, stopped-run stats inspection, and Java typed outcome stream.
3. Run the cases above against genuine Mineflayer observations and retain exact commands and results here. A headless result must not be described as a GUI or Metal result.
