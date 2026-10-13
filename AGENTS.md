# Arena working rules

- Keep `packages/arena-core` free of runtime, network, filesystem, and server dependencies. `packages/arena-spec` may depend on core; `packages/arena-bots` may depend on core, Mineflayer, and `mineflayer-pathfinder`; `packages/arena-runner` owns process and filesystem effects.
- Keep competitors and automated spectators headless. The owner may connect an external native Minecraft client as a spectator; do not add human competitors, GUI, renderer, or protocol-bridge work.
- Keep the Paper plugin as the sole match and outcome authority. TypeScript clients consume only their own Mineflayer observations plus explicitly permitted team messages.
- Treat `versions.lock.toml` as the Paper, Node.js, Java, and Gradle version authority. Keep `package-lock.json`, Gradle verification metadata, and tool versions aligned with it.
- Keep npm caches, generated output, toolchains, server files, test worlds, and temporary files under `.work/`; `.work/` is excluded locally. Keep `TMPDIR` under `.work/tmp`.
- Use pinned Node and npm versions and the committed lockfile. Do not change global Node defaults.
- Do not bind a Minecraft server outside loopback. Bot identities are offline and non-operator.
- Never set shipped EULA acceptance by default. Local campaign smoke runs may write explicit acceptance in their disposable world directory.
- Reject unsupported schema versions and unknown fields. Keep code comments self-contained.
