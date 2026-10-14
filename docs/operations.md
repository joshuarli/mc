# Runner operations

`./arena` validates scenarios, prepares run data, starts Paper matches, inspects stopped runs, removes selected run data, and reads trace evidence. Use `./arena help` for launcher commands.

## Run and inspect

`validate` compiles a scenario, map, and policy without creating a run. `prepare` stages a world plan under `.work/arena/runs/<run-id>`. `run` starts an owned Paper server, runs the configured competitors with the baseline policy, and prints the result and created paths as JSON.

```sh
./arena doctor
./arena validate --scenario scenarios/hunger-six.toml
./arena prepare --scenario scenarios/hunger-six.toml --run-id ops-prepare
./arena run --scenario scenarios/hunger-six.toml --run-id ops-run --accept-minecraft-eula
./arena inspect --run-id ops-run
```

`run` requires explicit Minecraft EULA acceptance. It generates a UUID if you omit `--run-id`. Use `--reserve-external-spectator-slot` to leave one configured spectator connection open for a native client. Add `--wait-for-external-player` to wait for that client before the match starts.

## Play and watch

`play` substitutes one configured bot seat with one external client and waits for that exact identity before the countdown. `watch` reserves a spectator slot and waits for a native client; it never consumes a competitive seat. Both require `--accept-minecraft-eula` and bind the server to loopback.

```sh
./arena play --scenario scenarios/hunger-24.toml --username Alex_9 --accept-minecraft-eula
./arena play --scenario scenarios/hunger-six.toml --username Alex_9 --seat 2 --accept-minecraft-eula
./arena watch --scenario scenarios/hunger-six.toml --accept-minecraft-eula
```

`--username` is 3 to 16 ASCII letters, digits, or underscores and cannot start with `ArenaBot` or `ArenaSpec`. `--seat` defaults to 0 and must be a configured bot seat. The substitution does not add a competitor. It changes the roster and therefore the scenario identity, which is reported as `scenario_semantic_id` in the result. A schema 2 scenario stages world plan schema 3 when a seat is substituted; schema 1 scenarios cannot host an external seat.

The admission wait defaults to 120 s for `play`. `--join-timeout-seconds <1-3600>` changes it for `play`, `watch`, and `run`. The wait fails before the countdown if the identity does not appear, and Ctrl-C during the wait stops and cleans up the server.

Progress goes to stderr: run ID, Minecraft version, address, mode, role and seat, admission, and each match phase. The result JSON on stdout adds `role` (`competitor` with seats and offline UUIDs, `spectator`, or `none`). A failure names the run ID and the run directory under `.work/arena/runs/`.

`./arena test --suite integration --case external-seat` drives the same path with an unattended Mineflayer client.

`inspect --run-id` reads only stopped runs. Use the run ID from the `run` result. A run ID cannot be reused while its path exists under `.work/arena/traces/`, including a partial archive.

## Explain a seat

`./arena explain --run-id <id> --seat <n>` prints one seat's recorded decisions, skill outcomes, action-funnel stages, and authoritative effects for a stopped run. It needs a schema 4 trace for funnel and effect fields and states only what the trace records. See [determinism](determinism.md).

## Save and resume

`./arena save --run-id <id> [--checkpoint-id <id>]` checkpoints a running generalized-roster Hunger match (schema 3 scenario, or a schema 2 scenario with `play`; civilization is excluded). The run's process settles bot skills, sends `checkpoint` with its epoch, waits for `checkpoint_written`, stops Paper cleanly, copies the stopped world and the plugin's record under `.work/arena/checkpoints/<id>/`, verifies the record digest and length, and publishes `manifest.json` last. A missing manifest means an incomplete checkpoint. `save` returns after the run's process writes `save-result.json` in the run directory; a failed save names its reason and the original run keeps going unless the failure came after the barrier. The saved run has no outcome; `report` names it `checkpointed_without_outcome`.

`./arena resume --checkpoint <id> --accept-minecraft-eula [--run-id <id>]` verifies the manifest, record and bot state, recompiles the saved scenario (refusing a changed scenario identity), restores the world copy, starts Paper with `-Darena.resume-checkpoint`, sends the saved `prepare` with `resume: {checkpoint_digest, epoch: saved epoch + 1}`, reconnects every living seat with its saved identity (an external seat must rejoin within the usual wait), restores each bot's policy memory, PRNG and opening state by seat, and starts. Observations stay unknown until re-observed, and pending skill feedback is not carried over. Eliminated seats stay out of play.

## League

`./arena league --manifest evaluation/league-v1.toml --accept-minecraft-eula` runs candidate policies against frozen opponents on hunger-six and prints a paired report. A league unit is one natural match: three candidate seats against three opponent seats, played twice per world seed with the seat parity swapped. A match scores 1 for a last survivor on the candidate side, 0.5 for a draw, 0 otherwise.

The manifest (`schema = 1`, strict TOML) lists `[[candidate]]` and `[[opponent]]` entries, each either `id` with optional `params` or `profile = "<path to policies/candidates/<id>.toml>"`, the seed file and set (`evaluation/seeds-v1.toml`: mechanics regression `481516..481521`, development `500001..500012`, held-out `600001..600024`), the analysis method (`bootstrap` or `tInterval`, 95% interval, grouped by world seed), and the promotion thresholds. The frozen baseline must be an opponent.

Matches run serially through the normal run path. Each completed or failed match is published atomically as `.work/arena/league/<id>/matches/<match>.json`; a rerun skips published matches and refuses a record whose plan digest no longer matches the manifest. Per-seat candidate identity is written into each trace as `seat-policy-v1`.

The report keeps denominators: planned, completed, failed or censored (with reasons), degraded, and matches with disconnects. It gives the cluster mean, interval, effect size against an even match, the mean if censored matches count as losses, and survival and attack-issue gates against the opponent side. A candidate is promoted only when every match completed, the mean is at least `min_mean`, the interval lower bound exceeds `min_lower_bound`, no match was degraded or lost a seat to a disconnect, and neither gate regressed beyond its tolerance. Otherwise the verdict is `keep_baseline` with the reasons.

`min_seeds` (default 12 for regression and development sets, 24 for held-out) is the fewest world seeds that may support a promotion; a smaller set can only yield `keep_baseline` with `insufficient_seeds`.

Known limitation: the per-seed scenario is derived by substituting the `seed`, `map` and `policy` lines of the scenario text into a file under `.work/arena/league/<id>/scenarios/`; the roster is never edited. A spec-level seed override would replace this.

A held-out seed set is evaluated once per frozen candidate set. Before the first match the harness writes `evaluation/heldout-ledger/<seed>.json` with the candidate-set digest. A different digest or league over a consumed seed fails with `heldout_seed_already_consumed`; the same digest resumes. To reuse the seeds, change their set to `role = "development"` in the seed manifest and add a new held-out set with fresh seeds.

## Remove run data

Use `gc --dry-run` to review selected run directories. Use `gc --apply` to archive eligible evidence and remove selected directories. The command does not select unrelated runs for removal.

```sh
./arena gc --dry-run --run-id ops-run
```

## Read trace evidence

`inspect`, `replay-policy`, and `report` accept complete trace segments. The runner orders segments by sequence range and requires one run with no gaps or overlaps. `inspect` displays generic records. `replay-policy` checks recorded decisions against the core policy. `report` reconstructs the terminal outcome from typed lifecycle records. `compare` requires exactly two single-segment files and compares their sequence ranges and records. See [determinism and evidence](determinism.md) for schemas and replay limits.

```sh
./arena inspect tests/fixtures/replay-report-v2/segment-0001.json
./arena replay-policy tests/fixtures/policy-border-preemption/trace-v2-000001.json
./arena report tests/fixtures/legal-player-passed/trace-v2-000001.json
./arena compare tests/fixtures/replay-report-v2/segment-0001.json tests/fixtures/replay-report-v2/segment-0001-other-run.json
```

Successful commands write one JSON object to stdout. Failures write one JSON error to stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a missing prerequisite, 4 for a resource conflict, 5 for corrupt or incomplete evidence, 6 for runtime failure, and 130 for cancellation.

## Runtime fault selectors

Each named fault selector starts the prepared Paper stack for one failure path. Run selectors separately when you need focused evidence; `faults` runs all five sequentially.

```sh
./arena test --suite integration --case faults-port-conflict
./arena test --suite integration --case faults-second-owner
./arena test --suite integration --case faults-plugin-identity
./arena test --suite integration --case faults-server-crash
./arena test --suite integration --case faults-sigint
./arena test --suite integration --case faults
```
