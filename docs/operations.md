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

`./arena explain --run-id <id> --seat <n>` prints one seat's recorded decisions, skill outcomes, action-funnel stages, and authoritative effects for a stopped run as JSON, and a text timeline to stderr. The timeline collapses equal decisions into tick ranges with goal, intent, wait reason, reason code (`decision-explain-v1`), scored alternatives with their rejecting condition, nearest cache, opponent and border-center distances, then idle spans (marked UNEXPLAINED when no wait reason or deferral covers them), engagements by opponent, environment damage, and the death with its cause. It needs a schema 4 trace for funnel, effect, and explanation fields and states only what the trace records. See [determinism](determinism.md).

`./arena report <segment>...` adds `seat_quality` to its JSON and the per-seat table to stderr.

`./arena decision-diff --run-id <id> --candidate <id> [--baseline <id>] [--seat <n>]` replays the run's recorded observations and memory through two registered candidates (baseline defaults to `baseline`) and lists every decision where they differ, with both goals, intents and reason codes. It reads evidence only and starts no server.

## Per-seat quality table

Every league match, `quality` run, and `report` derives one row per seat from recorded evidence only: loot actions started and chests opened (a succeeded `containerOpen`), distance travelled (horizontal, summed between consecutive decision observations), idle ticks (consecutive decisions with under one block of movement and no in-place action) split by waiting reason or `no_progress:<intent>`, attacks issued against rejected before issue with the funnel miss reason and a self-inflicted count, damage dealt and taken from `damage` events with the share taken from competitors, time alive, death tick and cause (the last damage cause before the elimination, with the attacker seat when PvP), and decision reason-code counts. The match adds PvP engagements (distinct attacker-victim pairs), PvP hits, and elimination causes. A stationary `navigate` or `approach` interval whose policy effect records a failed navigation (`noProgress`, or a path update of `noPath` or `timeout`) is `trapped:<intent>`: it counts toward trapped ticks and the longest trapped span, and it does not count toward the unexplained idle span.

Self-inflicted rejections are `outOfGeometricReach`, `cooldownNotReady`, `aimNotReady`, `blockedLineOfSight`, `ownershipDeferred`, `clientOperationFailed`, `friendlyFireRisk`, and `noAmmunition`. The Hunger quality gates are: every match terminates; at least 75% of seats open a chest or collect a drop; at least 40% of eliminations are PvP; self-inflicted rejections under 5% of issued attacks; no unexplained idle span over 600 ticks. A gate without data fails with `no_data`.

## Quality loop

`./arena quality --scenario scenarios/hunger-six.toml --seeds 481516,481517 --accept-minecraft-eula [--candidate <id>] [--concurrency <1-4>]` plays one Hunger match per seed, the candidate on even seats and `baseline` on odd seats (`baseline` on all seats without `--candidate`), and prints the per-seat table, reason-code histograms per policy, and the gates to stderr. The JSON report goes to stdout and `.work/arena/league/quality/report-NNNN.json`. A failed match stays in the report with its reason and counts against the termination gate.

Every league, quality, duel, acceptance, and bench match takes an ephemeral loopback game port (`ephemeralGamePort`); only `run`, `play`, `watch`, `make server`, and the fault and lifecycle selectors keep 25565. `--concurrency n` (default 1, maximum 4) runs up to n matches at once, each in its own run directory with its own Paper process. One world template per scenario is built once per process and cloned per run, so concurrent runs of one seed share only the read-only template. Results are ordered by plan, never by completion; a failed match does not stop the others; each match records the concurrency level it ran at, and a report with concurrency above 1 labels its outcomes timing-sensitive, because server tick pressure changes with the number of live servers.

Memory budget: each match runs Paper with `-Xms512m -Xmx2g`, plus about 1 GiB of JVM metaspace, thread stacks and chunk data, plus the runner's six in-process bots; plan 3.5 GiB per match and one runner process of about 1 GiB. Concurrency 3 needs about 11.5 GiB and concurrency 4 about 15 GiB; the 32 GiB development host fits 4, and 3 matches fit 10 CPUs without starving the 20 TPS tick.

## Duel

`./arena duel --scenario <path> --candidate <id> --opponent <id> --seeds <a,b,c> --rounds <n> --accept-minecraft-eula [--concurrency <1-4>]` runs a two-competitor `hunger_games` scenario. The compiled roster must be exactly two competitors (`duel_requires_two_competitors`). A scenario whose mode is not `hunger_games` is rejected (`duel_requires_hunger_games`). The command does not read the rules kind: `scenarios/duel.toml` is a legal target, and so is a later two-seat `hunger_games` scenario whose rules kind is `uhc_duel`. `--rounds` is 1, 2, or 3. `--seeds` uses the same comma-separated seed grammar as `quality`, with at most 24 distinct seeds. `--concurrency` defaults to 1 and is at most 4. EULA acceptance is never implied.

For every seed and round the command plays both seat assignments: the candidate on seat 0 and the opponent on seat 1, then the swap. Matches use ephemeral loopback ports. A failed match stays in the report with its reason and run id and does not stop the others. Results stay in plan order. The JSON report goes to stdout and `.work/arena/league/duel/report-NNNN.json`. Each round log entry lists the run id `./arena explain --run-id <id> --seat <n>` can open.

`--opponent pool` is rejected with `duel_opponent_pool_unavailable`. The candidate registry has no frozen opponent pool, and this command does not add sparring partners. Pass one registered candidate id (`baseline`, `cautious-survivor`, `equipment-skirmisher`, `melee-duelist`, `ranged-kiter`, or `improved`).

A completed match scores 1 when the authoritative winner is on the candidate seat, 0.5 for a draw, and 0 for a loss. The paired score for a world seed is the mean of its completed assignments across every round. The reported mean and 95% interval are the league harness `tInterval` over those seed clusters (`estimateMean` grouped by world seed). One cluster has a mean and no interval. Failed matches stay in the denominators and out of the cluster mean; `mean_if_censored_lost` counts each as 0. Concurrency above 1 marks the report timing-sensitive.

When a match has quality evidence, the engagement summary records attacks engaged, issued, and rejected per seat, damage dealt and taken per seat, and the match PvP hit and engagement counts. A round sums the candidate seat across the assignments that have evidence. These counts are omitted because match quality does not retain them: swings, time in reach, heals, bow shots, bow hits, and first strike. The per-seat quality table is printed from the recorded evidence. Hunger quality gates are not part of the duel report.

## Capacity benchmark

`./arena bench --profile scale-v1 --accept-minecraft-eula [--workloads <list>] [--layouts <1,2,4>] [--regimes <cold_world,prepared_world>] [--max-level <n>]` measures the highest population that meets fixed quality floors, per workload, worker layout and world regime. The filters narrow the matrix; they do not change the profile.

`scale-v1` data: levels 6, 12, 24, 48, 96, 128 and 256 competitors, advancing only while the previous level qualifies; 3 valid runs per level; a 30 s warmup then a 120 s steady window; worker layouts 1, 2 and 4 for natural Hunger matches (idle connections and traversal run in the supervisor, layout 1); cold-world (a fresh world seed per run) and prepared-world (one seed per level, primed by an unmeasured run) reported separately. Economy, siege and dense-combat are typed slots reported as `workload_not_implemented`.

Floors, fixed in the profile and never edited after a failure: mean TPS at least 97% of 20; per-tick service p95 < 40 ms and p99 < 50 ms; event-loop delay p99 < 25 ms for each worker that made decisions; at least 90% of expected decisions useful or waiting with a stated reason; queue depth not growing without bound; zero critical evidence lost. A percentile with too few samples (p95 < 20, p99 < 100) is `insufficient_samples` and cannot pass. Idle connections exempts the policy-engagement floors.

Every measured run is bracketed by `perf-gate-ready` and `perf-gate-ready -1`. A busy host defers the run (`perf gate deferred: host busy`) and is never a pass; a run that overlapped load is discarded and retried once. A level needs 3 valid runs. A failing run stops the level and the report names the stop reason (`quality_floor_failed`, `operational_failure`, `insufficient_valid_runs`, `perf_gate_deferred_host_busy`, `perf_gate_unavailable`) and the bottleneck floor.

Metrics: authoritative TPS from clock ticks over arrival time, tick service time from the plugin's `metrics` message, event-loop delay and utilization per worker, tick-arrival-to-decision and decision-to-execution delay per worker (never averaged across skipped actors), action outcomes, queue depth, dropped optional metrics, and Paper and supervisor CPU time. Metrics the stack cannot measure (search work, chunk generation, encoded bytes, log throughput, memory) stay `null`. The plugin does not yet emit `metrics`, so tick service time is `null` and no level can qualify until it does.

## Save and resume

`./arena save --run-id <id> [--checkpoint-id <id>]` checkpoints a running generalized-roster Hunger match (schema 3 scenario, or a schema 2 scenario with `play`; civilization is excluded). The run's process settles bot skills, sends `checkpoint` with its epoch, waits for `checkpoint_written`, stops Paper cleanly, copies the stopped world and the plugin's record under `.work/arena/checkpoints/<id>/`, verifies the record digest and length, and publishes `manifest.json` last. A missing manifest means an incomplete checkpoint. `save` returns after the run's process writes `save-result.json` in the run directory; a failed save names its reason and the original run keeps going unless the failure came after the barrier. The saved run has no outcome; `report` names it `checkpointed_without_outcome`.

`./arena resume --checkpoint <id> --accept-minecraft-eula [--run-id <id>]` verifies the manifest, record and bot state, recompiles the saved scenario (refusing a changed scenario identity), restores the world copy, starts Paper with `-Darena.resume-checkpoint`, sends the saved `prepare` with `resume: {checkpoint_digest, epoch: saved epoch + 1}`, reconnects every living seat with its saved identity (an external seat must rejoin within the usual wait), restores each bot's policy memory, PRNG and opening state by seat, and starts. Observations stay unknown until re-observed, and pending skill feedback is not carried over. Eliminated seats stay out of play.

## League

`./arena league --manifest evaluation/league-v1.toml --accept-minecraft-eula [--concurrency <1-4>]` runs candidate policies against frozen opponents on hunger-six and prints a paired report. A league unit is one natural match: three candidate seats against three opponent seats, played twice per world seed with the seat parity swapped. A match scores 1 for a last survivor on the candidate side, 0.5 for a draw, 0 otherwise.

The manifest (`schema = 1`, strict TOML) lists `[[candidate]]` and `[[opponent]]` entries, each either `id` with optional `params` or `profile = "<path to policies/candidates/<id>.toml>"`, the seed file and set (`evaluation/seeds-v1.toml`: mechanics regression `481516..481521`, development `500001..500012`, held-out `600001..600024`), the analysis method (`bootstrap` or `tInterval`, 95% interval, grouped by world seed), and the promotion thresholds. The frozen baseline must be an opponent.

Matches run through the normal run path, serially unless `--concurrency <1-4>` is given (see Quality loop). Each completed or failed match is published atomically as `.work/arena/league/<id>/matches/<match>.json`; a rerun skips published matches and refuses a record whose plan digest no longer matches the manifest. Per-seat candidate identity is written into each trace as `seat-policy-v1`.

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
