# Arena

Arena is a headless Minecraft competition stack. Mineflayer bots compete; an external native Minecraft client may join as a spectator. The Paper plugin owns authoritative world and match rules. Toolchain versions are pinned in [`versions.lock.toml`](versions.lock.toml), while package versions are pinned in the npm manifests and lockfile. See [compatibility](docs/compatibility.md) for the full matrix.

The TypeScript runner supports configured Paper runs, scenario preparation, stopped-run inspection and cleanup, and trace inspection, policy replay, reporting, and comparison. Runtime lifecycle and authority behavior have focused live proofs; full gameplay acceptance remains in progress.

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

## Watch a local match

Run `make server` from the repository (or the installed parent workspace shortcut). Explicit EULA acceptance is required: use `make server ACCEPT_MINECRAFT_EULA=1`, or set `ACCEPT_MINECRAFT_EULA := 1` in the ignored `.work/arena/server.mk` after accepting the Minecraft EULA. No acceptance is shipped by default.

The target starts `scenarios/hunger-six.toml` with six bots and three automated spectators, reserving the fourth spectator slot for your client. It prints the actual Minecraft Java Edition version and connection address after server and bot readiness. Use a matching native client and connect to `127.0.0.1:25565` as a spectator. The server stops when the match ends or when you press Ctrl-C. Plain `make` only shows help.

## Current proof

Historical Paper proofs cover the two-client stack, configured-map reset, authority variants, duel, fairness, replay, and lifecycle cleanup. The current baseline policy passed `./arena test --suite integration --case policy-border-preemption`, with strict replay and independent outcome inspection. Checkpoints, active-skill responsiveness, failed-target feedback, and actual AStar compute scheduling have focused behavioral proofs. The exact ramp now passes after correcting the pinned client/server player-width mismatch; the complete legal-player chain remains pending. Campaign execution continues after an owner-authorized archival exception restored two live run slots. Six-seed gameplay, current Paper fault closure, civilization acceptance, full functional/release gates, fresh-checkout execution, and Linux remain unverified. See the [acceptance report](docs/acceptance-report.md) for committed evidence and reproduction commands.

Pinned toolchains, downloads, dependencies, generated builds, test runs, and prepared run data stay under the repository-local `.work/` directory.
