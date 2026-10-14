# Compatibility and foundation

`versions.lock.toml`, the pnpm package manifests, and `pnpm-lock.yaml` own the exact identities. This table is a reader-facing summary; `./arena check compatibility` verifies that it stays in sync.

| Component | Locked identity |
| --- | --- |
| Minecraft | 26.1.2, protocol 775 |
| Node.js | 26.11.1 |
| pnpm | 12.13.0 |
| TypeScript | 7.0.2 |
| Oxlint and tsgolint | 1.87.0 and 7.0.2004 |
| Effect | 4.0.2 |
| Mineflayer | 4.39.0 with mineflayer-pathfinder 2.4.5; its published version list includes Minecraft 26.1 |
| Paper server | Stable 26.1.2 build 74, `paper-26.1.2-74.jar` |
| Paper API | `io.papermc.paper:paper-api:26.1.2.build.74-stable`, plugin API version `26.1.2` |
| Java | Eclipse Temurin JDK 25.0.4.1+1; runtime build `25.0.4.1+1-LTS` |
| Gradle | 9.6.1 wrapper; wrapper JAR and distribution SHA-256 are checked against `versions.lock.toml` |

Mineflayer 4.39.0 and `minecraft-protocol` 1.68.0 advertise Minecraft 26.1 support, and the protocol data maps Minecraft 26.1.2 to protocol 775. The exact server artifact and matching Paper API are pinned in `versions.lock.toml`.

Mineflayer 4.39.0's feature table omits `entityActionUsesStringMapper` for protocol 775. Its numeric sprint fallback encodes `start_sprinting` as action 3, which the protocol maps to `start_riding_jump`; the bots adapter supplies the missing feature answer for this protocol so Mineflayer serializes sprint actions by name. Remove this correction when Mineflayer's feature table reports the mapper capability for protocol 775.

**Arena live compatibility status: the two-client stack smoke passed on macOS arm64 with Node.js 26.11.1.** `./arena test --suite integration --case stack` passed against Paper 26.1.2 build 74 (protocol 775) and Mineflayer 4.39.0. Both clients logged in, received chunks, moved, transferred chest items, produced a server-observed ordinary hit, and disconnected; the wrong-protocol control was rejected. The test took 14.56 seconds. The Node.js 26.8.2 (14.87 seconds) and 24.21.0 runs remain historical evidence. Linux x86_64 and full gameplay acceptance remain unverified. The smoke is a compatibility check, not a performance measurement.

Node.js 26.11.1 and the pnpm 12.13.0 workspace now replace the former Node 24 bootstrap. Linux x86_64 is the other supported native target and still needs a host run.

Sources: [Mineflayer 4.39.0 supported versions](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/lib/version.js), [Mineflayer 4.39.0 package metadata](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/package.json), [minecraft-protocol 1.68.0 protocol versions](https://raw.githubusercontent.com/PrismarineJS/node-minecraft-protocol/1.68.0/src/version.js), [Minecraft 26.1.2 protocol mapping](https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json), [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [Paper Java requirements](https://docs.papermc.io/paper/getting-started/).
