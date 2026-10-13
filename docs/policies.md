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

The observation constructor rejects stale fields whose tick is not earlier than the observation and duplicate opponent IDs, drop entity IDs, or chest block positions. Self health is bounded to 0–40 half-hearts and hunger to 0–20 points. Opponent entries represent currently visible, targetable competitors; the adapter omits spectators and other non-combat entities. Entries expose a visible entity ID, position, and whether that competitor is attacking this agent. Opponent health and inventory are absent.

The agent snapshot includes confirmed inventory and equipped state. Food stacks identify their inventory slot and count. Each equipment candidate identifies its inventory slot, destination equipment slot, and rating. Equipped state has a separate confirmed value for weapon, helmet, chestplate, leggings, and boots; `null` means that slot was confirmed empty. There is no aggregate armor rating. A drop target uses its client-visible entity ID. An unopened container target uses its block position because a chest has no entity ID. Container contents remain unknown until opened and observed.

Ticks and observation sequences are nonnegative safe integers, with sequence zero rejected. Seat IDs accept all 256 byte values; the ordinary six-seat scenario limit belongs to spec and runner validation. Entity IDs are positive safe integers and inventory slots are nonnegative safe integers. The adapter validates inventory slots against the client's inventory map before constructing observations.

The policy waits when self state is unknown, stale, or eliminated, or when the border is unknown or stale. Border escape needs a current border. Eating requires a current empty opponent observation and no recent remembered nearby threat. Stale opponents can guide a bounded search, but are never attacked. Unknown opponent visibility does not establish a safe moment to eat.

## Baseline behavior

The baseline applies these priorities:

1. Move toward the current border center when outside the safe margin.
2. Retreat from a nearby remembered or visible opponent at low health.
3. Eat when hungry, food is present, and a current opponent observation establishes a safe moment. Select the lowest confirmed food inventory slot.
4. Equip the best confirmed owned upgrade. Compare armor only with the same armor slot, then emit the candidate inventory slot and equipment slot.
5. Approach or attack a currently visible opponent in range while above the retreat threshold.
6. Collect a useful visible drop or open a visible container.
7. Search a bounded last-seen position, then choose a short exploration point.

A failed loot target is skipped while that same candidate remains unchanged. A failed last-known search is skipped while the opponent remains at the same position. A failed exploration point stays suppressed until the agent moves at least eight Manhattan blocks from its failure origin; changes to the tick, loot, opponents, or border do not retry it. Relevant loot or search evidence changes and explicit success clear the corresponding failed target. When every representable exploration direction is remembered as failed, the policy returns `wait { reason: 'failedTargetsExhausted' }`. Border escape and low-health retreat always retain their priority over failed-target memory.

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

`DeterministicRandom` pins SplitMix64 with 64-bit `bigint` state and reference vectors. `RandomStream` derives separate policy and search streams by stable seat ID, plus a setup stream. Exploration uses the supplied search stream; candidate ordering and hysteresis never depend on randomness. JSON boundaries encode 64-bit seeds and control sequences as canonical decimal strings. `normalizePolicyReplayInput()` captures the validated observation, prior memory, ordered feedback batch, parameters, and pre-decision RNG state in the strict `policy-input-v2` shape. Its RNG state is a canonical unsigned 64-bit decimal string; `rehydratePolicyReplayInput()` rejects unknown fields, unsafe numbers, malformed Unicode, and invalid RNG encodings, then rebuilds the branded observation through `agentObservation()`. Historical `policy-input-v1` remains a separate memory shape and is replayed through `decidePolicyReplayV1()` without skill feedback; it retains the original single sampled exploration direction and unrepresentable-target hold. Path results do not feed policy decisions. Replaying the same normalized inputs proves identical core decision outputs; it does not prove live client path determinism or cross-architecture replay.

Geometry uses safe-integer block coordinates. Distances and border checks use exact `bigint` arithmetic. `offsetBlockPosition` returns a tagged coordinate-overflow result when an offset would leave the safe-integer range. A retreat returns `wait { reason: 'unrepresentableTarget' }` with `hold` when it cannot be represented. Version 2 skips overflowing exploration directions; policy-input-v1 preserves its sampled direction and may return that hold. Skill outcomes are closed variants; progress is strictly between pending and succeeded, timeout is a failure cause, and cancellation has its own outcome.

## Adapter and fairness proof seam

`arena-bots` converts each client's receipt-tracked view into `AgentObservation`. That conversion owns the assignment of current, stale, and unknown states. Navigation and policy must use the same per-client knowledge; shared pathfinder state cannot widen the client's view. Equipment and food intents address the exact inventory slots validated from that client's received inventory.

This offline core slice does not prove receipt isolation. Before any fairness claim, the adapter must pass the live two-client test with disjoint chunk/entity receipt, hidden-state perturbation, and identical permitted observations producing identical decisions. Core fixtures prove deterministic policy behavior only.

## Civilization client

`createMineflayerCivilizationClient()` binds one Mineflayer connection to a validated seat, faction, role, objective, and public six-seat roster. `observe(sharedMatchTick)` combines that connection's ordinary observation and civilization view at the same authoritative match tick. Own material knowledge starts unknown until the client receives its full inventory window snapshot, and becomes stale on respawn until another snapshot arrives. Resource sightings and outpost cells come only from blocks and entities received by that client.

Team reports enter through `receiveTeamReport()` with an authenticated sender seat and current shared tick supplied separately from the decoded report. The client validates report fields, faction eligibility, age, rate, encoded size, and queue capacity before exposing a message in an observation. `run()` accepts the existing adapter skill intents, including exact block arrival; `runCivilization()` accepts the civilization gathering, crafting, transfer, and building intents. Both use the same client-owned skill lifecycle.

Civilization crafting uses the no-table oak-log recipe, which consumes one log for four planks. The client accepts only 4, 8, 12, or 16 plank outputs and reports success after its received inventory shows the matching log consumption and plank increase.
