# Arena: unattended Minecraft implementation campaign

**Status: not ready under the live-foundation proof requirement; execution decisions and owner prerequisites are closed.** EULA acceptance, download contact, and Brew authorization are supplied. The exact Paper/Azalea stack and per-client observation isolation still need the live proofs in P0. The executor can start F0 unattended; unproven foundations and blocked proofs never count as passes.

**Goal:** one command starts a real local six-competitor Minecraft world with independently controlled headless bots, plus a small resource-producing two-faction scenario. Scripted policies need no LLM, API key, GPU, graphical bot process, or paid bot accounts. Hundreds of active players and expert-human skill remain measured future objectives.

**Deliverables**

1. Locked, compatible Paper Java 26.2 / JDK 25 / Azalea stack and a native local supervisor.
2. Strict declarative maps, semantic starting-state determinism, safe pristine resets, and six-seat Hunger Games rules.
3. Six-bot `run` and five-bot/one-human `play`, real movement/looting/combat, fair observations, and authoritative results.
4. D1 build determinism, D2 policy replay, D3 event-derived reporting, fault handling, and executable behavior coverage.
5. A six-player, two-faction civilization slice with legal gathering/crafting/storage/building/combat and material conservation.
6. A frozen baseline, tested stronger-policy candidate, whole-system benchmarks, justified optimization, and fresh-checkout delivery.

## 1. Charter

This document authorizes the implementation campaign, not publication or remote operation. Work in `/Users/josh/d/mc/arena` when executing from this draft-only directory; initialize Git there. If executing inside an existing Arena repository, use it and preserve unrelated work. Do not initialize Git or start implementation during preflight.

- Decide inside the bounds below, append one short decision-log line, and continue. Never ask or wait for approval during execution. Send no check-ins; finish with one report. Continue until every deliverable passes or every remaining item is parked with a concrete blocker and reproduction.
- Hard stops park the affected item: an irreversible or outside-scope action, a forbidden contract boundary, an unavailable legal/artifact prerequisite, or no usable verification loop after three attempts. Continue independent items. Pushing, publishing, spending money, public listeners, cloud provisioning, modifying unrelated saves/accounts, and destructive Git operations are forbidden.
- Implement feature completeness and behavior coverage first. Runtime/size/build budgets are measured before P3 but only the safety ceilings and egregious floors gate earlier work. Do not optimize while a required feature or parity behavior is missing or parked; finish independent feature work, then park optimization that depends on it.
- Fix a baseline failure that blocks the current item, a warm focused check exceeding 120 seconds, or a reproducible same-workload regression above 2 times baseline, in a separate scoped commit. Investigate cause first. Log other unrelated defects and leave them.
- Every bug fix begins with a minimal failing regression. Never weaken assertions, retry a flaky check to green, fabricate outcomes, use administrative combat, inject live inventories, teleport stuck competitors, or hide errors. No formatters.
- Use rolling lanes under the Campaigns section of `orchestrate`. One integrator owns shared contracts, integration, and verification; it writes no feature code while lanes run. Lanes own the largest ready coherent slices and cannot redefine schemas, versions, or another lane's files.
- Reserve **4 GiB peak RSS per build lane**, **8 GiB for the one live integration lane**, and **8 GiB host headroom**. Start with one build to measure actual peak. Width is the smaller of ready disjoint ownership sets, available agent slots, and `floor((available_bytes - 8 GiB - live_reservation) / 4 GiB)`. Reduce width if actual peaks exceed reservations. No simultaneous live servers or timed perf runs with build lanes.
- Before the first working-state write, add `.work/` to `.git/info/exclude` in the implementation repo. Worktrees: `.work/wt/<lane>`; scratch and `TMPDIR`: `.work/tmp`; caches/toolchains/downloads/worlds/traces: `.work/arena/`. There is no `.arena/` or ignored `artifacts/` state outside `.work/`. Cargo, Gradle, JVM, download extraction, and test temp roots use project-local working paths.
- A lane commits only its owned files on `campaign/<lane>`; integration occurs on `campaign/arena`. The integrator reviews, rebases, fast-forwards, and runs the touched-area checks from `.work/wt/verify-<item>` at the merged commit. Remove verification worktrees after checks. After successful integration remove the lane worktree and delete its merged branch with `git branch -d`. Parked lanes commit their checkpoint and remove the worktree, preserving the branch. Only running lanes and active verification own worktrees.
- Campaign execution authorizes local commits. Every commit is `type(scope): imperative lowercase subject`, at most 72 subject characters; item IDs go in the body. Use `!` for contract changes. Preflight makes no commits. Never push. Code comments state local reasons and never cite this plan or other planning documents.
- Keep bookkeeping minimal. Commit compact behavioral fixtures, reports, and these two logs; retain full evidence under `.work/` only while needed. No separate progress tracker, provenance register, ADR collection, or duplicate plan. Hashes are allowed only for artifact integrity, semantic identity, and trace corruption detection used by a reader.

### Failure budget and loop

One attempt is one falsifiable hypothesis followed by its narrow proof. After two refuted hypotheses bisect input/code/environment; after three recheck the actual binary, configuration, version, and first error. Limit an item to **three hypotheses or 90 minutes**, whichever comes first. Park with the cause or unknown, failed command, output, and the smallest reproduction. A dependency on a parked proof stays parked; independent seams may still be implemented. Resume only on new evidence or a changed prerequisite, never to retry the same failing approach.

An item ends on a named test/compiler check; a phase ends on touched-area suites. Full functional suites run only at the P1 completeness milestone and P4 close, because those integrate all product paths. Cold bootstrap is allowed up to 20 minutes per tool build/download step; announce expensive verification in the lane brief/log before starting it. A warm loop must target core/spec named tests ≤5 seconds, Java named tests ≤10 seconds, adapter incremental check ≤30 seconds, and an already-prepared real-server case ≤90 seconds. If a target is missed, P0 first establishes a narrower covering command; above 120 seconds the loop defect blocks work relying on it. Do not run workspace-wide builds merely to check one crate.

## 2. Decisions

### Owner-decided — 2026-10-12

- **Minecraft EULA accepted for these local runs.** The owner explicitly accepted it during preflight. The executor may write local acceptance and pass `--accept-minecraft-eula` for this campaign. Shipped software still requires an operator's explicit acceptance; never enable acceptance by default for other users.
- **Paper download contact authorized:** `dankmeme133769@proton.me`. Use `Arena/0.1 (dankmeme133769@proton.me)` as the identifying User-Agent for this campaign's official Paper requests. Treat contact as operator configuration, not a secret or semantic scenario input; shipped software requires its own operator contact. Do not substitute an upstream project's contact. If contact configuration or artifact access is unavailable at execution, park dependent live proofs and continue independent work.
- **Homebrew installation is permitted when needed.** Honor suitable existing installations first; native repo-local verified toolchains remain preferred. Brew is an authorized fallback for prerequisite tools/JDK, with package/version and host change recorded. Do not use `doas`, root, change global Rust defaults, or install an unrelated package manager. This supersedes the draft's unconditional ban on package-manager use.

### Prescribed

| Decision | Reason; what would reverse it |
|---|---|
| Paper **26.2**, native **JDK 25**, one Java plugin, Rust/Azalea swarm; no proxy or alternate server | One mechanics authority and one client stack; only an explicit future product change permits replacement. |
| Four Rust crates: core, spec, bots, runner; one Java project | Keep pure decisions separate from effects; split further only after a real dependency/compile boundary is demonstrated. |
| Complete Hunger Games and civilization before stronger policy/scaling/LTO/allocator tuning | All required behavior must exist before performance work; only loop repair or egregious/safety fixes move earlier. |
| `versions.lock.toml` is tool/artifact identity authority; typed spec defaults resolve once into canonical IR | Prevent drift; Rust/Java duplicates are intentional and checked by golden fixtures, not independently defaulted. |
| Schema/control/trace versions begin at **1**; unknown fields, enum values, and unsupported versions fail | No historical consumers exist; no migration or compatibility shim is needed. Revisit only with proven persisted consumers. |
| Plugin is sole match/outcome authority; runner supervises and reconstructs reports | Two authorities can disagree; change only with a replacement design and mechanics proof. |
| Disconnect after countdown starts eliminates immediately at that tick's terminal-resolution boundary; no replacement/competitive reconnect | Bounded, testable roster contract. Before countdown, release an unready human seat and wait again. |
| `play` claims slot 0 for first eligible local non-bot, requires `/arena ready`, then starts with five bots | Prevent an absent human from silently becoming a bot. Later joins are spectators; waiting expires after 300 seconds with an abort. |
| Protocol play is automatic acceptance; actual GUI/Metal checks are separately marked unverified if unavailable | Automation can verify seats/actions, not visual presentation. Never claim graphical or Metal verification from a headless client. |
| Full state is evaluator-only; per-client knowledge and faction entitlements govern every policy/skill/cache query | Azalea shared storage is not an authorization boundary. Live noninterference proof is mandatory before fair-match claims. |
| Strict owned-root path policy, fresh run directories, no hard links to snapshots | Avoid corrupting pristine worlds or escaping the repo. Revisit only with equivalent atomic/confinement tests. |

### Delegated within bounds

The executor chooses internal names/private type layout, native toolchain builds, legal loot tables, symmetric map geometry, and a minimal PRNG/JSON/CLI implementation. Tie-break: reuse an accepted maintained dependency at its boundary, otherwise prefer the smallest standard-library solution. Use private validated constructors, enum variants for lifecycle/skill outcomes, stable seat IDs, explicit tick/byte units, and distinct observation versus evaluator types. No speculative abstractions or new configuration knobs.

The integrator alone admits new dependencies after maintenance, license, transitive-size, standard-library alternative, cold build CPU time, release binary/plugin size, and warm startup/runtime review. Azalea/Bevy/Tokio are accepted at the adapter boundary; no Tokio/Bevy/Azalea types enter core or TOML. One pinned small Java JSON library is allowed. Dependency budgets: warm core/spec checks remain within the loop targets; owned release binary ≤100 MiB; plugin ≤10 MiB; a new dependency adds ≤10% cold-build CPU time and ≤5% warm-start CPU time against the immediately preceding equivalent build, outside observed spread. Before P3 these are recorded targets; safety ceilings still apply. If a required dependency misses them, complete parity, then optimize/remove it in P3; do not silently relax the target. An unresolved final budget parks delivery.

## 3. Baseline and foundation evidence

Preflight on **2026-10-12** found only this draft in `/Users/josh/d/mc`: no `.git`, code, AGENTS.md file, tests, prior failures, or build artifacts. The owner's Working Contract supplied in the session governs the implementation. No claim about an existing implementation is valid. All paths below describe planned files.

Host observed: macOS/Darwin arm64, 10 logical CPUs, 32 GiB physical RAM. `rustc --version`: 1.98.1; `kache`, `jaq`, and `perf-gate-ready` available. `/usr/bin/java` is a launcher stub and reports **no Java runtime**; Gradle is absent. Operational command timings, one invocation each, not performance-gate measurements: `rustc --version` **0.05 s**, failed `java -version` **0.01 s**, immutable upstream protocol-source read **0.20 s**, authorized-User-Agent Paper metadata assertion **0.27 s**. Test/build/startup/replay loops and resource baselines are **unmeasured because no application exists**; P0 must measure them, not invent them.

Primary sources checked:

- Azalea development source declares Minecraft **26.2**, protocol **776**; published docs still identify **0.16.0+mc26.1**. Candidate revision `0bd22cbcdd30b611b112fc1c0a3d78535fd493a1` was read at its immutable protocol source. Its toolchain file uses floating `nightly`; Arena must select a dated nightly and compile it.
- Paper official API returned metadata for stable **26.2 build 133**, including a server download and checksum. The authorized-User-Agent request also passed assertions for nonempty artifact size, SHA-256 field shape, and official download host. No jar was downloaded or checksum verified. This is an availability observation, not a validated lock. API documentation inspected was `26.2.build.130-stable`; do not assume that API build equals the server build.
- Official Paper docs require Java 25 and an identifying User-Agent with a contact URL/email. Official Minecraft release notes document experimental Vulkan and MoltenVK on macOS; visual support was not run here.
- Python's default HTTPS reader failed certificate validation; native `curl` succeeded for the source reads. Use the functioning system trust path; never disable TLS validation or classify a certificate failure as missing upstream support.

**Foundation A, exact-stack interoperability: passed on macOS arm64.** `./arena test --suite integration --case stack` exercised the locked Paper 26.2 build 133, Paper API 26.2.build.133-stable, Azalea revision `0bd22cbcdd30b611b112fc1c0a3d78535fd493a1`, and protocol 776. Two clients completed login, chunk receipt, movement, a two-diamond chest transfer, server-observed swing and damage events, and disconnect; the wrong-protocol control was rejected. The prepared test took 17.34 seconds. Linux x86_64 remains unverified.

**Foundation B, shared-world knowledge isolation: unproven.** P0 must identify receipt ownership in the selected Azalea revision; B1/H1 must test two clients with disjoint chunk/entity visibility and hidden-state perturbations against the real adapter. If internals cannot support a filtered view, implement a focused receipt-tracking adapter/patch within the chosen stack, then prove it. Never label the result fair based only on core mocks.

P0 records baseline known-reds and cold/warm loop timings here, and six-seat RSS/CPU/tick figures once M1 runs. There is no old application to port. The parity reference is the **behavior specified here**, plus ordinary mechanics observed on the locked Paper server with ordinary protocol clients. Keep a compact behavior-to-test table in `docs/acceptance-report.md`; no separate parity tracker. Normalize only timestamps/run IDs and genuinely unordered diagnostic output, never inventories, event order, match outcomes, or decisions.

## 4. Sequence and ownership

Sizes: S ≤ half a lane session; M ≈ one session; L spans sessions with coherent committed checkpoints. A row is one end-to-end capability. F0 has separable skeleton/schema/offline checks and live smoke; if its live proof is parked, only dependents requiring that proof park. Its merged offline seams still unlock independent implementation. Every row owns its implementation tests and section in its area document. Shared manifests, locks, schemas, top-level README/AGENTS, and this plan remain integrator-owned; a lane requests additions. Adjacent ready items in the same ownership set stay in one lane. Broad-suite verification belongs to the integrator; lanes run only named changed tests and the cheapest compiler check.

| Phase / item | Size | Prerequisites | Owned files | Capability and proof |
|---|---|---|---|---|
| **P0 F0 — foundation and loop** | L | none | Integrator: repo skeleton, `arena`, manifests/locks/toolchains, schemas, `tests/integration/stack.rs`, `docs/compatibility.md`, `AGENTS.md` | Resolve exact versions, establish narrow checks, create CI entrypoints, implement minimal real two-client smoke; `./arena test --suite integration --case stack`. |
| **P1 S1 — world/spec capability** | L | F0 canonical IR/schema seam; live proof needed only for integration | `crates/arena-spec/**`, `maps/**`, `scenarios/hunger-six.toml`, `scenarios/duel.toml`, map/spec fixtures, `docs/scenarios.md` | Strict compiler, geometry/reachability contracts, semantic hashing; named spec tests plus `validate`/`build`. |
| **P1 J1 — server authority** | L | F0 control/IR seam; S1 IR for map integration | `server/arena-plugin/**`, Java fixtures/tests, `docs/rules.md` | Generation/setup/snapshot readiness, full match authority, roster/UI/outcomes; Java named tests, then real `maps-reset` and `match-rules` cases. |
| **P1 B1 — real client player** | L | F0 core/adapter seam and stack; S1 minimal route/container fixture; J1 preparation/telemetry for live proof | `crates/arena-core/**`, `crates/arena-bots/**`, policy/observation/skill fixtures, `policies/baseline.toml`, `docs/policies.md` | One legal navigating/looting/eating/equipping/melee client; deterministic policy and receipt isolation; `legal-player` case and named core/adapter tests. |
| **P1 R1 — lifecycle and evidence** | L | F0 control/trace seam and stack; J1 handshake/events for integration | `crates/arena-runner/**`, `tests/integration/lifecycle.rs`, replay/report fixtures, `docs/operations.md`, `docs/determinism.md` | Supervision, safe reset-by-clone, CLI, authoritative logs, D1–D3 replay/report; `lifecycle`, `replay-report`, `doctor`. |
| **P1 M1 — six-seat MVP integration** | M | S1, J1, B1, R1 merged and live proofs passed | Integrator: `tests/acceptance/hunger.rs`, `tests/acceptance/seats.rs`, README, report | Six seeded matches, seat/spectator flow, frozen baseline; `hunger-six` and `play-seats`. Identify verified MVP commit. |
| **P1 C1 — civilization server/spec** | L | M1; F0 civilization IR/rule variants committed | Same S1/J1 streams, serialized within each: civilization map/scenario/Java rules, their tests | Two-faction resource map, capture/scoring, real blueprint/material validation; spec/Java tests then server `civilization-rules`. |
| **P1 C2 — civilization client capability** | L | M1; C1 IR contract (runtime fixture need only at integration) | Same B1 stream: core/bots, `policies/civilization.toml`, team/task fixtures | Gathering/crafting/storage/building, bounded team reports and legal combat; named tests then `civilization-six`. |
| **P1 M2 — completeness milestone** | M | C1, C2 plus M1 merged | Integrator: `tests/acceptance/civilization.rs`, report | Full functional suite, all deliverables 1–5 behavior rows covered, raw six-seat resource baseline. No unresolved parity behavior permits P3. |
| **P2 H1 — hardening** | L | M2 | Same four area streams, same ownership; integrator owns cross-language goldens and acceptance | Malformed inputs, disk-full/interruption, trace truncation, fairness/cache/faction isolation, regression reduction, docs/contracts; affected-area suites and `fairness`, `faults`, `replay-report`. |
| **P3 K1 — stronger policy** | L | H1; frozen baseline and complete parity | Core/bots stream and policy fixtures/profiles; integrator owns experiment acceptance | Cooldowns, aim/spacing/retreat/hysteresis, bounded one-step lookahead only with fixture benefit; curriculum and `policy-compare`. |
| **P3 O1 — measurements and optimization** | L | H1; K1 default policy decision before final comparisons | Runner stream: `benches/**`, runner benchmark module, `docs/performance.md`; any measured adapter fix returns to bots stream | Workload fixtures, scale ladder, profile, remove measured work, compare equivalent builds; `bench` and resource assertions. |
| **P4 Z1 — close and delivery** | L | K1, O1, all functional proofs | Integrator: cleanup across landed tree, README, report, roadmap, CI | Dead-code check, ultrareview/P1/P2 fixes, final full suite, release/size/perf checks, clean-cache and warm-offline acceptance; `fresh-checkout`. |

**Width:** P0 one contract/foundation lane. P1 up to four disjoint area lanes after F0 seams merge, plus one read-only review lane; actual build width follows memory. S1/J1 and B1/R1 may start independent halves once seams exist and integrate their dependent halves later in the same workstream. M1/M2 each one integration lane. Civilization exposes up to three lanes (spec, Java, client) over those same streams. P2 up to four. P3 K1 and benchmark-harness work may run two disjoint lanes, but actual measurements run alone; an optimization touching bots waits for K1 integration. P4 one integrator plus read-only review. No feature writer shares another lane's files.

## 5. Executable acceptance and limits

F0 implements the selectors below; these are **required future commands, not existing commands**. `./arena test --suite <integration|acceptance> --case <name>` selects one case exactly, rejects unknown names, prints evidence location, and returns nonzero on failed/blocked required checks. `--suite all` runs all functional cases, excluding benchmarks, cold bootstrap, and unavailable GUI/other-host checks. Core loop: `cargo test --locked -p arena-core <fully-qualified-test> -- --exact`; the selector must resolve to exactly one executed test, never zero; spec equivalent; Java loop: `./gradlew --no-daemon test --tests <Class.method>` from the plugin directory. Named crate tests must not pull in server/network dependencies.

| Deliverable / case | Required observable proof |
|---|---|
| D1 / `stack` | Locked Cargo/Java build, two real protocol clients, login/configuration/chunks/move/chest transfer/ordinary server-observed hit/disconnect on exact versions. Wrong-version negative control must fail. |
| D1,D4 / `lifecycle` | Ten start/stop cycles, no owned descendants/sockets/locks left; occupied port, bad token/version/frame, controller loss, server crash, Ctrl-C, second owner, wrong plugin identity, truthful interrupted result. |
| D2 / `maps-reset` | Three independent prepares/resets yield identical canonical IR and semantic world state; six reachable loot routes, changed parameter changes intended content, chunk/negative-coordinate boundaries; no old inventories/deaths. |
| D3 / `legal-player` | Real obstacle navigation, chest transfer, equipment, food use, melee damage and knockback; inventory conservation from server state. Intent/packet-only assertions fail this case. |
| D2,D3 / `match-rules` | Normal win, same-tick zero-survivor draw, border death, disconnect, timeout, abort, spectator, duplicate identity, eliminated reconnect, restart; actual two-bot duel and independently reconstructed result. |
| D3 / `hunger-six` | Six declared seeds `481516..481521`; every match terminates, each bot performs useful movement or is legitimately eliminated before opportunity, at least one legal loot and hit per match, no infinite stuck loop. At least one match has one survivor and at least two distinct ordinary PvP engagements. Only border deaths/timeouts cannot pass. |
| D3 / `play-seats` | Five bots + automated human-protocol seat, explicit ready/start, reserved-seat wait/abort, extra spectator isolation, human death-to-spectator/result. README contains real GUI join flow; GUI/Metal remain separately marked performed or unverified. |
| D4 / `replay-report` | D2 identical decisions on three replays per recorded run; D3 independent report reconstruction matches outcome. Timestamp/verbosity perturbation unchanged; truncated/schema-mismatched trace fails; D1 semantic equality is checked separately. |
| D4 / `faults` | Disk-full, critical/optional queue saturation, partial initialization, signal cancellation, symlink swap/traversal, non-UTF-8 paths, stale lease, atomic-write interruption and corrupt cache; valid state or explicit invalid outcome after restart, no escaped writes or orphan resources. |
| D4 / `fairness` | Hidden enemy/loot perturbation and two-client disjoint receipt live test; same permitted inputs produce same decisions; spectator/evaluator/shared-cache/faction data do not leak. Deliberately injecting hidden state must make the test fail. |
| D5 / `civilization-rules`, `civilization-six` | Six clients, both factions useful, real log→drop→craft→chest→placed outpost chain with material conservation; legal capture/ownership change/combat and pre-countdown human substitution into slot 0 through `play`; cancellation, cargo death, contention, stale plans/unobtainable materials, route invalidation. |
| D6 / `policy-compare` | Curriculum passes; 12 development seeds then 24 held-out seeds, each with swapped duel positions (48 held-out duels). Primary metric: candidate wins + half draws. Default switches only if the paired bootstrap 95% lower bound of improvement over 50% exceeds zero and no behavior regresses; otherwise baseline remains default and candidate is unproven. Report arena results on six fixed seeds separately. |
| D6 / `bench` | Correct equivalent workloads, actual activity and alive count, whole-process CPU/RSS/network/tick/latency, guarded scale rungs and same-workload A/B evidence. Maximum completed rung and overload failure are explicit, not a 256 promise. |
| D1–D6 / `fresh-checkout` | All functional suite after merge and close; native-host clean-checkout build/run from an empty project-local cache, cached offline run/replay, final owned release binary/plugin sizes, no secrets/jars/worlds in Git, no orphans, reports and commands actually reproduce. |

Development/held-out seed sets live in one experiment fixture owned by the integrator, fixed before candidate tuning. K1 may inspect development seeds; held-out results are opened only once the candidate is frozen. Bootstrap resampling is deterministic, paired by seed/position, 10,000 draws; absent supported improvement is an honest outcome and does not authorize more tuning on held-out seeds.

### Runtime safety ceilings (resolved once by runner)

| Resource | Default and breach behavior |
|---|---|
| Normal roster / test bench | Exactly 6 competitors in shipped scenarios; 4 spectators. Bench count is explicit fixture input, ≤256 and ≤`--max-bots`; the flag is only a ceiling, never a hidden scenario-roster override. |
| JVM / combined run | `-Xms512m -Xmx2g` initially. Paper+Arena combined RSS ≤8 GiB; larger benchmark requires explicit within-host budget, never above 50% physical RAM. Stop/abort before further escalation on breach or swapping. |
| CPU workers / paths | Initial CPU-heavy worker cap `max(1,min(4,logical_cpus-2))`; one pending path per bot; global active path searches ≤worker cap; 2,048 expansions per slice. No extra pool until justified. |
| Files/downloads | Per download ≤512 MiB; dependency/bootstrap total ≤8 GiB; total `.work/arena` ≤16 GiB; require ≥4 GiB free before prepare. Exhaustion parks new preparation/downloads, never deletes evidence silently. |
| Runs/traces | At most 10 retained full runs; one run trace ≤256 MiB; segment ≤8 MiB; checkpoint every 200 observation records. At cap finalize invalid if required records cannot fit. Explicit `gc --dry-run` then `gc --apply` may delete only selected owned terminal runs, retaining latest three failures. |
| Frames/queues | Control frame ≤1 MiB, JSON nesting ≤32, incoming command queue 128, critical event queue 4,096, optional metric queue 1,024. Reject command overflow; optional drops counted; critical loss sets invalid/abort, never blocks tick thread. |
| Deadlines | Cold prepare/start ≤180 s; normal ready ≤60 s; human wait ≤300 s; bot operation synchronization ≤100 ticks; skill no-progress ≤100 ticks then two legal replans, fail by 300 ticks. |
| Liveness/shutdown | Heartbeat each 1 s, lease loss at 5 s; plugin aborts and initiates stop. Supervisor graceful stop ≤15 s, owned kill/reap ≤5 s more; no unrelated process killing. |
| Wall duration | Hunger run ≤600 s including waiting; civilization ≤1,200 s; each benchmark sample ≤300 s plus 60 s warmup. Operational timeout is **aborted**, never a tick-limit draw or winner. |
| World bounds | MVP 128×128; civilization 192×192; loaded-generation halo is configured view distance (6 chunks initially); pregeneration ≤1,024 chunks at ≤4 requested concurrently. Benchmark fixture may enlarge within stated disk/RSS limits. |
| Perception / team | 40-block entity range, 120° horizontal/90° vertical FOV, voxel line-of-sight; reaction 4 ticks, aim ≤30° yaw/15° pitch per tick; entity memory expires 100 ticks, stale remembered terrain remains last-observed. Team message ≤1 KiB, ≤1 per sender/20 ticks, queue 16 per receiver, age ≤200 ticks; same-faction recipients only. |

Limits may be tightened automatically for lower memory/disk. Do not increase safety ceilings or weaken fair perception to pass a check. Configuration precedence is explicit CLI > environment > scenario > typed defaults, validated once; legal acceptance and contact remain operator inputs, not scenario fields.

**Performance gates:** time-based budgets/claims run only when `perf-gate-ready` exits 0 immediately beforehand and `perf-gate-ready -1` exits 0 immediately afterward. Overlap discards the sample. If unavailable/busy, defer it, continue functional work, and record **“perf gate deferred: host busy”**; do not call delivery complete. Memory/binary-size checks always run. Profile separately from reported measurements. For A/B use at least five alternating samples per side, same release build settings/versions/workload, 60 s warmup and 120 s measurement. Report CPU-time minimum, median/range, wall latency tails, failures and actual work; treat a regression as established only above both 10% and observed spread. Six-player final target: 20 TPS, server simulation p95 ≤50 ms and p99 ≤100 ms over that window, no routine disconnects or stuck loops. If pinned APIs cannot measure simulation duration, mark that metric unverified; wall repeating-task intervals cannot substitute. Run release builds only in P3 performance work and P4 final verification.

## 6. Contract changes and non-goals

Pre-authorized: new Arena CLI/types/schema-v1/wire-v1/trace-v1 and their documented errors; strict input rejection; the exact roster/disconnect/grace/capture/perception rules in this doc; owned cache/run writes, authenticated loopback control, local offline identities; scoped Azalea fixes after failing regression; dependency selection inside the stated policy; deletion of demonstrably dead new code; local campaign commits and removal of integrated lane worktrees. Implement code, tests, examples, and docs together. List each public/API/schema/permission/invariant/transaction change in the acceptance report.

Forbidden: alternate Minecraft version/stack/protocol proxy, public/off-host load, world/admin queries feeding policies, live administrative kills/items/teleports, authentication bypass, inferred EULA/contact acceptance, deleting user artifacts or force-removing dirty trees, changing old saved-data semantics, destructive Git resets, paid/remote CI provisioning, autonomous pushes. Package installation is limited to the owner-authorized Brew prerequisites or repo-local artifacts.

Non-goals: full survival parity for Hunger Games (building/breaking disabled equally), expert-human certification, D4 bit-identical asynchronous live trajectory, graphical world replay, renewable civilization economy, unbounded persistent campaigns, learned/LLM policies, general terrain/template language, new rendering client, browser dashboard/MCP, separate civilization backend, multiple ECS/network stacks. Do not add SoulFire, Mineflayer, Baritone, Carpet, Terra, WorldPainter, Folia, Hyperion, Pumpkin, ViaVersion/Proxy, Redis, Kafka, or Kubernetes. Roadmap describes later tracks; it authorizes no implementation.

## 7. Reference: executable design

### Repository and module boundaries

```text
arena/
  arena  README.md  AGENTS.md  Cargo.toml  Cargo.lock
  rust-toolchain.toml  versions.lock.toml  .cargo/config.toml
  crates/{arena-core,arena-spec,arena-bots,arena-runner}/
  server/arena-plugin/          # source, tests, plugin.yml, pinned Gradle wrapper
  schemas/{scenario,map,control,trace}.schema.json
  scenarios/{hunger-six,duel,civilization-six}.toml
  maps/{hunger-six,duel,civilization-six}.toml  maps/prefabs/
  policies/{baseline,competitive,civilization}.toml
  fixtures/{protocol,observations,maps,regressions,experiments}/
  tests/{integration,acceptance}/  benches/
  docs/{architecture,compatibility,scenarios,rules,policies,operations,
        determinism,fairness,performance,macos-client,acceptance-report,roadmap}.md
  .github/workflows/
  .work/                       # excluded locally, all disposable working state
```

`arena-core`: policy, observation/memory/intents, PRNG, geometry, outcome evaluation, no runtime/IO. `arena-spec -> arena-core`: strict parse/validated compiler and canonical IR. `arena-bots -> arena-core`: per-client receipt/perception and Azalea skills, never spec/evaluator world access. `arena-runner -> spec/bots/core`: CLI, lifecycle, recording/report/bench. Java independently consumes golden-tested wire/IR and owns authoritative world rules. The evaluator's full-state types stay in runner/plugin, absent from the policy API. Build offline core alone to enforce the boundary.

Policy interface: `decide(&AgentObservation, &PolicyMemory, &PolicyParams, &mut DeterministicRandom) -> Decision`; the return holds new memory and goal/intent, not tasks/world handles. Observation unknown/stale/observed states and skill pending/progress/succeeded/failed/cancelled are enums with valid payloads. Seat IDs remain stable across usernames. Slots 0–5 are bots in run; slot 0 human and 1–5 bots in play. A spectator has no competitive seat.

### Locked compatibility and bootstrap

F0 selects a full Azalea revision supporting 26.2/776 from source, then compiles its exact examples with a dated nightly. Candidate source reads are not pins. Select an official stable Paper 26.2 build, exact available Paper API coordinate, native JDK 25 distribution/build and compatible exact Gradle wrapper. Match API/server build if available; otherwise compile/smoke the available API against that server and record the difference. No floating `main`, `nightly`, `build.+`, invented SHAs/checksums, default latest-server upgrade, or protocol downgrade.

Commit Cargo lock, versions lock, Gradle dependency locks/verification metadata, wrapper checksum, dated Rust toolchain. Downloads use official URLs, valid operator User-Agent, TLS verification and hash checks. A supplied Paper jar requires official-version/hash evidence before executing; absent verified metadata parks it. Cache verified artifacts once; cached warm runs operate offline. Docs record actual protocol/server/API/revision/toolchain/host support and proof commands. Use native macOS arm64 and Linux x86_64; Linux arm64 is future feasibility, not a claimed supported target without a build/run. A missing second host leaves its checks unverified, not silently passed.

`./arena` is a thin POSIX entrypoint locating/building the locked binary. Rust builds use `kache`; Linux musl links with `mold` when that target is tested. Respect network/proxy environment. No global Rust-default changes. CI starts with offline core/spec, distinct Java/protocol jobs and prerequisite-controlled real-server jobs; heavy acceptance/bench explicit/manual. Pin action/tool versions from real sources; failed/missing required prerequisites fail the job. No formatter job or recurring paid cloud task. Add fixed-seed property cases at owning boundaries for geometry/transforms, strict validation, stream isolation, inventory conservation, terminal states and reconstruction. Bounded parser/control/trace fuzz cases cover one-byte reads, repeated fields, lengths/oversized integers, non-finite floats, unknown versions, traversal and truncation; keep per-case development runs within the narrow loop. Every claim must have an oracle assertion that fails under a deliberate wrong output, not just a call or a generated fixture echoed back.

### Scenario and deterministic world

The public scenario shape below is schema 1. Resolve paths relative to the declaring file; map/policy inputs must remain within canonical repo roots. Unknown fields fail with source location. No executable snippets, eval, dynamic imports, recursive includes, or general expression language.

```toml
schema = 1
name = "hunger-six"
mode = "hunger_games"
seed = 481516
map = "../maps/hunger-six.toml"
policy = "../policies/baseline.toml"

[roster]
competitors = 6
human_seats_in_play_mode = 1
spectator_capacity = 4

[server]
minecraft = "26.2"
view_distance_chunks = 6
simulation_distance_chunks = 5
max_tick_rate = 20

[match]
countdown_ticks = 100
grace_ticks = 200
authoritative_max_ticks = 7200
respawn = false
block_breaking = false
block_placing = false
natural_mobs = false
natural_random_ticks = false

[border]
initial_diameter_blocks = 126
shrink_start_tick = 1200
shrink_end_tick = 6000
final_diameter_blocks = 16

[bots]
strategy_interval_ticks = 4
path_expansions_per_slice = 2048
max_pending_paths_per_bot = 1
perception = "competitive-v1"

[record]
mode = "evaluation"
policy_replay = true
world_outcomes = true
```

The renamed `authoritative_max_ticks` makes the tick budget distinct from wall timeout; update all examples, schema, parsers and tests. Defaults have one typed Rust owner; Java consumes fully resolved values. Canonical compilation emits immutable scenario/map IR, roster and report; machine paths/secrets/wall times do not enter semantic identity. Parameter profiles select a registered Rust policy and validated versioned parameters, not arbitrary code. Policy identity includes code and parameter identity.

Map is 128×128 safe floor, modest height/cover/landmarks/open fights, six central-ring spawns, central loot and alternate routes. Avoid initially untested water/ladder/door/partial-block/deep-cave routes. Bounded cuboid/fill, wall/hollow box, path/ramp, spawn group, loot container, translated/right-angle prefab and seeded cover/loot variation suffice. Rust resolves all PRNG decisions to chunk palettes/runs and setup records; Java never repeats the generation RNG or runs per-block RCON.

Paper public `ChunkGenerator` consumes immutable order-independent IR on generation workers; mutable containers/block entities/gamerules are setup on the server thread. Disable unrelated vanilla phases. Validate spawn support/headroom/separation, traversable central/loot routes, valid inventories/chunk boundaries/negative division, fair starting access and reachable final border zone. Pregenerate area plus view-distance halo, finish lighting/setup/readiness, save and stop cleanly before snapshot. Prevent portals/spectators from unbounded generation; outside arena is deterministic cheap terrain.

Semantic world hashes cover relevant blocks, block entities/inventories, declared rules; volatile Minecraft serialization is excluded. Snapshot file-integrity hashes are separate. Reset is reflink/copy of stopped pristine world into a fresh owned directory, never mutable hard links/live copies. Reset player inventories/advancements/statistics/deaths. No live desired-state repair of destroyed structures.

### Ownership, protocol, durable state and errors

One Arena process owns the swarm and one Paper JVM; graphical human play adds the user's own client, excluded from bot benchmarks. Supervisor owns children/pipes/sockets/locks/run directories/deadlines and drains output continuously. Readiness is a versioned authenticated plugin handshake after prepared-world verification, never a fixed sleep. Runner listens on ephemeral loopback control port; plugin connects with protected per-run secret. Game port defaults to loopback 25565 for play, ephemeral for tests; occupied ports fail without killing another owner. Disable unrelated remote listeners. Bots are non-operator offline identities on private loopback only.

Control frames: 4-byte big-endian byte length followed by UTF-8 JSON, protocol/run/sequence/type/correlation fields, authenticated handshake and explicit capabilities. Rust control/schema is authority; Java DTOs are mirrored with cross-language golden positive/negative fixtures. Families: readiness/build progress, prepare/start/abort/finish, public clock/state, outcomes, metrics, ack/errors. No command executor/full world-query policy API. Reject malformed/oversize/stale-run/duplicate sequence/unauthorized input before mutation; Each direction has its own strictly increasing sequence. Response correlation echoes the initiating request sequence, not a separate retry key. Commands execute once on the server thread; duplicate/out-of-order sequences are protocol errors and no control command is retransmitted under a new sequence. There is no response cache or application-command retry. A lost acknowledgment times out and aborts; lost connection aborts rather than reconnecting/replaying commands.

A server task resolves all deaths/disconnects at end of tick before terminal evaluation. Network tasks queue immutable commands/events, never call unsafe async world APIs or block tick thread on disk/network. Critical queue overflow marks evidence invalid and schedules abort; optional metrics may drop with counts. The critical writer owns sequence and bounded buffers; errors retain their cause and invalidate evaluation.

Graceful shutdown: stop accepting work, cancel/release skills, disconnect clients, request save/stop, drain/finalize files, reap JVM, release run lock. Plugin control-lease loss ends the match and stops the owned server. Forced termination targets only owned descendants after grace. Restart never resumes an interrupted competition; orphaned staging/run state becomes interrupted/invalid with diagnosis.

Run manifest is created once, versioned, and records effective config/code dirty status/versions. Sequential critical events, confirmed client state and policy inputs are separate streams; sending an attack is not a hit/ack. Correlate only evidence that actually supports it. Trace segments carry schema, sequence range, checksum, and completion trailer; missing trailer/truncated segment rejects replay. Terminal result writes to same-directory temp, fsync, atomic rename and parent sync; it is published only after required events finish. Event-derived report is canonical outcome; terminal summary is a derived index validated against it. One locked owner writes; readers see completed segments or explicit incompleteness.

Reject unsupported old/new schema versions, no fallback writer. Retry only classified transient downloads up to three attempts (1/2/4-second backoff), validate complete file before atomic publication; no gameplay retries beyond skill budget. CLI boundary maps errors once: 0 success, 2 invalid input/config, 3 missing prerequisite/version, 4 owner/port conflict, 5 corrupt/incomplete evidence, 6 timeout/runtime failure, 130 cancellation. JSON error contains category, resource and structured source; never secrets. Legitimate completed game draws/timeouts return 0; operational aborts return 6.

Owned writes/deletes reject symlinks and traversal at each component, use handle-relative/atomic operations where races exist, reject special files, preserve raw OS paths without lossy conversion. Input map/policy symlinks may be followed only if canonical target remains in allowed repo roots. Copy fallbacks preserve semantics and are real-filesystem tested. GC cannot touch active runs, pristine snapshots, failed-run retention, or unrelated paths; dry-run lists exact selected terminal paths. Chat/sign/book text is data, never shell instructions.

### Match and civilization rules

Lifecycle: preparing→waiting→countdown→grace→active→finished; any nonterminal state may abort. Match tick 0 is release after countdown; grace occupies ticks 0..199, PvP begins at tick 200. Tick limit checks after all outcomes for its tick. Border diameter linearly interpolates by authoritative ticks 1200..6000, initial 126/final 16. No wall-time border transition masquerades as tick scheduling. One survivor wins, zero same-tick survivors draw, multiple at tick 7200 draw/timeout; operational abort is separate. Freeze/place/reset before release equally for all seats. Normal hunger/food/armor/cooldowns/reach/knockback/drops remain real; building/breaking disabled equally for Hunger Games. Spectators cannot damage/loot/compete/serve as targets or leak observations. Non-operator status/ready and scoped spectator controls, scoreboard/bossbar/chat for countdown/remaining/border/result.

Civilization reuses runtime, clients, recording, policy boundary and world compiler. Map 192×192, mirrored bases/resources and two factions of three, equal declared food/tool starting kits, ordinary trees/drops/crafting/chests and neutral capture zone. Roles: gatherer/crafter, builder, defender/scout. Grace 2,400 ticks, no respawn, max 18,000 ticks. Breaking/placing enabled equally; no privileged resource actions. Capture requires 200 uncontested tick increments after grace without the capturing faction leaving; contested ticks pause the accumulated counter, absence of the capturing faction resets unfinished progress, and uncontested opposition begins its own counter from zero. Existing ownership persists until capture completes; owner scores one point each end-of-tick, including completion tick. Opponent elimination wins; both wiped same tick draw; otherwise points at limit decide or draw on equality.

Blueprint: survival-placed 3×3 plank platform plus two 3-high plank corner pillars, 15 plank blocks total, with pillars starting above the platform at opposite corners and a reachable placement order; gather at least four logs and craft 16 planks through real recipe/inventory operations. All placement consumes actual inventory. Blueprint location must cover a small reachable observation/defense position without trapping a spawn. Verify drop collection, legal crafting, real chest deposit/withdraw and structure server-side; reservations are plans until confirmed. Death/cancellation releases task plans, not physical material. Finite food is labeled finite, no self-sustaining-economy claim. Team reports carry sender/observation tick and stale status; faction entitlements apply to all caches. Structure changes invalidate affected routes. In `play`, reserve faction A slot 0 for the human before countdown through the same ready flow; never replace a competitor once countdown starts.

### Skills, fairness and replay

Policy→bounded cancellable skill→Azalea adapter→normal packets. Skills: navigate, aim, open/loot, select/equip, eat, approach/retreat, melee; civilization adds mine/drop-collect/craft/storage/place. Preconditions/progress/success/failure/timeout are explicit. Arbitration owns movement/aim/inventory/hand resources; cancelling releases controls and waits for inventory synchronization. Use confirmed window state IDs/slot maps/equipment/food-use duration/cooldowns/corrections/knockback. No completion merely on packet send, no anti-knockback or movement behavior suppression to hide a bug.

Baseline prioritizes border escape, safe hunger recovery, equip, favorable visible fight, retreat, useful loot, bounded search. Stable tie-breaks/hysteresis avoid thrashing. Per-client received-chunk/entity tracking and visibility filtering feed navigation AND policy/skill queries; a shared pathfinder cannot query globally known unseen terrain. Receipt histories update knowledge only from that client or explicit permitted team messages. Unopened loot/enemy exact health/inventory/map seed/future events/privileged annotations remain unknown. Bounded opponent memory is last-observed, not magically refreshed. Evaluator has separate full-state data and types. An unrestricted diagnostic perception is a different workload, never a fair policy result.

D1: identical canonical IR and semantic starting state for same source/config/seed/locks. D2: identical decision outputs for normalized recorded observations, memory, RNG, and recorded skill/path results. D3: identical event-derived statistics/result. D4 exact asynchronous live trajectories is not promised. Named pinned PRNG with reference vectors; independent seat/purpose streams for policy/search/setup, unaffected by spectators/logging. Stable order/fixed scores; physics float handling explicit. Client tick/public server tick/observation sequence/age recorded; not a global atomic snapshot. Tick-sensitive ECS scheduling follows locked Azalea docs, never arbitrary Tokio tasks reading mutable client state. Upstream nondeterministic live paths are recorded inputs to D2; deterministic fixture navigation does not prove live path replay. Cross-architecture D2 is claimed only after actual replay on both supported hosts.

Stronger-policy curriculum covers navigation, chest contention, equipment disparity, low-health retreat, eating under threat, wall occlusion, target loss, edge knockback, behind approach, border escape and two targets. Improve cooldown/aim/equipment/spacing/cover/retreat/hysteresis with inspectable logic; bounded one-step utility lookahead only after fixture evidence. Never call a policy expert without expert-human evaluation. Freeze the simple baseline and version every tested candidate.

### Benchmark, cleanup and delivery

Separate idle connections; active navigation/container; repeated active duel/team-combat soak; elimination matches with alive population; dispersed civilization resource/building. A respawning soak is explicitly a different workload. Bench command is `./arena bench --workload active-combat --counts 6,16,32,64,128,256 --max-bots 256`; generated fixtures declare their roster/map/rules, never mutate shipped six-seat TOML silently. Start at six; escalate only after one rung succeeds. Each scale rung uses three samples; whole bench command wall budget is 60 minutes and its deadline returns the highest completed rung. Five alternating samples per side are reserved for the required same-workload A/B comparison, which may use a separate 60-minute command. A benchmark deadline reached between rungs is an honest bounded result; a timed-out sample is not a pass. Stop if combined RSS exceeds limit, free memory falls below 4 GiB, swapping appears, disconnects exceed 1%, or TPS <15 for 10 seconds. Highest completed rung and limiting resource are the result; 256 need not succeed. Warmup/measurement/activity assertions apply to each rung.

Record host/cores/RAM/config/version/build/scenario/policy semantic IDs, actual thread counts, instrumentation, CPU core-seconds, summed RSS (not unique physical memory), JVM heap separately, bandwidth/packets, tick simulation percentiles where genuinely available, path expansions/backlog, decision/skill latency, corrections/stuck/reconnect/failure counts and log size. Human GUI CPU/GPU is separate. Sample optional metrics without perturbing policy inputs; measure instrumentation overhead separately.

Profile before optimizing. Remove redundant work/copies/serialization/searches; add spatial indexes/caches only for measured dominant operations with knowledge-safe invalidation. Default remains portable headless, no display/GPU/assets per bot. Keep necessary physics/network/inventory. Generic packet-event cloning/feature trimming, thread/GC/allocator changes, LTO/native/PGO are P3 experiments; do not strip receipt tracking to save time. A focused upstream patch needs a retained regression and license/attribution; no whole-stack rewrite. If no safe measured opportunity exists, report why no optimization was justified.

Z1 deletes temporary instruments/dead paths after checking callers, configs, docs and persisted evidence consumers. Keep the frozen baseline as a live evaluation reference. Run `ultrareview` over implementation, fix P1/P2 findings with narrow regressions then recheck touched areas. Read its explicit-only skill from the installed skill path at execution; if unavailable, perform equivalent independent API/type/durable/lifecycle/fairness/verification reviews using available agents and record that substitution. No cleanup before liveness evidence, no compatibility shims without consumers.

README begins with actual `doctor`, `bootstrap`, `validate`, `build`, `run`, `play` commands and expected results; then exact tests/bench commands. Required tools also include `replay-policy`, `report`, `inspect`, `compare`, `gc --dry-run|--apply`, usable help, JSON errors and documented exit codes. Print concrete created run paths for subsequent commands; never leave `RUN_ID` as purported runnable evidence. Fresh acceptance uses a clean checkout under `.work/wt/fresh`, its own `.work/` cache and TMPDIR, then warm offline operation. Do not commit jars, secrets, enormous worlds/caches/traces. Selected compact evidence lives in fixtures/reports for future readers; full disposable evidence is referenced as local, not promised to survive checkout.

`docs/acceptance-report.md` lists exact verified commits, versions/host, each item passed/failed/parked with command and evidence, all contract changes, real six-bot outcome and human join command, reset/replay/isolation results, policy comparison sample/uncertainty, whole-system measurements/rungs, civilization conservation/build/combat proof, GUI/Metal/other-host status, known defects/reproductions and remaining prerequisites. `docs/macos-client.md` documents ordinary Java 26.2 profile/localhost flow and GUI checklist (ready/countdown, inventory, damage, bot presentation, elimination/spectator, border/result, exit), experimental Vulkan/MoltenVK-to-Metal and F3/log backend confirmation; never claims a renderer run from documentation. No bundled renderer/mod pack.

`docs/roadmap.md` is grounded in delivered measurements: competitive movement/ranged/shields/terrain/tactics and human calibration; renewable economy/logistics/persistent faction depth; measured active-player bottlenecks before alternative engines/workers; optional learned goals with budgets/cancellation/evaluation; strict scheduling/barriers only after D1–D3. Finish this campaign before implementing roadmap tracks.

### Primary sources

Use exact locked source/API for implementation. Mutable links below are research entry points, not reproducible version locks.

- [Azalea development README](https://github.com/azalea-rs/azalea), [candidate protocol source](https://github.com/azalea-rs/azalea/blob/0bd22cbcdd30b611b112fc1c0a3d78535fd493a1/azalea-protocol/src/packets/mod.rs), [workspace](https://raw.githubusercontent.com/azalea-rs/azalea/main/Cargo.toml), [feature graph](https://raw.githubusercontent.com/azalea-rs/azalea/main/azalea/Cargo.toml), [toolchain](https://raw.githubusercontent.com/azalea-rs/azalea/main/rust-toolchain.toml).
- [Published Azalea API and scheduling cautions](https://docs.rs/azalea/latest/azalea/), [performance](https://azalea.rs/azalea/_docs/performance/index.html), [swarm](https://azalea.rs/azalea/swarm/index.html), [pathfinder](https://azalea.rs/azalea/pathfinder/index.html).
- [Paper Java requirements](https://docs.papermc.io/paper/getting-started/), [plugin setup](https://docs.papermc.io/paper/dev/project-setup/), [official downloads requirements](https://docs.papermc.io/misc/downloads-service/), [26.2 generator API](https://jd.papermc.io/paper/26.2/org/bukkit/generator/ChunkGenerator.html), [Folia scope](https://docs.papermc.io/folia/faq/).
- [Minecraft Java 26.2 release and renderer notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-2).

## 8. Decision log

Append one line per execution judgment that a reader would otherwise miss: date, item, decision and reason. Owner decisions and prescribed choices above are already recorded; do not duplicate them here.

- 2026-10-12 — P1: start independent S1, B1, and R1 offline halves after the F0 workspace/schema seam merged, because these paths can progress without the still-pending live stack proof; defer their proof-dependent integrations.
- 2026-10-12 — P1: admit parse-only `toml_edit`, `serde`, `serde_json`, and `sha2` for source-aware TOML validation, strict JSON evidence, and SHA-256 identity/checksums; all versions were already locked, so the graph adds no package versions; record release-size and startup budgets for P3 because this offline slice forbids release builds.
- 2026-10-12 — P1: use the already locked Gson 2.14.0 for strict streaming reads of resolved world plans; declare it directly for compilation and Java test runtime, with no package version added to the graph.
- 2026-10-12 — F0: check in the generated Gradle 9.6.1 wrapper, pin its JAR hash in `versions.lock.toml`, and verify its URL and distribution checksum against that authority before use; require strict dependency verification with the committed lock and metadata.
- 2026-10-12 — P0: reserve the live stack smoke for one lane after the wrapper build and all offline P1 slices finish; keep other builds idle while the server is running.
- 2026-10-12 — P0: use Azalea's dedicated tick broadcaster after buffered client ticks let the smoke exit before its attack reached Paper; the rerun passed every stack marker and wrong-protocol control.
- 2026-10-12 — P1: stage the resolved map plan before Paper starts so its generator can read it during world loading; reserve control frames for scenario rules and roster metadata. Admit JUnit Jupiter 6.1.3 for named Java tests as test-only dependencies.
- 2026-10-12 — P1: cap each chest inventory at 27 one-item entries in the map and resolved-plan contracts because one entry occupies one of the chest's 27 slots; the Rust compiler owns the limit and a drift test checks both schemas and the user-facing docs.
- 2026-10-12 — P1: cap resolved world-plan JSON at 128 MiB and pregeneration at 8,192 chunks to bound staging, parsing, and startup while covering the declared 192×192 map and 32-chunk view distance.

## 9. Campaign log

Append one line per phase end: date, merged checkpoint, checks passed, parked items and reason. No continuous progress diary. A blocked milestone is explicitly blocked, never a passed gate with prose caveats.

## 10. For the owner afterwards

- Read README for exact bootstrap/run/play commands and acceptance report for tested versus parked claims.
- Read contract changes, policy comparison, performance results, GUI/platform limitations, and roadmap.
- Inspect/cherry-pick coherent commits from `campaign/arena`; parked lane branches are named in the report. Nothing awaits owner approval to finish local execution.
- Launch prompt: **Execute `minecraft-arena-agent-campaign.md` unattended, starting at F0; honor its owner decisions, complete independent work, park blocked proofs, and never push.**
