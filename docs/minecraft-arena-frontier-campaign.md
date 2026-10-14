# Arena Frontier: from a six-bot experiment to competitive worlds

**Status:** resumed 2026-10-14. Integration branch `campaign/frontier`, at the commit that contains this status. The live order is Steering order below. The wave is steering S0 (runner reports), steering S1 (planned UHC lab schema), and steering S3 (pure `frontier-v1`, no `skills.ts`). The one-leg drop (`7e93161`) is merged offline and was not live-checked. The owner stopped that duel before a match result. That run has no score. Next work, when resumed, is S0, then S1. S3 may run beside them only as a pure `arena-core` module that does not edit `skills.ts`. Seed 260114 stays a navigation and perception red. Its 0.75 score is a match outcome and is excluded from combat-skill qualification. Do not grind that seed with more look or path patches. Written against `master` at `f479b16` (2026-10-14). This document supersedes the earlier agent campaign plans, which G0 deleted.

## Steering order (2026-10-14, owner)

This order replaces the Priority override sequence and the pit-search method in `92a09ea`, `eea8169`, `6accccf`, and `7e93161`. Those commits stay on the branch. Do not extend them, and do not build `frontier-v1` on them. The four-heading sweep (`6a2d5dd`) may stay while every heading is fixed and independent of entity coordinates.

These stay in force: completion gates, world generation, ordinary mechanics, fairness, plugin-owned outcomes, fault tests, civilization, human admission, hunger-24, frontier-war-64, capacity, checkpoint and resume, and delivery. Keep `baseline@1` frozen. Keep historical trace readers. A changed meaning gets a new schema version. Keep an accepted commit that a review snapshot omitted.

On resume the executor runs from S0 through S9 without asking. Competitive-seat tests use a headless surrogate. No owner playtest. No LLM, GPU, or paid cloud. No push. No new runtime dependency. Keep Paper 26.1.2 build 74, protocol 775, Java 25, Node.js 26.11.1, pnpm, TypeScript 7, Mineflayer 4.39.0, and mineflayer-pathfinder 2.4.5. Do not add Azalea, SoulFire, Python, XState, an ECS, GOAP, or a behavior-tree library.

### Evidence that sets this order

- Finished duels on seed 260114 (`./arena duel --scenario scenarios/uhc-duel.toml --candidate improved --opponent baseline --seeds 260114 --rounds 1 --concurrency 1`) scored 0.75. One assignment is a border death. The swap draws at tick 7200. Attacks issued 0. PvP hits 0. Opponent observations 0. The closest recorded approach was about 5.1 blocks horizontal and 20 vertical. Combat qualification uses the S1 layouts. A safe draw on seed 260114 is an acceptable diagnostic result.
- Six-seed quality on 481516..481521: terminate pass, loot 0.556 (gate 0.75), PvP eliminations 0.655 (gate 0.40), self-inflicted 0.268 (gate 0.05), unexplained idle span 1,288 (gate 600). Improved seats are 16 self-inflicted of 92 issued, 12 of them `ownershipDeferred`, and their longest unexplained span is 108. The 1,288 span is a baseline seat. S0 splits those denominators before any aim change.
- `decideV5` calls v4 `decide`, then `chooseOverride`. `GOAL_SCORE` is read only inside `explain`. `decideOpeningV5` calls `decideV5`, ignores `OpeningPolicyContext.style`, and copies `context.state` through. Confirm that with a failing end-to-end opening-style regression. Leave frozen `improved` replay inputs unchanged.
- Pool version 1 names are ahead of the mechanics. `bow-kiter` does not shoot. `shield-user` does not raise a shield. `eatUnderPressure` selects the food stack with the greatest `restores`. With `NATURAL_REGENERATION` false, ordinary food is not a health cure. The observation has no golden-apple id.

### What counts as competence

Four envelopes stay separate. A is a 1v1 UHC duel. B is hunger games at 6 and at 24. C is faction war with logistics. D is hundreds of protocol bots doing the measured workload. Idle connections do not satisfy D.

Report legal PvP opportunities, contact coverage, damage per combat second, healing, survival given an engagement, environmental deaths, resource use, falls, task completion, idle and trapped time, the action-failure taxonomy, and whole-system cost. A policy that avoids every fight fails the duelist check. A policy that rushes and dies fails the survivor check. There is no omniscient scalar reward. When a rule separates combat from environmental wins, publish both measures.

### The next candidate

Add one versioned candidate, `frontier-v1`, in `packages/arena-core`. Freeze `baseline@1` and `improved`. `stepAgent` is pure: no Promise, Mineflayer, clock, global RNG, or filesystem. One step updates belief from the observation, applies safety constraints, scores goal proposals, keeps one task, and emits commands for one skill owner. Use hierarchical tasks, utility arbitration, and small skill state machines. Navigation phases are plan, follow, validate, and recover. Weapon cooldown is a combat phase, not a top-level goal.

One owner per fact. A mode is a discriminated union. Each goal declares eligibility, utility, commitment, success, failure, interruption, and cooldown. The trace stores the proposals and rejections that selected the goal. Lethal damage and an active border escape outrank ordinary scores. A goal holds a lease. An unchanged skill continues across policy ticks. Replan on a material observation, an invalid route, an emergency, or a skill result.

`skills.ts` may forward while a slice moves. It gains no new global heuristic. Split along `skills/navigation`, `skills/combat`, `skills/inventory`, and `skills/civilization` behind the existing adapter when a slice needs that split. Scanning is a client action on a world-independent schedule. `knownLastSeen` is an earlier sighting that passed the cone and the voxel ray. Coordinates of an entity that failed that check do not choose gaze, a step, a path endpoint, or a sweep angle. Do not raise `maxDropDown` so a seat can fall about 20 blocks to force a duel.

`explain` shows the proposals the selector used. `decisionDiff` compares identical legal inputs and does not prove a counterfactual win. On resume, cancel in-flight actions and treat observations as unknown until they arrive again.

The first goal union is `escapeBorder`, `heal`, `loot`, `engage`, and a safe `explore` fallback. Evade is the retreat side of `engage`. Raid, craft, escort, and the other civilization jobs wait until that slice is live. Those jobs reuse this arbitration. They do not get a second state machine.

### S0 through S9

Ids S0 through S9 here are this steering sequence. Section 4 items S1 through S13 are the earlier scenario work. The numbers do not match across the two lists.

Independent offline work may run in disjoint worktrees. Live proofs stay in the order below. Park a blocked item with a reproducer and continue anything that does not depend on it.

| Item | Owns | Delivers and proof |
|---|---|---|
| **S0** | RUN | A ledger of this tip against earlier proofs. Reports separate wins and survival from `competitive_exposure` (time both seats could legally perceive or reach each other, attack opportunities, attacks, damage, and death cause). Label each case fixture-invalid, perception failure, policy failure, skill failure, or a valid loss or win. An idle valid game still counts in the game-quality metrics. Funnel stages are attempted, admitted, issued, confirmed, and rejected, and the counts conserve. `ownershipDeferred` is a deferral, not an issued illegal swing. If the 5% gate mixed those denominators, version the metric and keep the old report. Duel reports gain `contact_validity` and `combat_opportunities`. A run with 0 attacks and 0 PvP is `no combat demonstrated`. Proof: fixtures for zero contact, blocked line of sight, unreachable terrain, an illegal issued attack, a strategic deferral, contact with no swing, and contact with confirmed damage. No policy or skill tuning in this item. |
| **S1** | SRV, then MECH | Keep `scenarios/uhc-duel.toml` (natural 1024) as the transfer diagnostic. Add a small symmetric planned arena: flat ground, optional cover, equal elevation, spawns 10 to 16 blocks apart, walkable, reciprocal line of sight. Schema 3 cannot express that arena, so add the smallest versioned spec and plan extension. Four layouts: clear flat melee, a clear bow lane, symmetric cover, and symmetric elevation on ramps with no unescapable 20-block pit. A layout where an attack is impossible fails arena validation before training. Proof: one legal player-caused damage event in each combat layout, reciprocal interaction on both seat swaps, and a start-to-first-contact distribution. Headless. |
| **S2** | MECH | `bow-kiter` fires arrows and keeps distance. `shield-user` raises and lowers a shield. `strafer` shows measurable lateral movement. `aggressive-rusher` starts contact. A defender heals with a permitted item. `stationary-dummy` is a diagnostic, not an equal expert. Hunger food, golden apples, absorption, and potion duration stay distinct. A member without a live receipt of its named action is `unqualified` and stays out of promotion scoring, with the reason in the report. Version the pool when a mechanic changes. Proof: client and server receipts, plus a cross-play matrix. A promotion cannot rest on killing a stationary, trapped, or border-stalling opponent. |
| **S3** | MECH | A short note in `docs/policies.md`. Pure modules under `packages/arena-core/src/`. Belief, scored proposals, one persistent task, recovery, and one tactical state machine. The four goals above, one end-to-end slice at a time. Do not wrap `chooseOverride`. Property checks use the existing test runner. No new property-test dependency. `improved` keeps ignoring opening style. `frontier-v1` diverges on a distinguishing observation. Proof: a registry entry, a replay, and a trace whose scores selected the goal. Frozen baseline output stays byte-identical on historical inputs. This lane does not edit `skills.ts`. |
| **S4** | MECH | Scanning is its own client action. Local topological memory comes from received terrain. The pathfinder follows a connected path. Recovery replans one edge, steps back, or abandons the goal. An unreachable target 20 blocks below is not a reason to fall. Seed 260114 stays a diagnostic. Proof: a hole with no legal exit, a ramp, water, lava, partial cover, a cliff, a moving border, a visible occluded target, and an unloaded frontier. No lethal fall when an admitted safe alternative exists. |
| **S5** | MECH | Combat is an owned tick-driven state machine: acquire an admitted target, approach, space, aim, cooldown or draw, swing or release, confirm, recover, shield, eat a golden apple, disengage. Preserve `curriculum-melee`, `curriculum-ranged`, and `curriculum-survival`. Proof: live reciprocal engagements. If the 5% rejection gate still fails, the report names the funnel stage that dominates. |
| **S6** | MECH, RUN | Three fidelities: pure fixtures, short live microarenas, then natural hunger and faction matches. At most 12 tunables, searched with the existing helper. A quality-diversity archive is optional, adds no dependency, and waits until S0 through S5 have a passing slice. Before adding a heuristic, name the observation it uses, its failure mode, the other goal it can disrupt, the measurement, and the ablation. No score for avoiding contact, waiting on a trapped opponent, or farming `stationary-dummy`. Proof: the ablation and the tie-break, written down before the search. |
| **S7** | RUN | Compare `baseline@1`, frozen `improved`, and `frontier-v1` on the same scenario and seeds, both seat assignments. A candidate histogram that contains only `delegatedBaselineRules` is void. Hunger development seeds are 500001..500012. Held-out 600001..600024 is consumed once. Duel seeds are a new list, disjoint from 260114. Promote only at mean ≥ 0.65 and a 95% lower bound above 0.5 against a qualified pool, with completion, engagement exposure, and no loot, survival, or legality regression. Proof: `./arena quality`, `./arena league`, and `./arena duel` on those seeds. |
| **S8** | per the original item | After the S7 foundation, finish open original items. C0, then C1 through C5, on this same arbitration. R1 and R1c with a headless surrogate. Hunger-24, S12, M4, the H items, K1 preservation, benches, and Z1. No human attendance. No claim of expert-human play. |
| **S9** | INT | Focused suites, the full compiled offline suite, the Java unit, the live cases the items require, and a fresh checkout on a supported host when one is available. The report separates implemented, unit tested, live verified, qualified opponent, promoted candidate, and capacity certified. |

### Regressions that stay red until shown otherwise

- A UHC duel on the S1 arena shows legal PvP. A zero-contact win does not qualify as duel-skill improvement.
- Opening style on `improved` is characterized. `frontier-v1` rotates style from a client-confirmed cache transfer.
- `bow-kiter` shoots and `shield-user` blocks, or the report marks them `unqualified`.
- Low health with full hunger does not treat ordinary food as a golden apple.
- Hidden opponent coordinates do not drive gaze, a step, pathfinding, or a sweep.
- Goal persistence, preemption, phase timeout, cancellation, and retry are pure, bounded, and replayable.
- Two skill completions cannot corrupt a newer task or consume another action's receipt.
- Scheduling deferrals and illegal issued attacks use different funnel stages.
- A seat in a hole is not told to take an unsurvivable 20-block drop to force a fight.
- Pool members used in a promotion have a live receipt of the named action.
- Civilization conservation and team-private observations hold under `frontier-v1`.

The recorded 260114 duels are the evidence for that seed. Rerunning the same command until a fight appears is not an S0 or S1 step. Do not start S6, or a quality-diversity archive, before S0 through S5 have a passing slice.

## Priority override (2026-10-14, owner)

**Sequence superseded by Steering order.** The definitions in this section stay. D-train and Q2 run as steering items S6 and S7, against a qualified pool, after S0 through S5. A zero-contact duel score does not meet D-train.

These item definitions were the 2026-10-14 quality sprint. Steering order now decides which of them runs, and when. Quality is judged by live full-match numbers and the league, never by offline tests alone.

| Item | Delivers and proof |
|---|---|
| **Q0** | Live measurement of the tip: `acceptance hunger-six` on 481516..481521 plus per-seat quality table (loot, distance, idle ticks, attacks issued/rejected from the funnel, damage dealt/taken, death causes and ticks, PvP share). Recorded in `docs/acceptance-report.md`. |
| **Q-loop** | Quality loop speed: league and acceptance matches run on ephemeral game ports with up to 3 concurrent matches (10 CPUs, 32 GiB), one world template per seed; a development league of 12 seeds finishes in under 30 minutes. |
| **Q1** | Policy and skill defects found from Q0 traces (idle seats, stalls, stuck spawns, no-loot seats, rejected attacks) fixed with failing regressions first. The frozen baseline is copied once as `baseline@1` before any change; improvements ship as a new implementation id compared against it. |
| **Q-engage** (engage) | Strike-phase rewrite of the melee skill so hits land in dynamic fights (plan and numbers in the Handoff). Proof: offline orbit/knockback simulation hit-rate before/after, `curriculum-melee`, and `./arena quality` self-inflicted rejection share under 5%. |
| **Q-resilience** (MECH/RUN) | One client's window desync or quarantine must not fail a whole match (Decisions: quarantine row). Proof: injected-desync test keeps the run valid, seat eliminated, run marked `degraded`. |
| **Q-trapped** (RUN) | `trapped` classification (zero displacement with failed navigation each cycle) in seat quality, kept out of the unexplained-idle gate but counted and listed. |
| **Q2** | Candidate tuning on development seeds 500001..500012 with the existing search helper; one held-out evaluation of 600001..600024 per frozen candidate set; promote only at mean ≥ 0.65 and lower bound > 0.5. |

**UHC-style 1v1 duel training (owner, 2026-10-14, item definitions; sequence superseded).** PvP skill has a lot of nuanced strategy; the bots must become strong duelists, and 1v1 UHC-style duels are the training and evaluation ground. "Training" here is the campaign's CPU-only loop: scripted policy families with bounded tunable parameters, searched and evaluated on a duel ladder against a fixed opponent pool. No LLM, neural network, GPU or paid inference.

| Item | Delivers and proof |
|---|---|
| **D-rules** (SRV) | Scenario rule mode `uhc_duel` (versioned, in the schema-3 `[rules]` table): exactly two competitors, symmetric declared kit per seat (armor tier, sword, bow and arrows, golden apples, food, optionally shield), natural regeneration off so healing comes only from golden apples and food, no respawn, flat or lightly obstructed arena with symmetric spawn mirroring, tick limit and a decisive-or-draw outcome. Mechanics are the pinned server's ordinary ones. Proof: spec and Java tests, `./arena validate`, a live smoke duel. |
| **D-skills** (MECH, engage) | Duel strategy components, each a verified distinct behavior with typed reason codes: spacing and target range control, strafing and circle movement, attack-cooldown timing and first-strike, retreat-to-heal and golden-apple eating windows under pressure, bow opening and kiting, shield use and counterplay, fall and edge awareness, disengage when behind and re-engage when ahead (health, armor, food and cooldown comparison from own observations only). Offline regressions against a scripted sparring partner, then live. |
| **D-ladder** (RUN) | `./arena duel --candidate <id> --opponent <id|pool> --seeds a,b,c --rounds n --concurrency k --accept-minecraft-eula`: seat swaps every pair, concurrent matches on ephemeral ports, per-round engagement summaries (swings, hits, damage dealt and taken, time in reach, heals, bow shots and hits, first strike), pool scoring (win 1, draw 0.5) with paired grouped intervals, and a round log fit for `explain`. |
| **D-pool** (MECH) | A fixed, versioned opponent pool of scripted sparring partners with rising difficulty (stationary dummy, strafer, aggressive rusher, kiter with bow, defensive shield user, the frozen `baseline@1`). The pool is data; a candidate never trains against itself only. |
| **D-train** (MECH, RUN) | Bounded CPU parameter search (the existing coordinate/random search helper, extended tunables for the duel components) over the duel ladder: development seeds and rounds fixed in a manifest, a finite experiment budget (at most 5 candidates, 3 rounds, 24 development seeds with swaps), one held-out evaluation per frozen candidate set. Promote only at pool score ≥ 0.65 with a 95% lower bound > 0.5 against `baseline@1` and the pool average, and no regression in the hunger-six quality gates (transfer check on 3-vs-3 natural matches). |

Honest scope: "UHC-style" means the ruleset and strategy mix (no natural regeneration, golden apples, bows, armor tiers, symmetric kits), not 1.8 click mechanics. The pinned server uses the modern attack cooldown; strategy is trained for that. No autoclicker timings, extended reach, aim snapping or hidden-state use; the observation fairness profile and exclusive skill control stay exactly as for every other mode. Every duel round must be explainable through the introspection requirements below.

**Introspectability requirement (owner, 2026-10-14).** Bot quality work needs maximum introspectability and reporting. Every live match and league run must leave enough evidence to answer, per seat and per tick range, what the bot perceived (own observations only), which goal and intent it chose and why (scored alternatives and the rejecting condition), whether the skill was admitted, deferred or replaced, what the client did, and what the server confirmed. Concretely: (1) per-seat decision timelines in the trace (goal, intent, disposition, reason codes, wait reasons, border-known state, nearest known cache and opponent distances); (2) the action funnel with typed miss reasons for every action; (3) `./arena explain` and `./arena report` render a seat timeline and a match summary (loot, movement, idle spans, engagements, damage, deaths with causes); (4) a league and quality report with denominators, per-seat and per-seed tables, failures kept, and a candidate-versus-baseline diff of decisions on identical observations; (5) bounded diagnostic rings that flush on failure and optional verbose capture for a chosen seat/seed; (6) no hidden evaluator state may leak into policy inputs while doing any of this. A quality item is not done until its effect is visible in these reports.

Duel gates fixed now: self-inflicted attack rejections under 5% of issued attacks in duels; no unexplained idle span over 100 ticks in a duel; promoted candidate meets the D-train threshold; duel results are reproducible from the manifest and seeds. S0 may publish a versioned denominator beside this gate and must keep the old report. A zero-contact score does not meet the D-train threshold.

Quality gates fixed now are the Hunger-24 gates row in Decisions plus: self-inflicted attack rejections under 5% of issued attacks in live matches, and a candidate must beat `baseline@1` per the league rule.

## Item status (2026-10-14)

Merged means on `campaign/frontier` and verified at least offline. Partial and parked items carry their next step in the Handoff. The S ids in this table are section 4 scenario items, not the steering sequence S0 through S9.

| State | Items |
|---|---|
| Merged and live-verified | G0, G1, G2 (baseline recorded), S1, S2, M0, M1 (melee curriculum), M2 (ranged curriculum), K1 plugin and runner (`checkpoint-resume` live), Q0, Q-loop |
| Merged, offline only or partly live | R1b (rules sent by the runner; no live run uses a rule mode), S3/S3a, S4–S7, S8/S8b, S9, S10, S11, S13, M3, M3a, L1a, R2, R3, L1, B1, Q1 (v5 set), `steadyMeleeEngagement`, Q-trapped, D-ladder (`./arena duel`), D-pool (pool version 1; `bow-kiter` does not shoot; `shield-user` does not raise a shield), D-skills (`improved` eats under pressure, then disengages with no food; outside melee with arrows it shoots; no shield policy, strafe, or fall avoidance), D-rules (`uhc_duel` v1; natural terrain; one live smoke won), Q-engage (led strike; `curriculum-melee` passed; six-seed quality fails the 5% rejection gate at 0.268), Q-resilience (one quarantined client; `--workers 1` marks the run degraded; `--workers` greater than 1 does not) |
| Partial / parked | C0 (craft defect), M4 (`curriculum-survival` unrun, calibration unmeasured), R1/R1c (`external-seat` row 1), S12 (seed matrix incomplete), Q1 (live comparison mixed) |
| Not started | S0 through S9 (Steering order). Still open inside that order: a shield raise and strafe that the pool actually performs, fall avoidance that does not drop into the pit, D-train, Q2, C1–C5, H-SRV/MECH/RUN/CIV, O1, L2, Z1 |

## Handoff (resumed 2026-10-14)

**Resume.** Prompt: `Execute docs/minecraft-arena-frontier-campaign.md from Steering order on branch campaign/frontier. Start at S0, then S1. S3 may run beside them only as a pure arena-core module that does not edit skills.ts. Finish every deliverable. Never push. Do not grind seed 260114. Do not extend the rejected search and drop commits.` First commands: `git switch campaign/frontier && ./arena build --package all`. No lane worktrees exist; recreate under `.work/wt/frontier-<lane>` with `git worktree add .work/wt/frontier-<lane> -b campaign/frontier-<lane> campaign/frontier`, then `pnpm install --frozen-lockfile --offline --store-dir <repo>/.work/arena/pnpm-store` and `git checkout pnpm-lock.yaml` (pnpm adds `@pnpm/exe`; never commit it). Lanes that run live need `.work/arena/{toolchains,downloads,gradle}` cloned with `cp -cR`.

**State.** Branch `campaign/frontier` at the commit that contains this handoff; `master` untouched. Everything from the first pause (see Decision and Campaign logs) plus this sprint is merged: runner wiring of per-seat candidates, `baseline@1` frozen with `improved` (policy-v5) and `decisionDiff`/`explain` introspection, `./arena quality` (ephemeral ports, `--concurrency 1-4`, per-seat quality table, reason histograms, gates), `decision-diff`, seat timelines in `explain`, S8b duplicate-login fix, S9 tick metrics, S10/S11/S13 spawn and cache search with reachability and whole-formation translation (`world-search-v6`), `steadyMeleeEngagement`, observed-support travel targets, feedback-contract fix, combat-arena latency options for tests.

**Quality evidence so far (live, `./arena quality`, hunger-six, concurrency 2).**
- Baseline 4 seeds (481516..481519): all terminate; seats looting 0.58; PvP eliminations 0.53; self-inflicted attack rejections 0.63 per issued attack; longest unexplained idle 2,236 ticks.
- `improved` on seats 0/2/4 vs baseline on 1/3/5 (3 of 4 seeds, before S13): 481519 improved won decisively (damage out 40/8.6/87 vs 2.6/0/5; chests 3–6 vs 1–3); 481517 worse (three improved seats died in melee at ticks 827–1,102); 481518 mixed (improved seat 0 looted 4 chests and killed a baseline seat; two improved seats were pit-trapped by spawn placement, since fixed by S13); 481516 match killed by a window synchronization failure.
- No promotion verdict: league never run live; mean over those matches about 0.5.

**Known red / open defects.**
- Every finished UHC duel on seed 260114 produced no fight: 0 attacks issued, 0 PvP hits, no `shoot`. Score mean 0.75 is a border death or a draw. Steering order marks that `no combat demonstrated` and excludes it from combat-skill qualification. Baseline died to the border at tick 6091 after moving a few blocks; the swapped seats drew at tick 7200. `eatUnderPressure` did fire. In the first match, 3,046 decisions recorded no visible opponent. Later reruns still had an empty opponent list. The closest samples were about 5.1 blocks apart horizontally and 20 vertically, near (520, 63, 508) and (525, 43, 509). The upper seat cannot path down under the default 4-block drop. The search, rim, and drop commits aimed a step or a fall at a player the visibility ray had not admitted. That method is rejected. The drop duel was stopped before a match result.
- Six-seed quality (`improved` on seats 0/2/4, concurrency 2) fails three gates: loot 0.556 (threshold 0.75), self-inflicted rejections 0.268 (threshold 0.05), longest unexplained idle span 1,288 ticks (threshold 600). Improved seats alone are 16/92 self-inflicted (0.174) and their longest unexplained span is 108. The idle-gate failures are baseline seats. Improved attack rejections are mostly `targetNoLongerVisible` (53), which is outside the self-inflicted set; the self-inflicted count is `ownershipDeferred` 12, `blockedLineOfSight` 2, `aimNotReady` 1, and `clientOperationFailed` 1.
- A client quarantine with `--workers` greater than 1 still disconnects only that seat and does not fail the worker, but the supervisor result does not receive `degraded` (`d917f87`). The default `--workers 1` path, which quality and league use, records the degradation.
- v5 travel/probe still produces little distance in some seats (idle 3,000+ ticks); orbit/probe loops need re-measurement after the observed-support fix and S13.
- `civilization-rules` fails at the sixteen-plank craft (mineflayer `bot.craft` clicks before server ack; fix in `craftCivilizationMaterial`); `civilization-six`/`baseline` never ran.
- `external-seat` row 1 (surrogate loots/damages/wins) fails with a bare AssertionError; the other 7 rows pass. `curriculum-survival` never ran; calibration constants not measured.
- S12 seed matrix incomplete: hunger-six resolves at 481516..481521; `hunger-12` at 481516/481518 failed before the ranked-translation commit (not rerun); hunger-24, development 500001..500012 and held-out 600001..600024 never probed.

**Open lanes.** Steering S0 `campaign/frontier-s0`, steering S1 `campaign/frontier-s1`, steering S3 `campaign/frontier-s3`. Worktrees `.work/wt/frontier-s0`, `.work/wt/frontier-s1`, `.work/wt/frontier-s3`. S1 does not run a live match. The integrator runs that proof after the schema merges. **Retained worktrees.** The eleven unregistered `.work/wt/civ-*`, `natural-*`, and `opening-style-evidence` directories stay untouched.

**Not started (in order).**
1. S0 evaluation honesty. No behavior tuning. Split the six-seed 5% denominator before treating 0.268 as an aim failure. Mark the finished 260114 duels `no combat demonstrated`.
2. S1, a symmetric reachable UHC arena. Keep `scenarios/uhc-duel.toml` as the transfer case. Schema 3 needs a versioned extension for a planned flat arena.
3. S3, beside S0 and S1, only as pure `arena-core`. Four goals. That lane does not edit `skills.ts`.
4. S2 real pool mechanics, then S4 and S5.
5. S6 and S7 after a passing slice of S0 through S5. D-train and Q2 live here, against a qualified pool. Do not start a quality-diversity archive first. Do not rerun seed 260114 as a combat gate.
6. S8, the earlier backlog: C0 craft fix and C1–C5, R1 and R1c with a headless surrogate, hunger-24, S12, M4, hardening, the bench matrix (O1), Z1. Then S9.

Q-engage, D-rules, D-pool, D-ladder, and the eat, retreat, and bow slices of D-skills are merged. See the campaign log. Q-resilience (`d917f87`) and Q-trapped (`7707b16`) are merged offline. `baselineExplanation` is already exported. Duel engagement summaries still omit swings, time in reach, heals, bow shots, bow hits, and first strike. The six-seed table is recorded and fails loot, self-inflicted rejections, and unexplained idle. Held-out 600001..600024 is unconsumed.

**Operational notes.** Quality and league runs use ephemeral ports; acceptance `hunger-six`, lifecycle, faults and external-seat still bind 25565: serialize them with `until mkdir .work/live.lock 2>/dev/null; do sleep 10; done; <cmd>; rmdir .work/live.lock` and wait for the port. `./arena build --package all` does not build the `arena-fs` helper (`make -C native/arena-fs build`). Quality runs print Paper logs only to stderr.

**Owner decisions owed.** None blocking. Logged calls to review: `[rules]` table in scenario 3; squads outcome last-survivor by seat; `hunger-six` on scenario schema 3; v5 ships as candidate `improved`, baseline stays frozen until a league verdict.

**Verified at this stop.** Branch `campaign/frontier`, at the commit that contains this handoff. One worktree, the main checkout. No live lock. The drop duel was stopped before a match result. The 631 and 644 suite counts in the log are earlier tips. Not re-run on this tip: the full compiled suite, lint, and live `stack` / `legal-player`.

## 1. Charter

The executor has this document and the repo. On a resume it runs from Steering order item S0 through S9, then any original item still open, without asking anything. Steering order wins when it conflicts with the Priority override sequence or with section 4.

- **Decide, log, continue.** Make the smallest reversible choice inside the bounds below and append one line to the decision log. Never ask, never wait for approval, send no check-ins. Run until every deliverable is met or every remaining item is parked.
- **Hard stops** park the item and nothing else: an irreversible action, anything outside the repo and `.work/`, a boundary this document forbids, a loop that cannot check the item. Pushing is always forbidden. Park by committing the item's checkpoint on its branch, writing a reproducer in the campaign log, and moving to the next item that does not depend on it.
- **Time-box.** Three failed attempts at one item, each from a new diagnosis, then park. A flaky check is never retried to green; a predeclared repeated experiment is not a retry.
- **Cause before fix.** Inspect the first wrong value, not the final timeout (`root-cause`). A bug fix starts with a minimal failing test and keeps it. A live reproduction may be the first test when the defect has no offline form; retain a compact fixture afterwards. Never weaken a test, drop a seed, extend a deadline or redefine success to pass. A test changes only when its contract is wrong, with the reason in the commit body.
- **Parity before optimization.** Phases P1 and P2 finish every feature and every test. Performance budgets in P1 and P2 are measured and logged, never gating. Item O1 and later are the only optimization work.
- **Fix on the way** what is egregious, in its own `fix` commit: a warm focused command over 120 s, a same-workload regression over 2× baseline, a baseline-red test that blocks the item. Record anything else and leave it.
- **Honest labels.** Implemented, unit tested, live verified, qualified opponent, promoted candidate, capacity certified at N, and open limit are different claims. A headless surrogate is not an expert human. Configuration support is not capacity. An action admission rate is not hit accuracy. A match score with zero attacks is no combat demonstrated.
- **A comparison is valid only if the candidate ran.** Every candidate-versus-baseline report must show the candidate's own reason codes firing in the seat reason histograms and record the commit it ran on. A run whose histograms show only `delegatedBaselineRules` for candidate seats is void. (A runner wiring bug once made "improved" seats decide with baseline; this rule is why it was caught.)
- **Evidence is stamped.** Every quality, league, duel or bench result names the branch tip it ran on, scenario and seeds, candidate ids and versions, concurrency, and whether the host was shared; concurrent matches are labeled timing-sensitive.
- **Merging lanes.** Lanes commit on their own branches; the coordinator integrates by `git cherry-pick` of `git cherry campaign/frontier <lane-branch>`, resolves conflicts in favor of keeping both sides, runs `./arena build --package all`, `./arena check lint` and the compiled offline suite, then updates the verify worktree before any live run. Live evidence is never gathered from a tree that is behind the merged tip.
- **Live runs.** League, quality and bench matches use ephemeral ports and may run concurrently (host memory budget about 3.5 GiB per match, at most 3 concurrent). Acceptance cases that bind 25565 (`hunger-six`, lifecycle, faults, external-seat) serialize under `.work/live.lock` and wait for the port; never kill another lane's process.
- **Bookkeeping is small.** This document, updated area docs, one acceptance report, compact fixtures a reader uses. No tracker, provenance register, hashes or manifests unless a reader or failure needs them.
- **No code comments.** Put the reason in a name, type or test. A surviving comment states its own constraint and never cites this document, an item ID or a phase. Delete failing comments in files you touch.
- **Commits.** Local commits are authorized. Each is a Conventional Commit `type(scope): subject`, scope = workstream or area, item ID in the body, `!` for a contract change, ending with the attribution trailer the session supplies. No formatters. Never push.
- **Working state** lives under `.work/` (already in `.git/info/exclude`). Lane worktrees: `.work/wt/frontier-<lane>`. Scratch and `TMPDIR`: `.work/tmp`. Never `/tmp`. The eleven existing `.work/wt/*` directories (`civ-*`, `natural-*`, `opening-style-evidence`) are not registered worktrees; leave them alone and never reuse their names.
- **Branches.** Integration branch `campaign/frontier` from `master`. Lane branches `campaign/frontier-<lane>`. A lane commits only files it owns. The coordinator rebases, fast-forwards, runs the touched-area checks on the merged tree, then `git worktree remove` and `git branch -d` the lane. A parked lane keeps its committed branch, not its worktree.
- **Width and memory.** Host: 10 CPUs, 32 GiB, 84 GiB free disk at preflight. Static budget: 4 GiB per offline lane, 8 GiB for the one live-integration slot, 8 GiB headroom, so at most four offline lanes plus the live slot. Do not poll host memory. Phase width is the smaller of ready disjoint ownership sets and four.
- **Serialized live work.** Timed measurements (bench, perf gates) and acceptance cases that bind port 25565 run one at a time under the lock; league and quality matches use ephemeral ports and follow the Live runs rule above. Lanes may run their own live cases under these rules; the coordinator owns shared evidence and hands results back.
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
| 2026-10-14 | Steering order replaces the Priority override sequence and the pit-search method. Seed 260114 is a navigation diagnostic. Its 0.75 score stays a match fact and is excluded from combat-skill qualification. |

### Prescribed

| Decision | Reason; what reverses it |
|---|---|
| Keep Paper 26.1.2 build 74, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, one Java plugin, four TypeScript packages with today's boundaries | Rebuilding the stack is the largest schedule risk and nothing observed contradicts it. Reverse only on a reproduced incompatibility. |
| The plugin stays the only match and outcome authority. It observes mechanics and never steers, equips, heals, teleports or creates favorable outcomes. | Two authorities disagree. |
| Competitor ceiling 256 (seats 0–255, matching `packages/arena-core/src/observation.ts:46`). Spectators use a separate identity space and never consume a seat. No 512 claim. | The existing core bound; widening needs a separate identifier migration. |
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
| A client that must be quarantined (window desync that does not settle) is treated as a disconnect of that seat: eliminated at the tick boundary, the run is marked `degraded` with the reason, and the match continues; it is excluded from league and capacity statistics but kept in quality reports. | Failing a whole six-seat match for one client desync destroyed otherwise valid evidence. Reverse if degraded runs start hiding a systematic client bug (then fix the bug). |
| Candidate promotion happens only through the league or duel ladder rule; `baseline@1` is never edited, and a promoted candidate becomes `baseline@2` by a new frozen record, with `baseline@1` kept as an opponent. | Keeps comparisons reproducible. |
| Duel scoring is per seed pair with both seat assignments; the pool is fixed data and versioned; training never uses held-out seeds; hunger-six quality gates are the regression guard for any duel-trained candidate. | Prevents overfitting to one scripted opponent or one arena. |
| `skills.ts` is split first (item M0): civilization-only handlers move to `civilization-skills.ts`, owned by the civilization lane. | One 1,300-line file owned by two lanes is the dominant merge risk. |
| Rule modes are `kind` values of the optional schema-3 `[rules]` table (`frontier_survival`, `squads`, `uhc_duel`; `frontier_war` when C-items land), each versioned; absent means classic `hunger_games`. No frozen scenario changes meaning. | Frozen baselines must stay reproducible. |

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

**Open live failures (not re-run):** `civilization-rules` times out waiting for seat 1 to observe a mined block (run `b7e91e9e`, Paper checkpoint at tick 2716 shows the sixth oak log absent and one dropped item); at that tip server-crash cleanup showed a cleanup failure and there was no clean live SIGINT proof (G2 later passed both `faults-sigint` and `faults-server-crash`); five of six natural seeds have no live terrain check; no current-source full suite, benchmark, fresh-checkout or Linux run.

**Reference numbers for D3.** Frozen six-seed run: 6,231 attack actions, 5,576 `preconditionsNotMet` (89.5%), 339 succeeded, 341 local damage events. Fixture: `tests/fixtures/hunger-six-baseline/` (`481516.json`–`481521.json`, `hunger-six.tap`, `hunger-six-recheck.tap`). The frozen commit `296c3c9` no longer resolves in this history; the fixture is the evidence. Current-source recheck: five wins and one draw. These are action outcomes, not hit accuracy.

---

### Updated measurements (2026-10-14, after the quality sprint)

| Command or run | Time or result |
|---|---|
| `./arena build --package all` warm | about 2 s |
| Offline suite (compiled, 4-way concurrency) | 631 tests, about 25 s |
| Java unit (`./arena test --suite java --case unit`) | 6–16 s |
| Live `stack`, `legal-player` | 15 s, 131 s |
| `curriculum-melee`, `curriculum-ranged` live | 106 s, 73 s |
| `./arena quality` three hunger-six seeds, concurrency 1 / 2 / 3 | 810 s / 573 s / 368 s (shared host) |
| Setup-only world preparation (hunger-six) | 35–47 s per world |
| Baseline quality, four seeds | seats looting 0.58, PvP eliminations 0.53, self-inflicted rejections 0.63 per issued attack, longest unexplained idle 2,236 ticks |

## 4. Sequence

Steering order S0 through S9 runs before any unfinished section 4 item. A section 4 id in Item status is not a steering id, even when the numbers match. The Priority override sequence no longer sets the order. Items are capabilities a lane delivers end to end. A lane takes several in a go. Prerequisites that cross workstreams are written on the item.

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
| **M1** | MECH | L | M0, G2 | Action funnel with typed reasons (opportunity → choice → admission → local validation → issued → client response → evaluator-confirmed effect); fractional combat view (validated finite floats, integer block identity kept); engage skill coordinating pursuit, spacing, aim and attack under the existing exclusive skill owner; root cause of the 89.5% rejection shown by a failing test before the fix; the 3-block adapter reach against the 4-block documented fight range reconciled by one named constant (`MELEE_REACH_BLOCKS` in `packages/arena-core/src/combat.ts`). Curriculum rows 1–6 of §6 offline and live (`curriculum-melee`). |
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
| Quality | `./arena quality --scenario scenarios/hunger-six.toml --seeds 481516,481517,481518,481519,481520,481521 --candidate improved --concurrency 2 --accept-minecraft-eula` | All five Quality gates pass on the six seeds; candidate reason codes fired; compared against `baseline@1` on the same tip |
| Duel (D-*) | `./arena duel --candidate improved --opponent pool --seeds <manifest> --rounds <n>` | D-train threshold met against `baseline@1` and the pool, duel gates met, and no hunger-six regression |
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

### Verified code map (refreshed at the second pause tip)

| Area | Anchor |
|---|---|
| Launcher, usage, Node check | `arena:87` (`prepare_node`), usage block in `arena`; `scripts/run-named-tests.mjs` (case registry: integration and acceptance names are closed sets) |
| CLI commands today | `doctor`, `gc`, `inspect`, `report`, `replay-policy`, `compare`, `explain`, `decision-diff`, `league`, `quality`, `bench`, `prepare`, `validate`, `run`, `play`, `watch`, `save`, `resume` in `packages/arena-runner/src/cli.ts` (`duel` is not implemented yet) |
| Spectator wait | `packages/arena-runner/src/runtime/external-player-gate.ts`, `Makefile` target `server` |
| Decision loop and dispositions | `packages/arena-runner/src/runtime/live-policy-loop.ts` (`#disposition`) (start, continue, defer, replace; `cleanupPending`, `lowerPriority`, `goalPersistence`, `hysteresis`) |
| Melee admission | `packages/arena-core/src/combat.ts` (`MELEE_REACH_BLOCKS = 3`, eye to bounding box); `packages/arena-bots/src/skills.ts` `#pursueAndStrike`; `docs/policies.md` fight range 4 versus reach 3 |
| Seat bounds | `packages/arena-core/src/observation.ts:46` (0–255); six-seat caps listed in S1 |
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
- **Exploration and goals.** A lazy hierarchical navigation map from each client's permitted world; destinations resolve to observed traversable support. Goals (food, weapon upgrade, safe terrain, cached chest, ammunition, avoiding a stronger group, ambush, pre-border reposition) use utility scoring or a bounded planner with an explicit work budget and known state only. The next candidate is `frontier-v1` (Steering order). Its recorded scores are the scores that selected the goal. `GOAL_SCORE` in `policy-v5.ts` is explanation-only and stays frozen with `improved`. The first goal union is `escapeBorder`, `heal`, `loot`, `engage`, and a safe `explore` fallback. Later jobs reuse that arbitration. Opening styles are biases, not handicaps; a style name without a distinct verified behavior does not count. `decideOpeningV5` ignores `OpeningPolicyContext.style` and copies `context.state` through.
- **Scenario DSL.** A small composition layer with only consumed features (terrain rules, placement constraints, prefab blueprints, kits, loot tables, rosters, objectives, material and recipe sets), compiled to canonical IR. No embedded evaluation.

### Fairness

- Visible entities and items inform decisions only through the bot's own receipts and declared line of sight and field of view. Hidden chest contents, buried ore, unseen players, inaccessible health and evaluator state never enter policy inputs. A loaded chunk is collision data, not permission to select hidden ore or containers.
- Facts learned earlier are remembered with timestamps. `knownLastSeen` is an earlier sighting that passed the cone and the voxel ray. A sweep uses a fixed, world-independent schedule. Coordinates of an entity that failed that check do not choose gaze, a step, a path endpoint, or a sweep angle. Motion prediction uses observed history, never future server positions.
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

- 2026-10-14 G0: bumped Node lock to 26.11.1 per owner; moved this doc to `docs/` and deleted both predecessors.
- 2026-10-14 G2: `./arena` integration cases now build `all` before `stack`; a fresh worktree failed on missing package output otherwise.
- 2026-10-14 S3a: border center is the floored mean spawn column (fractional centers made every policy hold `borderUnknown`).
- 2026-10-14 S3: rule modes are a `[rules]` table in scenario 3; squads outcome stays last-survivor by seat.
- 2026-10-14 M3: introduced `policy-input-v4`; merge held until the runner migration (R2) landed.
- 2026-10-14 S7: natural hunger-six moved to scenario schema 3 so the spawn search applies; schema 1/2 stay strict.
- 2026-10-14 resume: Q-resilience stays behind Q-engage (shared `skills.ts`); D-ladder accepts any two-seat hunger scenario until `uhc_duel` merges; Q-trapped runs beside D-ladder because it only edits seat quality.
- 2026-10-14 Q-resilience: a Mineflayer error whose message contains `this client is quarantined` retires that seat only. `RunDegradation.worker` and `epoch` are `number | null`; a quarantine row uses null, so result JSON `worker_losses` can contain nulls. It is not a `worker-loss-v1` trace note. `--workers` greater than 1 does not copy that row onto the supervisor result.
- 2026-10-14 steering: the owner stopped execution during the drop duel. That run is not a result. Search and drop commits `92a09ea`, `eea8169`, `6accccf`, and `7e93161` stay on the branch and are a rejected method. Seed 260114 score 0.75 is a match fact and is excluded from combat-skill qualification. Next order is S0, then S1. `decideOpeningV5` ignores `OpeningPolicyContext.style` and returns `context.state` unchanged.

## 12. Campaign log (append-only, one line per phase end or parked item)

- 2026-10-14 P0 end: G0 and G1 merged, G2 baseline recorded (legal-player pass; civilization-rules and hunger-six red).
- 2026-10-14 P1 partial: S1–S10, M0–M3a, L1a, R1–R3, L1, K1, B1 merged; C0 and M4 parked partial (craft defect, survival case unrun).
- 2026-10-14 paused: campaign wound down at owner request; see Handoff.
- 2026-10-14 quality sprint: Q0 baseline, Q-loop, policy-v5/improved, S11/S13 spawn fixes merged; melee engage rewrite planned not implemented; second pause at owner request.
- 2026-10-14 resumed: wave is Q-engage (`campaign/frontier-engage`), D-rules (`campaign/frontier-duel-rules`), D-ladder (`campaign/frontier-duel-ladder`), Q-trapped (`campaign/frontier-trapped`). Worktrees under `.work/wt/frontier-*`. Q-resilience waits on Q-engage because both edit `skills.ts`. D-pool and D-skills wait for the same reason. D-ladder does not depend on the `uhc_duel` kind; it accepts any two-seat hunger scenario until D-rules merges.
- 2026-10-14 Q-trapped merged offline at `7707b16`. Compiled package tests 624/624, lint clean. Report shape adds `idle.trapped_ticks` and `idle.max_trapped_span_ticks` and a `trapped` column. Not live-checked.
- 2026-10-14 D-ladder merged offline at `96c7f5a`. `./arena duel` plans both seat assignments, scores with the league seed-cluster `tInterval`, and records run ids. `--opponent pool` is `duel_opponent_pool_unavailable` until D-pool. Engagement omits swings, time in reach, heals, bow shots, bow hits, and first strike. Compiled package tests 627/627, lint clean. Not live-checked.
- 2026-10-14 D-rules merged offline at `c3a871c`. Schema-3 `[rules].kind = "uhc_duel"` version 1, semantic-id discriminant 3. Shipped scenario id `e3f9ef8eed6d0e4036af909e98ab81e6797df74460b5109c8c937e9713279b24`. Every prepare sets `NATURAL_REGENERATION` (false only for this kind). Kit is granted once in `bindSeat`. Arena is natural 1024 terrain because schema 3 has no superflat. Compiled package tests 640/640, lint clean, Java unit green, `./arena validate` green. Live smoke not run.
- 2026-10-14 Q-engage merged offline at `54ff3bf` and `cf664c8`. The strike leads one tick and swings after one non-forced look once the crosshair is on the body. `isCrosshairOnBody` is unchanged. Compiled package tests 644/644, bots 126/126, lint clean.
- 2026-10-14 Q-engage live: the first `curriculum-melee` on that tip failed the 5% admission gate at 3/31, all `targetNoLongerVisible` after a fixed 54-tick pursuit. `e9e04a0` keeps turning through the cooldown after a cone miss. `b59a721` gives looking during pursuit back to the pathfinder. The rerun passed: static 22 attacks and 0 rejections, fractional-boundary 11 and 0, 37 server hits, 33 attacks, 0 rejections.
- 2026-10-14 six-seed quality, `./arena quality --scenario scenarios/hunger-six.toml --seeds 481516,481517,481518,481519,481520,481521 --candidate improved --concurrency 2 --accept-minecraft-eula`. All six matches terminated. Gates: terminate pass, loot 0.556 fail, PvP eliminations 0.655 pass, self-inflicted rejections 0.268 fail, unexplained idle span 1,288 fail. Issued attacks 183, rejected 112, self-inflicted 49. Improved seats 92 issued and 16 self-inflicted; baseline seats 91 and 33. Survivors: improved seats won 481517, 481520, and 481521; baseline seats won 481516 and 481518; 481519 drew with baseline seats 1 and 3. Seed 481516 is degraded: ArenaBot4 (improved seat 4) disconnected during a chest interaction and the match still finished, winner baseline seat 1. This is not a league verdict.
- 2026-10-14 D-rules live smoke: `./arena run --scenario scenarios/uhc-duel.toml` run `5bd6836b-22d1-4978-b63a-d0a5185cfae1` finished with winner seat 0 at match tick 6091, one elimination, zero disconnects. The prepare payload is `uhc_duel` and the scenario id matches `e3f9ef8eed6d0e4036af909e98ab81e6797df74460b5109c8c937e9713279b24`. Statistics recorded `playerKills` 0, so the elimination was not credited as a player kill.
- 2026-10-14 Q-resilience merged offline at `d917f87`. An injected quarantine eliminates that seat, records `degraded` on the in-process loop, and lets the other seat finish. Policy-loop tests 20/20. Any other action error still fails the run. Not live-checked. `--workers` greater than 1 does not mark the supervisor result degraded.
- 2026-10-14 D-pool merged offline at `399a969` and `d0cf2a2`. Pool version 1 is `stationary-dummy`, `strafer`, `aggressive-rusher`, `bow-kiter`, `shield-user`, and frozen `baseline`. `--opponent pool` plans the two-seat swap once per member. The report stays schema 1, sets `opponent` to `pool`, and adds `pool_version` 1. A non-baseline member's plan keeps candidate id `baseline` and sets `poolPartner` to the member id; `seatOpponent` assigns that id. `bow-kiter` navigates to its own block when already outside melee reach and steps out when inside; it does not shoot. `shield-user` attacks above 10 half-hearts and navigates away at or below that; it does not raise a shield. Named duel tests 5/5. Not live-checked.
- 2026-10-14 D-skills merged offline at `ce0a2e1` and `329285d`. On `improved` only, a seat with food eats (`eatUnderPressure`) when hunger or health is at the existing threshold, including while an opponent is visible. With no food and health at the retreat threshold it navigates away inside the border (`disengageWhenBehind`). An unarmed approach still becomes `attack` with `steadyMeleeEngagement` on both sides of melee reach. Baseline decisions are unchanged. Policy-v5 tests 18/18 before the bow slice. Not live-checked. The observation has no opponent health, attack cooldown, golden-apple id, shield slot, or ground column.
- 2026-10-14 D-skills bow merged offline at `5ec6ce3`. `improved` emits `shoot` with `bowOpening` when arrows remain and the opponent is outside melee reach, and `attack` inside that reach. A hunt past fight range with arrows uses `shoot` and keeps `huntVisibleOpponentArmed`. Zero arrows does not shoot. The skill equips the bow, calls Mineflayer `activateItem` and `deactivateItem`, and fails with `noAmmunition` without swinging when no arrow or bow is present. Opening replay counts `shoot` in the attack bucket; the trace schema stays 2. Policy, mechanics, and skills tests 61/61. The melee strike path was not changed. The client can already raise a shield in the skill tests; the policy still does not.
- 2026-10-14 UHC duel smoke: `./arena duel --scenario scenarios/uhc-duel.toml --candidate improved --opponent baseline --seeds 260114 --rounds 1 --concurrency 1`. Both matches completed, none degraded. Score mean 0.75 (one cluster, no interval): improved won the seat-0 assignment 1–0 after baseline died to the border at tick 6091 having moved 3 blocks; the swapped assignment drew at tick 7200 with both seats alive. PvP hits 0, attacks issued 0, and no `shoot` or `bowOpening` record. `eatUnderPressure` fired 8 times in each match. The first match's 3,046 decisions contain no observation with a visible opponent, so the bow path never had a target. The closest positions were about 9 blocks apart horizontally and 19 vertically, outside a level look. This does not show a bow shot or a fight.
- 2026-10-14 D-sight merged offline at `a9e4173`. After a `withinRange` or `exactBlock` travel leg stops, the client looks once at a point 8 blocks toward the goal and 12 blocks below the eye. `meleeReach` and `pickupReach` do not. The 40-block, 120° by 90° cone is unchanged. A level look still misses the recorded drop; that downward look includes it. Named tests passed.
- 2026-10-14 D-sight live rerun, same command and seed 260114. Both matches completed, none degraded. Improved won both: baseline died to the border at tick 6091 and at tick 6030. PvP hits 0, attacks issued 0. The first match again had 3,046 decisions and no visible opponent. The look is followed by the next path leg, so the policy samples the view after the pathfinder has looked away.
- 2026-10-14 D-sight hold merged offline at `734c927`. If the downward look puts another targetable player inside the existing cone, travel returns without another `setGoal` and leaves the look in place. With no such player, later legs still run. Melee pursuit does not look down. The travel-look test passed.
- 2026-10-14 D-sight hold live rerun, same command and seed 260114. Score mean 0.75: improved won the first assignment when baseline died to the border at tick 6091, and the swap drew at tick 7200. PvP hits 0, attacks issued 0. The first match again had 3,046 decisions and an empty opponent list. The closest samples were about 6.3 blocks apart horizontally and 20 vertically. The downward look aims along the travel goal, so a player beside that line stays outside the 120° cone.
- 2026-10-14 D-sight sweep merged offline at `6a2d5dd`. Between travel legs the client looks down on the goal heading and three quarter-turns, and returns on the first look that puts a targetable player inside the existing cone. The cone is unchanged. The headings are not aimed at the entity map. The travel-look test passed after a type-narrowing fix in that test.
- 2026-10-14 D-sight sweep live rerun, same command and seed 260114. Score mean 0.75: improved won when baseline died to the border at tick 6091; the swap drew at tick 7200. PvP hits 0, attacks issued 0. The first match again had 3,046 decisions and an empty opponent list. Closest samples were about 8.9 blocks apart horizontally and 19 vertically, inside the angle of a downward look. The voxel ray is the filter still rejecting them. A trapped seat also never reaches the sweep, because a `noPath` failure skips it.
- 2026-10-14 D-sight search merged offline at `92a09ea`. The four-heading sweep also runs after `noProgress` from `noPath`, before that failure leaves navigation. A fully visible player still ends travel on that look. A player inside the angular cone whose voxel ray fails becomes the next goal, one horizontal block toward that player's block, as an exact block so a range-2 arrival does not skip the step. Melee and pickup do not sweep. The travel-look test and the two arrival tests passed.
- 2026-10-14 D-sight search live rerun, same command and seed 260114. Score mean 0.75 again: improved won on a border death at tick 6091, and the swap drew at tick 7200. PvP hits 0, attacks issued 0. The first match still had 3,046 decisions and an empty opponent list. Closest samples were 11 blocks apart horizontally and 19 vertically. A failed step to the same block can repeat until the navigation deadline.
- 2026-10-14 D-sight rim merged offline at `eea8169` and `6accccf`. A blocked step is used only when the block below is solid and the feet and head are empty. If the next block is air, the bot walks to 0.3 blocks in from the current block's near edge, without a path goal, for at most 8 physics ticks. A following look that sees the player ends travel. A nudge or exact step that already failed is not selected again. Melee and pickup do not sweep. The travel-look test and the arrival test passed.
- 2026-10-14 D-sight rim live rerun, same command and seed 260114. Score mean 0.75 again: improved won on a border death at tick 6091, and the swap drew at tick 7200. PvP hits 0, attacks issued 0. The first match still had 3,046 decisions and an empty opponent list. Closest samples were 5.1 blocks apart horizontally and 20 vertically, at about (520, 63, 508) and (525, 43, 509). The default pathfinder drop is 4 blocks, so the upper seat cannot path down to the trapped seat.
- 2026-10-14 D-sight drop merged offline at `7e93161`. When a player the current look classifies as blocked is below and the next column is a drop, one travel leg raises `maxDropDown` enough to reach that floor, at most 24, and restores the previous value in `finally`. Parkour, digging, and towers stay off. A failed drop is not repeated. A fully visible player still ends travel. The travel-look test and the arrival test passed. Not live-checked. The owner stopped the seed-260114 rerun before a match result. Live lock released. Steering order rejects this method. Do not extend it.
- 2026-10-14 steering order incorporated from `arena_frontier_steering_v2.md`, and that file deleted. Execution stays stopped until the owner says resume. Next work is S0, then S1. S3 may run beside them only as pure `arena-core` that does not edit `skills.ts`.
- 2026-10-14 resumed: wave is steering S0 (`campaign/frontier-s0`, duel contact report, no policy edits), steering S1 (`campaign/frontier-s1`, scenario schema for a planned UHC lab, no live match), and steering S3 (`campaign/frontier-s3`, pure `frontier-v1`, no `skills.ts`). Live damage on the new arena waits until S1 is merged.

## 13. For the owner afterwards

While the campaign is open, resume from the Handoff prompt. After it finishes, read the reports below. Do not start again from G0.

- Read `docs/acceptance-report.md`, the league report, the capacity summaries and the list of parked items in the campaign log.
- Cherry-pick from `campaign/frontier`; nothing is pushed.
- Review the `AGENTS.md` invariant rewrite and the Node lock bump first; they are the two contract edits that outlive the campaign.
- The open-campaign resume prompt is in the Handoff. G0 is already merged.
