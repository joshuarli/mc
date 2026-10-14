# Arena working rules

- Keep `packages/arena-core` free of runtime, network, filesystem, and server dependencies. `packages/arena-spec` may depend on core; `packages/arena-bots` may depend on core, Mineflayer, and `mineflayer-pathfinder`; `packages/arena-runner` owns process and filesystem effects.
- Keep competitors and automated spectators headless. The owner may connect an external native Minecraft client as a spectator; do not add human competitors, GUI, renderer, or protocol-bridge work.
- Keep the Paper plugin as the sole match and outcome authority. TypeScript clients consume only their own Mineflayer observations plus explicitly permitted team messages.
- Treat `versions.lock.toml` as the Paper, Node.js, Java, and Gradle version authority. Keep `pnpm-lock.yaml`, Gradle verification metadata, and tool versions aligned with it.
- Keep pnpm caches, generated output, toolchains, server files, test worlds, and temporary files under `.work/`; `.work/` is excluded locally. Keep `TMPDIR` under `.work/tmp`.
- Use Node.js 26.8.2 and the pnpm workspace lockfile.
- Install with `pnpm install --frozen-lockfile`; run `./arena check lint`, `./arena build --package all`, and named `./arena test` cases.
- Do not bind a Minecraft server outside loopback. Bot identities are offline and non-operator.
- Never set shipped EULA acceptance by default. Local campaign smoke runs may write explicit acceptance in their disposable world directory.
- Reject unsupported schema versions and unknown fields. Keep code comments self-contained.
