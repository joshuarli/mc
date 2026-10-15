# Frontier S7 evaluation

## Frozen comparison

Use `scenarios/hunger-six.toml` and development seeds `500001..500012` for `frontier-v1` with default parameters and frozen `improved`, each against `baseline`. The quality command assigns the candidate to even seats. The league comparison covers both seat assignments. Do not include the rejected S6 `eatAtHungerOrBelow=10` tuning.

Use duel seeds `510001..510012` against the qualified pool. This list is disjoint from the earlier `260114` duels and is fixed before those matches run. Do not use held-out seeds unless a frozen candidate set passes the development gates.

The runs below use branch `campaign/frontier`, HEAD `76f487ac95f9`, with uncommitted working-tree changes present. The machine reports `timing_sensitive` for concurrent runs; keep that label with their results.

## Trace ordering repair

The first three-match quality attempt on seeds `500001..500003` failed before outcomes. A concurrent policy tick started a new action after the settled action left the seat action map but before its effect reached the trace builder. The trace builder still owned the previous sequence and raised `invalid_policy_action_identity`.

The live-policy loop now keeps the settled action in the seat map until effect recording finishes. The focused delayed-persistence regression test failed before the fix and passes after it. `./arena build --package runner` and that test case passed; the runner suite reported 31 passing test files.

## Frontier canary

The one-seed canary for `frontier-v1` on seed `500001` completed at concurrency 1. Report: `.work/arena/league/quality/report-0003.json`. Match `q1e7bcd-s500001` drew at tick 7200, with no disconnects or degradation. Trace replay verified 7,529 decisions and 1,967 effects.

The candidate's reason histogram included `travelToBorderCenter`, `lootBeforeUnarmedFight`, `eatUnderPressure`, `steadyMeleeEngagement`, and other frontier reasons, so the candidate policy ran. Across all six seats, this single-match screen passed termination and issued-illegal gates, and failed looting (0.333), PvP eliminations (0.25), self-inflicted rejection (0.4), and unexplained idle (784 ticks). This is a canary, not a promotion verdict.

## Quality results

- `frontier-v1` quality on seed `500001`: report 0003, concurrency 1.
- `frontier-v1` quality on seeds `500002..500012`: report 0004, concurrency 2, timing-sensitive.
- The combined even-seat screen has 11 completed matches out of 12. Seed `500010` failed before bot admission because the bounded natural-world search found no safe cache columns; the report retains it as a failed match.
- Across the 11 completed traces, policy replay verified 69,147 decisions and 16,064 effects. No completed match repeated `invalid_policy_action_identity`.
- Combined quality gates: termination 11/12 (fail); looting 0.424 (fail); PvP eliminations 0.490 (pass); self-inflicted rejections 0.455 (fail); issued illegal swings 0 (pass); longest unexplained idle span 1,448 ticks (fail).
- Candidate seats alone looted 14/33; issued 118 attacks with 34 self-inflicted rejections and no issued illegal swings; their maximum unexplained idle span was 380 ticks. Candidate reason codes fired in the histogram.
- `improved` quality on seeds `500001..500012`: report 0005, concurrency 2, timing-sensitive. Eleven matches completed. Seed `500010` failed before admission with the same `invalid_world` cache-search result.
- Across the 11 completed improved traces, policy replay verified 47,949 decisions and 14,800 effects. No completed match repeated `invalid_policy_action_identity`.
- Improved quality gates: termination 11/12 (fail); looting 0.561 (fail); PvP eliminations 0.648 (pass); self-inflicted rejections 0.402 (fail); issued illegal swings 0 (pass); longest unexplained idle span 1,360 ticks (fail).
- Improved seats alone looted 20/33; issued 201 attacks with 69 self-inflicted rejections and no issued illegal swings; their maximum unexplained idle span was 1,360 ticks. Candidate reason codes fired in the histogram.
- `baseline` quality on seeds `500001..500012`: report 0006, concurrency 2, timing-sensitive. Nine matches completed. Seed `500010` failed before admission with `plugin_rejected_command` and `invalid_world`. Seeds `500011` and `500012` failed with `runtime_failure` from a Mineflayer `client_error`; the saved reason is `Error`, and the artifacts do not identify a more specific cause.
- Across the nine completed baseline traces, policy replay verified 52,078 decisions and 14,460 effects.
- Baseline quality gates: termination 9/12 (fail); looting 0.537 (fail); PvP eliminations 0.571 (pass); self-inflicted rejections 0.733 (fail); issued illegal swings 0 (pass); longest unexplained idle span 1,260 ticks (fail).
- The S7 league input is `evaluation/frontier-s7.toml`; it compares `improved` and `frontier-v1` against `baseline` on development seeds `500001..500012`.
- The two-assignment league completed at concurrency 3; results are timing-sensitive. Report: `.work/arena/league/frontier-s7/report-0001.json`.
- `improved` completed 21/24 matches: 12 candidate wins, 5 draws, and 4 opponent wins. Mean score was 0.705 and the 95% lower bound was 0.500. The verdict is `keep_baseline` because the set had three failures, one degraded match, a disconnect, and only 11 world seeds. Failures: one reused pre-fix trace with `unmatched_policy_action` (`c0-o0-s500007-r0`) and two seed-500010 `plugin_rejected_command` / `invalid_world` failures.
- `frontier-v1` completed 19/24 matches: 9 candidate wins, 3 draws, and 7 opponent wins. Mean score was 0.575 and the 95% lower bound was 0.325. The verdict is `keep_baseline` because the set had five failures, two degraded matches, disconnects, only 10 world seeds, and an interval below the threshold. Failures: three `conflict` results for run directories left by the interrupted league, and two seed-500010 `plugin_rejected_command` / `invalid_world` failures.
- League quality gates over all 48 plans: termination 0.833 (fail), looting 0.483 (fail), PvP eliminations 0.487 (pass), self-inflicted rejections 0.429 (fail), issued illegal swings 0 (pass), and longest unexplained idle 1,412 ticks (fail).
- Policy replay verified all 40 completed league traces. The reused improved trace failure is preserved and was not replayable as a completed match. No new `unmatched_policy_action` occurred after the lifecycle fix.
- Qualified-pool duels on seeds `510001..510012`: pending for both candidates.
- No candidate passed the development quality gates. Held-out seeds `600001..600024` remain untouched.
