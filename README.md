# Arena

Arena runs Minecraft competitions with headless Mineflayer bots and an authoritative Paper server. A native Minecraft client can join as a spectator.

## Install

Install Node.js 26.11.1 and pnpm 12.13.0. From the repository root, install the workspace and check the launcher:

```sh
pnpm install --frozen-lockfile
./arena bootstrap
```

The first live run downloads the pinned JDK and Paper server and builds the plugin. See [`versions.lock.toml`](versions.lock.toml) for the toolchain and Minecraft version.

## Run a match

After accepting the Minecraft EULA, start the six-bot Hunger Games scenario:

```sh
./arena run --scenario scenarios/hunger-six.toml --accept-minecraft-eula
```

The runner prints progress and the connection address to stderr. After the match stops, stdout contains a JSON result with the run ID, created paths, trace segments, outcome report, and player statistics. Use the printed run ID with `./arena inspect --run-id <id>` to inspect a stopped run.

Scenario files in [`scenarios/`](scenarios/) select the map and policy. Validate a scenario without starting Paper:

```sh
./arena validate --scenario scenarios/hunger-six.toml
```

## Watch as a spectator

To wait for a native client before the match starts, run:

```sh
make server ACCEPT_MINECRAFT_EULA=1
```

This starts six bots and three automated spectators, reserves a fourth spectator slot, and waits for your client. Connect to `127.0.0.1:25565` with the Minecraft version in `versions.lock.toml`. The server stops when the match ends or you press Ctrl-C.

## Help and license

Run `./arena help` for launcher commands and `./arena doctor` for available runner capabilities. This repository does not declare a license.
