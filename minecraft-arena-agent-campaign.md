# Arena: unattended Minecraft implementation campaign

**Status: campaign execution continues.** Frozen M1 and current-source legal-player and six-seed rechecks pass. Civilization startup fixes are merged, but the latest `civilization-rules` run (`b7e91e9e`) timed out waiting for a client to observe a mined block; cleanup succeeded. C1, C2, M2, H1, K1, O1, and Z1 remain pending. New owner-directed work adds a TypeScript toolchain migration and replaces the synthetic Hunger map with a seeded 1024×1024 natural world, varied opening styles, and a headless strategy/effect report. The live failure and next diagnostic are summarized in the acceptance report.

**Goal:** one command starts a real local six-competitor Minecraft world with independently controlled headless bots, plus a small resource-producing two-faction scenario. Scripted policies need no LLM, API key, GPU, graphical bot process, or paid bot accounts. Hundreds of active players and expert-human skill remain measured future objectives.

**Deliverables**

1. Locked Paper 26.1.2 candidate / JDK 25 / Mineflayer stack and a Node.js 26.8.2 TypeScript local supervisor. pnpm is the only package authority; TypeScript 7, Oxlint with `oxlint-tsgolint`, and Effect 4 own their assigned layers. The exact Paper build and Mineflayer dependency graph are selected and tested at P0.
2. Strict declarative maps, semantic starting-state determinism, safe pristine resets, and six-seat Hunger Games rules on seeded 1024×1024 vanilla terrain.
3. Six-bot `run`, automated spectator and seat isolation, real movement/looting/combat, fair observations, and authoritative results.
4. D1 build determinism, D2 policy replay, D3 event-derived reporting, fault handling, and executable behavior coverage.
5. A six-player, two-faction civilization slice with legal gathering/crafting/storage/building/combat and material conservation.
6. A frozen baseline, a stronger policy with demonstrated procedural competence, whole-system benchmarks, justified optimization, and fresh-checkout delivery.
7. Deterministic, seat-balanced opening personalities and a headless per-seat report of strategy, goals, observed opportunities, and confirmed effects.

Human participation, `play`, graphical-client checks, Metal rendering, and protocol bridges are outside this campaign. No acceptance gate requires the owner to be present.

## 1. Charter

This document authorizes the implementation campaign, not publication or remote operation. Work in `/Users/josh/d/mc/arena` when executing from this draft-only directory; initialize Git there. If executing inside an existing Arena repository, use it and preserve unrelated work. Do not initialize Git or start implementation during preflight.

- Make routine choices inside this scope and keep moving. Ask only if a choice changes a contract, user intent, or carries real risk. Send no progress check-ins; continue independent work when an item is blocked.
- Park an item when its prerequisite is unavailable, its contract boundary is forbidden, or no usable verification loop exists; continue independent work. Pushing, publishing, spending money, public listeners, cloud provisioning, modifying unrelated saves/accounts, and destructive Git operations are forbidden.
- Implement feature completeness and behavior coverage first. Runtime/size/build budgets are measured before P3 but only the safety ceilings and egregious floors gate earlier work. Do not optimize while a required feature or parity behavior is missing or parked; finish independent feature work, then park optimization that depends on it.
- Fix a baseline failure that blocks the current item, a warm focused check exceeding 120 seconds, or a reproducible same-workload regression above 2 times baseline, in a separate scoped commit. Investigate cause first. Log other unrelated defects and leave them.
- Every bug fix begins with a minimal failing regression. Never weaken assertions, retry a flaky check to green, fabricate outcomes, use administrative combat, inject live inventories, teleport stuck competitors, or hide errors. No code comments or formatters.
- Keep work areas clear and avoid overlapping edits. Serialize Paper runs and timed performance measurements. Do not preflight free space, aggregate work-tree bytes, retained-run count, host memory, or swap activity.
- Keep `.work/` ignored. Put scratch and `TMPDIR` under `.work/tmp`, and Arena caches, worlds, and runs under `.work/arena/`.
- Local campaign commits are authorized. Use Conventional Commits, never push, and keep code comments focused on local invariants or behavior.
- Keep only the campaign plan, acceptance report, and fixtures a reader needs to reproduce or judge behavior. Do not keep a progress diary or duplicate run-by-run archive metadata. Leave useful failure evidence in place until its cause is understood or the campaign no longer needs it.

### Failure budget and loop

Reproduce failures with the narrowest useful check, inspect the first wrong value, and fix the cause where it begins. Keep the regression. Avoid retrying the same failing condition; if an item is blocked, continue independent work and keep a concise reason to resume it.

Use focused checks for each change and run the full functional suite at the completeness and final delivery milestones. Keep slow verification targeted; do not build the whole workspace to check one package.

## 2. Decisions

### Owner-decided — 2026-10-12

- **Minecraft EULA accepted for these local runs.** The owner explicitly accepted it during preflight. The executor may write local acceptance and pass `--accept-minecraft-eula` for this campaign. Shipped software still requires an operator's explicit acceptance; never enable acceptance by default for other users.
- **Paper download contact authorized:** `dankmeme133769@proton.me`. Use `Arena/0.1 (dankmeme133769@proton.me)` as the identifying User-Agent for this campaign's official Paper requests. Treat contact as operator configuration, not a secret or semantic scenario input; shipped software requires its own operator contact. Do not substitute an upstream project's contact. If contact configuration or artifact access is unavailable at execution, park dependent live proofs and continue independent work.
- **Homebrew installation is permitted when needed.** Honor suitable existing installations first; native repo-local verified toolchains remain preferred. Brew is an authorized fallback for prerequisite tools/JDK, with package/version and host change recorded. Do not use `doas`, root, change global runtime defaults, or install an unrelated package manager. This supersedes the draft's unconditional ban on package-manager use.

### Owner-decided — 2026-10-13 continuation

- Continue until the campaign is done. Stopped runs may be moved intact to `.work/arena/traces/<same-id>/retained-run` when useful; no per-run approval is required. Do not move a run with an active lease or server process or overwrite an existing archive path. Retained failures remain failures and are not completed archives.
- Remove run-count, free-space, aggregate work-tree, and generic download-size admission gates. Remove runtime RSS, available-memory, and swap polling and abort checks. Acceptance reports mark host resource measurements unavailable. Keep exact locked artifact size/hash verification and per-operation filesystem, parser, trace, and protocol bounds.

### Owner-decided — 2026-10-13 Hunger terrain and tooling

- Replace the synthetic Hunger Games floor with seeded vanilla natural terrain covering exactly 1024×1024 blocks. The scenario seed is also the world-generation seed. Prepare only spawn, objective, and view-halo chunks at startup; allow other chunks to generate as clients explore.
- Assign deterministic opening styles that rotate across seeds and seats: explorers skip planned chests and explore immediately; scavengers may take one useful cache, then leave the cache area; hunters favor useful equipment and visible isolated opponents. Policies receive only their own client observations and permitted border state.
- Add headless output that connects each seat's assigned style and opening goals to observed opportunities and confirmed skill effects. Keep evaluator world-generation truth out of bot inputs.
- Apply the TypeScript tooling layers that fit this server/CLI repository: pnpm-only package management, Node.js 26.8.2 execution and tests, TypeScript 7, Oxlint plus `oxlint-tsgolint`, and Effect 4 at real I/O boundaries. Vite, Solid, browser tests, and browser-specific layers do not apply.

### Prescribed

| Decision | Reason; what would reverse it |
|---|---|
| Paper **26.1.2 candidate (protocol 775)**, native **JDK 25**, Mineflayer bots under **Node.js 26.8.2**, one Java plugin | Mineflayer 4.39.0 lists 26.1 and its protocol data maps 26.1.2 to 775; exact Paper gameplay support still requires Arena's live proof. |
| **pnpm**, **Node.js 26.8.2**, **TypeScript 7**, **Oxlint/tsgolint**, and **Effect 4** | pnpm alone owns packages and `pnpm-lock.yaml`; Node.js owns runtime and tests. Effect owns meaningful I/O boundaries; pure policy/spec code stays plain TypeScript. |
| One TypeScript workspace (`core`, `spec`, `bots`, `runner`) and one Java project | Keep policy pure and separate from client effects; retain only package boundaries used by real dependency and test boundaries. |
| Complete Hunger Games and civilization before stronger policy/scaling/LTO/allocator tuning | All required behavior must exist before performance work; only loop repair or egregious/safety fixes move earlier. |
| `versions.lock.toml` is tool/artifact identity authority; `arena-spec` owns defaults and resolves them once into canonical IR | Prevent drift; TypeScript/Java duplicates are intentional and checked by golden fixtures, not independently defaulted. |
| Existing scenario/map/world-plan/control versions stay strict; natural terrain and opening-style contracts require explicit schema bumps; revised TypeScript traces advance from version **2** for the new policy input | Terrain columns resolve against the seeded server world, and replay must carry the assigned style/state. Old readers remain strict and historical trace-v1 remains rejected. |
| Plugin is sole match/outcome authority; runner supervises and reconstructs reports | Two authorities can disagree; change only with a replacement design and mechanics proof. |
| Disconnect after countdown starts eliminates immediately at that tick's terminal-resolution boundary; no replacement/competitive reconnect | Bounded, testable roster contract. Before countdown, fail preparation if the declared bot roster cannot become ready. |
| All declared competitors are bots; extra joins are noncompetitive spectators | Keep unattended runs independent of user participation and enforce spectator isolation. |
| Acceptance uses ordinary headless clients and server observations | No GUI, renderer, or human-play proof is required or claimed. |
| Full state is evaluator-only; each Mineflayer instance's received world/entity data and faction entitlements govern policy and skill queries | Application caches shared across clients are not an authorization boundary. Live noninterference proof is mandatory before fair-match claims. |
| Strict owned-root path policy, fresh run directories, no hard links to snapshots | Avoid corrupting pristine worlds or escaping the repo. Revisit only with equivalent atomic/confinement tests. |

### Delegated within bounds

The executor chooses internal names/private type layout, native toolchain builds, legal loot tables, symmetric map geometry, and a minimal PRNG/JSON/CLI implementation. Tie-break: reuse an accepted maintained dependency at its boundary, otherwise prefer the smallest standard-library solution. Use private validated constructors, enum variants for lifecycle/skill outcomes, stable seat IDs, explicit tick/byte units, and distinct observation versus evaluator types. No speculative abstractions or new configuration knobs.

The integrator alone admits pnpm dependencies after maintenance, license, transitive-size, standard-library alternative, cold install/build CPU time, emitted output/plugin size, and warm startup/runtime review. Mineflayer and `mineflayer-pathfinder` are accepted at the bot boundary; `mineflayer-pvp` is only a baseline/reference and is not the final combat controller. Effect 4 is limited to meaningful effectful boundaries; no Mineflayer objects enter policy or spec packages. Dependency budgets: warm core/spec checks remain within loop targets; plugin ≤10 MiB; a new runtime dependency adds ≤10% cold install/build CPU time and ≤5% warm-start CPU time against the preceding equivalent build, outside observed spread. There is no owned native executable-size gate. Before P3 these are recorded targets; safety ceilings still apply. If a required dependency misses them, complete parity, then optimize/remove it in P3; do not silently relax the target. An unresolved final budget parks delivery.

T1 uses Node.js 26.8.2, pnpm 12.13.0, TypeScript 7.0.2, Oxlint 1.87.0/tsgolint 7.0.2004, and Effect 4.0.2. The Effect package is MIT-licensed, has no declared runtime dependencies, and occupies 54 MiB unpacked in the local install. The broad and short-command Effect wrappers exceeded the warm-start budget in five-run interleaved comparisons, so Effect is loaded only for the `runPreparedRun` server lifecycle. That final path and cold install/build CPU remain to be measured against the campaign budget before P3 closes.

## 3. Baseline and foundation evidence

Preflight on **2026-10-12** found only this draft in `/Users/josh/d/mc`: no `.git`, code, AGENTS.md file, tests, prior failures, or build artifacts. The owner's Working Contract supplied in the session governs the implementation. No claim about an existing implementation is valid. All paths below describe planned files.

Host observed at preflight: macOS/Darwin arm64, 10 logical CPUs, 32 GiB physical RAM. The historical Rust toolchain reported 1.98.1; `kache`, `jaq`, and `perf-gate-ready` were available. `/usr/bin/java` was a launcher stub and reported **no Java runtime**; Gradle was absent. Operational command timings, one invocation each, not performance-gate measurements: `rustc --version` **0.05 s**, failed `java -version` **0.01 s**, immutable upstream source read **0.20 s**, authorized-User-Agent Paper metadata assertion **0.27 s**. Those preflight measurements came from the earlier Rust/Azalea campaign and do not establish the current Node/Paper baseline. T1 must record its actual baseline and migration result.

Primary sources checked for the revised stack:

- Mineflayer **4.39.0**'s pinned `testedVersions` and `node-minecraft-protocol` 1.67.0 both list **26.1**; Mineflayer requires Node `>=22`. `minecraft-data` maps Minecraft 26.1.2 to the same protocol **775**. These are upstream compatibility claims, not Arena's proof.
- The prior Node 24 proof remains historical Mineflayer interoperability evidence; current Node.js 26.8.2 proof is recorded below.
- Official Paper docs require Java 25 for current Minecraft 26.x and an identifying download User-Agent. Paper's prior 26.2 build 133 artifact was downloaded and its SHA-256 matched the official metadata, but that artifact is not the selected Mineflayer server. Prior Java tests also used the 26.2 API; rerun them against the chosen 26.1.2 API. The new P0 must pin an exact server/API pairing and verify the server bytes.
- Python's default HTTPS reader failed certificate validation during the original source reads; native `curl` succeeded. Use the functioning system trust path; never disable TLS validation or classify a certificate failure as missing upstream support.

**Historical Foundation A, Azalea interoperability: passed on macOS arm64, but does not satisfy current D1.** The prior `./arena test --suite integration --case stack` exercised Paper 26.2 build 133 and Azalea revision `0bd22cbcdd30b611b112fc1c0a3d78535fd493a1` over protocol 776. Two clients completed login, chunk receipt, movement, chest transfer, server-observed swing and damage events, and disconnect; the wrong-protocol control was rejected in 17.34 seconds. Retain this as historical evidence only; the Mineflayer stack requires a new smoke proof. Linux x86_64 remains unverified.

**Foundation A, Mineflayer interoperability: passed on macOS arm64 with Node.js 26.8.2.** The current `./arena test --suite integration --case stack` passed against Paper 26.1.2 build 74 and Mineflayer 4.39.0 in 14.87 seconds: both clients logged in, received chunks, moved, transferred chest items, produced server-observed hit events, and disconnected; the wrong-protocol control was rejected. The earlier Node.js 24.21.0 proof remains historical. Configured-map reset, competitive authority, policy replay, and per-client fairness have passed as detailed in the acceptance report. Six-seat acceptance and Linux remain unverified.

**Foundation B, per-client observation isolation: unproven for Mineflayer.** Prove two clients with disjoint chunk/entity visibility and hidden-state perturbations against their separate Mineflayer client instances. Policies, skills, and navigation may read only their bot's received state plus explicit permitted team messages. Never label the result fair based only on isolated policy fixtures.

T1 records the existing build/test known-reds before migration. The prior code is a behavioral reference, not a runtime architecture to preserve. The parity reference is the **behavior specified here**, plus ordinary mechanics observed on the locked Paper server. Keep the behavior-to-test table in `docs/acceptance-report.md`. Normalize only timestamps/run IDs and genuinely unordered diagnostics, never inventories, event order, match outcomes, or decisions.

## 4. Sequence and ownership

Sizes: S ≤ half a lane session; M ≈ one session; L spans sessions with coherent committed checkpoints. A row is one end-to-end capability. F0 has separable skeleton/schema/offline checks and live smoke; if its live proof is parked, only dependents requiring that proof park. Its merged offline seams still unlock independent implementation. Every row owns its implementation tests and section in its area document. Shared manifests, locks, schemas, top-level README/AGENTS, and this plan remain integrator-owned; a lane requests additions. Adjacent ready items in the same ownership set stay in one lane. Broad-suite verification belongs to the integrator; lanes run only named changed tests and the cheapest compiler check.

| Phase / item | Size | Prerequisites | Owned files | Capability and proof |
|---|---|---|---|---|
| **P0 F0 — TypeScript foundation and loop** | L | none | Integrator: pnpm workspace, Node.js runtime, `arena`, manifests/locks/toolchains, schemas, `tests/integration/stack.ts`, `docs/compatibility.md`, `AGENTS.md` | Prove Paper 26.1.2 with Mineflayer under Node.js 26.8.2, establish named checks, implement a two-client smoke; `./arena test --suite integration --case stack`. |
| **P0 T1 — TypeScript tools migration** | L | current P0 foundation and baseline | Integrator: manifests/locks, TypeScript config, lint, CLI/runtime I/O boundaries, all TypeScript tests, local instructions | pnpm-only dependency graph; Node.js 26.8.2 runtime and tests; TypeScript 7; Oxlint/tsgolint; Effect 4 at meaningful I/O boundaries; remove npm workspace and old path aliases. Fresh pnpm install and the focused `./arena` checks. |
| **P1 S1 — world/spec capability** | L | F0 TypeScript package/schema seam; live proof needed only for integration | `packages/arena-spec/**`, `maps/**`, `scenarios/hunger-six.toml`, `scenarios/duel.toml`, map/spec fixtures, `docs/scenarios.md` | Strict compiler, geometry/reachability contracts, semantic hashing; named spec tests plus `validate`/`build`. |
| **P1 J1 — server authority** | L | F0 control/IR seam; S1 IR for map integration | `server/arena-plugin/**`, Java fixtures/tests, `docs/rules.md` | Generation/setup/snapshot readiness, full match authority, roster/UI/outcomes; Java named tests, then real `maps-reset` and `match-rules` cases. |
| **P1 B1 — real client player** | L | F0 TypeScript/Mineflayer seam and stack; S1 minimal route/container fixture; J1 preparation/telemetry for live proof | `packages/arena-core/**`, `packages/arena-bots/**`, policy/observation/skill fixtures, `policies/baseline.toml`, `docs/policies.md` | One legal navigating/looting/eating/equipping/melee client; deterministic policy and per-client observation isolation; `legal-player` case and named core/adapter tests. |
| **P1 R1 — lifecycle and evidence** | L | F0 control/trace seam and stack; J1 handshake/events for integration | `packages/arena-runner/**`, `tests/integration/lifecycle.ts`, replay/report fixtures, `docs/operations.md`, `docs/determinism.md` | Supervision, safe reset-by-clone, CLI, authoritative logs, D1–D3 replay/report; `lifecycle`, `replay-report`, `doctor`. |
| **P1 M1 — six-seat MVP integration** | M | S1, J1, B1, R1 merged and live proofs passed | Integrator: `tests/acceptance/hunger.ts`, README, report | Six seeded matches, seat/spectator flow, frozen baseline; `hunger-six`, including automated seat and spectator checks. Identify verified MVP commit. |
| **P1 N1 — natural terrain and opening styles** | L | M1 baseline; T1 toolchain migration | Integrator with spec/runner/plugin/bots ownership | Seeded 1024×1024 vanilla terrain with sparse chunk preparation, surface-resolved starts/caches, three seed-balanced opening styles, and a headless per-seat strategy/effect report; rebaseline fixed six-seed gameplay without replacing the frozen synthetic report. |
| **P1 C1 — civilization server/spec** | L | M1; F0 civilization IR/rule variants committed | Same S1/J1 streams, serialized within each: civilization map/scenario/Java rules, their tests | Two-faction resource map, capture/scoring, real blueprint/material validation; spec/Java tests then server `civilization-rules`. |
| **P1 C2 — civilization client capability** | L | M1; C1 IR contract (runtime fixture need only at integration) | Same B1 stream: core/bots, `policies/civilization.toml`, team/task fixtures | Gathering/crafting/storage/building, bounded team reports and legal combat; named tests then `civilization-six`. |
| **P1 M2 — completeness milestone** | M | C1, C2 plus M1 merged | Integrator: `tests/acceptance/civilization.ts`, report | Full functional suite, all deliverables 1–5 behavior rows covered, raw six-seat resource baseline. No unresolved parity behavior permits P3. |
| **P2 H1 — hardening** | L | M2 | Same four area streams, same ownership; integrator owns cross-language goldens and acceptance | Malformed inputs, disk-full/interruption, trace truncation, fairness/cache/faction isolation, regression reduction, docs/contracts; affected-area suites and `fairness`, `faults`, `replay-report`. |
| **P3 K1 — competent policy** | L | H1; frozen baseline and complete parity | Core/bots and policy fixtures | Improve closed-loop combat and survival decisions; measure confirmed effects and task outcomes, not intent volume; compare against frozen baseline with `policy-compare`. |
| **P3 O1 — measurements and optimization** | L | H1; K1 default policy decision before final comparisons | Runner stream: `benches/**`, runner benchmark module, `docs/performance.md`; any measured adapter fix returns to bots stream | Workload fixtures, scale ladder, profile, remove measured work, compare equivalent builds; `bench` and resource assertions. |
| **P4 Z1 — close and delivery** | L | K1, O1, all functional proofs | Integrator: cleanup across landed tree, README, report, roadmap | Dead-code check, ultrareview/P1/P2 fixes, final full suite, release/size/perf checks, clean-cache and warm-offline acceptance; `fresh-checkout`. |

## 5. Executable acceptance and limits

The local interface is `pnpm install --frozen-lockfile` followed by the named `./arena` build, check, and test commands. `./arena check lint` runs type-aware Oxlint with tsgolint; it reports errors while the existing warning backlog remains documented. Selectors reject unknown names, require one exact test, and return nonzero on failed or blocked checks. The full functional suite excludes benchmarks, cold bootstrap, and unavailable other-host checks. Bot checks add focused TypeScript validation without starting a server. Java uses the repository's pinned Gradle selector. Package tests must not pull in server/network dependencies unless the named integration case requires them.

| Deliverable / case | Required observable proof |
|---|---|
| D1 / `stack` | Frozen pnpm install and Node/Java build, two real Mineflayer clients under Node.js 26.8.2, login/configuration/chunks/move/chest transfer/ordinary server-observed hit/disconnect on exact versions. Wrong-version negative control must fail. |
| D1,D4 / `lifecycle` | Ten start/stop cycles, no owned descendants/sockets/locks left; occupied port, bad token/version/frame, controller loss, server crash, Ctrl-C, second owner, wrong plugin identity, truthful interrupted result. |
| D2 / `maps-reset` | Three independent prepares/resets yield identical canonical IR and semantic world state; six reachable loot routes, changed parameter changes intended content, chunk/negative-coordinate boundaries; no old inventories/deaths. |
| D3 / `legal-player` | Mineflayer client navigates a real obstacle, transfers chest contents, equips, eats, and deals melee damage/receives knockback; inventory conservation comes from server state. Intent/API-call-only assertions fail this case. |
| D2,D3 / `match-rules` | Normal win, same-tick zero-survivor draw, border death, disconnect, timeout, abort, spectator, duplicate identity, eliminated reconnect, restart; actual two-bot duel and independently reconstructed result. |
| D3 / `hunger-six` | Six declared seeds `481516..481521` on natural terrain; every match terminates, each bot performs useful movement or is legitimately eliminated before opportunity, at least one legal loot and hit per match, no infinite stuck loop. At least one match has one survivor and at least two distinct ordinary PvP engagements. Only border deaths/timeouts cannot pass. |
| D3 / `hunger-six` headless strategy report | Per seat: assigned opening style, first goals/intents, locally observed chest/opponent opportunities, and confirmed navigation/loot/eat/equip/attack outcomes. Show strategy rotation across seeds. Report evaluator terrain seed and terrain facts separately from bot observations. |
| D3 / `hunger-six` seat checks | Six fixed bot seats, extra automated spectator isolation, bot death-to-spectator/result, duplicate identities, eliminated reconnect, and no competitive replacement after countdown. |
| D4 / `replay-report` | D2 identical decisions on three replays per recorded run; D3 independent report reconstruction matches outcome. Timestamp/verbosity perturbation unchanged; truncated/schema-mismatched trace fails; D1 semantic equality is checked separately. |
| D4 / `faults` | Disk-full, critical/optional queue saturation, partial initialization, signal cancellation, symlink swap/traversal, non-UTF-8 paths, stale lease, atomic-write interruption and corrupt cache; valid state or explicit invalid outcome after restart, no escaped writes or orphan resources. |
| D4 / `fairness` | Hidden enemy/loot perturbation and two-client disjoint receipt live test; same permitted inputs produce same decisions; spectator/evaluator/shared-cache/faction data do not leak. Deliberately injecting hidden state must make the test fail. |
| D5 / `civilization-rules`, `civilization-six` | Six clients, both factions useful, real log→drop→craft→chest→placed outpost chain with material conservation; legal capture/ownership change/combat with fixed bot factions; cancellation, cargo death, contention, stale plans/unobtainable materials, route invalidation. |
| D6 / `policy-compare` | Train on 12 development seeds; freeze the candidate before 24 held-out seeds with swapped positions (48 duels). Require a positive paired confidence bound for wins plus half draws and preserve functional floors. Report confirmed damage, successful loot/equipment/food tasks, survival, and failure causes; report six fixed arena seeds separately. |
| D6 / `bench` | Correct equivalent workloads, actual activity and alive count, network/tick/latency, functional floors, scale rungs and same-workload A/B evidence. Host RSS/memory/swap measurements are unavailable. Maximum completed rung and overload failure are explicit, not a 256 promise. |
| D1–D6 / `fresh-checkout` | All functional suite after merge and close; native-host clean-checkout build/run from an empty project-local cache, cached offline run/replay, final owned release binary/plugin sizes, no secrets/jars/worlds in Git, no orphans, reports and commands actually reproduce. |

Development and held-out seeds are fixed before tuning. Only development results may guide changes; evaluate held-out seeds once after freezing the candidate. If improvement is not supported, keep the baseline default and report the result plainly.

The frozen six-seed reports contain 6,231 attack actions: 5,576 ended with `preconditionsNotMet` (89.5%), while 339 succeeded and recorded 341 local damage events. These are action outcomes, not mechanical hit accuracy. K1 must explain and reduce avoidable failures using permitted client-local evidence, including target visibility, reach, occlusion, and damage confirmation. Its curriculum covers approaching visible targets, recovering after lost line of sight, eating or retreating under pressure, knockback/border recovery, and choosing between targets. If policy feedback or replay contracts change, version them and keep prior readers strict.

### Runtime safety ceilings (resolved once by runner)

| Resource | Default and breach behavior |
|---|---|
| Normal roster / test bench | Exactly 6 competitors in shipped scenarios; 4 spectators. Bench count is explicit fixture input, ≤256 and ≤`--max-bots`; the flag is only a ceiling, never a hidden scenario-roster override. |
| JVM / combined run | Start with `-Xms512m -Xmx2g`; no runner RSS, host-memory, or swap threshold. |
| Node workers / paths | Start with one Node worker for the six-bot run. At most one active path per bot; schedule replanning under one worker-wide CPU budget. `mineflayer-pathfinder` 2.4.5 defaults to a 40 ms `tickTimeout` and unlimited search radius, so choose a shorter slice and bounded radius from the pinned API and arena dimensions. Record event-loop delay. Add cohort workers only after measured load shows a need. |
| Files/downloads | No generic transfer-size or cumulative-work-tree cap. Downloads must match their locked artifact size and SHA-256. |
| Runs/traces | No retained-run-count or host-byte admission gate; segment ≤8 MiB and checkpoint every 200 observation records. Native GC removes only eligible owned terminal runs; stopped protected runs may be archived intact under the campaign authority above. |
| Frames/queues | Control frame ≤1 MiB, JSON nesting ≤32, incoming command queue 128, critical event queue 4,096, optional metric queue 1,024. Reject command overflow; optional drops counted; critical loss sets invalid/abort, never blocks tick thread. |
| Deadlines | Cold prepare/start ≤180 s; normal ready ≤60 s; bot operation synchronization ≤100 ticks; skill no-progress ≤100 ticks then two legal replans, fail by 300 ticks. |
| Liveness/shutdown | Heartbeat each 1 s, lease loss at 5 s; plugin aborts and initiates stop. Supervisor graceful stop ≤15 s, owned kill/reap ≤5 s more; no unrelated process killing. |
| Wall duration | Hunger run ≤600 s including waiting; civilization ≤1,200 s; each benchmark sample ≤300 s plus 60 s warmup. Operational timeout is **aborted**, never a tick-limit draw or winner. |
| World bounds | Hunger natural terrain 1024×1024; civilization 192×192. Prepare only spawn/objective chunks plus the configured view-distance halo (6 chunks initially); generate the rest on demand. Civilization remains a bounded planned map. |
| Perception / team | 40-block entity range, 120° horizontal/90° vertical FOV, voxel line-of-sight; reaction 4 ticks, aim ≤30° yaw/15° pitch per tick; entity memory expires 100 ticks, stale remembered terrain remains last-observed. Team message ≤1 KiB, ≤1 per sender/20 ticks, queue 16 per receiver, age ≤200 ticks; same-faction recipients only. |

Protocol, parser, and per-operation filesystem bounds remain enforced. Configuration precedence is explicit CLI > environment > scenario > typed defaults, validated once; legal acceptance and contact remain operator inputs, not scenario fields.

**Performance gates:** time-based budgets/claims run only when `perf-gate-ready` exits 0 immediately beforehand and `perf-gate-ready -1` exits 0 immediately afterward. Overlap discards the sample. If unavailable/busy, defer it, continue functional work, and record **“perf gate deferred: host busy”**; do not call delivery complete. Binary-size checks always run; host memory/swap measurements are disabled. Profile separately from reported measurements. For A/B use at least five alternating samples per side, same release build settings/versions/workload, 60 s warmup and 120 s measurement. Report CPU-time minimum, median/range, wall latency tails, failures and actual work; treat a regression as established only above both 10% and observed spread. Six-player final target: 20 TPS, server simulation p95 ≤50 ms and p99 ≤100 ms over that window, no routine disconnects or stuck loops. If pinned APIs cannot measure simulation duration, mark that metric unverified; wall repeating-task intervals cannot substitute. Run release builds only in P3 performance work and P4 final verification.

## 6. Contract changes and non-goals

Pre-authorized: new TypeScript Arena CLI/types/schema-v1/wire-v1/trace-v2 and their documented errors; strict input rejection; the exact roster/disconnect/grace/capture/perception rules in this doc; owned cache/run writes, authenticated loopback control, local offline identities; scoped Mineflayer adapter fixes after failing regressions; dependency selection inside the stated policy; deletion of demonstrably dead new code; local campaign commits and removal of integrated lane worktrees. Implement code, tests, examples, and docs together. List each public/API/schema/permission/invariant/transaction change in the acceptance report.

Forbidden: public/off-host load, world/admin queries feeding policies, live administrative kills/items/teleports, authentication bypass, inferred EULA/contact acceptance, deleting user artifacts or force-removing dirty trees, changing old saved-data semantics, destructive Git resets, paid/remote CI provisioning, autonomous pushes. Bots connect directly to Paper on Mineflayer's native supported protocol; no protocol bridge or graphical client implementation is in scope. The owner may observe through an external native client on loopback. Package installation is limited to the owner-authorized Brew prerequisites or repo-local artifacts.

Non-goals: human play, GUI/Metal verification, protocol bridges, full survival parity for Hunger Games (building/breaking disabled equally), expert-human certification, D4 bit-identical asynchronous live trajectory, graphical world replay, renewable civilization economy, unbounded persistent campaigns, learned/LLM policies, general terrain/template language, new rendering client, browser dashboard/MCP, separate civilization backend, interchangeable client backends, and fleet infrastructure beyond the single local supervisor. Do not add SoulFire, Baritone, Carpet, Terra, WorldPainter, Folia, Hyperion, Pumpkin, Redis, Kafka, or Kubernetes. Roadmap describes later tracks; it authorizes no implementation.

## 7. Reference: executable design

### Repository and module boundaries

```text
arena/
  arena  README.md  AGENTS.md  package.json  pnpm-lock.yaml  tsconfig.json
  versions.lock.toml
  packages/{arena-core,arena-spec,arena-bots,arena-runner}/
  server/arena-plugin/          # source, tests, plugin.yml, pinned Gradle wrapper
  schemas/{scenario,map,control,trace}.schema.json
  scenarios/{hunger-six,duel,civilization-six}.toml
  maps/{hunger-six,duel,civilization-six}.toml  maps/prefabs/
  policies/{baseline,competitive,civilization}.toml
  fixtures/{protocol,observations,maps,regressions,experiments}/
  tests/{integration,acceptance}/  benches/
  docs/{architecture,compatibility,scenarios,rules,policies,operations,
        determinism,fairness,performance,macos-client,acceptance-report,roadmap}.md
  .work/                       # excluded locally, all disposable working state
```

`arena-core`: pure policy, observation/memory/intents, PRNG, geometry, and outcome evaluation, with no runtime/network/filesystem/server imports. `arena-spec -> arena-core`: strict TOML parse/validated compiler and canonical IR. `arena-bots -> arena-core`: per-client Mineflayer observation adapter and skills, never spec/evaluator world access. `arena-runner -> spec/bots/core`: CLI, lifecycle, recording/report/bench. Java independently consumes golden-tested wire/IR and owns authoritative world rules. The evaluator's full-state types stay in runner/plugin, absent from the policy API. Typecheck/test the pure core package without Mineflayer or server dependencies.

Policy interface: `decide(observation, memory, params, random): Decision`; the return holds new memory and goal/intent, not Mineflayer objects, callbacks, or client handles. Observation unknown/stale/observed states and skill pending/progress/succeeded/failed/cancelled are discriminated unions with required payloads. Seat IDs remain stable across usernames. Slots 0–5 are bots in normal runs. A spectator has no competitive seat.

### Locked compatibility and bootstrap

F0 pins Node.js 26.8.2 in `versions.lock.toml`, the pnpm release in `package.json`, TypeScript 7, and the exact transitive package graph in `pnpm-lock.yaml`. Select and verify an exact official stable Paper 26.1.2 server build and matching available API coordinate, native JDK 25 distribution/build, and exact Gradle wrapper. Confirm Mineflayer's exact native protocol support from its pinned source and exercise it under Node.js against the server before locking. No floating `main`, unpinned package ranges at install time, invented SHAs/checksums, default latest-server upgrade, or protocol translation for bots.

Commit `pnpm-lock.yaml`, `versions.lock.toml`, Gradle dependency locks/verification metadata, wrapper checksum, and exact Node/pnpm/Paper/JDK identities. Downloads use official URLs, valid operator User-Agent for Paper, TLS verification and hash checks. A supplied Paper jar requires official-version/hash evidence before executing; absent verified metadata parks it. Keep pnpm, Gradle, and Paper caches inside `.work/arena`; warm checks should run offline after the first install/build. Docs record protocol/server/API/revision/toolchain/host and proof commands. Use native macOS arm64 and Linux x86_64; Linux arm64 is future feasibility, not a claimed supported target without a build/run. A missing second host leaves its checks unverified, not silently passed.

`./arena` is the POSIX entrypoint for the Node.js 26.8.2 CLI and pinned native helpers. Respect network/proxy environment; do not change global runtime defaults. GitHub Actions are outside this campaign; the canonical local named build, check, integration, and acceptance commands are the required checks. Add fixed-seed property cases at owning boundaries for geometry/transforms, strict validation, per-bot isolation, inventory conservation, terminal states and reconstruction. Bounded parser/control/trace fuzz cases cover one-byte reads, repeated fields, lengths/oversized integers, non-finite floats, unknown versions, traversal and truncation; keep per-case development runs within the narrow loop. Every claim must have an oracle assertion that fails under a deliberate wrong output, not just a call or a generated fixture echoed back.

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
spectator_capacity = 4

[server]
minecraft = "26.1"
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
perception = "competitive-v1"

[record]
mode = "evaluation"
policy_replay = true
world_outcomes = true
```

The renamed `authoritative_max_ticks` makes the tick budget distinct from wall timeout; update all examples, schema, parsers and tests. Defaults have one typed TypeScript owner; Java consumes fully resolved values. Canonical compilation emits immutable scenario/map IR, roster and report; machine paths/secrets/wall times do not enter semantic identity. Parameter profiles select a registered TypeScript policy and validated versioned parameters, not arbitrary code. Policy identity includes code and parameter identity.

Hunger map spans x/z `[0,1023]` over a seeded 1024×1024 vanilla world. Use surface-column spawn and loot coordinates so the Paper world, not a nominal YAML/TOML Y, resolves each safe feet position. Keep planned setup sparse and local; terrain, trees, caves, and ordinary vegetation come from vanilla generation. The scenario seed owns both worldgen and policy streams. Do not pregenerate the full 4096-chunk square: prepare spawn/cache chunks and their view halos, then let Paper generate terrain on demand. Existing duel/civilization maps remain explicit planned maps until independently migrated.

For planned maps, the Paper chunk generator consumes immutable order-independent IR on generation workers. Natural maps use Paper's normal generator; resolve surface columns, place authored containers, apply scenario rules, and validate spawn support/headroom on the server thread after chunks exist. Validate per-seat safe separation, bounded objective access, valid inventories/chunk boundaries, and reachable border behavior. Do not derive route truth from a flat compiler model when natural terrain is enabled; acceptance proves the actual client routes. Prepare only required chunks and view halos, finish setup/readiness, save and stop cleanly before snapshots. Prevent portals/spectators from unbounded generation; world generation outside the arena follows the same seeded vanilla world.

Semantic world hashes cover relevant blocks, block entities/inventories, declared rules; volatile Minecraft serialization is excluded. Snapshot file-integrity hashes are separate. Reset is reflink/copy of stopped pristine world into a fresh owned directory, never mutable hard links/live copies. Reset player inventories/advancements/statistics/deaths. No live desired-state repair of destroyed structures.

### Ownership, protocol, durable state and errors

One Arena process owns the headless swarm and one Paper JVM. Supervisor owns children/pipes/sockets/locks/run directories/deadlines and drains output continuously. Readiness is a versioned authenticated plugin handshake after prepared-world verification, never a fixed sleep. Runner listens on ephemeral loopback control port; plugin connects with protected per-run secret. Game port defaults to loopback 25565 for normal runs, ephemeral for tests; occupied ports fail without killing another owner. Disable unrelated remote listeners. Bots are non-operator offline identities on private loopback only.

Control frames: 4-byte big-endian byte length followed by UTF-8 JSON, protocol/run/sequence/type/correlation fields, authenticated handshake and explicit capabilities. Unsigned 64-bit seeds and wire/trace sequences use canonical decimal strings on JSON boundaries and exact BigInt values in TypeScript; sequences are positive. TypeScript control/schema is authority; Java DTOs are mirrored with cross-language golden positive/negative fixtures. Families: readiness/build progress, prepare/start/abort, public clock/state, eliminations and the sole terminal outcome, metrics, ack/errors. No command executor/full world-query policy API. Reject malformed/oversize/stale-run/duplicate sequence/unauthorized input before mutation; each direction has its own strictly increasing sequence. Response correlation echoes the initiating request sequence, not a separate retry key. Commands execute once on the server thread; duplicate/out-of-order sequences are protocol errors and no control command is retransmitted under a new sequence. There is no response cache or application-command retry. A lost acknowledgment times out and aborts; lost connection aborts rather than reconnecting/replaying commands.

A server task resolves all deaths/disconnects at end of tick before terminal evaluation. Network tasks queue immutable commands/events, never call unsafe async world APIs or block tick thread on disk/network. Critical queue overflow marks evidence invalid and schedules abort; optional metrics may drop with counts. The critical writer owns sequence and bounded buffers; errors retain their cause and invalidate evaluation.

Graceful shutdown: stop accepting work, cancel/release skills, disconnect clients, request save/stop, drain/finalize files, reap JVM, release run lock. Plugin control-lease loss ends the match and stops the owned server. Forced termination targets only owned descendants after grace. Restart never resumes an interrupted competition; orphaned staging/run state becomes interrupted/invalid with diagnosis.

Run manifest is created once, versioned, and records effective config/code dirty status/versions. Sequential critical events, confirmed client state and policy inputs are separate streams; sending an attack is not a hit/ack. Correlate only evidence that actually supports it. Trace segments carry schema, sequence range, checksum, and completion trailer; missing trailer/truncated segment rejects replay. Terminal result writes to same-directory temp, fsync, atomic rename and parent sync; it is published only after required events finish. Event-derived report is canonical outcome; terminal summary is a derived index validated against it. One locked owner writes; readers see completed segments or explicit incompleteness.

Reject unsupported old/new schema versions, no fallback writer. Retry only classified transient downloads up to three attempts (1/2/4-second backoff), validate complete file before atomic publication; no gameplay retries beyond skill budget. CLI boundary maps errors once: 0 success, 2 invalid input/config, 3 missing prerequisite/version, 4 owner/port conflict, 5 corrupt/incomplete evidence, 6 timeout/runtime failure, 130 cancellation. JSON error contains category, resource and structured source; never secrets. Legitimate completed game draws/timeouts return 0; operational aborts return 6.

Owned writes/deletes reject symlinks and traversal at each component, use handle-relative/atomic operations where races exist, reject special files, preserve raw OS paths without lossy conversion. Input map/policy symlinks may be followed only if canonical target remains in allowed repo roots. Copy fallbacks preserve semantics and are real-filesystem tested. GC cannot touch active runs, pristine snapshots, failed-run retention, or unrelated paths; dry-run lists exact selected terminal paths. Chat/sign/book text is data, never shell instructions.

### Match and civilization rules

Lifecycle: preparing→waiting→countdown→grace→active→finished; any nonterminal state may abort. Match tick 0 is release after countdown; grace occupies ticks 0..199, PvP begins at tick 200. Tick limit checks after all outcomes for its tick. Border diameter linearly interpolates by authoritative ticks 1200..6000, initial 126/final 16. No wall-time border transition masquerades as tick scheduling. One survivor wins, zero same-tick survivors draw, multiple at tick 7200 draw/timeout; operational abort is separate. Freeze/place/reset before release equally for all seats. Normal hunger/food/armor/cooldowns/reach/knockback/drops remain real; building/breaking disabled equally for Hunger Games. Spectators cannot damage/loot/compete/serve as targets or leak observations. Non-operator status/ready and scoped spectator controls, scoreboard/bossbar/chat for countdown/remaining/border/result.

Civilization reuses runtime, clients, recording, policy boundary and world compiler. Map 192×192, mirrored bases/resources and two factions of three, equal declared food/tool starting kits, ordinary trees/drops/crafting/chests and neutral capture zone. Roles: gatherer/crafter, builder, defender/scout. Grace 2,400 ticks, no respawn, max 18,000 ticks. Breaking/placing enabled equally; no privileged resource actions. Capture requires 200 uncontested tick increments after grace without the capturing faction leaving; contested ticks pause the accumulated counter, absence of the capturing faction resets unfinished progress, and uncontested opposition begins its own counter from zero. Existing ownership persists until capture completes; owner scores one point each end-of-tick, including completion tick. Opponent elimination wins; both wiped same tick draw; otherwise points at limit decide or draw on equality.

Blueprint: survival-placed 3×3 plank platform plus two 3-high plank corner pillars, 15 plank blocks total, with pillars starting above the platform at opposite corners and a reachable placement order; gather at least four logs and craft 16 planks through real recipe/inventory operations. All placement consumes actual inventory. Blueprint location must cover a small reachable observation/defense position without trapping a spawn. Verify drop collection, legal crafting, real chest deposit/withdraw and structure server-side; reservations are plans until confirmed. Death/cancellation releases task plans, not physical material. Finite food is labeled finite, no self-sustaining-economy claim. Team reports carry sender/observation tick and stale status; faction entitlements apply to all caches. Structure changes invalidate affected routes. Factions contain only fixed bot competitors; never replace a competitor once countdown starts.

### Skills, fairness and replay

Policy→bounded cancellable skill→Mineflayer adapter→normal client API. Skills: navigate, aim, open/loot, select/equip, eat, approach/retreat, melee; civilization adds mine/drop-collect/craft/storage/place. Preconditions/progress/success/failure/timeout are explicit. One skill owns each bot's movement, aim, inventory and hand resources; cancellation releases controls and waits for client-observed inventory synchronization. Use observed window state IDs/slot maps/equipment/food-use duration/cooldowns/corrections/knockback. No completion merely on API-call completion, no anti-knockback or movement behavior suppression to hide a bug.

Baseline prioritizes border escape, safe hunger recovery, equip, favorable visible fight, retreat, useful loot, bounded search. Stable tie-breaks/hysteresis avoid thrashing. Per-client received-chunk/entity tracking and visibility filtering feed navigation AND policy/skill queries; a shared pathfinder cannot query globally known unseen terrain. Receipt histories update knowledge only from that client or explicit permitted team messages. Unopened loot/enemy exact health/inventory/map seed/future events/privileged annotations remain unknown. Bounded opponent memory is last-observed, not magically refreshed. Evaluator has separate full-state data and types. An unrestricted diagnostic perception is a different workload, never a fair policy result.

D1: identical canonical IR and semantic starting state for same source/config/seed/locks. D2: identical decision outputs for normalized recorded observations, memory, RNG, and recorded skill/path results. D3: identical event-derived statistics/result. D4 exact asynchronous live trajectories is not promised. Named pinned PRNG with reference vectors; independent seat/purpose streams for policy/search/setup, unaffected by spectators/logging. Stable order/fixed scores; physics float handling explicit. Client tick/public server tick/observation sequence/age recorded; not a global atomic snapshot. Policy decisions are pure TypeScript calls over immutable snapshots; Mineflayer event handlers update per-bot state, and asynchronous skills have one explicit owner/cancellation path. Record live path results as D2 inputs; deterministic fixture navigation does not prove live path replay. Cross-architecture D2 is claimed only after actual replay on both supported hosts.

Stronger-policy curriculum covers navigation, chest contention, equipment disparity, low-health retreat, eating under threat, wall occlusion, target loss, edge knockback, behind approach, border escape and two targets. Improve cooldown/aim/equipment/spacing/cover/retreat/hysteresis with inspectable logic; bounded one-step utility lookahead only after fixture evidence. Never call a policy expert without expert-human evaluation. Freeze the simple baseline and version every tested candidate.

### Benchmark, cleanup and delivery

Separate idle connections; active navigation/container; repeated active duel/team-combat soak; elimination matches with alive population; dispersed civilization resource/building. A respawning soak is explicitly a different workload. Bench command is `./arena bench --workload active-combat --counts 6,16,32,64,128,256 --max-bots 256`; generated fixtures declare their roster/map/rules, never mutate shipped six-seat TOML silently. Start at six; escalate only after one rung succeeds. Each scale rung uses three samples; whole bench command wall budget is 60 minutes and its deadline returns the highest completed rung. Five alternating samples per side are reserved for the required same-workload A/B comparison, which may use a separate 60-minute command. A benchmark deadline reached between rungs is an honest bounded result; a timed-out sample is not a pass. Stop if disconnects exceed 1% or TPS <15 for 10 seconds. Host memory and swap are not measured by the runner. Highest completed rung and functional failure are the result; 256 need not succeed. Warmup/measurement/activity assertions apply to each rung.

Record OS/cores/config/version/build/scenario/policy semantic IDs, worker counts, bandwidth/packets, tick simulation percentiles where genuinely available, path replanning backlog, decision/skill latency, corrections/stuck/reconnect/failure counts and log size. Host memory and swap are reported as unavailable.

Profile before optimizing. Remove redundant work/copies/serialization/searches; add spatial indexes/caches only for measured dominant operations with knowledge-safe invalidation. Default remains portable headless, no display/GPU/assets per bot. Keep necessary physics/network/inventory. Node worker/cohort changes, GC flags, native path search and packet/world-cache changes are P3 experiments; do not strip per-bot observation isolation to save time. A focused upstream patch needs a retained regression and license/attribution; no whole-stack rewrite. If no safe measured opportunity exists, report why no optimization was justified.

Z1 deletes temporary instruments/dead paths after checking callers, configs, docs and persisted evidence consumers. Keep the frozen baseline as a live evaluation reference. Run `ultrareview` over implementation, fix P1/P2 findings with narrow regressions then recheck touched areas. Read its explicit-only skill from the installed skill path at execution; if unavailable, perform equivalent independent API/type/durable/lifecycle/fairness/verification reviews using available agents and record that substitution. No cleanup before liveness evidence, no compatibility shims without consumers.

README begins with actual `doctor`, `bootstrap`, `validate`, `build`, `run` commands and expected results; then exact tests/bench commands. Required tools also include `replay-policy`, `report`, `inspect`, `compare`, `gc --dry-run|--apply`, usable help, JSON errors and documented exit codes. Print concrete created run paths for subsequent commands; never leave `RUN_ID` as purported runnable evidence. Fresh acceptance uses a clean checkout under `.work/wt/fresh`, its own `.work/` cache and TMPDIR, then warm offline operation. Do not commit jars, secrets, enormous worlds/caches/traces. Selected compact evidence lives in fixtures/reports for future readers; full disposable evidence is referenced as local, not promised to survive checkout.

`docs/acceptance-report.md` lists exact verified commits, versions/host, each item passed/failed/parked with command and evidence, all contract changes, real six-bot outcome and runnable automated commands, reset/replay/isolation results, policy comparison sample/uncertainty, whole-system measurements/rungs, civilization conservation/build/combat proof, other-host status, known defects/reproductions and remaining prerequisites. Human-client and renderer documentation is outside this campaign.

`docs/roadmap.md` is grounded in delivered measurements: competitive movement/ranged/shields/terrain/tactics and human calibration; renewable economy/logistics/persistent faction depth; measured active-player bottlenecks before alternative engines/workers; optional learned goals with budgets/cancellation/evaluation; strict scheduling/barriers only after D1–D3. Finish this campaign before implementing roadmap tracks.

### Primary sources

Use exact locked source/API for implementation. Mutable links below are research entry points, not reproducible version locks.

- [Mineflayer 4.39.0 version support](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/lib/version.js), [4.39.0 runtime/dependency metadata](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/package.json), [node-minecraft-protocol 1.67.0 versions](https://raw.githubusercontent.com/PrismarineJS/node-minecraft-protocol/1.67.0/src/version.js), [26.1.2 protocol mapping](https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json), [mineflayer-pathfinder 2.4.5 scheduling defaults](https://raw.githubusercontent.com/PrismarineJS/mineflayer-pathfinder/2.4.5/index.js), [basic PvP plugin](https://github.com/PrismarineJS/mineflayer-pvp).
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [pnpm release feed](https://pnpm.io/blog?type=releases), [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html), [Effect 4 release](https://effect.website/blog/releases/effect/40).
- [Paper Java requirements](https://docs.papermc.io/paper/getting-started/), [plugin setup](https://docs.papermc.io/paper/dev/project-setup/), [official downloads requirements](https://docs.papermc.io/misc/downloads-service/), [26.1.2 chunk generator API](https://jd.papermc.io/paper/26.1.2/org/bukkit/generator/ChunkGenerator.html).

## 8. Current status

Frozen M1 and the current-source legal-player and six-seed checks pass. Civilization startup fixes and local C2 checks pass, but the live rules case still fails when a client does not observe a mined block change. Native inspection reports nine run directories. The next step is to preserve the failing observation's packet and local-world details, then rerun C1. C2 live and M2 follow C1; H1, K1, O1, and Z1 remain pending.

## 9. For the owner

- Read README for run commands and the acceptance report for current proofs and blockers.
- Local campaign commits and intact archival of stopped runs needed for capacity are authorized. Never push.
- Launch prompt: Continue this campaign from the current branch, finish every deliverable, and never push.
