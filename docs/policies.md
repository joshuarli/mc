# Client policy and observation boundary

`@arena/core` contains deterministic TypeScript policy and integer geometry. Its source has no Node runtime, network, filesystem, Mineflayer, plugin, or evaluator dependency. A caller creates one immutable `AgentObservation` from one client's received state and passes that snapshot with the seat's prior `PolicyMemory`, validated `PolicyParams`, and deterministic search stream to `decide`. The result contains a goal, an adapter-facing intent, and the next memory. It never contains a client handle, world query, skill task, or evaluator state.

```ts
const decision = decide(observation, memory, params, searchRandom);
memory = decision.memory;
```

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

`PolicyParams.baseline()` is the sole typed baseline default. Arbitrary code or unvalidated parameter values are not accepted by `decide`.

## Determinism and outcomes

`DeterministicRandom` pins SplitMix64 with 64-bit `bigint` state and reference vectors. `RandomStream` derives separate policy and search streams by stable seat ID, plus a setup stream. The fallback exploration choice uses the supplied search stream; candidate order and hysteresis never depend on randomness. JSON boundaries encode 64-bit seeds and control sequences as canonical decimal strings. Replay records the stream seed/key and normalized observation, memory, params, and decisions. This proves deterministic core decisions for those recorded inputs; it does not prove live client path determinism or cross-architecture replay.

Geometry uses safe-integer block coordinates. Distances and border checks use exact `bigint` arithmetic. `offsetBlockPosition` returns a tagged coordinate-overflow result when an offset would leave the safe-integer range. The policy returns `wait { reason: 'unrepresentableTarget' }` with `hold` when retreat or exploration cannot be represented. Skill outcomes are closed variants; progress is strictly between pending and succeeded, timeout is a failure cause, and cancellation has its own outcome.

## Adapter and fairness proof seam

`arena-bots` converts each client's receipt-tracked view into `AgentObservation`. That conversion owns the assignment of current, stale, and unknown states. Navigation and policy must use the same per-client knowledge; shared pathfinder state cannot widen the client's view. Equipment and food intents address the exact inventory slots validated from that client's received inventory.

This offline core slice does not prove receipt isolation. Before any fairness claim, the adapter must pass the live two-client test with disjoint chunk/entity receipt, hidden-state perturbation, and identical permitted observations producing identical decisions. Core fixtures prove deterministic policy behavior only.
