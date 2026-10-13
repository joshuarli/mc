# Arena

Arena is a headless Minecraft competition stack. Mineflayer bots are the only clients; the Paper plugin owns authoritative world and match rules. Toolchain versions are pinned in [`versions.lock.toml`](versions.lock.toml), while package versions are pinned in the npm manifests and lockfile. See [compatibility](docs/compatibility.md) for the full matrix.

The current TypeScript runner supports offline scenario preparation and trace inspection, reporting, and comparison. Full live-run supervision and gameplay acceptance are still in progress.

## Set up and check

```sh
./arena bootstrap
./arena build --package spec
./arena test --suite spec --case scenario_v1_compiles_hunger_six_and_duel
./arena test --suite integration --case stack
./arena test --suite java --case unit
./arena check compatibility
./arena check build-script
```

`bootstrap` installs the pinned Node.js, npm, and package workspace. `build` accepts `core`, `spec`, `bots`, `control`, `owned-files`, `runtime`, `runner`, or `all`. Tests select one exact registered case by suite and name. The `stack` case starts the pinned Paper fixture and exercises two Mineflayer clients; Java unit tests use the pinned JDK and Gradle wrapper.

## Implemented commands

Use `./arena help` for launcher syntax. The implemented runner commands are:

```sh
./arena doctor
./arena prepare --scenario scenarios/hunger-six.toml --run-id smoke-001
./arena inspect tests/fixtures/replay-report-v2/segment-0001.json
./arena report tests/fixtures/replay-report-v2/segment-0002.json tests/fixtures/replay-report-v2/segment-0001.json
./arena compare tests/fixtures/replay-report-v2/segment-0001.json tests/fixtures/replay-report-v2/segment-0001-other-run.json
```

`prepare` compiles a scenario and stages its world plan. `inspect` and `report` read complete trace segments; `compare` checks two single-segment streams. These evidence commands do not start Paper or run a match. See [runner operations](docs/operations.md) for input and output details.

## Current proof

The two-client Paper/Mineflayer stack smoke passed on macOS arm64 with the pinned versions. Linux x86_64 has not been verified. This smoke proves protocol and ordinary client-action compatibility for its fixture only; configured-map reset, authoritative match outcomes, full gameplay acceptance, and performance remain unverified. See [compatibility](docs/compatibility.md) and the [acceptance report](docs/acceptance-report.md) for current case status.

Pinned toolchains, downloads, dependencies, generated builds, test runs, and prepared run data stay under the repository-local `.work/` directory.
