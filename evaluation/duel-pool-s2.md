# Duel pool S2 qualification

Pool version 2 changes the `bow-kiter` action policy and adds receipt based qualification. `DUEL_POOL_IDS` continues to expose every member for direct diagnostic runs. `DUEL_POOL_SCORING_CANDIDATES` excludes `stationary-dummy`; the promotion set is the subset that has client and server receipts for every required action. No member currently qualifies for promotion.

## Qualification

| Member | Required client and server receipts | Status | Reason |
| --- | --- | --- | --- |
| `stationary-dummy` | Diagnostic only | Diagnostic | Excluded from promotion scoring |
| `strafer` | Measurable lateral movement | Unqualified | The planned duel produced only `navigate` to the current block while no opponent was visible; no lateral displacement receipt |
| `aggressive-rusher` | Contact started | Unqualified | The planned bow and melee traces had no visible opponents for this member; it never emitted an approach or attack intent, and server contact came from the other participant |
| `bow-kiter` | Arrow released; distance maintained | Unqualified | The planned bow trace had no visible opponents; it navigated to the current block, kept its arrows, and produced no arrow or distance receipt |
| `shield-user` | Shield raised; shield lowered; healed with a permitted item | Unqualified | Healing is demonstrated, but no shield raise or lower action was emitted or recorded |
| `baseline` | Contact started | Unqualified | No member-specific client and server receipts |

The planned UHC bow duel completed both assignments for seed `710114`, round 0, at concurrency 1. The trace seat-policy record identifies `bow-kiter` as seat 1 in assignment 0. Its 100 client observations showed no visible opponents, `navigate` intents to its current block, and arrows unchanged at 16/17; seat 0 `improved` produced the observed arrows and server `Take Aim` advancement, so those events do not qualify `bow-kiter`.

The `strafer` duel on the UHC bow kit completed both assignments for seed `710115`. Its trace showed 93 `navigate`/`explore` decisions with no visible opponent and no lateral displacement. The first `aggressive-rusher` duel on the UHC bow kit completed both assignments for seed `710116`; its member trace remained `navigate` with no visible opponent. A second `aggressive-rusher` duel on `scenarios/uhc-melee.toml` completed both assignments for seed `710118`; the member still emitted no approach or attack intent before the other participant initiated server recorded melee contact.

The `shield-user` duel on `scenarios/uhc-melee.toml` completed both assignments for seed `710119`. In the member's client trace, eating from slot 39 reduced the stack from two to one. That scenario puts golden apples in slot 39. The corresponding Paper player statistics record `minecraft:used:minecraft:golden_apple: 2` and `damage_absorbed: 40`, establishing permitted-item healing and its server effect. The trace contains no attack or shield action, and the server statistics show no shield use, so the member remains unqualified for `shieldRaised` and `shieldLowered`.

The separate legacy `curriculum-ranged` live setup failed before combat: chest navigation returned `preconditionsNotMet`. It produced no S2 receipts and does not change the planned UHC duel evidence.

## Cross-play matrix

| Client | Server | Result | S2 evidence |
| --- | --- | --- | --- |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow duel completed both assignments, seed `710114` | `bow-kiter` acquired no visible opponent and released no arrow; the other participant's arrow is not credited |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow duel completed both assignments, seed `710115` | `strafer` acquired no visible opponent and showed no lateral displacement |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC bow duel completed both assignments, seed `710116` | `aggressive-rusher` acquired no visible opponent and started no contact |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | UHC melee duels completed both assignments, seeds `710118` and `710119` | Rusher started no contact; shield user consumed golden apples and server recorded absorption but no shield action |
| Mineflayer 4.39.0 headless clients | Paper 26.1.2 build 74, protocol 775 | Legacy `curriculum-ranged` setup aborted before combat | Chest navigation failed before S2 actions |
| Ordinary external Minecraft client | Paper 26.1.2 build 74, protocol 775 | Not tested | No ordinary-client playtest was performed |

## Observation and replay contract

The Mineflayer observer maps golden apples and enchanted golden apples to `goldenApple`, and other food stacks to `hungerFood`. It also carries absorption in half-heart units when the player metadata value is available, and each observed active effect's id, amplifier, and duration from Mineflayer's latest entity effect state. An unavailable absorption value remains `null`; an empty effects list remains distinct from missing status.

`policy-input-v5` serializes food identity and combat status. Its reader requires those fields, while v1–v4 readers remain strict and reject the new fields. Existing v1–v4 normalization remains unchanged. Runner trace writing still uses V4, writes `duel-pool-v1` metadata, and omits qualification and scoring member IDs; those RUN-owned fields need the integration handoff.
