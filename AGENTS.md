# Arena working rules

- Keep `arena-core` free of runtime, network, filesystem, and server dependencies. `arena-spec` may depend on core; `arena-bots` may depend on core and Azalea; `arena-runner` owns process and filesystem effects.
- Treat `versions.lock.toml` as the version authority. Keep manifest and toolchain pins aligned with it.
- Keep Cargo targets, caches, toolchains, server files, test worlds, and temporary files under `.work/`; `.work/` is excluded locally.
- Run Rust builds through `kache`. Use the pinned Rust toolchain and locked dependencies.
- Do not bind a Minecraft server outside loopback. Smoke identities are offline and non-operator.
- Never set shipped EULA acceptance by default. Local campaign smoke runs may write explicit acceptance in their disposable world directory.
- Reject unsupported schema versions and unknown fields. Keep code comments self-contained.
