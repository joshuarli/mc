# Arena: unattended Minecraft implementation campaign

**Status: campaign execution continues; P1 M1 remains blocked by the exact ramp timeout.** The six-player steering slice has focused checkpoint, policy, and search proofs plus a passing live border-preemption check at `761916d`. The owner authorized a one-time archival exception for two never-started preparations, restoring two live run slots without deleting evidence. New server rejection diagnostics are being prepared. The owner-selected Mineflayer/TypeScript and Paper/Java stack is unchanged. Rust and Azalea code remains retired; archived refs are historical, unverified source and must not be built or integrated. Six-seed gameplay and dependent civilization integration remain gated on M1.

**Goal:** one command starts a real local six-competitor Minecraft world with independently controlled headless bots, plus a small resource-producing two-faction scenario. Scripted policies need no LLM, API key, GPU, graphical bot process, or paid bot accounts. Hundreds of active players and expert-human skill remain measured future objectives.

**Deliverables**

1. Locked Paper 26.1.2 candidate / JDK 25 / Mineflayer / Node.js 24 LTS stack and a TypeScript local supervisor. The exact Paper build and Mineflayer dependency graph are selected and tested at P0.
2. Strict declarative maps, semantic starting-state determinism, safe pristine resets, and six-seat Hunger Games rules.
3. Six-bot `run`, automated spectator and seat isolation, real movement/looting/combat, fair observations, and authoritative results.
4. D1 build determinism, D2 policy replay, D3 event-derived reporting, fault handling, and executable behavior coverage.
5. A six-player, two-faction civilization slice with legal gathering/crafting/storage/building/combat and material conservation.
6. A frozen baseline, tested stronger-policy candidate, whole-system benchmarks, justified optimization, and fresh-checkout delivery.

Human participation, `play`, graphical-client checks, Metal rendering, and protocol bridges are outside this campaign. No acceptance gate requires the owner to be present.

## 1. Charter

This document authorizes the implementation campaign, not publication or remote operation. Work in `/Users/josh/d/mc/arena` when executing from this draft-only directory; initialize Git there. If executing inside an existing Arena repository, use it and preserve unrelated work. Do not initialize Git or start implementation during preflight.

- Decide inside the bounds below, append one short decision-log line, and continue. Never ask or wait for approval during execution. Send no check-ins; finish with one report. Continue until every deliverable passes or every remaining item is parked with a concrete blocker and reproduction.
- Hard stops park the affected item: an irreversible or outside-scope action, a forbidden contract boundary, an unavailable legal/artifact prerequisite, or no usable verification loop after three attempts. Continue independent items. Pushing, publishing, spending money, public listeners, cloud provisioning, modifying unrelated saves/accounts, and destructive Git operations are forbidden.
- Implement feature completeness and behavior coverage first. Runtime/size/build budgets are measured before P3 but only the safety ceilings and egregious floors gate earlier work. Do not optimize while a required feature or parity behavior is missing or parked; finish independent feature work, then park optimization that depends on it.
- Fix a baseline failure that blocks the current item, a warm focused check exceeding 120 seconds, or a reproducible same-workload regression above 2 times baseline, in a separate scoped commit. Investigate cause first. Log other unrelated defects and leave them.
- Every bug fix begins with a minimal failing regression. Never weaken assertions, retry a flaky check to green, fabricate outcomes, use administrative combat, inject live inventories, teleport stuck competitors, or hide errors. No formatters.
- Use rolling lanes under the Campaigns section of `orchestrate`. One integrator owns shared contracts, integration, and verification; it writes no feature code while lanes run. Lanes own the largest ready coherent slices and cannot redefine schemas, versions, or another lane's files.
- Reserve **4 GiB peak RSS per build lane**, **8 GiB for the one live integration lane**, and **8 GiB host headroom**. Start with one build to measure actual peak. Width is the smaller of ready disjoint ownership sets, available agent slots, and `floor((available_bytes - 8 GiB - live_reservation) / 4 GiB)`. Reduce width if actual peaks exceed reservations. No simultaneous live servers or timed perf runs with build lanes.
- Before the first working-state write, add `.work/` to `.git/info/exclude` in the implementation repo. Worktrees: `.work/wt/<lane>`; scratch and `TMPDIR`: `.work/tmp`; caches/toolchains/downloads/worlds/traces: `.work/arena/`. There is no `.arena/` or ignored `artifacts/` state outside `.work/`. npm, Node, Gradle, JVM, downloads, generated output, and test temp roots use project-local working paths.
- A lane commits only its owned files on `campaign/<lane>`; integration occurs on `campaign/arena`. The integrator reviews, rebases, fast-forwards, and runs the touched-area checks from `.work/wt/verify-<item>` at the merged commit. Remove verification worktrees after checks. After successful integration remove the lane worktree and delete its merged branch with `git branch -d`. Parked lanes commit their checkpoint and remove the worktree, preserving the branch. Only running lanes and active verification own worktrees.
- Campaign execution authorizes local commits. Every commit is `type(scope): imperative lowercase subject`, at most 72 subject characters; item IDs go in the body. Use `!` for contract changes. Preflight makes no commits. Never push. Code comments state local reasons and never cite this plan or other planning documents.
- Keep bookkeeping minimal. Commit compact behavioral fixtures, reports, and these two logs; retain full evidence under `.work/` only while needed. No separate progress tracker, provenance register, ADR collection, or duplicate plan. Hashes are allowed only for artifact integrity, semantic identity, and trace corruption detection used by a reader.

### Failure budget and loop

One attempt is one falsifiable hypothesis followed by its narrow proof. After two refuted hypotheses bisect input/code/environment; after three recheck the actual binary, configuration, version, and first error. Limit an item to **three hypotheses or 90 minutes**, whichever comes first. Park with the cause or unknown, failed command, output, and the smallest reproduction. A dependency on a parked proof stays parked; independent seams may still be implemented. Resume only on new evidence or a changed prerequisite, never to retry the same failing approach.

An item ends on a named test/compiler check; a phase ends on touched-area suites. Full functional suites run only at the P1 completeness milestone and P4 close, because those integrate all product paths. Cold bootstrap is allowed up to 20 minutes per tool build/download step; announce expensive verification in the lane brief/log before starting it. A warm loop must target policy/spec named tests ≤5 seconds, Java named tests ≤10 seconds, bot-adapter typecheck ≤30 seconds, and an already-prepared real-server case ≤90 seconds. If a target is missed, P0 first establishes a narrower covering command; above 120 seconds the loop defect blocks work relying on it. Do not run workspace-wide builds merely to check one package.

## 2. Decisions

### Owner-decided — 2026-10-12

- **Minecraft EULA accepted for these local runs.** The owner explicitly accepted it during preflight. The executor may write local acceptance and pass `--accept-minecraft-eula` for this campaign. Shipped software still requires an operator's explicit acceptance; never enable acceptance by default for other users.
- **Paper download contact authorized:** `dankmeme133769@proton.me`. Use `Arena/0.1 (dankmeme133769@proton.me)` as the identifying User-Agent for this campaign's official Paper requests. Treat contact as operator configuration, not a secret or semantic scenario input; shipped software requires its own operator contact. Do not substitute an upstream project's contact. If contact configuration or artifact access is unavailable at execution, park dependent live proofs and continue independent work.
- **Homebrew installation is permitted when needed.** Honor suitable existing installations first; native repo-local verified toolchains remain preferred. Brew is an authorized fallback for prerequisite tools/JDK, with package/version and host change recorded. Do not use `doas`, root, change global Node defaults, or install an unrelated package manager. This supersedes the draft's unconditional ban on package-manager use.

### Owner-decided — 2026-10-13 continuation

- Continue until the entire campaign is done. The owner explicitly authorized moving the two never-started preparations `fault-plugin-identit-c85417a1-a7a7-4357-8442-57ac20702023` and `fault-second-owner-0f08ae38-34d1-44ba-97f7-d9bd80e3e11b` into `.work/arena/traces/<same-id>/retained-run`. This one-time retention exception excludes those two preparations from the run-directory count; it does not authorize moving other protected runs, deleting evidence, or changing shipped limits. Both directories retain their complete original files and identities. They remain incomplete preparations, not completed or cleaned runs.

### Prescribed

| Decision | Reason; what would reverse it |
|---|---|
| Paper **26.1.2 candidate (protocol 775)**, native **JDK 25**, Mineflayer bots on **Node 24 LTS**, one Java plugin | Mineflayer 4.39.0 lists 26.1 and its protocol data maps 26.1.2 to 775; exact Paper gameplay support still requires Arena's live proof. All clients in this campaign use the native supported protocol. |
| One TypeScript workspace (`core`, `spec`, `bots`, `runner`) and one Java project | Keep policy pure and separate from client effects; retain only package boundaries used by real dependency and test boundaries. |
| Complete Hunger Games and civilization before stronger policy/scaling/LTO/allocator tuning | All required behavior must exist before performance work; only loop repair or egregious/safety fixes move earlier. |
| `versions.lock.toml` is tool/artifact identity authority; `arena-spec` owns defaults and resolves them once into canonical IR | Prevent drift; TypeScript/Java duplicates are intentional and checked by golden fixtures, not independently defaulted. |
| Scenario/map/world-plan/control remain version **1**; revised TypeScript traces use version **2**; unknown fields, enum values, and unsupported versions fail | Historical numeric trace-v1 data remains unsupported by the revised runner. Preserve the TypeScript trace-v1 rejection fixture as a negative reader case. |
| Plugin is sole match/outcome authority; runner supervises and reconstructs reports | Two authorities can disagree; change only with a replacement design and mechanics proof. |
| Disconnect after countdown starts eliminates immediately at that tick's terminal-resolution boundary; no replacement/competitive reconnect | Bounded, testable roster contract. Before countdown, fail preparation if the declared bot roster cannot become ready. |
| All declared competitors are bots; extra joins are noncompetitive spectators | Keep unattended runs independent of user participation and enforce spectator isolation. |
| Acceptance uses ordinary headless clients and server observations | No GUI, renderer, or human-play proof is required or claimed. |
| Full state is evaluator-only; each Mineflayer instance's received world/entity data and faction entitlements govern policy and skill queries | Application caches shared across clients are not an authorization boundary. Live noninterference proof is mandatory before fair-match claims. |
| Strict owned-root path policy, fresh run directories, no hard links to snapshots | Avoid corrupting pristine worlds or escaping the repo. Revisit only with equivalent atomic/confinement tests. |

### Delegated within bounds

The executor chooses internal names/private type layout, native toolchain builds, legal loot tables, symmetric map geometry, and a minimal PRNG/JSON/CLI implementation. Tie-break: reuse an accepted maintained dependency at its boundary, otherwise prefer the smallest standard-library solution. Use private validated constructors, enum variants for lifecycle/skill outcomes, stable seat IDs, explicit tick/byte units, and distinct observation versus evaluator types. No speculative abstractions or new configuration knobs.

The integrator alone admits npm and Gradle dependencies after maintenance, license, transitive-size, standard-library alternative, cold install/build CPU time, emitted output/plugin size, and warm startup/runtime review. Mineflayer and `mineflayer-pathfinder` are accepted at the bot boundary; `mineflayer-pvp` is only a baseline/reference and is not the final combat controller. No Mineflayer objects enter policy or spec packages. Dependency budgets: warm core/spec checks remain within loop targets; plugin ≤10 MiB; a new runtime dependency adds ≤10% cold install/build CPU time and ≤5% warm-start CPU time against the preceding equivalent build, outside observed spread. There is no owned native executable-size gate. Before P3 these are recorded targets; safety ceilings still apply. If a required dependency misses them, complete parity, then optimize/remove it in P3; do not silently relax the target. An unresolved final budget parks delivery.

## 3. Baseline and foundation evidence

Preflight on **2026-10-12** found only this draft in `/Users/josh/d/mc`: no `.git`, code, AGENTS.md file, tests, prior failures, or build artifacts. The owner's Working Contract supplied in the session governs the implementation. No claim about an existing implementation is valid. All paths below describe planned files.

Host observed at preflight: macOS/Darwin arm64, 10 logical CPUs, 32 GiB physical RAM. The historical Rust toolchain reported 1.98.1; `kache`, `jaq`, and `perf-gate-ready` were available. `/usr/bin/java` was a launcher stub and reported **no Java runtime**; Gradle was absent. Operational command timings, one invocation each, not performance-gate measurements: `rustc --version` **0.05 s**, failed `java -version` **0.01 s**, immutable upstream source read **0.20 s**, authorized-User-Agent Paper metadata assertion **0.27 s**. Those preflight measurements came from the earlier Rust/Azalea campaign and do not establish the selected Node/Paper baseline. P0 must measure the selected stack, not invent results.

Primary sources checked for the revised stack:

- Mineflayer **4.39.0**'s pinned `testedVersions` and `node-minecraft-protocol` 1.67.0 both list **26.1**; Mineflayer requires Node `>=22`. `minecraft-data` maps Minecraft 26.1.2 to the same protocol **775**. These are upstream compatibility claims, not Arena's proof.
- Node's official release schedule lists v24 as LTS and v26 as Current on 2026-10-13. Use the v24 LTS line and pin its exact patch/build, unless a new official schedule and Mineflayer compatibility check changes the decision before P0 locks it.
- Official Paper docs require Java 25 for current Minecraft 26.x and an identifying download User-Agent. Paper's prior 26.2 build 133 artifact was downloaded and its SHA-256 matched the official metadata, but that artifact is not the selected Mineflayer server. Prior Java tests also used the 26.2 API; rerun them against the chosen 26.1.2 API. The new P0 must pin an exact server/API pairing and verify the server bytes.
- Python's default HTTPS reader failed certificate validation during the original source reads; native `curl` succeeded. Use the functioning system trust path; never disable TLS validation or classify a certificate failure as missing upstream support.

**Historical Foundation A, Azalea interoperability: passed on macOS arm64, but does not satisfy current D1.** The prior `./arena test --suite integration --case stack` exercised Paper 26.2 build 133 and Azalea revision `0bd22cbcdd30b611b112fc1c0a3d78535fd493a1` over protocol 776. Two clients completed login, chunk receipt, movement, chest transfer, server-observed swing and damage events, and disconnect; the wrong-protocol control was rejected in 17.34 seconds. Retain this as historical evidence only; the Mineflayer stack requires a new smoke proof. Linux x86_64 remains unverified.

**Current Foundation A, Mineflayer interoperability: passed on macOS arm64.** `./arena test --suite integration --case stack` passed at the isolated `6c553f2` checkpoint against Paper 26.1.2 build 74, protocol 775, Mineflayer 4.39.0, Node 24.21.0, and Temurin 25.0.4.1+1. Two independent clients completed login, chunk receipt, movement, chest transfer, ordinary server-observed swing/damage, and disconnect; the wrong-protocol control was rejected. The first run exposed randomized smoke-world spawns; setting the actual world spawn-radius game rule to zero fixed setup without weakening the case. Configured-map reset, competitive authority, policy replay, and per-client fairness have since passed as detailed in the acceptance report. Six-seat acceptance and Linux remain unverified.

**Foundation B, per-client observation isolation: unproven for Mineflayer.** Prove two clients with disjoint chunk/entity visibility and hidden-state perturbations against their separate Mineflayer client instances. Policies, skills, and navigation may read only their bot's received state plus explicit permitted team messages. Never label the result fair based only on isolated policy fixtures.

P0 records baseline known-reds and cold/warm loop timings for TypeScript, Node, Paper and the integration test; six-seat RSS/CPU/tick figures remain for M1. The prior code is a behavioral reference, not a runtime architecture to port. The parity reference is the **behavior specified here**, plus ordinary mechanics observed on the locked Paper server. Keep the behavior-to-test table in `docs/acceptance-report.md`. Normalize only timestamps/run IDs and genuinely unordered diagnostics, never inventories, event order, match outcomes, or decisions.

## 4. Sequence and ownership

Sizes: S ≤ half a lane session; M ≈ one session; L spans sessions with coherent committed checkpoints. A row is one end-to-end capability. F0 has separable skeleton/schema/offline checks and live smoke; if its live proof is parked, only dependents requiring that proof park. Its merged offline seams still unlock independent implementation. Every row owns its implementation tests and section in its area document. Shared manifests, locks, schemas, top-level README/AGENTS, and this plan remain integrator-owned; a lane requests additions. Adjacent ready items in the same ownership set stay in one lane. Broad-suite verification belongs to the integrator; lanes run only named changed tests and the cheapest compiler check.

| Phase / item | Size | Prerequisites | Owned files | Capability and proof |
|---|---|---|---|---|
| **P0 F0 — TypeScript foundation and loop** | L | none | Integrator: npm workspace, `arena`, manifests/locks/toolchains, schemas, `tests/integration/stack.ts`, `docs/compatibility.md`, `AGENTS.md` | Prove Paper 26.1.2 with pinned Mineflayer before locking, establish package checks and CI, implement a two-client smoke; `./arena test --suite integration --case stack`. |
| **P1 S1 — world/spec capability** | L | F0 TypeScript package/schema seam; live proof needed only for integration | `packages/arena-spec/**`, `maps/**`, `scenarios/hunger-six.toml`, `scenarios/duel.toml`, map/spec fixtures, `docs/scenarios.md` | Strict compiler, geometry/reachability contracts, semantic hashing; named spec tests plus `validate`/`build`. |
| **P1 J1 — server authority** | L | F0 control/IR seam; S1 IR for map integration | `server/arena-plugin/**`, Java fixtures/tests, `docs/rules.md` | Generation/setup/snapshot readiness, full match authority, roster/UI/outcomes; Java named tests, then real `maps-reset` and `match-rules` cases. |
| **P1 B1 — real client player** | L | F0 TypeScript/Mineflayer seam and stack; S1 minimal route/container fixture; J1 preparation/telemetry for live proof | `packages/arena-core/**`, `packages/arena-bots/**`, policy/observation/skill fixtures, `policies/baseline.toml`, `docs/policies.md` | One legal navigating/looting/eating/equipping/melee client; deterministic policy and per-client observation isolation; `legal-player` case and named core/adapter tests. |
| **P1 R1 — lifecycle and evidence** | L | F0 control/trace seam and stack; J1 handshake/events for integration | `packages/arena-runner/**`, `tests/integration/lifecycle.ts`, replay/report fixtures, `docs/operations.md`, `docs/determinism.md` | Supervision, safe reset-by-clone, CLI, authoritative logs, D1–D3 replay/report; `lifecycle`, `replay-report`, `doctor`. |
| **P1 M1 — six-seat MVP integration** | M | S1, J1, B1, R1 merged and live proofs passed | Integrator: `tests/acceptance/hunger.ts`, README, report | Six seeded matches, seat/spectator flow, frozen baseline; `hunger-six`, including automated seat and spectator checks. Identify verified MVP commit. |
| **P1 C1 — civilization server/spec** | L | M1; F0 civilization IR/rule variants committed | Same S1/J1 streams, serialized within each: civilization map/scenario/Java rules, their tests | Two-faction resource map, capture/scoring, real blueprint/material validation; spec/Java tests then server `civilization-rules`. |
| **P1 C2 — civilization client capability** | L | M1; C1 IR contract (runtime fixture need only at integration) | Same B1 stream: core/bots, `policies/civilization.toml`, team/task fixtures | Gathering/crafting/storage/building, bounded team reports and legal combat; named tests then `civilization-six`. |
| **P1 M2 — completeness milestone** | M | C1, C2 plus M1 merged | Integrator: `tests/acceptance/civilization.ts`, report | Full functional suite, all deliverables 1–5 behavior rows covered, raw six-seat resource baseline. No unresolved parity behavior permits P3. |
| **P2 H1 — hardening** | L | M2 | Same four area streams, same ownership; integrator owns cross-language goldens and acceptance | Malformed inputs, disk-full/interruption, trace truncation, fairness/cache/faction isolation, regression reduction, docs/contracts; affected-area suites and `fairness`, `faults`, `replay-report`. |
| **P3 K1 — stronger policy** | L | H1; frozen baseline and complete parity | Core/bots stream and policy fixtures/profiles; integrator owns experiment acceptance | Cooldowns, aim/spacing/retreat/hysteresis, bounded one-step lookahead only with fixture benefit; curriculum and `policy-compare`. |
| **P3 O1 — measurements and optimization** | L | H1; K1 default policy decision before final comparisons | Runner stream: `benches/**`, runner benchmark module, `docs/performance.md`; any measured adapter fix returns to bots stream | Workload fixtures, scale ladder, profile, remove measured work, compare equivalent builds; `bench` and resource assertions. |
| **P4 Z1 — close and delivery** | L | K1, O1, all functional proofs | Integrator: cleanup across landed tree, README, report, roadmap, CI | Dead-code check, ultrareview/P1/P2 fixes, final full suite, release/size/perf checks, clean-cache and warm-offline acceptance; `fresh-checkout`. |

**Width:** P0 has one contract/foundation writer plus independent source, dependency, and compatibility scouts. Pure policy, spec, client, lifecycle, and Java writers may prepare disjoint source slices during P0 once their minimal interfaces are assigned; manifests/locks remain foundation-owned, and dependent checks wait for merged seams. P1 continues those area lanes with additional disjoint review/scouting lanes as useful; actual build width follows memory. S1/J1 and B1/R1 start independent halves first and integrate their dependent halves later in the same workstream. M1/M2 each one integration lane. Civilization exposes up to three lanes (spec, Java, client) over those same streams. P2 up to four writers plus independent reviewers. P3 K1 and benchmark-harness work may run two disjoint lanes, but actual measurements run alone; an optimization touching bots waits for K1 integration. P4 one integrator plus independent reviews. No feature writer shares another lane's files.

## 5. Executable acceptance and limits

F0 implements the selectors below; these are **required future commands, not existing commands**. `./arena test --suite <integration|acceptance> --case <name>` selects one case exactly, rejects unknown names, prints evidence location, and returns nonzero on failed/blocked required checks. `--suite all` runs all functional cases, excluding benchmarks, cold bootstrap, and unavailable other-host checks. Core/spec loop: named `node:test` cases run against compiled TypeScript packages and must resolve to exactly one executed test, never zero. Bot loop adds a focused TypeScript check without starting a server. Java loop: `./gradlew --no-daemon test --tests <Class.method>` from the plugin directory. Package tests must not pull in server/network dependencies unless the named integration case requires them.

| Deliverable / case | Required observable proof |
|---|---|
| D1 / `stack` | Locked npm/Java build, two real Mineflayer clients, login/configuration/chunks/move/chest transfer/ordinary server-observed hit/disconnect on exact versions. Wrong-version negative control must fail. |
| D1,D4 / `lifecycle` | Ten start/stop cycles, no owned descendants/sockets/locks left; occupied port, bad token/version/frame, controller loss, server crash, Ctrl-C, second owner, wrong plugin identity, truthful interrupted result. |
| D2 / `maps-reset` | Three independent prepares/resets yield identical canonical IR and semantic world state; six reachable loot routes, changed parameter changes intended content, chunk/negative-coordinate boundaries; no old inventories/deaths. |
| D3 / `legal-player` | Mineflayer client navigates a real obstacle, transfers chest contents, equips, eats, and deals melee damage/receives knockback; inventory conservation comes from server state. Intent/API-call-only assertions fail this case. |
| D2,D3 / `match-rules` | Normal win, same-tick zero-survivor draw, border death, disconnect, timeout, abort, spectator, duplicate identity, eliminated reconnect, restart; actual two-bot duel and independently reconstructed result. |
| D3 / `hunger-six` | Six declared seeds `481516..481521`; every match terminates, each bot performs useful movement or is legitimately eliminated before opportunity, at least one legal loot and hit per match, no infinite stuck loop. At least one match has one survivor and at least two distinct ordinary PvP engagements. Only border deaths/timeouts cannot pass. |
| D3 / `hunger-six` seat checks | Six fixed bot seats, extra automated spectator isolation, bot death-to-spectator/result, duplicate identities, eliminated reconnect, and no competitive replacement after countdown. |
| D4 / `replay-report` | D2 identical decisions on three replays per recorded run; D3 independent report reconstruction matches outcome. Timestamp/verbosity perturbation unchanged; truncated/schema-mismatched trace fails; D1 semantic equality is checked separately. |
| D4 / `faults` | Disk-full, critical/optional queue saturation, partial initialization, signal cancellation, symlink swap/traversal, non-UTF-8 paths, stale lease, atomic-write interruption and corrupt cache; valid state or explicit invalid outcome after restart, no escaped writes or orphan resources. |
| D4 / `fairness` | Hidden enemy/loot perturbation and two-client disjoint receipt live test; same permitted inputs produce same decisions; spectator/evaluator/shared-cache/faction data do not leak. Deliberately injecting hidden state must make the test fail. |
| D5 / `civilization-rules`, `civilization-six` | Six clients, both factions useful, real log→drop→craft→chest→placed outpost chain with material conservation; legal capture/ownership change/combat with fixed bot factions; cancellation, cargo death, contention, stale plans/unobtainable materials, route invalidation. |
| D6 / `policy-compare` | Curriculum passes; 12 development seeds then 24 held-out seeds, each with swapped duel positions (48 held-out duels). Primary metric: candidate wins + half draws. Default switches only if the paired bootstrap 95% lower bound of improvement over 50% exceeds zero and no behavior regresses; otherwise baseline remains default and candidate is unproven. Report arena results on six fixed seeds separately. |
| D6 / `bench` | Correct equivalent workloads, actual activity and alive count, whole-process CPU/RSS/network/tick/latency, guarded scale rungs and same-workload A/B evidence. Maximum completed rung and overload failure are explicit, not a 256 promise. |
| D1–D6 / `fresh-checkout` | All functional suite after merge and close; native-host clean-checkout build/run from an empty project-local cache, cached offline run/replay, final owned release binary/plugin sizes, no secrets/jars/worlds in Git, no orphans, reports and commands actually reproduce. |

Development/held-out seed sets live in one experiment fixture owned by the integrator, fixed before candidate tuning. K1 may inspect development seeds; held-out results are opened only once the candidate is frozen. Bootstrap resampling is deterministic, paired by seed/position, 10,000 draws; absent supported improvement is an honest outcome and does not authorize more tuning on held-out seeds.

### Runtime safety ceilings (resolved once by runner)

| Resource | Default and breach behavior |
|---|---|
| Normal roster / test bench | Exactly 6 competitors in shipped scenarios; 4 spectators. Bench count is explicit fixture input, ≤256 and ≤`--max-bots`; the flag is only a ceiling, never a hidden scenario-roster override. |
| JVM / combined run | `-Xms512m -Xmx2g` initially. Paper+Arena combined RSS ≤8 GiB; larger benchmark requires explicit within-host budget, never above 50% physical RAM. Stop/abort before further escalation on breach or swapping. |
| Node workers / paths | Start with one Node worker for the six-bot run. At most one active path per bot; schedule replanning under one worker-wide CPU budget. `mineflayer-pathfinder` 2.4.5 defaults to a 40 ms `tickTimeout` and unlimited search radius, so choose a shorter slice and bounded radius from the pinned API and arena dimensions. Record event-loop delay. Add cohort workers only after measured load shows a need. |
| Files/downloads | Per download ≤512 MiB; dependency/bootstrap total ≤8 GiB; total `.work/arena` ≤16 GiB; require ≥4 GiB free before prepare. Exhaustion parks new preparation/downloads, never deletes evidence silently. |
| Runs/traces | At most 10 retained full runs; one run trace ≤256 MiB; segment ≤8 MiB; checkpoint every 200 observation records. At cap finalize invalid if required records cannot fit. Explicit `gc --dry-run` then `gc --apply` may delete only selected owned terminal runs, retaining latest three failures. |
| Frames/queues | Control frame ≤1 MiB, JSON nesting ≤32, incoming command queue 128, critical event queue 4,096, optional metric queue 1,024. Reject command overflow; optional drops counted; critical loss sets invalid/abort, never blocks tick thread. |
| Deadlines | Cold prepare/start ≤180 s; normal ready ≤60 s; bot operation synchronization ≤100 ticks; skill no-progress ≤100 ticks then two legal replans, fail by 300 ticks. |
| Liveness/shutdown | Heartbeat each 1 s, lease loss at 5 s; plugin aborts and initiates stop. Supervisor graceful stop ≤15 s, owned kill/reap ≤5 s more; no unrelated process killing. |
| Wall duration | Hunger run ≤600 s including waiting; civilization ≤1,200 s; each benchmark sample ≤300 s plus 60 s warmup. Operational timeout is **aborted**, never a tick-limit draw or winner. |
| World bounds | MVP 128×128; civilization 192×192; loaded-generation halo is configured view distance (6 chunks initially); pregeneration ≤1,024 chunks at ≤4 requested concurrently. Benchmark fixture may enlarge within stated disk/RSS limits. |
| Perception / team | 40-block entity range, 120° horizontal/90° vertical FOV, voxel line-of-sight; reaction 4 ticks, aim ≤30° yaw/15° pitch per tick; entity memory expires 100 ticks, stale remembered terrain remains last-observed. Team message ≤1 KiB, ≤1 per sender/20 ticks, queue 16 per receiver, age ≤200 ticks; same-faction recipients only. |

Limits may be tightened automatically for lower memory/disk. Do not increase safety ceilings or weaken fair perception to pass a check. Configuration precedence is explicit CLI > environment > scenario > typed defaults, validated once; legal acceptance and contact remain operator inputs, not scenario fields.

**Performance gates:** time-based budgets/claims run only when `perf-gate-ready` exits 0 immediately beforehand and `perf-gate-ready -1` exits 0 immediately afterward. Overlap discards the sample. If unavailable/busy, defer it, continue functional work, and record **“perf gate deferred: host busy”**; do not call delivery complete. Memory/binary-size checks always run. Profile separately from reported measurements. For A/B use at least five alternating samples per side, same release build settings/versions/workload, 60 s warmup and 120 s measurement. Report CPU-time minimum, median/range, wall latency tails, failures and actual work; treat a regression as established only above both 10% and observed spread. Six-player final target: 20 TPS, server simulation p95 ≤50 ms and p99 ≤100 ms over that window, no routine disconnects or stuck loops. If pinned APIs cannot measure simulation duration, mark that metric unverified; wall repeating-task intervals cannot substitute. Run release builds only in P3 performance work and P4 final verification.

## 6. Contract changes and non-goals

Pre-authorized: new TypeScript Arena CLI/types/schema-v1/wire-v1/trace-v2 and their documented errors; strict input rejection; the exact roster/disconnect/grace/capture/perception rules in this doc; owned cache/run writes, authenticated loopback control, local offline identities; scoped Mineflayer adapter fixes after failing regressions; dependency selection inside the stated policy; deletion of demonstrably dead new code; local campaign commits and removal of integrated lane worktrees. Implement code, tests, examples, and docs together. List each public/API/schema/permission/invariant/transaction change in the acceptance report.

Forbidden: public/off-host load, world/admin queries feeding policies, live administrative kills/items/teleports, authentication bypass, inferred EULA/contact acceptance, deleting user artifacts or force-removing dirty trees, changing old saved-data semantics, destructive Git resets, paid/remote CI provisioning, autonomous pushes. Bots connect directly to Paper on Mineflayer's native supported protocol; No protocol bridge or graphical client is in scope. Package installation is limited to the owner-authorized Brew prerequisites or repo-local artifacts.

Non-goals: human play, GUI/Metal verification, protocol bridges, full survival parity for Hunger Games (building/breaking disabled equally), expert-human certification, D4 bit-identical asynchronous live trajectory, graphical world replay, renewable civilization economy, unbounded persistent campaigns, learned/LLM policies, general terrain/template language, new rendering client, browser dashboard/MCP, separate civilization backend, interchangeable client backends, and fleet infrastructure beyond the single local supervisor. Do not add SoulFire, Baritone, Carpet, Terra, WorldPainter, Folia, Hyperion, Pumpkin, Redis, Kafka, or Kubernetes. Roadmap describes later tracks; it authorizes no implementation.

## 7. Reference: executable design

### Repository and module boundaries

```text
arena/
  arena  README.md  AGENTS.md  package.json  package-lock.json  tsconfig.json
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
  .github/workflows/
  .work/                       # excluded locally, all disposable working state
```

`arena-core`: pure policy, observation/memory/intents, PRNG, geometry, and outcome evaluation, with no runtime/network/filesystem/server imports. `arena-spec -> arena-core`: strict TOML parse/validated compiler and canonical IR. `arena-bots -> arena-core`: per-client Mineflayer observation adapter and skills, never spec/evaluator world access. `arena-runner -> spec/bots/core`: CLI, lifecycle, recording/report/bench. Java independently consumes golden-tested wire/IR and owns authoritative world rules. The evaluator's full-state types stay in runner/plugin, absent from the policy API. Typecheck/test the pure core package without Mineflayer or server dependencies.

Policy interface: `decide(observation, memory, params, random): Decision`; the return holds new memory and goal/intent, not Mineflayer objects, callbacks, or client handles. Observation unknown/stale/observed states and skill pending/progress/succeeded/failed/cancelled are discriminated unions with required payloads. Seat IDs remain stable across usernames. Slots 0–5 are bots in normal runs. A spectator has no competitive seat.

### Locked compatibility and bootstrap

F0 pins the Mineflayer release, TypeScript compiler, Node 24 LTS patch/build, and exact transitive npm graph in `package-lock.json`; runtime identity also appears in `versions.lock.toml`. Select and verify an exact official stable Paper 26.1.2 server build and matching available API coordinate, native JDK 25 distribution/build, and exact Gradle wrapper. Confirm Mineflayer's exact native protocol support from its pinned source and exercise it against the server before locking. No floating `main`, unpinned npm ranges at install time, invented SHAs/checksums, default latest-server upgrade, or protocol translation for bots.

Commit `package-lock.json`, `versions.lock.toml`, Gradle dependency locks/verification metadata, wrapper checksum, and exact Node/Paper/JDK identities. Downloads use official URLs, valid operator User-Agent for Paper, TLS verification and hash checks. A supplied Paper jar requires official-version/hash evidence before executing; absent verified metadata parks it. Keep npm, Gradle, Node and Paper caches inside `.work/arena`; after the first verified install/build, warm checks should run offline. Docs record protocol/server/API/revision/toolchain/host and proof commands. Use native macOS arm64 and Linux x86_64; Linux arm64 is future feasibility, not a claimed supported target without a build/run. A missing second host leaves its checks unverified, not silently passed.

`./arena` is a thin POSIX entrypoint that selects exact package/test cases and starts the local Node supervisor. Respect network/proxy environment; do not change global Node defaults. CI starts with offline core/spec checks, separate Java and Mineflayer protocol jobs, and prerequisite-controlled real-server jobs; heavy acceptance/bench runs are explicit/manual. Pin action/tool versions from real sources; failed/missing required prerequisites fail the job. No formatter job or recurring paid cloud task. Add fixed-seed property cases at owning boundaries for geometry/transforms, strict validation, per-bot isolation, inventory conservation, terminal states and reconstruction. Bounded parser/control/trace fuzz cases cover one-byte reads, repeated fields, lengths/oversized integers, non-finite floats, unknown versions, traversal and truncation; keep per-case development runs within the narrow loop. Every claim must have an oracle assertion that fails under a deliberate wrong output, not just a call or a generated fixture echoed back.

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

Map is 128×128 safe floor, modest height/cover/landmarks/open fights, six central-ring spawns, central loot and alternate routes. Avoid initially untested water/ladder/door/partial-block/deep-cave routes. Bounded cuboid/fill, wall/hollow box, path/ramp, spawn group, loot container, translated/right-angle prefab and seeded cover/loot variation suffice. TypeScript resolves all PRNG decisions to chunk palettes/runs and setup records; Java never repeats the generation RNG or runs per-block RCON.

Paper public `ChunkGenerator` consumes immutable order-independent IR on generation workers; mutable containers/block entities/gamerules are setup on the server thread. Disable unrelated vanilla phases. Validate spawn support/headroom/separation, traversable central/loot routes, valid inventories/chunk boundaries/negative division, fair starting access and reachable final border zone. Pregenerate area plus view-distance halo, finish lighting/setup/readiness, save and stop cleanly before snapshot. Prevent portals/spectators from unbounded generation; outside arena is deterministic cheap terrain.

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

Separate idle connections; active navigation/container; repeated active duel/team-combat soak; elimination matches with alive population; dispersed civilization resource/building. A respawning soak is explicitly a different workload. Bench command is `./arena bench --workload active-combat --counts 6,16,32,64,128,256 --max-bots 256`; generated fixtures declare their roster/map/rules, never mutate shipped six-seat TOML silently. Start at six; escalate only after one rung succeeds. Each scale rung uses three samples; whole bench command wall budget is 60 minutes and its deadline returns the highest completed rung. Five alternating samples per side are reserved for the required same-workload A/B comparison, which may use a separate 60-minute command. A benchmark deadline reached between rungs is an honest bounded result; a timed-out sample is not a pass. Stop if combined RSS exceeds limit, free memory falls below 4 GiB, swapping appears, disconnects exceed 1%, or TPS <15 for 10 seconds. Highest completed rung and limiting resource are the result; 256 need not succeed. Warmup/measurement/activity assertions apply to each rung.

Record host/cores/RAM/config/version/build/scenario/policy semantic IDs, worker counts, instrumentation, process CPU time, summed RSS (not unique physical memory), Node heap and JVM heap separately, event-loop delay, bandwidth/packets, tick simulation percentiles where genuinely available, path replanning backlog, decision/skill latency, corrections/stuck/reconnect/failure counts and log size. Sample optional metrics without perturbing policy inputs; measure instrumentation overhead separately.

Profile before optimizing. Remove redundant work/copies/serialization/searches; add spatial indexes/caches only for measured dominant operations with knowledge-safe invalidation. Default remains portable headless, no display/GPU/assets per bot. Keep necessary physics/network/inventory. Node worker/cohort changes, GC flags, native path search and packet/world-cache changes are P3 experiments; do not strip per-bot observation isolation to save time. A focused upstream patch needs a retained regression and license/attribution; no whole-stack rewrite. If no safe measured opportunity exists, report why no optimization was justified.

Z1 deletes temporary instruments/dead paths after checking callers, configs, docs and persisted evidence consumers. Keep the frozen baseline as a live evaluation reference. Run `ultrareview` over implementation, fix P1/P2 findings with narrow regressions then recheck touched areas. Read its explicit-only skill from the installed skill path at execution; if unavailable, perform equivalent independent API/type/durable/lifecycle/fairness/verification reviews using available agents and record that substitution. No cleanup before liveness evidence, no compatibility shims without consumers.

README begins with actual `doctor`, `bootstrap`, `validate`, `build`, `run` commands and expected results; then exact tests/bench commands. Required tools also include `replay-policy`, `report`, `inspect`, `compare`, `gc --dry-run|--apply`, usable help, JSON errors and documented exit codes. Print concrete created run paths for subsequent commands; never leave `RUN_ID` as purported runnable evidence. Fresh acceptance uses a clean checkout under `.work/wt/fresh`, its own `.work/` cache and TMPDIR, then warm offline operation. Do not commit jars, secrets, enormous worlds/caches/traces. Selected compact evidence lives in fixtures/reports for future readers; full disposable evidence is referenced as local, not promised to survive checkout.

`docs/acceptance-report.md` lists exact verified commits, versions/host, each item passed/failed/parked with command and evidence, all contract changes, real six-bot outcome and runnable automated commands, reset/replay/isolation results, policy comparison sample/uncertainty, whole-system measurements/rungs, civilization conservation/build/combat proof, other-host status, known defects/reproductions and remaining prerequisites. Human-client and renderer documentation is outside this campaign.

`docs/roadmap.md` is grounded in delivered measurements: competitive movement/ranged/shields/terrain/tactics and human calibration; renewable economy/logistics/persistent faction depth; measured active-player bottlenecks before alternative engines/workers; optional learned goals with budgets/cancellation/evaluation; strict scheduling/barriers only after D1–D3. Finish this campaign before implementing roadmap tracks.

### Primary sources

Use exact locked source/API for implementation. Mutable links below are research entry points, not reproducible version locks.

- [Mineflayer 4.39.0 version support](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/lib/version.js), [4.39.0 runtime/dependency metadata](https://raw.githubusercontent.com/PrismarineJS/mineflayer/4.39.0/package.json), [node-minecraft-protocol 1.67.0 versions](https://raw.githubusercontent.com/PrismarineJS/node-minecraft-protocol/1.67.0/src/version.js), [26.1.2 protocol mapping](https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json), [mineflayer-pathfinder 2.4.5 scheduling defaults](https://raw.githubusercontent.com/PrismarineJS/mineflayer-pathfinder/2.4.5/index.js), [basic PvP plugin](https://github.com/PrismarineJS/mineflayer-pvp).
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces).
- [Paper Java requirements](https://docs.papermc.io/paper/getting-started/), [plugin setup](https://docs.papermc.io/paper/dev/project-setup/), [official downloads requirements](https://docs.papermc.io/misc/downloads-service/), [26.1.2 chunk generator API](https://jd.papermc.io/paper/26.1.2/org/bukkit/generator/ChunkGenerator.html).

## 8. Decision log

Append one line per execution judgment that a reader would otherwise miss: date, item, decision and reason. Owner decisions and prescribed choices above are already recorded; do not duplicate them here.

Decisions dated 2026-10-12 are historical and are superseded where they select Rust, Azalea, or Paper 26.2 for bots. Their evidence remains valid only for the exact earlier stack.

- 2026-10-13 — M1 continuation at `0672d9a`: prioritize the owner's six-player steering; reproduce checkpoint scheduling and policy responsiveness deterministically, reopen ramp navigation only with bounded live diagnostics, and account for path searches separately from following. Preserve the locked stack, gameplay floors, local failure evidence, and serialized Paper ownership. GitHub Actions work is omitted by the owner's later instruction. Current review classifications are recorded in the acceptance report.
- 2026-10-13 — Steering source verified at `761916d`: recorded-decision checkpointing, one-owner preemption with bounded cleanup, v2 local failed-target feedback/replay, pending exploration persistence, and pinned AStar compute scheduling are integrated. The real baseline border-preemption selector passed, including independent outcome inspection and 62 exact replayed decisions. The authority reader's missing v2 classification, position-flag recorder mismatch, and shutdown pipe race were reproduced and corrected with retained regressions. No dependency, backend, performance campaign, or GitHub Actions work was added.

- 2026-10-12 — P1: start independent S1, B1, and R1 offline halves after the F0 workspace/schema seam merged, because these paths can progress without the still-pending live stack proof; defer their proof-dependent integrations.
- 2026-10-12 — P1: admit parse-only `toml_edit`, `serde`, `serde_json`, and `sha2` for source-aware TOML validation, strict JSON evidence, and SHA-256 identity/checksums; all versions were already locked, so the graph adds no package versions; record release-size and startup budgets for P3 because this offline slice forbids release builds.
- 2026-10-12 — P1: use the already locked Gson 2.14.0 for strict streaming reads of resolved world plans; declare it directly for compilation and Java test runtime, with no package version added to the graph.
- 2026-10-12 — F0: check in the generated Gradle 9.6.1 wrapper, pin its JAR hash in `versions.lock.toml`, and verify its URL and distribution checksum against that authority before use; require strict dependency verification with the committed lock and metadata.
- 2026-10-12 — P0: reserve the live stack smoke for one lane after the wrapper build and all offline P1 slices finish; keep other builds idle while the server is running.
- 2026-10-12 — P0: use Azalea's dedicated tick broadcaster after buffered client ticks let the smoke exit before its attack reached Paper; the rerun passed every stack marker and wrong-protocol control.
- 2026-10-12 — P1: stage the resolved map plan before Paper starts so its generator can read it during world loading; reserve control frames for scenario rules and roster metadata. Admit JUnit Jupiter 6.1.3 for named Java tests as test-only dependencies.
- 2026-10-12 — P1: keep Paper API and Gson production `compileOnly`, add them to Java test compile/runtime, and lock the resolved Paper test graph with strict checksums so generator tests run without bundling server APIs.
- 2026-10-12 — P1: cap each chest inventory at 27 one-item entries in the map and resolved-plan contracts because one entry occupies one of the chest's 27 slots; the Rust compiler owns the limit and a drift test checks both schemas and the user-facing docs.
- 2026-10-12 — P1: cap resolved world-plan JSON at 128 MiB and pregeneration at 8,192 chunks to bound staging, parsing, and startup while covering the declared 192×192 map and 32-chunk view distance.
- 2026-10-13 — J1: require the protocol fixture to be selected with `-Darena.test-fixture=true`; missing plan configuration must fail instead of silently starting the smoke world.
- 2026-10-13 — campaign reset: replace Rust/Azalea with Mineflayer and TypeScript because the expected maintenance risk was understated and there is no measured workload evidence that justified the Rust client cost; keep Paper's Java plugin as game authority and require new P0 compatibility/isolation proofs.
- 2026-10-13 — compatibility: target Paper 26.1.2 with Mineflayer's advertised 26.1 protocol support and Node 24 LTS; test ViaVersion only for the optional 26.2 GUI client because protocol translation alone does not prove movement, inventory, and combat behavior.

- 2026-10-13 — scope: complete unattended bot-only runs and automated spectators; remove human play, GUI/Metal, and ViaVersion work because no owner participation is available.

- 2026-10-13 — trace version: use trace-v2 for revised decimal-string sequences and JavaScript checksum rules; the revised reader rejects numeric trace-v1, covered by its negative fixture.
- 2026-10-13 — Rust retirement: remove the old Rust runtime and readers from the current tree after the Mineflayer/TypeScript replacement; preserve `campaign/b1-live` and `campaign/r1-stage` only as unverified historical checkpoints, not as active or accepted implementation.
- 2026-10-13 — scheduling: prepare pure civilization domain and capture-rule modules on isolated branches while the Hunger Games supervisor is assembled; their merge and live acceptance remain gated on the six-seat MVP.

## 9. Campaign log

Append one line per phase end: date, merged checkpoint, checks passed, parked items and reason. No continuous progress diary. A blocked milestone is explicitly blocked, never a passed gate with prose caveats.

- 2026-10-13 — P1 M1 blocked at `c8c3e4e`: configured resets, ordinary duel, Hunger fairness, and several authority variants passed; legal-player food loss passed but precise ramp navigation timed out without a proven source cause. Park the six-seat MVP and its dependent integrations; continue independent authority, lifecycle, replay/report, and runtime-failure proofs. Reproduction and resume condition are in the acceptance report.

## 10. For the owner afterwards

- Read README for exact bootstrap/run commands and acceptance report for tested versus parked claims.
- Read contract changes, policy comparison, performance results, platform limitations, and roadmap.
- Inspect/cherry-pick coherent commits from `campaign/arena`; parked lane branches are named in the report. Nothing awaits owner approval to finish local execution.
- Launch prompt: **Continue `minecraft-arena-agent-campaign.md` unattended from the documented M1 block; honor owner decisions, continue independent proofs, resume M1 only when its stated evidence prerequisite changes, and never push.**
