# Arena

Arena is a headless Minecraft competition stack. Build with `./arena build --package all`, test one named case with `./arena test --suite <suite> --case <case>`, and check with `./arena check lint`.

## Invariants

- `packages/arena-core` has no runtime, network, filesystem, or server dependencies; `arena-spec` may depend on core, `arena-bots` may depend on core, Mineflayer, and `mineflayer-pathfinder`, and `arena-runner` owns process and filesystem effects.
- Bot competitors and automated spectators are headless; one external ordinary client may occupy an admitted competitive seat or spectate on loopback, and Arena adds no GUI, renderer, or protocol bridge.
- The Paper plugin owns match state and outcomes; bots use only their own Mineflayer observations and permitted team messages.
- Use the Node.js and pnpm versions in [compatibility](docs/compatibility.md); `versions.lock.toml` owns Paper, Minecraft, Node.js, Java, and Gradle versions, and `pnpm-lock.yaml` owns workspace package versions.
- Keep caches, toolchains, generated output, server files, test worlds, and temporary files under `.work/`; set `TMPDIR` to `.work/tmp`.
- Bind Minecraft servers to loopback; bot identities are offline and non-operator.
- Shipped runs do not accept the Minecraft EULA by default; local runs require explicit operator acceptance.
- Reject unsupported schema versions and unknown fields at input boundaries.

## Topics

- End-user setup and matches: [README](README.md).
- Toolchain and Minecraft compatibility: [compatibility](docs/compatibility.md).
- Scenarios, maps, and policy configuration: [scenarios](docs/scenarios.md).
- Match and world rules: [rules](docs/rules.md).
- Control wire format: [protocol](docs/protocol.md).
- Policy behavior and client fairness: [policies](docs/policies.md), [fairness](docs/fairness.md).
- Runner lifecycle and commands: [runtime](docs/runtime.md), [operations](docs/operations.md).
- Owned files and path safety: [filesystem](docs/filesystem.md).
- Trace formats, replay, and reports: [determinism](docs/determinism.md).
- Current verification status: [acceptance report](docs/acceptance-report.md), [civilization acceptance](docs/civilization-acceptance.md).
- Campaign instructions and decisions: [campaign plan](docs/minecraft-arena-frontier-campaign.md).
