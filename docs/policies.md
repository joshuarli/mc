# Client policy and observation boundary

`@arena/core` contains deterministic TypeScript policy and integer geometry. Its source has no Node runtime, network, filesystem, Mineflayer, plugin, or evaluator dependency. A caller creates one immutable `AgentObservation` from one client's received state and passes that snapshot with the seat's prior `PolicyMemory`, validated `PolicyParams`, deterministic search stream, and completed local skill feedback to `decide`. The result contains a goal, an adapter-facing intent, and the next memory. It never contains a client handle, world query, skill task, or evaluator state.

```ts
const feedback = createPolicyFeedback({
  initiatingObservation,
  goal: originatingDecision.goal,
  intent: originatingDecision.intent,
  outcome: completedSkillOutcome,
});
const decision = decide(observation, memory, params, searchRandom, feedback === null ? [] : [feedback]);
memory = decision.memory;
```

The adapter creates feedback only when a local skill reports success or failure. `createPolicyFeedback()` derives a target and its comparison evidence from the initiating client observation and the originating goal and intent; it accepts no adapter or world state. Cancellation has no policy effect. Feedback is ordered by completion and a batch may contain at most two outcomes between decisions. Each seat owns its own memory, which retains at most 16 failed targets in FIFO order.

## Observation rules

`agentObservation()` is the only supported constructor for an opaque, immutable `AgentObservation`; `decide()` rejects structural objects that skipped this validation. The type brands ticks, observation sequences, entity IDs, inventory slots, and seat IDs so callers cannot interchange these numeric units accidentally. An observation contains one client's state at a client tick and positive observation sequence. Its knowledge fields use the closed `Knowledge<T>` union:

| State | Meaning | Baseline use |
|---|---|---|
| `unknown` | The client has no permitted value. | Never infer absence or safety from it. |
| `current(value)` | The value belongs to this observation tick. | May drive an immediate action. |
| `stale(value, observedAt)` | The client last received the value on an earlier tick. | May support bounded search or conservative threat checks; never starts combat. |

The observation constructor rejects stale fields whose tick is not earlier than the observation and duplicate opponent IDs, drop entity IDs, or chest block positions. Self health is bounded to 0–40 half-hearts and hunger to 0–20 points. Mineflayer already reports health in half-hearts and may send fractional values after damage; the adapter rounds these up so integer policy thresholds retain their meaning and positive health never appears as zero. Negative health is rejected before rounding. Opponent entries represent currently visible, targetable competitors; the adapter omits spectators and other non-combat entities. Entries expose a visible entity ID, position, and whether that competitor is attacking this agent. Opponent health and inventory are absent.

The agent snapshot includes confirmed inventory and equipped state. Food stacks identify their inventory slot and count. Each equipment candidate identifies its inventory slot, destination equipment slot, and rating. Equipped state has a separate confirmed value for weapon, helmet, chestplate, leggings, and boots; `null` means that slot was confirmed empty. There is no aggregate armor rating. A drop target uses its client-visible entity ID. An unopened container target uses its block position because a chest has no entity ID. Container contents remain unknown until opened and observed.

Ticks and observation sequences are nonnegative safe integers, with sequence zero rejected. Seat IDs accept all 256 byte values; the ordinary six-seat scenario limit belongs to spec and runner validation. Entity IDs are positive safe integers and inventory slots are nonnegative safe integers. The adapter validates inventory slots against the client's inventory map before constructing observations.

The policy waits when self state is unknown, stale, or eliminated, or when the border is unknown or stale. Border escape needs a current border. Eating requires a current empty opponent observation and no recent remembered nearby threat. Stale opponents can guide a bounded search, but are never attacked. Unknown opponent visibility does not establish a safe moment to eat.

## Baseline behavior

The baseline applies these priorities:

1. Move toward the current border center when outside the safe margin.
2. Retreat from a nearby remembered or visible opponent at low health.
3. Eat when hungry, food is present, and a current opponent observation establishes a safe moment. Select the lowest confirmed food inventory slot.
4. Equip the best confirmed owned upgrade. Compare armor only with the same armor slot, then emit the candidate inventory slot and equipment slot.
5. Approach or attack a currently visible opponent in range while above the retreat threshold. Fight range (4 blocks) decides when to engage; melee reach (`MELEE_REACH_BLOCKS`, 3 blocks, eye to target bounding box) decides attack versus approach.
6. Collect a useful visible drop or open a visible container.
7. Search a bounded last-seen position, then choose a short exploration point.

A failed loot target is skipped while that same candidate remains unchanged. A failed last-known search is skipped while the opponent remains at the same position. A failed exploration point stays suppressed until the agent moves at least eight Manhattan blocks from its failure origin; changes to the tick, loot, opponents, or border do not retry it. Relevant loot or search evidence changes and explicit success clear the corresponding failed target. When every representable exploration direction is remembered as failed, the policy returns `wait { reason: 'failedTargetsExhausted' }`. Border escape and low-health retreat always retain their priority over failed-target memory.

## Combat view and engagement

An agent state and each visible opponent may carry a validated fractional combat view: feet position, velocity per tick, yaw, pitch, bounding-box width and height, and for the agent the eye height. Values are fixed-point integers in 1/1024 block (angles in 1/1024 radian), so the strict replay encoding keeps them as safe integers. Non-finite or out-of-range measurements are rejected when the view is built. Positions are floored when quantized, so the integer block position that identifies a block or an entity cell is always the floor of the fractional position; a mismatch is rejected. Observations without a view keep the integer block geometry, which is how historical replays decide.

With views on both sides, the policy measures reach from the agent's eye to the target's bounding box against `MELEE_REACH_BLOCKS`, the same function the adapter uses before a swing, so policy and adapter cannot disagree about whether a target is in reach. Fight range uses feet-to-feet fixed-point distance. Among opponents inside fight range the policy prefers one attacking the agent, then one inside reach, then the nearest, then the lowest entity ID. An agent at or below twice the retreat threshold with two or more opponents inside fight range retreats instead of engaging.

The adapter runs `approach` and `attack` as one engagement under the exclusive skill owner. Pursuit re-paths toward the target in bounded legs. During that close, and on every physics tick of the strike, the client makes a non-forced look at a melee aim point: a point just inside the nearest face of the target body after a one-tick horizontal lead from the target's recently observed velocity. That lead uses the same one-block-per-tick observed-velocity cap as a bow shot and does not extend `MELEE_REACH_BLOCKS`. In reach, the client waits out the weapon cooldown while still turning. Up to three consecutive physics ticks where the line of sight is blocked are ignored during that wait; a fourth consecutive blocked tick stops the engagement with `blockedLineOfSight`, and any other visibility failure stops it with that failure's existing reason. After the cooldown the client repeats the aim for at most four looks. It swings only when the current observation is inside melee reach and the crosshair ray enters the body. If those four looks do not settle, the engagement stops with `aimNotReady`. It then waits a bounded number of ticks for the client to observe the damage. Cancellation restores controls and the selected hotbar slot. A swing is never issued while the target is outside reach, outside the perception cone, or occluded.

Each engagement reports one action funnel record through the optional `funnel` sink of `createMineflayerArenaClient`. A record names the last passed stage of opportunity, tactical choice, skill admission, local validation, issued, client response and confirmed effect, and for a stop one typed reason: `outOfGeometricReach`, `targetNoLongerVisible`, `targetDespawnedOrEliminated`, `cooldownNotReady`, `aimNotReady`, `blockedLineOfSight`, `ownershipDeferred`, `clientOperationFailed`, `serverRejection`, `ambiguousConfirmation`, `timeout`, `agentEliminated` or `runShutdown`. The adapter can pass at most client response; evaluator confirmation and the stages before skill admission belong to the runner and the plugin.

## Ranged, defensive and recovery behavior

An agent state may also carry a ranged loadout (a bow plus a positive arrow count, read from the client's own inventory) and up to 32 block positions the client saw change since its previous observation. With a ranged loadout and a visible opponent within 16 blocks and outside fight range, the policy keeps the `approach` intent and the adapter shoots instead of closing: it equips the bow, draws for 20 ticks while sampling the target's received positions, derives velocity only from those samples (bounded to one block per tick), leads and drops the aim for arrow flight, refuses when the line is occluded or a rostered teammate is within one block of it, releases, and accounts the arrow from the inventory. A hit is the client observing damage from this client; an unobserved hit is reported as a miss.

Eating checks for a visible opponent within 8 blocks before starting and again every physics tick; a threat or damage releases the item and fails the action. A shield in the offhand is raised during the weapon cooldown and lowered before the swing. A block change inside the corridor of a failed exploration route clears only that failure. When every exploration direction has failed, the policy retries the oldest failure instead of idling, so a stale failure never holds the agent in place.

## Knowledge, loadout and versions

`policy-input-v4` is the schema for decisions that use the data below. `policy-input-v1` to `v3` remain strict and replay with their historical semantics: they reject a combat view, ranged loadout, terrain changes, direction support, food restoration, ammunition loot and `memory.knowledge`, and `decide` treats their observations as historical.

Policy memory may carry exploration knowledge: up to 64 visited 16-block regions and up to 8 trail positions at least 8 blocks apart, both derived only from the agent's own positions. Agent state may carry the observed support in each of the eight exploration directions at radius 8: a standable block within one block up or three down with two clear blocks above it, `blocked` (cliff, obstruction, no support), or `unloaded` (a chunk the client has not received), plus a hazard flag for lava, fire, cactus and similar ground. Exploration then targets observed support, prefers an unvisited region, skips hazards and failed targets, and when every target has failed backtracks to the newest trail position, then retries the oldest failure, and holds with `noReachableFrontier` only when every direction is known to be blocked. Fully unloaded terrain falls back to the plain ring.

Opening styles transition by state: an unarmed hunter scavenges until armed and turns to exploring when more than one opponent is visible; an explorer without a weapon scavenges after tick 200. Food choice picks the stack that restores the most hunger without exceeding the current deficit, else the smallest restoration, else the lowest slot. An archer below 16 arrows treats arrow drops as useful loot.

## Opening styles

Schema-v2 Hunger Games scenarios assign each seat a style from their explicit `openingStyleCycle`. The policy maps `(seed mod 3 + seat) mod 3` to that cycle, so each fixed seat receives all three styles across any three consecutive seeds.

After border escape, low-health retreat, safe eating, known equipment upgrades, and close combat, `explorer` skips loot and last-seen search and chooses an exploration target. `scavenger` opens at most one observed unopened container when it has no food or an empty equipment slot. After confirmed success, it navigates to a point at least eight Manhattan blocks from that container. `hunter` approaches or attacks one currently visible opponent within 12 blocks when the agent is above its retreat threshold. The policy uses only its client's observation and the current border.

`policy-input-v3` stores the seed, assigned style, cycle, and prior opening state. Replay checks the assignment and resulting opening state along with the decision and RNG state. Historical `policy-input-v1` and `policy-input-v2` retain their own strict input shapes.

Visible opponents are ordered by exact squared integer distance and then entity ID. A nearest threat currently attacking the agent wins before a non-attacking threat; remaining ties use distance and entity ID. Loot is ordered by utility, Manhattan distance, then tagged target: drop entity ID or container block position. A previous loot target remains selected when it is still equally useful and within the configured distance hysteresis band. Input vector order does not affect decisions.

Eating requires food in a confirmed slot and emits `eat { inventorySlot }`. Equipping emits `equip { inventorySlot, equipmentSlot, rating }`, so an adapter never has to guess which matching item was selected. A drop collection intent addresses an entity ID; opening a container addresses a block position. These intents describe the requested action. The adapter reports success only after observing the corresponding client state change.

## Parameters

Callers provide named `PolicyParamValues` and receive `PolicyParams` only after range validation. Version `1` is the only accepted parameter contract. Profile parsing rejects unknown versions and fields before constructing values. The values in `policies/baseline.toml` are checked against the typed baseline in `PolicyParams.baseline()`.

| Parameter | Baseline | Accepted range |
|---|---:|---:|
| Eat at hunger or below | 8 | 1–20 |
| Retreat at health half-hearts or below | 8 | 1–39 |
| Border margin | 2 blocks | 0–8 blocks |
| Fight range | 4 blocks | 1–8 blocks |
| Opponent memory | 100 ticks | 1–100 ticks |
| Loot hysteresis | 2 blocks | 0–16 blocks |
| Search radius | 8 blocks | 1–16 blocks |

In `policy-input-v2`, fallback exploration starts from one of eight horizontal directions and checks each direction at most once in cyclic order. It skips unrepresentable positions and remembered failures, then holds when every representable direction has failed. Each horizontal coordinate offset is capped at `searchRadiusBlocks`; a diagonal target may therefore have a Manhattan distance greater than that value.

`PolicyParams.baseline()` is the sole typed baseline default. Arbitrary code or unvalidated parameter values are not accepted by `decide`.

## Determinism and outcomes

`DeterministicRandom` pins SplitMix64 with 64-bit `bigint` state and reference vectors. `RandomStream` derives separate policy and search streams by stable seat ID, plus a setup stream. Exploration uses the supplied search stream; candidate ordering and hysteresis never depend on randomness. JSON boundaries encode 64-bit seeds and control sequences as canonical decimal strings. `normalizePolicyReplayInput()` captures the validated observation, prior memory, ordered feedback batch, parameters, and pre-decision RNG state in the strict `policy-input-v2` shape. Its RNG state is a canonical unsigned 64-bit decimal string; `rehydratePolicyReplayInput()` rejects unknown fields, unsafe numbers, malformed Unicode, and invalid RNG encodings, then rebuilds the branded observation through `agentObservation()`. `normalizeOpeningPolicyReplayInput()` adds the opening assignment and state in `policy-input-v3`. Historical `policy-input-v1` remains a separate memory shape and is replayed through `decidePolicyReplayV1()` without skill feedback; it retains the original single sampled exploration direction and unrepresentable-target hold. Path results do not feed policy decisions. Replaying the same normalized inputs proves identical core decision outputs; it does not prove live client path determinism or cross-architecture replay.

Trace schema 3 carries `policy-replay-v3` records. `replay-policy` reports per-seat assigned styles, first goals and intents, locally observed chest and opponent opportunities, and confirmed navigation, loot, eat, equip, and attack outcomes. It retains up to 64 distinct chest positions and visible opponent positions per seat. Trace schema 2 remains readable for historical records and rejects `policy-replay-v3` records.

Geometry uses safe-integer block coordinates. Distances and border checks use exact `bigint` arithmetic. `offsetBlockPosition` returns a tagged coordinate-overflow result when an offset would leave the safe-integer range. A retreat returns `wait { reason: 'unrepresentableTarget' }` with `hold` when it cannot be represented. Version 2 skips overflowing exploration directions; policy-input-v1 preserves its sampled direction and may return that hold. Skill outcomes are closed variants; progress is strictly between pending and succeeded, timeout is a failure cause, and cancellation has its own outcome.

## Adapter and fairness proof seam

`arena-bots` converts each client's receipt-tracked view into `AgentObservation`. That conversion owns the assignment of current, stale, and unknown states. Navigation and policy must use the same per-client knowledge; shared pathfinder state cannot widen the client's view. Equipment and food intents address the exact inventory slots validated from that client's received inventory.

This offline core slice does not prove receipt isolation. Before any fairness claim, the adapter must pass the live two-client test with disjoint chunk/entity receipt, hidden-state perturbation, and identical permitted observations producing identical decisions. Core fixtures prove deterministic policy behavior only.

## Civilization client

`createMineflayerCivilizationClient()` binds one Mineflayer connection to a validated seat, faction, role, objective, and public six-seat roster. `observe(sharedMatchTick)` combines that connection's ordinary observation and civilization view at the same authoritative match tick. Own material knowledge starts unknown until the client receives its full inventory window snapshot, and becomes stale on respawn until another snapshot arrives. Resource sightings and outpost cells come only from blocks and entities received by that client.

Team reports enter through `receiveTeamReport()` with an authenticated sender seat and current shared tick supplied separately from the decoded report. The client validates report fields, faction eligibility, age, rate, encoded size, and queue capacity before exposing a message in an observation. `run()` accepts the existing adapter skill intents, including exact block arrival; `runCivilization()` accepts the civilization gathering, crafting, transfer, and building intents. Both use the same client-owned skill lifecycle.

Civilization crafting uses the no-table oak-log recipe, which consumes one log for four planks. The client accepts only 4, 8, 12, or 16 plank outputs and reports success after its received inventory shows the matching log consumption and plank increase.
