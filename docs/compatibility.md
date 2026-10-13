# Compatibility and foundation

`versions.lock.toml`, the npm package manifests, and `package-lock.json` own the exact identities. This table is a reader-facing summary; `./arena check compatibility` verifies that it stays in sync.

| Component | Locked identity |
| --- | --- |
| Minecraft | 26.1.2, protocol 775 |
| Node.js and npm | Node.js 24.21.0, npm 11.19.0 |
| TypeScript | 5.9.3 |
| Mineflayer | 4.39.0 with mineflayer-pathfinder 2.4.5; its published version list includes Minecraft 26.1 |
| Paper server | Stable 26.1.2 build 74, `paper-26.1.2-74.jar` |
| Paper API | `io.papermc.paper:paper-api:26.1.2.build.74-stable`, plugin API version `26.1.2` |
| Java | Eclipse Temurin JDK 25.0.4.1+1; runtime build `25.0.4.1+1-LTS` |
| Gradle | 9.6.1 wrapper; wrapper JAR and distribution SHA-256 are checked against `versions.lock.toml` |

Mineflayer 4.39.0 and `minecraft-protocol` 1.68.0 advertise Minecraft 26.1 support, and the protocol data maps Minecraft 26.1.2 to protocol 775. These upstream declarations justify the selected pairing; they do not establish Arena's gameplay compatibility. The exact server artifact and matching Paper API are pinned in `versions.lock.toml`.

**Arena live compatibility status: pending.** The required two-client Mineflayer smoke must verify login, chunks, movement, chest transfer, an ordinary hit observed by the server, disconnect, and rejection of a wrong-version client against the locked Paper build. No live Mineflayer/Paper proof is recorded yet.

The pinned Node and npm bootstrap completed on macOS arm64. Linux x86_64 is the other supported native target and still needs a host run.

Sources: [Mineflayer 4.39.0 supported versions](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/lib/version.js), [Mineflayer 4.39.0 package metadata](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/package.json), [minecraft-protocol 1.68.0 protocol versions](https://raw.githubusercontent.com/PrismarineJS/node-minecraft-protocol/1.68.0/src/version.js), [Minecraft 26.1.2 protocol mapping](https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json), [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [Paper Java requirements](https://docs.papermc.io/paper/getting-started/).
