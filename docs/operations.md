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

`inspect --run-id` reads only stopped runs. Use the run ID from the `run` result. A run ID cannot be reused while its path exists under `.work/arena/traces/`, including a partial archive.

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
