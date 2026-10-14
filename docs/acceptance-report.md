# Acceptance report

**Status: campaign execution continues.** Frozen M1 and current-source legal-player and six-seed checks pass. The latest Civilization rules run, civilization-rules-b7e91e9e-9621-4ca4-8375-1d983f543cba, timed out waiting for seat 1 to observe a mined block; cleanup succeeded. C1 is not accepted. Native inspection reports nine run directories and one open slot.

## Verified

- Frozen M1 passed all six declared Hunger seeds at 296c3c9: five wins and one draw, with ordinary loot and PvP.
- Current-source legal-player passed movement, food use, loot, equipment, ordinary damage, knockback, and authoritative outcome checks.
- The current-source six-seed recheck passed all six matches with five wins and one draw. Per-seed outcomes differ from the frozen run; the frozen reports are unchanged.
- Named integration checks pass for the Mineflayer/Paper stack, map reset, match authority, Hunger observation fairness, replay/report, and ten-cycle lifecycle.
- Port conflict, second-owner, and plugin-identity fault cases pass. The server-crash case exercised the actual crash and process reaping but ended with a cleanup failure. A clean live SIGINT proof is still pending.
- Civilization startup capability and client-context defects are fixed. Current-source core/bot Civilization modules pass 46 focused offline cases; this does not prove live six-client behavior.

## Bot quality

The frozen six-seed reports contain 6,231 attack actions. Of these, 5,576 ended with preconditionsNotMet (89.5%); 339 attack actions succeeded and 341 local damage events were recorded. These are action outcomes, not mechanical hit accuracy. They show that target/action failures need direct diagnosis before calling the bots competent.

K1 will measure why targets are unavailable, whether damage was confirmed, survival, and task completion. Its curriculum covers approaching visible targets, recovering after lost line of sight, eating or retreating under pressure, knockback/border recovery, and choosing between targets. Compare the frozen baseline with 12 development seeds and a frozen candidate on 24 held-out seeds with swapped positions. Do not tune on held-out results. If improvement is not supported, keep the baseline default.

## Civilization blocker

Paper's checkpoint for b7e91e9e at match tick 2716 records the sixth Ember oak log absent and one dropped log item. Seat 1's observer timed out after 20 seconds. The operational failure artifact kept the generic timeout even though the test attempted to report block-packet counts, target blockUpdate receipt, and local block presence. Preserve those details in the next failure result before another live C1 attempt.

After C1 passes, run civilization-six and civilization-baseline before M2. H1 follows M2; K1 follows H1 and parity; O1 follows H1 and K1's default-policy decision; Z1 closes the functional and delivery checks.

## Capacity and make server

The prior `make server` failure came from a ten-run cap and repeated work-tree capacity scan. Those gates and free-space, aggregate-byte, generic download-size, host memory, and swap thresholds are removed. A local run prepared its map, started Paper, connected six competitors and three automated spectators, and reached the external-player wait. I stopped it with Ctrl-C; the runner recorded structured cancellation, reaped Paper, and released port 25565. No external-client join or game outcome was observed. Host memory and swap measurements are unavailable.

The make server feature reserves one of four spectator slots, starts six competitors and three automated spectators, and waits for an external player before match start. RunPreparedRunOptions gained the additive waitForExternalPlayer option. Cancellation and observer disconnects are handled. No external-client join has been verified.

## Remaining work and limits

- H1 still needs the deterministic disk-full publication regression, full outbound critical/optional queue behavior, and adversarial Civilization faction-isolation proof.
- C1, live C2, and M2 remain incomplete. The server-crash cleanup and SIGINT proofs also remain open.
- No current-source full suite, benchmark, release-size check, fresh-checkout acceptance, or Linux run has been completed. No comparative performance or human-competitiveness claim is made.
- No dependency was added, and no time-based performance result is reported.
