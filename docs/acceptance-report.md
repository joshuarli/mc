# Acceptance report

**Status: initial D1 stack acceptance passed; remaining gameplay cases are unverified.** The isolated commit `6c553f2` passed the revised `stack` smoke after the Paper fixture set the actual spawn-radius game rule to zero. The same fix is present on the campaign mainline as `af84687`. This establishes the ordinary two-client stack path and wrong-protocol rejection only; it does not establish configured-map gameplay, reset, or fairness.

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
| `maps-reset` | Parked | Not run. The configured-run coordinator must prove three independent native clones, exact client-observed map state, and cleared inventory/death stats; readiness markers cannot establish this. |
| `match-rules` | Parked | Not run. No ordinary two-client duel or independently reconstructed typed result has been observed. |
| `legal-player` | Parked | Not run. No configured live route, container interaction, and attack sequence has been exercised through the Mineflayer skill client. |
| `fairness` | Parked | Not run. Independent client receipt histories, complete current perception, and a live hidden-state perturbation remain unproven. |
| `hunger-six` | Parked | Not run. Acceptance will assert all six bot seats, an automated spectator outside the competitor roster, and death/reconnect seat outcomes. |
| `replay-report`, `faults`, civilization, policy comparison, and benchmarks | Parked | No revised live or acceptance run was performed. |
| Linux x86_64 | Unverified | No Linux run was performed. |

All acceptance cases are unattended and headless, using bot clients for every participant.

## Source checks versus live proof

The Java plugin emits startup diagnostics for the prepared map and server readiness. Those diagnostics are useful for locating startup failures, but a marker alone does not prove generated blocks, chest contents, reset behavior, a legal action, or an authoritative match result. Acceptance cases must read block and inventory state through Mineflayer and consume the plugin's typed outcome stream. Match actions must use ordinary client mechanics; no administrative damage or injected live inventory is accepted.

The TypeScript support oracle in this change compares the full declared block sequence, client-observed spawn positions in seat order, and all 27 slots of every declared chest against a compiled map. It also requires a recorded death before reset and zero deaths afterward. None of these assertions has been exercised against a live client observation. The planned `arena inspect` check reads stopped-run stats for the same offline UUID from `<run>/server/world/stats/<offline-uuid>.json`; this read remains an integration prerequisite. Tests must consume `inspect` output rather than probing server files directly. The oracle's existence is not acceptance evidence.

## Contract changes and measurements

This slice adds only private test-support types and assertions; no product API, schema, rule, permission, or transaction contract is changed. No runtime, binary-size, startup, six-seat, or performance measurements were collected.

## Remaining prerequisites

1. Complete the configured-world runner lifecycle and expose stopped-run stats through `arena inspect`.
2. Run the remaining cases against genuine Mineflayer observations and retain exact commands and results here.
