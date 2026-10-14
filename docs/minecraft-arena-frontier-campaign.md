# Arena Frontier: from a six-bot experiment to competitive worlds

**Status:** winding down. Written against `master` at `f479b16` (2026-10-14). It supersedes `docs/minecraft-arena-agent-campaign.md` and the root `minecraft-arena-agent-campaign.md`; item G0 deletes both.

**Goal.** The owner opens an ordinary Minecraft client and plays against capable, fair opponents in a large Hunger Games match, or joins a faction whose economy, construction, reconnaissance and military decisions continue without them. Headless, scripted, no LLM, no paid inference, no GPU, no public listener.

**Deliverables**

1. **D1 Hunger 24.** Natural 1024 × 1024 seeded terrain, 24 competitors, all-bot or one external human plus 23 bots, competent movement, equipment, survival, melee and bows.
2. **D2 Human admission.** `play` and `watch`. One exact-identity external competitor on loopback, same rules as a bot.
3. **D3 Mechanics.** A measured action funnel, fractional combat geometry, an engage skill, and a live mechanics curriculum.
4. **D4 Frontier War.** A real resource economy, functional construction, squads, typed treaties, human faction orders. Two factions of 6, four of 8, four of 16.
5. **D5 Persistence.** Clean checkpoint and resume of a faction session.
6. **D6 Skill laboratory.** Seed manifests, frozen-opponent league, bounded CPU-only tuning, a default-policy decision.
7. **D7 Capacity laboratory.** Worker cohorts, a workload matrix to 256 competitors, measured qualifying capacity per workload.
8. **D8 Delivery.** Fresh-checkout build, README walkthrough, one acceptance report that separates implemented, verified, certified and open.

---

## 1. Charter

The executor has this document and the repo. It runs from G0 to the last item without asking anything.

- **Decide, log, continue.** Make the smallest reversible choice inside the bounds below and append one line to the decision log. Never ask, never wait for approval, send no check-ins. Run until every deliverable is met or every remaining item is parked.
- **Hard stops** park the item and nothing else: an irreversible action, anything outside the repo and `.work/`, a boundary this document forbids, a loop that cannot check the item. Pushing is always forbidden. Park by committing the item's checkpoint on its branch, writing a reproducer in the campaign log, and moving to the next item that does not depend on it.
- **Time-box.** Three failed attempts at one item, each from a new diagnosis, then park. A flaky check is never retried to green; a predeclared repeated experiment is not a retry.
- **Cause before fix.** Inspect the first wrong value, not the final timeout (`root-cause`). A bug fix starts with a minimal failing test and keeps it. A live reproduction may be the first test when the defect has no offline form; retain a compact fixture afterwards. Never weaken a test, drop a seed, extend a deadline or redefine success to pass. A test changes only when its contract is wrong, with the reason in the commit body.
- **Parity before optimization.** Phases P1 and P2 finish every feature and every test. Performance budgets in P1 and P2 are measured and logged, never gating. Item O1 and later are the only optimization work.
- **Fix on the way** what is egregious, in its own `fix` commit: a warm focused command over 120 s, a same-workload regression over 2× baseline, a baseline-red test that blocks the item. Record anything else and leave it.
- **Honest labels.** Implemented, behavior verified at N, capacity certified at N, and open limit are four different things. A headless surrogate is not an expert human. Configuration support is not capacity. An action admission rate is not hit accuracy.
- **Bookkeeping is small.** This document, updated area docs, one acceptance report, compact fixtures a reader uses. No tracker, provenance register, hashes or manifests unless a reader or failure needs them.
- **No code comments.** Put the reason in a name, type or test. A surviving comment states its own constraint and never cites this document, an item ID or a phase. Delete failing comments in files you touch.
- **Commits.** Local commits are authorized. Each is a Conventional Commit `type(scope): subject`, scope = workstream or area, item ID in the body, `!` for a contract change, ending with the attribution trailer the session supplies. No formatters. Never push.
- **Working state** lives under `.work/` (already in `.git/info/exclude`). Lane worktrees: `.work/wt/frontier-<lane>`. Scratch and `TMPDIR`: `.work/tmp`. Never `/tmp`. The eleven existing `.work/wt/*` directories (`civ-*`, `natural-*`, `opening-style-evidence`) are not registered worktrees; leave them alone and never reuse their names.
- **Branches.** Integration branch `campaign/frontier` from `master`. Lane branches `campaign/frontier-<lane>`. A lane commits only files it owns. The coordinator rebases, fast-forwards, runs the touched-area checks on the merged tree, then `git worktree remove` and `git branch -d` the lane. A parked lane keeps its committed branch, not its worktree.
- **Width and memory.** Host: 10 CPUs, 32 GiB, 84 GiB free disk at preflight. Static budget: 4 GiB per offline lane, 8 GiB for the one live-integration slot, 8 GiB headroom, so at most four offline lanes plus the live slot. Do not poll host memory. Phase width is the smaller of ready disjoint ownership sets and four.
- **One live Paper at a time.** Live runs and timed measurements are serialized by the coordinator (one port, one measurement). Lanes work offline in parallel; the coordinator owns the live slot and hands results back.
- **Disk.** No free-space gate. When free disk is under 20 GiB, run `./arena gc --dry-run`, then `./arena gc` on the owned terminal runs it lists. Never delete another path.
- **Perf gates.** A time-based measurement (TPS, tick percentile, startup, runtime) runs only when `perf-gate-ready` exits 0, and again with `-1` straight after; an overlapped run is discarded. A busy host defers the gate: write "perf gate deferred: host busy", continue functional work, and do not call the campaign done. Memory and binary-size gates always run. Prefer CPU time, min of N, interleaved A/B, and fail only above the observed spread.
- **Dependencies.** Allowed when a measured bottleneck or observed incompatibility justifies them. Each new runtime dependency is vetted (maintenance, license, transitive weight, whether the standard library or a few lines would do) with the reason in the commit body, and must keep: cold install/build CPU +10% or less, warm start CPU +5% or less against the preceding equivalent build and outside the spread, plugin jar at most 10 MiB. State the measured impact. Remove a dependency you stop using. No automatic upgrades; Paper, Minecraft, Java, Gradle, pnpm, TypeScript and Mineflayer pins do not change.
- **Test-first loop.** An item ends on the narrowest check that covers it (one named case, one package build). A phase ends on the checks of the areas it touched. The full offline suite and the live set run at the milestones named in the Sequence.

---

## 2. Decisions

### Owner-decided

| Date | Decision |
|---|---|
| 2026-10-14 | This document is the execution brief and supersedes the predecessor's milestone order, six-competitor limit, two-faction limit and ban on external human competitors. It does not relax loopback-only operation, observation fairness, ordinary mechanics, owned-path safety, explicit EULA handling or honest evidence. |
| 2026-10-14 | Bump the Node.js lock from 26.8.2 to 26.11.1. The locked 26.8.2 cannot start on this host (the Homebrew Cellar copy lacks `libsimdjson.33.dylib`) and `./arena` refuses any other version. |
| 2026-10-13 | Seeded vanilla 1024 × 1024 Hunger terrain; scenario seed is the world seed; prepare only spawn, cache and view-halo chunks. Three opening styles rotate across seeds and seats. Policies see only their own client's observations and permitted border state. |
| 2026-10-13 | Host run-count, free-space, aggregate-size, host-memory, RSS and swap admission gates are removed and stay removed. Per-operation parser, frame, queue, search, trace and filesystem bounds stay. |
| 2026-10-12 | The Minecraft EULA is accepted for local runs; pass `--accept-minecraft-eula`. Shipped software still requires explicit operator acceptance and never defaults to it. Paper downloads use the contact already configured in `./arena`. Homebrew is a permitted fallback for prerequisite tools only; no root, no global runtime-default changes. |
| 2026-10-13 | pnpm-only packages, Node runtime and tests, TypeScript 7, Oxlint with tsgolint, Effect 4 only at real I/O boundaries (`runPreparedRun`). |

### Prescribed

| Decision | Reason; what reverses it |
|---|---|
| Keep Paper 26.1.2 build 74, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, one Java plugin, four TypeScript packages with today's boundaries | Rebuilding the stack is the largest schedule risk and nothing observed contradicts it. Reverse only on a reproduced incompatibility. |
| The plugin stays the only match and outcome authority. It observes mechanics and never steers, equips, heals, teleports or creates favorable outcomes. | Two authorities disagree. |
| Competitor ceiling 256 (seats 0–255, matching `packages/arena-core/src/observation.ts:38`). Spectators use a separate identity space and never consume a seat. No 512 claim. | The existing core bound; widening needs a separate identifier migration. |
| New behavior ships as **new schema versions**: scenario 3, world-plan 3, control wire next, trace 4. Old readers stay strict and keep reading frozen fixtures. | Old schemas must not silently accept new fields. |
| Reuse the existing `competitive-v1` perception profile (120° horizontal, 90° vertical, 40 blocks, voxel line of sight; `docs/fairness.md`). A reaction delay or turn-rate limit is a new profile version, added only when a curriculum row needs it and never to the optimized variant alone. | The profile already exists and is tested; code today enforces no reaction delay or turn-rate limit. |
| Human admission binds an exact username and offline UUID reserved in the roster before countdown. A wrong or duplicate identity is rejected. Join wait is bounded (default 120 s, then the run fails before countdown). Competitive disconnect eliminates the seat at the tick boundary; no competitive reconnect; an eliminated player is a spectator and cannot re-enter. | Replaces today's "any non-runtime username counts" gate (`external-player-gate.ts:62`). |
| `save` settles active skills, stops Paper cleanly, copies the stopped world, publishes the manifest last, and ends the session. `resume` starts a new runtime epoch from the checkpoint. There is no live pause. | Copying a live mutable world is inconsistent. Reverse only if a Paper tick-freeze proves safe and the product needs live pause. |
| Unexpected worker loss applies the ordinary disconnect rule to that worker's seats, marks the run `degraded`, and excludes it from league and capacity statistics. | One declared fault policy; never a silent reconnect of a "same" actor. |
| Economy profile enables natural random ticks only in the new Frontier scenarios. A shortened growth fixture is a separate, labeled test and never proves ordinary-time food sufficiency. | Frozen Hunger semantics must not change. |
| League unit: one hunger-six natural match, three candidate seats against three opponent seats, seats rotated. Candidate score is 1 for last survivor on the candidate side, 0.5 for a draw, 0 otherwise. Promotion needs mean ≥ 0.65 and a 95% interval lower bound above 0.5, grouped by world seed, with no material regression in the mechanics, fairness, survival or task gates. | Head-to-head, not a six-player free-for-all rate. |
| Seed manifests (`evaluation/seeds-v1.toml`): mechanics regression set `481516..481521` (existing); development `500001..500012`; held-out `600001..600024`. The predecessor never defined its 12/24 seeds; these replace the reference. A held-out set is evaluated once per frozen candidate set. After any held-out result informs a change, retire it to development and draw `700001..700024`. | Prevents tuning on held-out data. |
| Tuning budget: at most 5 candidates, 12 development seeds, 2 seat swaps, 3 rounds. On a plateau keep the best verified candidate, record the next experiment, stop. | A finite budget; no hidden compute. |
| Hunger-24 gates (fixed now; G2 numbers may tighten them, never loosen): across `481516..481521`, every match terminates with a valid outcome; at least 75% of seats loot a chest; at least 40% of eliminations are PvP; at least two distinct engagements per match; at least one confirmed bow hit in the suite; no seat idle for more than 600 ticks without a recorded legitimate waiting reason. | A tournament that idles into border death is a failed gate. |
| Static-mechanics admission gate: under 5% self-inflicted admission failures on eligible controlled opportunities, with at least 20 issued actions and 10 attributed damage events per case. Moving-target cases report the funnel without a rate gate. | Paired with minimum work so "no attacks" cannot pass. |
| Capacity floors (§7): 20 TPS target, per-tick service p95 < 40 ms and p99 < 50 ms, engaged-worker event-loop delay p99 < 25 ms, at least 90% of living eligible actors useful or with a verified waiting reason, no unbounded queue growth, no silent critical evidence loss. | Fixed before measuring; never moved after a failure. |
| `skills.ts` is split first (item M0): civilization-only handlers move to `civilization-skills.ts`, owned by the civilization lane. | One 1,300-line file owned by two lanes is the dominant merge risk. |
| Rule modes are new scenario values: `frontier_survival`, `squads`, `frontier_war`, each versioned. `classic` is the existing `hunger_games`. No frozen scenario changes meaning. | Frozen baselines must stay reproducible. |

### Delegated (decide inside the bound, log it)

- Names, private type layout, internal file splits, loot tables, map geometry, prefab layouts, PRNG stream layout.
- Tactical cadence: start at every 2 ticks for engaged actors, strategy about every 20 ticks, squad and economy planning about every 40 ticks or on an event. Expose only knobs an experiment uses.
- JVM heap for large rosters: start `-Xmx2g`; raise per workload, record the value with the result.
- Scenario tick budgets: `authoritative_max_ticks` in 6,000–12,000 for Hunger-24, 18,000–36,000 for Frontier War; wall limit 1.5× tick budget at 20 TPS plus 120 s.
- Worker count per workload: pick by the one/two/four comparison in O1 on identical workloads.
- Tie-break for any unlisted choice: reuse an accepted dependency at its boundary, otherwise the smallest standard-library solution. No speculative abstraction, knob or compatibility shim.

---

## 3. Baseline (measured 2026-10-14 on `f479b16`, macOS arm64, 10 CPUs)

**The loop is red on this host before any work.** `./arena build`, `check` and `test` exit with `Node.js version mismatch: expected v26.8.2, got v26.11.1` (`arena:87`). G0 fixes it. The numbers below ran the same scripts directly under Node 26.11.1.

| Command | Time |
|---|---|
| `node scripts/typescript-build.mjs core` / `bots` / `all` (warm) | 0.4 s / 0.7 s / 1.2 s |
| One named core or bots test via `scripts/run-named-tests.mjs` | 0.7–1.0 s |
| Offline suite, 57 compiled files, `node --test --test-concurrency=4` | 22 s, 447 tests, 438 pass, 9 fail |
| `oxlint --type-aware --quiet packages tests` | 0.7 s, no errors |
| `integration stack` (live, recorded under 26.8.2) | 14.9 s; not re-measured |

**Known reds on the offline baseline (9).** G1 classifies each as a bug or a superseded contract.

| Test | Observed cause |
|---|---|
| `client waits for a received full inventory snapshot…`, `clients keep inventory snapshots…`, `runtime policy input is accepted…` | `entity.getDroppedItem is not a function`: stale mocks |
| `creates at most ten immediate owned runs under concurrent creation` | Tests the removed run-count gate; superseded, delete with the reason |
| `geometry uses exact distances for safe integer coordinates` | Wrong squared-distance value; unclassified (`geometry.test.ts:40`) |
| `coordinate overflow returns an explicit hold…` | Returns `explore` instead of `wait unrepresentableTarget` |
| `control frames use one big-endian length…` | Deep-equal mismatch, unclassified |
| `report accepts a same-tick zero-survivor draw…` | `elimination_after_public_state` thrown |
| `runtime trace persists actual pending records…` | `source` is a null-prototype object under Node 26.11.1; likely version-induced |

**Open live failures (not re-run):** `civilization-rules` times out waiting for seat 1 to observe a mined block (run `b7e91e9e`, Paper checkpoint at tick 2716 shows the sixth oak log absent and one dropped item); server-crash cleanup ended with a cleanup failure; no clean live SIGINT proof; five of six natural seeds have no live terrain check; no current-source full suite, benchmark, fresh-checkout or Linux run.

**Reference numbers for D3.** Frozen six-seed run: 6,231 attack actions, 5,576 `preconditionsNotMet` (89.5%), 339 succeeded, 341 local damage events. Fixture: `tests/fixtures/hunger-six-baseline/` (`481516.json`–`481521.json`, `hunger-six.tap`, `hunger-six-recheck.tap`). The frozen commit `296c3c9` no longer resolves in this history; the fixture is the evidence. Current-source recheck: five wins and one draw. These are action outcomes, not hit accuracy.

---

## 4. Sequence

Items are capabilities a lane delivers end to end. A lane takes several in a go. Prerequisites that cross workstreams are written on the item.

### Workstreams and ownership

| Workstream | Owns |
|---|---|
| **INT** (coordinator) | `AGENTS.md`, `README.md`, `versions.lock.toml`, `package.json`, `pnpm-lock.yaml`, `docs/compatibility.md`, `docs/acceptance-report.md`, `scripts/**`, `arena`, `tests/acceptance/hunger*`, `Makefile`, this document |
| **SRV** | `server/**` except `Civilization*.java`, `packages/arena-spec/**`, `packages/arena-runner/src/control/**`, `schemas/**`, `maps/**`, `scenarios/**`, `docs/{rules,scenarios,protocol}.md` |
| **MECH** | `packages/arena-core/src/{policy,observation,geometry,replay,random,outcome}.ts`, `packages/arena-bots/src/` except `civilization-*`, `policies/**`, `fixtures/policy-curriculum/**`, `docs/{policies,fairness}.md`, `tests/integration/{legal-player,policy-border-preemption,fairness,curriculum-*}.ts` |
| **CIV** | `packages/arena-core/src/civilization.ts` and new `economy/`, `packages/arena-bots/src/civilization-*.ts`, `server/**/Civilization*.java`, `packages/arena-runner/src/runtime/civilization-adapter.ts`, `tests/integration/{civilization-*,frontier-*}.ts`, `tests/acceptance/{civilization*,frontier*}`, `docs/civilization-acceptance.md` |
| **RUN** | `packages/arena-runner/src/` except `control/` and `civilization-adapter.ts`, new `workers/`, `league/`, `bench/`, `checkpoint/`, `docs/{runtime,operations,determinism,filesystem}.md`, `tests/integration/{lifecycle,faults,replay-report,checkpoint-resume,worker-fault}.ts` |

A shared file goes to one owner. A lane that needs a change in another stream's file adds a small request item to that stream; wire and schema changes go to SRV. New named cases are one appended row each in the case registry of `scripts/run-named-tests.mjs`; the coordinator resolves conflicts.

### P0 — Ground (INT; widest: 1 lane, then the live slot)

| ID | Size | Prereq | Delivers and proof |
|---|---|---|---|
| **G0** | M | — | Node lock bumped to 26.11.1 in `versions.lock.toml`, `README.md:7`, `docs/compatibility.md`, `docs/acceptance-report.md`. Integration branch created. This document moved to `docs/minecraft-arena-frontier-campaign.md`; both predecessor files deleted; the `AGENTS.md` campaign link repointed; the `AGENTS.md` invariant "Arena adds no human competitors" and "competitors headless" rewritten to "bot competitors and automated spectators are headless; one external ordinary client may occupy an admitted competitive seat on loopback; Arena adds no GUI, renderer or protocol bridge". Proof: `./arena doctor`, `./arena check compatibility`, `./arena build --package all`, `./arena test --suite integration --case stack` under 26.11.1. If `stack` fails under 26.11.1, park everything live and report; offline lanes continue under direct scripts. |
| **G1** | S | G0 | Offline suite run through the real launcher; each of the 9 reds fixed or superseded with a stated reason; `./arena check lint` clean of errors. Proof: suite at 447 or more tests, 0 fail. |
| **G2** | M | G0 | Live baseline, serialized: `legal-player`, `hunger-six` on seeds `481516..481521` natural terrain, `civilization-rules` with block-packet and local-block diagnostics preserved in the failure artifact, `faults-sigint`, `faults-server-crash`. Record duration per case. Proof: results in the acceptance report; failures stay failures with reproducers. Runs alongside the first wave of P1; offline lanes do not wait. |

### P1 — Parity and completeness (widest: 4 lanes, plus the live slot)

Wave 1 starts after G0. Wave 2 starts as each prerequisite merges.

| ID | WS | Size | Prereq | Delivers and proof |
|---|---|---|---|---|
| **S1** | SRV | L | G0 | Versioned roster, controller kind, factions, rule modes, limits to 256. Every six-seat bound audited and generalized: `scenario.ts:734`, `world-plan.ts:134`, `control/codec.ts:374`, Java `MapPlan.java:20`, `ControlProtocol.java` (278, 599, 662, 977, 1133, 1188, 1323, 1705, 1726), `MatchController.java:217`, `CivilizationMatchController.java` and `ArenaFoundationPlugin.java:924` (these two are CIV's; S1 only raises their bounds, merged before C1). Golden cross-language fixtures for the new roster. Validate-only `scenarios/hunger-24.toml`, `frontier-war-64.toml`, and a 256-seat boundary fixture. Proof: `spec` and `protocol` named cases, `java` unit, `./arena validate` on each scenario, old schemas reject new fields, frozen fixtures still read. |
| **M0** | MECH | S | G1 | Civilization-only handlers extracted from `skills.ts` into `civilization-skills.ts`; no behavior change. Proof: existing `bots` and civilization tests pass unchanged. |
| **M1** | MECH | L | M0, G2 | Action funnel with typed reasons (opportunity → choice → admission → local validation → issued → client response → evaluator-confirmed effect); fractional combat view (validated finite floats, integer block identity kept); engage skill coordinating pursuit, spacing, aim and attack under the existing exclusive skill owner; root cause of the 89.5% rejection shown by a failing test before the fix; the 3-block adapter reach (`skills.ts:40`) against the 4-block documented fight range (`docs/policies.md:71`) reconciled by one named constant. Curriculum rows 1–6 of §6 offline and live (`curriculum-melee`). |
| **S2** | SRV | M | S1 | Plugin binds exact username and UUID per seat before countdown; rejects wrong and duplicate identity; living competitor cannot become spectator and back; eliminated players cannot re-enter; spectator IDs never consume seats. Proof: `match-rules-*` cases plus new `external-seat` server rows. |
| **R1** | RUN | L | S1, S2 | `./arena play` (substitutes one configured bot seat) and `./arena watch` (never consumes a seat), bounded join wait, cancellation cleanup, stderr connection and phase messages, run ID and evidence path on failure, an unattended protocol surrogate client. Proof: integration case `external-seat` covers loot, damage, damage taken, death, win, wrong identity, duplicate identity, timeout, cancellation, spectator attempt, late reconnect. |
| **R2** | RUN | M | M1 (types), S1 | Funnel and proposed-versus-accepted records in trace 4 and the report; `./arena explain --run-id --seat`; bounded per-bot diagnostic rings that flush on failure. Proof: `replay-report` extended; old trace readers still reproduce `tests/fixtures/hunger-six-baseline`. |
| **M2** | MECH | L | M1 | Bow controller (draw, release, ammunition, bounded lead from observed velocity, occlusion, friendly fire), shield use and counterplay, safe eating window and retreat, border-plus-knockback recovery, natural obstacle course, contested chest and drop, changed route, exhausted-memory recovery: curriculum rows 7–14. Proof: `curriculum-ranged`, `curriculum-survival` live; offline regressions for every §6 row. |
| **S3** | SRV | L | S1 | Natural world for 12 and 24 seats: deterministic bounded candidate search for spawn columns (recipe and chosen columns in world identity, diagnostics on failure, no silent seed reroll), spawn and cache quality validation, `hunger-12.toml`, `hunger-24.toml`, rule modes `frontier_survival` and `squads`, chunk-preparation budget checked against the 8,192 cap. Proof: `maps-reset` natural rows, `hunger-six` unchanged. |
| **M3** | MECH | L | M2, S3 | Per-client lazy region/frontier memory with explicit recovery from stale-failure saturation; style state transitions by loadout, phase and danger; loadout, food and equipment planning; counterfactual noninterference tests (hidden enemy, closed chest, buried ore, another faction's store, worker reassignment, stale message). Proof: `fairness` extended; offline policy cases; no style without a distinct verified behavior. |
| **R3** | RUN | L | S1, M1 | Node child-process cohorts: deterministic seat→worker assignment independent of worker count, stable per-seat identity and seeds, per-worker epoch and per-source sequence, bounded typed IPC deltas, loss-intolerant critical evidence with a bounded failure on writer stall, optional diagnostics coalesced with counters, worker-loss fault policy. Single worker stays the default. Proof: `worker-fault`; same seed and policy give identical decisions under one and two workers (`fairness`, `replay-report`). |
| **C0** | CIV | M | M0, G2 | Mined-block receipt defect reproduced with preserved packet and block diagnostics, root-caused, fixed; `civilization-rules`, `civilization-six`, `civilization-baseline` pass live. |
| **C1** | CIV | L | C0, S1 | Finite technology chain with real recipes, fuel, durability and drops; renewable food; typed job and claim planner (claim owner, lease epoch, progress evidence, cancellation, failure reason, deterministic tie-break); stores and physical hauling with destination receipts; bounded tracked-material ledger with explicit transformations and unresolved remainder. Proof: ledger fixtures, race and cancellation fixtures (last-item withdrawal, full inventory, dead courier, furnace contents changed), `frontier-economy-12` live with two factions of 6. |
| **C2** | CIV | L | C1 | Blueprint construction from real inventory with dependency-ordered placement and cell verification; store, shelter, farm, workshop and smelter, lookout, palisade with entrance, bridge, outpost; recovery from lost blocks and builders. Each building serves its function (stores hold items, farms yield food, entrances admit allies, walls change routes). Proof: `frontier-economy-12` extended. |
| **K1** | RUN | L | C2, R3, S3 | `./arena save` and `./arena resume`: settle skills, stop Paper, publish manifest last, resume in a new epoch without the WAITING reset or starter kit; dead seats stay dead; observations unknown until re-observed. Plugin persists match tick, border and faction state. Proof: `checkpoint-resume`: no duplicate materials, failed manifest write stays incomplete, no ambiguous transfer replay, clean checkpoint of a 12-seat session. SRV and CIV supply the plugin and bot state as requests to this item. |
| **C3** | CIV | L | C2, M2, R3 | Squads (scout, front line, ranged, courier/engineer), orders (rally, flank a known route, hold, escort, probe, raid, repair, resupply, withdraw), deterministic leader replacement, focus fire on known targets, four factions of 8. Proof: `frontier-war-32`, including the raided-supply-route scenario (interrupt delivery, observe a real downstream shortage in inventories, then reroute, escort, repair or retreat). |
| **C4** | CIV | M | C3, R1 | Typed ceasefire, delivery contract and alliance with physical delivery and acknowledgement; breach events; human faction orders through a namespaced chat or command interface bound to the admitted identity, no operator power. Proof: adversarial faction-isolation case, treaty fixtures, surrogate-issued order case. |
| **C5** | CIV | M | C4 | Four factions of 16 (64 seats): configuration, behavior and one functional run at 64. Performance floors are measured and logged, not gating here. Proof: `frontier-war-64` terminates with a legitimate outcome or an explicit saved state; the certified size is decided in O1. |
| **L1** | RUN | M | M3, R3 | `./arena league --manifest evaluation/league-v1.toml`: seed manifests, candidate policy registry (cautious survivor, equipment skirmisher, melee duelist, ranged kiter, team-support planner as versioned implementation plus bounded parameters, never generated code), frozen baseline, paired grouped analysis with denominators and failures kept. Proof: a two-candidate smoke league on development seeds with a reproducible report. Candidate implementations are a MECH request item. |
| **Z0** | INT | S | all P1 | Full offline suite, full live set once, acceptance report updated. Exit gate for P1: every deliverable D1–D6 works end to end at its stated size; capacity (D7) has the matrix implemented but not yet certified. |

### P2 — Hardening (4 lanes, one item per stream)

| ID | WS | Delivers and proof |
|---|---|---|
| **H-SRV** | SRV | Malformed and oversize inputs at every new boundary; old/new schema matrix; disk-full at publication; docs and contract changes written up. |
| **H-MECH** | MECH | Hidden-state and shared-cache perturbation with cohorts; spectator and evaluator isolation; deliberately injected hidden state makes the test fail. |
| **H-RUN** | RUN | SIGINT, actual Paper crash, bind conflict, protocol mismatch, critical-writer stall and worker crash leave truthful artifacts and touch no unrelated process; fault proofs from §8. |
| **H-CIV** | CIV | Faction isolation adversarial suite; transfer and cargo reconciliation; blueprint deadlock recovery; ledger unresolved-remainder reporting. |

### P3 — Optimization and polish (only now)

| ID | WS | Prereq | Delivers and proof |
|---|---|---|---|
| **O1** | RUN | P2 | `./arena bench --profile scale-v1`: the §7 matrix 6, 12, 24, 48, 96, 128, 256, advancing only while the previous level qualifies; one/two/four worker layouts on identical workloads; cold-world and prepared-world regimes reported separately; profile first, optimize measured hot work (observation scans, repeated raycasts, all-pairs routing, per-tick canonicalization, duplicate searches, retained diagnostics, synchronous writes) with before/after equivalence and quality checks; per-bottleneck commits. Proof: compact raw summaries, sample counts, certified size per workload, `perf-gate-ready` bracket on each timed run. Quality floors are never degraded to improve a number. |
| **L2** | RUN, MECH | O1 | Tuning rounds per the budget above, then one held-out evaluation, then the default-policy decision (promote or keep baseline). Proof: league report with denominators, intervals and effect size; baseline preserved if the threshold is not met. |

### P4 — Close (INT)

| ID | Delivers and proof |
|---|---|
| **Z1** | Delete dead code with liveness proof (`dead-code-archaeology`); run `ultrareview` over the whole delta; fix its P1 and P2 findings with narrow regressions; fresh checkout under `.work/wt/frontier-fresh` with its own `.work/`; full offline suite and live set; final acceptance report; `campaign-winddown` conventions for any retained worktree. |

---

## 5. Acceptance

Nothing waits on a person. Cases are named so `./arena test --suite <suite> --case <name>` selects exactly one.

| Deliverable | Command or case | Passes when |
|---|---|---|
| Loop | `./arena doctor`, `./arena build --package all`, `./arena check lint`, offline suite | Node 26.11.1 accepted; zero test failures; zero lint errors |
| D1 | `acceptance hunger-12`, `hunger-24`, `hunger-24-human-seat` | Hunger-24 gates in §2 met on `481516..481521`; the human-seat run uses the protocol surrogate on seat 0; `hunger-six` and the frozen fixtures unchanged |
| D2 | `integration external-seat` | All F1 cases in R1 pass; a surrogate cannot read evaluator state or gain spectator knowledge |
| D3 | `integration curriculum-melee`, `curriculum-ranged`, `curriculum-survival`; `core` and `bots` curriculum cases | Every §6 row has an offline regression and one live proof; static-mechanics admission gate met; funnel complete in the report |
| D4 | `acceptance frontier-economy-12`, `frontier-war-32`, `frontier-war-64`, `civilization-baseline` | Real replenishment, construction, patrols, an ordinary raid, adaptive role recovery, the raided-supply-route causal scenario, ledger reconciled with unresolved entries reported; no evaluator action schedule in the acceptance actors |
| D5 | `integration checkpoint-resume` | A 12-seat session saves, resumes in a new epoch, no duplicate materials, no revived seat, failed manifest stays incomplete |
| D6 | `./arena league --manifest evaluation/league-v1.toml` | Reproducible report with denominators and intervals, and either a promoted candidate or the retained baseline |
| D7 | `./arena bench --profile scale-v1` | Highest qualifying population per workload with workload, quality floor, duration and samples; failures and stops recorded; at least 3 runs per level, 120 s steady load each |
| Fairness | `integration fairness` | Counterfactual perturbations leave decisions unchanged under one and two workers, caches and stale messages; injected leak fails the test |
| Faults | `integration faults`, `worker-fault` | Every §8 obligation passes; artifacts truthful |
| D8 | `fresh-checkout` procedure (Z1) | README walkthrough from an empty cache reaches a match; every advertised command exists; macOS arm64 tested, Linux reported untested unless a host exists |

The final acceptance report separates (1) implemented commands, scenarios and configurations, (2) behavior verified at the populations actually run, (3) capacity certified per workload and environment, (4) skill evidence including any human testing performed, (5) open limits.

---

## 6. Mechanics curriculum (D3)

Preserve the full action funnel. Do not raise the 89.5% figure's quality by issuing fewer attacks or relabeling rejections. Missing-transition reasons are typed: out of geometric reach, target no longer visible, target despawned or eliminated, cooldown not ready, aim not ready, blocked line of sight, ownership deferred, client operation failed, server rejection, ambiguous confirmation, timeout. Client reports may be uncertain; evaluator attribution is post hoc.

Each row has a deterministic offline regression and at least one ordinary-client Paper proof on a declared seed set.

| # | Case | Required behavior |
|---|---|---|
| 1 | Fractional reach boundary | Never alternate attack and rejection because policy and adapter geometry disagree |
| 2 | Static melee target | Eligible swings produce real attributable damage, not only an animation |
| 3 | Moving target and knockback | Useful pursuit and spacing without long stationary attack waits |
| 4 | Occluding obstacle | Reposition or keep a stale search goal; never hit through the obstacle |
| 5 | Target death or despawn | Retire the action promptly without corrupting the next goal |
| 6 | Multiple opponents | Choose a defensible target or exit, not simply the nearest |
| 7 | Shield encounter | Use and counter supported block mechanics |
| 8 | Moving bow target | Consume ammunition, score real shots, report misses, no fire through cover |
| 9 | Food under pressure | Eat only when safe, otherwise cancel and escape |
| 10 | Border plus knockback | Recover toward a reachable safe region |
| 11 | Natural obstacle course | Slopes, full-block rises, foliage, shallow water, partial blocks, safe descents |
| 12 | Contended chest or drop | Correct attribution of who received the item; recover when gone |
| 13 | Changed route | Invalidate only the affected path after a built or broken obstruction |
| 14 | Exhausted target memory | Recover or explain a true dead end; never idle on stale failures |

Calibrate against the pinned game with small real-server probes (reach, hitbox, cooldown, damage, knockback, sprint, shield, projectile charge, hunger, durability, placement and dig receipts); do not import 1.8 PvP assumptions. Retain per case: positions and velocities, permitted visibility, chosen target, item and cooldown state, disposition, issued action, local receipt, evaluator outcome. No continuous aim snapping, inflated reach, altered hitboxes or invulnerability; a larger reach is never the fix.

---

## 7. Capacity (D7)

A capacity claim is a workload, a quality floor and a duration.

| Workload | Measures | Does not establish |
|---|---|---|
| Idle connections | Login and connection baseline | Active capacity |
| Distributed traversal | Chunk receipt, generation, navigation | Dense combat |
| Dense sustained combat (respawning sparring fixture, labeled) | Tracking, local control, melee and ranged | Long-term economy |
| Natural Hunger matches | End-to-end quality and runtime | Stable population under elimination |
| Distributed economy | Mining, crafting, farming, logistics, building | A concentrated siege |
| Siege | Construction, destruction, projectiles, squads, chokepoints | Vanilla survival parity |

- Metrics permitted: authoritative tick service time and TPS, event-loop delay and utilization, decision and action timestamps, search work, action outcomes, queue depth, age and drops, chunk generation count and time, encoded bytes, log throughput, endpoint process CPU deltas, explicit profiling sessions. No RSS, free-memory or swap watchdogs; unavailable memory data stays null.
- Levels 6, 12, 24, 48, 96, 128, 256. Warmup defined; at least 120 s steady active load; at least 3 runs per reported level. World preparation reported separately.
- Compare one, two and four workers on equal match lifetimes, alive counts, kits, perception and recording before choosing a default.
- Report cold-world (new chunks generated) and prepared-world (known chunks) regimes. The product keeps lazy generation; warm measurement is an explicit experiment, not a pregeneration requirement.
- Tactical decisions are admitted by their next eligible cadence; report tick-arrival-to-decision and decision-to-execution delay per worker, never averaged over skipped actors.
- Distinguish target configuration implemented, behavior accepted at N, and capacity certified at N. A 256-idle-client run is not "hundreds of experts". No degraded vision, cadence, combat rules or population in the optimized variant only.
- A certified 24 or 48 for a demanding workload is a truthful result. Stop escalation on a failed quality floor or an operational failure; keep the result and the bottleneck.

---

## 8. Regression obligations

Each obligation is a test that fails for the forbidden behavior, owned by the stream in parentheses, written with the item that introduces the behavior.

- A high-priority danger observation replaces a low-priority skill without concurrent writers or an abandoned inventory operation (MECH).
- Deferred decisions never corrupt accepted-goal memory or consume feedback for another action; obsolete feedback cannot attach to a newer goal (MECH).
- Checkpoint thresholds cross correctly for batches spanning 199/200/201 and 399/400/401; out-of-order effects invent no completed work (RUN).
- A\* partial routes cannot be mutated through aliases; budget hooks restore after client close; no search budget is held while walking (MECH).
- A fractional-position target is not in reach through block rounding; a rejected or cancelled attack is not counted as damage; one server effect is not double-counted (MECH).
- Bow damage attribution carries the right shooter and ammunition without giving a policy evaluator information (MECH).
- A block already seen as air is not forced to wait for another event; missing block data is not air (MECH).
- Dig and transfer listeners are installed before actions that can produce their receipts; cleanup keeps the original diagnostics (MECH, CIV).
- Competing transfers, partial stacks, cursor state, durability, fuel and dropped death cargo reconcile without minting resources (CIV).
- A worker crash restores no eliminated competitor, steals no human seat, loses no critical event silently (RUN).
- Hidden resources, other-worker visibility, alliance or faction state and spectator state never reach policy inputs through a shared cache (MECH, CIV).
- Old schemas reject new fields; new versions support them; old trace readers reproduce frozen fixtures (SRV, RUN).
- A checkpoint contains no unclassified live side effect; a failed manifest write stays incomplete; resume never replays a transfer ambiguously (RUN).
- SIGINT, an actual owned Paper crash, bind conflict, protocol mismatch, disk-full at publication and critical-writer stall leave truthful artifacts and affect no unrelated process (RUN).

Headless evaluator accounts are ordinary players. Administrative mutations are allowed only for declared world setup or a clearly labeled disruption fixture, never as hidden production-agent behavior.

---

## 9. Contract changes and non-goals

**Pre-authorized** (list each change made in the acceptance report; code, tests and docs move together): scenario 3, world-plan 3, control wire and trace 4 with their strict old readers; roster and faction limits up to 256; controller kind; rule modes `frontier_survival`, `squads`, `frontier_war`; CLI additions `play`, `watch`, `league`, `bench`, `explain`, `save`, `resume`; the `AGENTS.md` invariant rewrite in G0; the Node lock bump; the checkpoint manifest format; `docs/` additions; new named cases in `scripts/run-named-tests.mjs`; deleting the two predecessor campaign files.

**Forbidden:** restoring any host admission or memory gate; public or off-host listeners; operator privileges for any bot or human; loosening an old schema reader; changing frozen fixture bytes or rewriting their history; world or admin queries feeding policies; administrative kills, items or teleports in production play; silent EULA acceptance; deleting paths outside owned roots; destructive Git commands; any pin change other than the Node bump; pushing; spending money or cloud runs; killing a process the run does not own.

**Non-goals** (drop the idea, do not queue it): custom graphical client, renderer, protocol bridge, server-engine replacement, public hosting, LLM loops, neural training infrastructure, general scripting language, arbitrary bot code, web dashboard, MCP wrapper, Kubernetes, Redis, a broker, a database service, ECS, another client backend, Azalea or SoulFire return, live worker migration, 512-seat support, crossbows before the bow controller passes, expert-human certification, an empty "native acceleration" package, unrestricted MCTS, political-emergence claims, cloud or Linux hardware provisioning.

---

## 10. Reference

### Verified code map (at `f479b16`)

| Area | Anchor |
|---|---|
| Launcher, usage, Node check | `arena:87` (`prepare_node`), usage block in `arena`; `scripts/run-named-tests.mjs` (case registry: integration and acceptance names are closed sets) |
| CLI commands today | `doctor`, `gc`, `inspect`, `report`, `replay-policy`, `compare`, `prepare`, `validate`, `run` in `packages/arena-runner/src/cli.ts:43-71` |
| Spectator wait | `packages/arena-runner/src/runtime/external-player-gate.ts`, `Makefile` target `server` |
| Decision loop and dispositions | `packages/arena-runner/src/runtime/live-policy-loop.ts:233-252` (start, continue, defer, replace; `cleanupPending`, `lowerPriority`, `goalPersistence`, `hysteresis`) |
| Melee admission | `packages/arena-bots/src/skills.ts:40` (`APPROACH_RANGE_BLOCKS = 3`), `:1166-1200` (`#approach`, `#attack`); `docs/policies.md:71` documents fight range 4 |
| Seat bounds | `packages/arena-core/src/observation.ts:38` (0–255); six-seat caps listed in S1 |
| Fairness boundary | `docs/fairness.md`, `packages/arena-bots/src/{observer,visibility,perception}.ts` |
| Search budget | 3 ms of search per bot in a 10 ms window, queue time counted against its deadline (`docs/fairness.md`) |
| Existing evidence | `tests/fixtures/hunger-six-baseline/`, `tests/fixtures/legal-player-*`, `tests/acceptance/fixtures/hunger-six-seed-4815{16..21}.toml` |
| Natural terrain | schema 2 maps, 1024 × 1024, spawn and cache columns resolved by Java; `docs/scenarios.md` |
| Civilization | oak-outpost slice, six seats, fixed 192-block border; `docs/rules.md`, `docs/civilization-acceptance.md` |

### Boundaries to keep

- `arena-core`: observations, belief updates, policies, tactical scoring, job planning, evaluation math. No Node, sockets, filesystem, Mineflayer, Java.
- `arena-spec`: parsing, validation, defaults resolved once, semantic identity, content compilation.
- `arena-bots`: legal perception, client actions, local navigation, skill ownership, diagnostics; one owner per live client.
- `arena-runner`: supervisor, workers, admission, traces, reports, experiments, CLI, persistence.
- The pathfinder coupling to its internals moves into one narrow version-checked adapter when that helps testing; prefer a pinned patch at that boundary over a fork. Keep the existing shape and version rejection, hook lifecycle, cancellation and route-snapshot tests.

### Identity

World and scenario identity: terrain seed, generation recipe, rules, roster policies and factions, public settings, setup content. Execution identity: build, dependency graph, worker layout, recording mode, collected environment fields. Moving a policy between workers changes neither its seed, style, faction nor semantic identity. Worker topology may change live scheduling and outcomes; record it and do not promise bit-identical live matches. Resolve defaults once in `arena-spec`.

### Command surface

Existing `run`, `validate`, `inspect`, `report`, `replay-policy`, `compare`, `prepare`, `doctor`, `gc` stay. New, in the existing parser and launcher usage:

```sh
./arena play  --scenario scenarios/hunger-24.toml --username <name> --accept-minecraft-eula
./arena watch --scenario scenarios/hunger-24.toml --accept-minecraft-eula
./arena run   --scenario scenarios/frontier-war-64.toml --accept-minecraft-eula
./arena league --manifest evaluation/league-v1.toml --accept-minecraft-eula
./arena bench  --profile scale-v1 --accept-minecraft-eula
./arena explain --run-id <id> --seat <n>
./arena save   --run-id <id>
./arena resume --checkpoint <id> --accept-minecraft-eula
```

Progress, connection and version information go to stderr; structured results go to stdout; failures name the run ID and evidence location. Role, team and policy selection resolves before countdown and appears in the run manifest. An operator command, if a transport is missing, uses one owned local socket under the run directory with lease and identity checks, never a public service.

### Agent architecture

- **Timescales.** Mechanics each client physics step; tactics short and bounded (reaction events no later than the next eligible tick); strategy and jobs slower or on invalidating facts. No global search per step. Do not claim human-equivalent action while lowering the physics tick rate.
- **One owner of controls.** Keep `start`, `continue`, `defer`, `replace` and the exclusive-control invariant. The engage skill coordinates pursuit, spacing, legal look control, weapon timing and defense; a subordinate locomotion routine serves its owner. Add sub-ownership only for a supported combination, with cancellation and restoration tests.
- **Proposed versus accepted.** Capture both. A deferred proposal never mutates the accepted destination. Completion carries its action ID and initiating evidence.
- **Per-agent knowledge.** Visited regions and reachable frontiers; locally seen resources and containers with discovered contents and depletion; last-seen opponents with tick, uncertainty and identity lifetime; known routes, hazards, cover and blocked links; current goal, route, supplies, fallback; personal claims and received faction reports. Unknown stays unknown; stale is not visible. Never feed the server seed, resource map, evaluator census, enemy inventory or global entity list.
- **Failure memory.** A failed target is suppressed until relevant evidence changes, and a saturated memory triggers recovery: inspect another reachable frontier, backtrack to known safe ground, request a legal team report, or wait with a stated reason. Never teleport, replan omnisciently or retry blindly.
- **Geometry.** Integer coordinates for block identity and hashing; a validated finite fractional view for position, velocity, orientation and bounding boxes; nonfinite values rejected; encoding and tolerances specified for replay; cross-platform bit identity not promised.
- **Exploration and goals.** A lazy hierarchical navigation map from each client's permitted world; destinations resolve to observed traversable support. Goals (food, weapon upgrade, safe terrain, cached chest, ammunition, avoiding a stronger group, ambush, pre-border reposition) by utility scoring or a bounded planner with an explicit work budget and known state only. Opening styles are biases, not handicaps; a style name without a distinct verified behavior does not count.
- **Scenario DSL.** A small composition layer with only consumed features (terrain rules, placement constraints, prefab blueprints, kits, loot tables, rosters, objectives, material and recipe sets), compiled to canonical IR. No embedded evaluation.

### Fairness

- Visible entities and items inform decisions only through the bot's own receipts and declared line of sight and field of view. Hidden chest contents, buried ore, unseen players, inaccessible health and evaluator state never enter policy inputs. A loaded chunk is collision data, not permission to select hidden ore or containers.
- Facts learned earlier are remembered with timestamps. A target behind a wall may be searched for, not attacked as visible. Motion prediction uses observed history, never future server positions.
- Teammates share facts only through authenticated, bounded, versioned messages. No shared inventories. Alliances do not merge knowledge. Message entitlements say exactly what crosses.
- Spectator omniscience is for viewing and reporting only. A human competitor cannot request an evaluator map.

### Human admission

An external participant is not a different kind of entity: same spawn, health, inventory, damage, border, death and scoring. Controller kind is an orchestration fact bots cannot use. Offline usernames are not authentication; this campaign is loopback only, never a public reserved-name server, and adds no login bypass. Network or Tailscale exposure stays a later operator choice.

### Frontier War design

- **Technology.** Logs, planks, sticks, crafting table, wooden tools; stone, better tools, furnaces; coal or charcoal fuel and iron smelting; iron equipment, shields, armor; seeds, water, farmland, renewable crops; renewable wood and food against finite ore. Real recipes, processing time, slots, durability, fuel and drops, checked on the locked version. Starter material is declared and recorded; nothing rescues a failing economy.
- **Jobs.** Survey, gather, craft, smelt, farm, store, haul, build, repair, scout, escort, defend, raid, resupply. Each has preconditions, required materials and tools, dependencies, claim owner and lease epoch, progress evidence, cancellation, failure reason, completion evidence. Reservations coordinate policies; they do not lock the world. Revalidate on execution; death, disconnect, stale lease, changed contents and failed delivery release or revise the claim. "Inventory decreased" is not delivery; require the destination receipt or receiver acknowledgement.
- **Logistics.** Supplies move by carried stack, drop and pickup, or chest. No faction-wide virtual chest, teleporting goods or evaluator-funded purchases. Scarcity shifts work: low food reduces raids; missing equipment changes the objective.
- **Construction.** Placement by dependency graph, reachable staging positions, cell verification; plans are intentions, not obstacles; routes invalidate only after locally received changes; competing builders use claims.
- **Squads and orders.** A commander receives only permitted reports. No plugin polling of enemies. Avoid collision jams and friendly fire. Leader loss reassigns deterministically.
- **Diplomacy.** Three typed agreements. A trade needs physical delivery and acknowledgement. A ceasefire has a duration and breach event and does not disable PvP unless the rules say so. Alliances state their communication scope and never merge stores or reveal private terrain.
- **Ledger.** Evaluator-only, bounded tracked materials with explicit transformations and source and sink categories. Not a global item-count invariant: crafting, smelting, eating, growth, burning, despawn and wear all change quantities. Unknown transitions are reported unresolved, never adjusted away. Event-driven deltas in ordinary matches; whole-world censuses only in finite fixtures or explicit checkpoints. World access stays on the Paper thread; copy immutable data to async writers.

### Policies, league and tuning

Scripted at runtime. Replay of recorded observations tests logic and regressions only; it cannot measure counterfactual live performance. Start with deterministic coordinate or random search over a few documented parameters; a bounded short-horizon scorer over local movement and aim candidates is allowed after calibration, with an explicit work budget. Predeclare scoring, sample sizes, interval method and stopping rules; keep failures, disconnects and censored runs; include the frozen baseline and earlier accepted candidates; restrict to the owned private server. "Expert-human competitive" needs a later named human evaluation with recorded rules and sample size and is unclaimed here.

### Workers and persistence

- One worker first. Long-lived cohorts afterwards, never one process per bot. The supervisor owns Paper, roster, admission, worker lifetime, version negotiation, traces, aggregates; a worker owns its clients, observations, policies, skills, region index, search budget, diagnostic rings. A squad coordinator's input type cannot include evaluator or global world state.
- Whole bot lifetimes per cohort; no live migration. IPC carries compact deltas and typed events, never chunk trees or full inventories per tick. Preserve per-source order; do not fabricate a global order from arrival times.
- A content-addressed cache may deduplicate already-permitted data but must not reveal an unseen update or another bot's discovery.
- Do not replace every bigint on suspicion. Profile; derive a safe local-coordinate range and keep equivalent boundary tests before choosing a faster representation. A native kernel only after profiling shows the JavaScript alternative inadequate and the macOS and Linux distribution cost is justified.
- Replay meanings: D1 deterministic content and scenario compilation; D2 identical policy output from the same normalized input, memory, feedback and RNG; D3 authoritative results reconstructed from preserved events; D4 consistent clean-checkpoint resume. D4 is not bit-identical packet scheduling or physics.
- Unclean crash: restore only a previously complete checkpoint and declare the rollback. Never replay uncertain inventory actions blindly or claim exactly-once side effects.
- `explain` ties decisions to permitted evidence, task progress, confirmed effects and failures. No fictional reasoning.

### Upstream references

Installed pinned source is the API authority. Mineflayer pathfinder (goal, movement, path computation), Mineflayer API (controls, observations, interactions, events), Paper scheduler (world access on the right thread; I/O on copied immutable data):
`https://github.com/PrismarineJS/mineflayer-pathfinder`,
`https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md`,
`https://docs.papermc.io/paper/dev/scheduler/`.
Do not spend a research phase rediscovering launchers, server replacements, bot backends or model providers.

---

## 11. Decision log (append-only, one line per judgment call)

## 12. Campaign log (append-only, one line per phase end or parked item)

## 13. For the owner afterwards

- Read `docs/acceptance-report.md`, the league report, the capacity summaries and the list of parked items in the campaign log.
- Cherry-pick from `campaign/frontier`; nothing is pushed.
- Review the `AGENTS.md` invariant rewrite and the Node lock bump first; they are the two contract edits that outlive the campaign.
- Launch prompt: `Execute minecraft-arena-frontier-campaign.md from item G0 on the current checkout; finish every deliverable; never push.`
