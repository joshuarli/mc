# Acceptance report

**Status: campaign execution continues.** Frozen M1 and current-source legal-player and six-seed checks pass. The latest Civilization rules run, civilization-rules-b7e91e9e-9621-4ca4-8375-1d983f543cba, timed out waiting for seat 1 to observe a mined block; cleanup succeeded. C1 is not accepted. The TypeScript tooling migration is in place; natural-terrain Hunger work is in progress. Node.js 26.11.1 replaces the former Node 24 bootstrap; the two-client stack smoke passes on Node 26.11.1.

## Verified

- Frozen M1 passed all six declared Hunger seeds at 296c3c9: five wins and one draw, with ordinary loot and PvP.
- Current-source legal-player passed movement, food use, loot, equipment, ordinary damage, knockback, and authoritative outcome checks.
- The current-source six-seed recheck passed all six matches with five wins and one draw. Per-seed outcomes differ from the frozen run; the frozen reports are unchanged.
- Named integration checks pass for the Mineflayer/Paper stack, map reset, match authority, Hunger observation fairness, replay/report, and ten-cycle lifecycle.
- The Mineflayer/Paper stack case passed under Node.js 26.8.2 on macOS arm64: two clients completed login, chunks, movement, chest transfer, a server-observed hit, disconnect, and wrong-protocol rejection.
- The TypeScript toolchain migration passes a frozen pnpm 12.13.0 install, all-package TypeScript 7 build, compatibility check, and the named runner CLI case. Oxlint with type-aware rules/tsgolint runs successfully; its existing warning backlog is not a clean warning gate.
- Dependency check: Effect 4.0.2 is MIT-licensed, declares no runtime dependencies, and occupies 54 MiB unpacked locally. On macOS arm64 with Node.js 26.8.2, a five-pair alternating warm-start comparison with identical compiled CLI code found the broad Effect wrapper slower for `doctor`: 260 ms median CPU (250–260 ms range) without Effect versus 380 ms (370–380 ms), a 46% increase. The narrow `effect/Effect` import gave 290 ms (280–300 ms). A dynamically loaded wrapper around `validate --scenario scenarios/hunger-six.toml` measured 410 ms median (410–430 ms) against 380 ms (360–380 ms), an 8% increase. `doctor` and validation JSON matched byte-for-byte across variants; the validation workload read and compiled the same scenario, map, and policy. The readiness gate passed before and after each run set; a separate profile showed Node ESM module compilation and garbage collection during startup. These broad and short-command variants exceeded the 5% budget and were removed. Effect is now loaded only around the live `runPreparedRun` server lifecycle; that path and cold install/build CPU remain to be measured before P3 closes.
- Port conflict, second-owner, and plugin-identity fault cases pass. The server-crash case exercised the actual crash and process reaping but ended with a cleanup failure. A clean live SIGINT proof is still pending.
- Civilization startup capability and client-context defects are fixed. Current-source core/bot Civilization modules pass 46 focused offline cases; this does not prove live six-client behavior.
- Before the tool migration, `./arena build --package all` passed. The compiled offline TypeScript suite ran 494 cases: 482 passed and 12 failed. Visible existing failures included dirty C1 `getDroppedItem` mocks and semantic-world expected-error mismatches. Treat those as migration baseline known-reds and retain them only if they still describe the intended contract.

## Bot quality

The frozen six-seed reports contain 6,231 attack actions. Of these, 5,576 ended with preconditionsNotMet (89.5%); 339 attack actions succeeded and 341 local damage events were recorded. These are action outcomes, not mechanical hit accuracy. They show that target/action failures need direct diagnosis before calling the bots competent.

K1 will measure why targets are unavailable, whether damage was confirmed, survival, and task completion. Its curriculum covers approaching visible targets, recovering after lost line of sight, eating or retreating under pressure, knockback/border recovery, and choosing between targets. Compare the frozen baseline with 12 development seeds and a frozen candidate on 24 held-out seeds with swapped positions. Do not tune on held-out results. If improvement is not supported, keep the baseline default.

## Civilization blocker

Paper's checkpoint for b7e91e9e at match tick 2716 records the sixth Ember oak log absent and one dropped log item. Seat 1's observer timed out after 20 seconds. The operational failure artifact kept the generic timeout even though the test attempted to report block-packet counts, target blockUpdate receipt, and local block presence. Preserve those details in the next failure result before another live C1 attempt.

After C1 passes, run civilization-six and civilization-baseline before M2. H1 follows M2; K1 follows H1 and parity; O1 follows H1 and K1's default-policy decision; Z1 closes the functional and delivery checks.

## Capacity and make server

The prior `make server` failure came from a ten-run cap and repeated work-tree capacity scan. Those gates and free-space, aggregate-byte, generic download-size, host memory, and swap thresholds are removed. A local run prepared its map, started Paper, connected six competitors and three automated spectators, and reached the external-player wait. I stopped it with Ctrl-C; the runner recorded structured cancellation, reaped Paper, and released port 25565. No external-client join or game outcome was observed. Host memory and swap measurements are unavailable.

The make server feature reserves one of four spectator slots, starts six competitors and three automated spectators, and waits for an external player before match start. `RunPreparedRunOptions` includes `waitForExternalPlayer`. The canonical natural-terrain seed 481516 passed both Paper bootstrap and cloned-run setup: each emitted `ARENA_MAP_READY`, the cloned run prepared 359 chunks, and all six bots joined at resolved terrain positions. The top-level server is waiting for an external player on 127.0.0.1:25565; no external-client join or match outcome has been observed in this run. The remaining five natural-terrain seeds are validated as scenario inputs but have not had live terrain checks.

## Remaining work and limits

- H1 still needs the deterministic disk-full publication regression, full outbound critical/optional queue behavior, and adversarial Civilization faction-isolation proof.
- C1, live C2, and M2 remain incomplete. The server-crash cleanup and SIGINT proofs also remain open.
- Natural-terrain Hunger acceptance remains open for the other five seeds and for six-seed gameplay evidence. The seed-481516 Paper startup verifies only that seed's terrain setup and cache placement.
- No current-source full suite, gameplay benchmark, release-size check, fresh-checkout acceptance, or Linux run has been completed. The Effect startup comparison above does not establish gameplay performance or human competitiveness.
- Effect 4.0.2 was added to the runner. Its final run-only boundary and cold install/build cost remain under the campaign's dependency budgets.
