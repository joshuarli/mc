# Compatibility and foundation

| Component | Locked identity |
| --- | --- |
| Minecraft protocol | Java 26.2, protocol 776 |
| Azalea | `0bd22cbcdd30b611b112fc1c0a3d78535fd493a1` |
| Rust | `nightly-2026-10-07`, rustc `1.101.0-nightly (8d1a76430 2026-10-06)` |
| Paper server | Stable 26.2 build 133, `paper-26.2-133.jar` |
| Paper API | `io.papermc.paper:paper-api:26.2.build.133-stable`, plugin API version `26.2` |
| Java | Eclipse Temurin JDK 25.0.4.1+1; runtime build `25.0.4+11-LTS` |
| Gradle | 9.6.1 binary distribution, bootstrapped from its locked SHA-256 under `.work/arena/toolchains` |

The Paper server artifact was downloaded from the official Fill v3 URL with `Arena/0.1 (dankmeme133769@proton.me)`. Its 64,525,509 bytes match the official SHA-256 in `versions.lock.toml`. The Paper API 133 coordinate is published. The server and API use the same build number; the API docs page inspected during research showed build 130, so API Javadocs were not treated as evidence for build 133.

The pinned Azalea repository's upstream `echo` example compiled with:

```sh
cargo +nightly-2026-10-07 check --locked --offline -p azalea --example echo
```

The same check failed on nightly 2026-09-24 because the revision uses `min_generic_const_args` features that that nightly did not recognize. Nightly 2026-10-07 is the first tested toolchain pin. On this macOS arm64 host the successful cold check took 118.72 seconds wall time and 165.95 seconds CPU time, with 1,416,085,504 bytes peak RSS and no swapping. A warmed check and the live protocol smoke remain unmeasured.

Foundation stack proof is pending until `./arena test --suite integration --case stack` exercises two clients against the locked Paper build. The runner materializes the locked Temurin archive for macOS arm64 or Linux x86_64; only macOS arm64 has been available for validation in this lane, so Linux x86_64 remains unverified.
