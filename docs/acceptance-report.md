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
| `maps-reset` | Failing | The first configured attempt at `26a07a7` reached generated-world startup, then failed because the adapter was constructed before Mineflayer injected its plugins. The runner stopped both JVMs and saved an operational failure artifact; map comparison and reset remain unverified. |
| `match-rules` | Parked | Not run. No ordinary two-client duel or independently reconstructed typed result has been observed. |
| `legal-player` | Parked | Not run. No configured live route, container interaction, and attack sequence has been exercised through the Mineflayer skill client. |
| `fairness` | Parked | Not run. Independent client receipt histories, complete current perception, and a live hidden-state perturbation remain unproven. |
| `hunger-six` | Parked | Not run. Acceptance will assert all six bot seats, an automated spectator outside the competitor roster, and death/reconnect seat outcomes. |
| `replay-report`, `faults`, civilization, policy comparison, and benchmarks | Parked | No revised live or acceptance run was performed. |
| Linux x86_64 | Unverified | No Linux run was performed. |

All acceptance cases are unattended and headless, using bot clients for every participant.

## Source checks versus live proof

The Java plugin emits startup diagnostics for the prepared map and server readiness. Those diagnostics are useful for locating startup failures, but a marker alone does not prove generated blocks, chest contents, reset behavior, a legal action, or an authoritative match result. Acceptance cases must read block and inventory state through Mineflayer and consume the plugin's typed outcome stream. Match actions must use ordinary client mechanics; no administrative damage or injected live inventory is accepted.

The TypeScript support oracle compares the full declared block sequence, client-observed spawn positions in seat order, and all 27 slots of every declared chest against a compiled map. It also requires a recorded death before reset and zero deaths afterward. None of these assertions has been exercised against a configured live client observation. `arena inspect --run-id` now reads stopped-run stats for the same offline UUID from `<run>/server/world/stats/<offline-uuid>.json`; its configured live use remains unverified. Tests consume `inspect` output rather than probing server files directly.

At `1cd0a60`, the strict TypeScript stack build and `all live acceptance scenario and policy sources compile offline` passed. This check compiles every live fixture's scenario, referenced map, and policy. It caught malformed recording fields and a border end tick equal to the match limit before a server was started. The native helper's strict C build and 19 owned-file cases also passed, including bounded resource accounting and rejection of symlinked work roots. These are offline checks.

At `e6357db`, the five focused Java test classes passed all 44 cases, including the pre-release phase policy. The plugin now freezes competitive positions and blocks inventory actions before release; the live `match-rules` case still must verify the Bukkit event wiring and initial player reset.

## Contract changes and measurements

The runtime now exposes `run --scenario`, read-only `validate --scenario`, and stopped-run inspection. Scripted acceptance cases select an evaluator driver; normal Hunger runs retain the baseline policy. Conflict and cancellation errors use exits 4 and 130 respectively. Configured live behavior remains unverified. No startup, six-seat, or performance gate measurements were collected.

## Remaining prerequisites

1. Verify configured-world startup, bounded shutdown, and stopped-run stats through `arena inspect`.
2. Run the remaining cases against genuine Mineflayer observations and retain exact commands and results here.
