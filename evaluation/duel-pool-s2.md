# Duel pool S2 qualification

Pool version 2 changes the `bow-kiter` action policy and adds receipt based qualification. `DUEL_POOL_IDS` continues to expose every member for direct diagnostic runs. `DUEL_POOL_SCORING_CANDIDATES` excludes `stationary-dummy`; the promotion set is the subset that has client and server receipts for every required action. The latest live receipt run, `d09a034`, completed all 12 seat assignments for `scenarios/uhc-bow.toml`, seed `710121`, in report 0016. All five scoring members qualified. Their pool score averaged 0.1 (one win in ten scoring matches), so this run establishes opponent eligibility, not candidate promotion.

## Qualification

| Member | Required client and server receipts | Status | Reason |
| --- | --- | --- | --- |
| `stationary-dummy` | Diagnostic only | Diagnostic | Excluded from promotion scoring |
| `strafer` | Measurable lateral movement | Qualified | Paired in assignment 1; assignment 0 movement was unpaired |
| `aggressive-rusher` | Contact started | Qualified | Paired in assignment 0; assignment 1 had no paired contact |
| `bow-kiter` | Arrow released; distance maintained | Qualified | Arrow release paired in both assignments; distance maintained paired in assignment 1 |
| `shield-user` | Shield raised; shield lowered; healed with a permitted item | Qualified | All three actions paired in both assignments |
| `baseline` | Contact started | Qualified | Paired in both assignments |

Report 0016 planned and completed all 12 matches with no failures. The two `stationary-dummy` outcomes remain diagnostic; promotion scoring used all ten matches against the five qualified members. The candidate scored one win and nine losses in that set (mean 0.1), below the promotion threshold. Historical report 0015 also completed all 12 matches, but only `baseline` qualified there; its two scored matches were both losses.

The planned UHC bow duel completed both assignments for seed `710114`, round 0, at concurrency 1. The trace seat-policy record identifies `bow-kiter` as seat 1 in assignment 0. Its 100 client observations showed no visible opponents, `navigate` intents to its current block, and arrows unchanged at 16/17; seat 0 `improved` produced the observed arrows and server `Take Aim` advancement, so those events do not qualify `bow-kiter`.

The `strafer` duel on the UHC bow kit completed both assignments for seed `710115`. Its trace showed 93 `navigate`/`explore` decisions with no visible opponent and no lateral displacement. The first `aggressive-rusher` duel on the UHC bow kit completed both assignments for seed `710116`; its member trace remained `navigate` with no visible opponent. A second `aggressive-rusher` duel on `scenarios/uhc-melee.toml` completed both assignments for seed `710118`; the member still emitted no approach or attack intent before the other participant initiated server recorded melee contact.

The `shield-user` duel on `scenarios/uhc-melee.toml` completed both assignments for seed `710119`. In the member's client trace, eating from slot 39 reduced the stack from two to one. That scenario puts golden apples in slot 39. The corresponding Paper player statistics record `minecraft:used:minecraft:golden_apple: 2` and `damage_absorbed: 40`, establishing permitted-item healing and its server effect. The trace contains no attack or shield action, and the server statistics show no shield use, so the member remains unqualified for `shieldRaised` and `shieldLowered`.

The separate legacy `curriculum-ranged` live setup failed before combat: chest navigation returned `preconditionsNotMet`. It produced no S2 receipts and does not change the planned UHC duel evidence.

The seed `710120` trace shows why the other members did not qualify in report 0015. The scripted pool seats repeatedly navigated to their current block while their current opponent observation was empty. The server still observed some lateral displacement and distance maintenance, but the client trace did not show corresponding movement relative to an admitted opponent. The shield user's golden apple action paired, but it did not begin a client attack or raise a shield. In seed `710121`, those behaviors changed: each scoring member produced at least one bounded client/server receipt pair for every required action.

## Cross-play matrix

| Client | Server | Result | S2 evidence |
| --- | --- | --- | --- |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow duel completed both assignments, seed `710114` | `bow-kiter` acquired no visible opponent and released no arrow; the other participant's arrow is not credited |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow duel completed both assignments, seed `710115` | `strafer` acquired no visible opponent and showed no lateral displacement |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow duel completed both assignments, seed `710116` | `aggressive-rusher` acquired no visible opponent and started no contact |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC melee duels completed both assignments, seeds `710118` and `710119` | Rusher started no contact; shield user consumed golden apples and server recorded absorption but no shield action |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow pool, all six members and both seat assignments, seed `710120` | 12/12 completed; only `baseline` qualified; client/server receipt statuses are in report 0015 |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow pool, all six members and both seat assignments, seed `710121` | 12/12 completed; all five scoring members qualified; score mean 0.1, so no promotion |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | Legacy `curriculum-ranged` setup aborted before combat | Chest navigation failed before S2 actions |
| Ordinary external Minecraft client | Paper 26.1.2 build 74, protocol 775 | Not tested | No ordinary-client playtest was performed |

## Observation and replay contract

The Mineflayer observer maps golden apples and enchanted golden apples to `goldenApple`, and other food stacks to `hungerFood`. It also carries absorption in half-heart units when the player metadata value is available, and each observed active effect's id, amplifier, and duration from Mineflayer's latest entity effect state. An unavailable absorption value remains `null`; an empty effects list remains distinct from missing status.

`policy-input-v5` serializes food identity and combat status. Its reader requires those fields; v1–v4 readers retain their historical strict shapes. New runner decisions write `policy-replay-v6` with `policy-input-v5`. Duel reports use schema 3 and pool metadata version 2. A pool report retains every factual match outcome while setting unqualified score entries to null for promotion scoring. Qualification requires action-specific client and server evidence from the same match, seat and bounded tick window; a client and server event from different matches cannot qualify a member. The runner extracts contact from an issued attack against the seat named by the server damage event, arrow launch from the issued shoot action, and healing from an eat action selecting a golden apple. Reports 0015 and 0016 confirm that member/action status is reported per match and qualification is applied to aggregate scoring.
