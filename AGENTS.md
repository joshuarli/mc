# Arena working rules

- Keep `packages/arena-core` free of runtime, network, filesystem, and server dependencies. `packages/arena-spec` may depend on core; `packages/arena-bots` may depend on core, Mineflayer, and `mineflayer-pathfinder`; `packages/arena-runner` owns process and filesystem effects.
- Keep this campaign fully headless: fixed bot competitors and automated spectators, with no human-play, GUI, renderer, or protocol-bridge work.
- Keep the Paper plugin as the sole match and outcome authority. TypeScript clients consume only their own Mineflayer observations plus explicitly permitted team messages.
- Treat `versions.lock.toml` as the Paper, Node.js, Java, and Gradle version authority. Keep `package-lock.json`, Gradle verification metadata, and tool versions aligned with it.
- Keep npm caches, generated output, toolchains, server files, test worlds, and temporary files under `.work/`; `.work/` is excluded locally. Keep `TMPDIR` under `.work/tmp`.
- Use pinned Node and npm versions and the committed lockfile. Do not change global Node defaults.
- Do not bind a Minecraft server outside loopback. Bot identities are offline and non-operator.
- Never set shipped EULA acceptance by default. Local campaign smoke runs may write explicit acceptance in their disposable world directory.
- Reject unsupported schema versions and unknown fields. Keep code comments self-contained.
- Existing Rust crates and Azalea integration are historical migration input only. Do not extend, build, or run them for the revised campaign; remove them only after their required behavior has a TypeScript replacement and focused verification.
