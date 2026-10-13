# Client policy and observation boundary

`arena-core` owns the deterministic policy contract and integer geometry. It has no Azalea, Tokio, server, filesystem, or network types. The public entry point is:

```rust
arena_core::decide(&observation, &memory, &params, &mut random)
```

The result contains a goal, an adapter-facing intent, and the next `PolicyMemory`. It never contains a task, client handle, world query, or evaluator state. Callers retain the returned memory and feed it into the next decision for that seat.

## Observation rules

`AgentObservation` is one client's input at a client tick and nonzero observation sequence. Its input fields use `Knowledge<T>`:

| State | Meaning | Baseline use |
|---|---|---|
| `Unknown` | The client has no permitted value. | Never infer absence or safety from it. |
| `Current(value)` | The value belongs to this observation tick. | May drive immediate action. |
| `Stale { value, observed_at }` | The client last received the value on an earlier tick. | May support bounded search or conservative threat checks; never starts combat. |

The constructor rejects stale samples whose tick is not earlier than the observation and rejects duplicate IDs in opponent or loot lists. Self health and hunger are bounded at construction. Opponent entries represent currently visible, targetable competitors; the adapter omits spectators and other non-combat entities. Entries expose a visible entity ID, position, and whether the competitor is attacking this agent; opponent health and inventory are absent. A visible drop may expose its item kind, while an unopened container exposes no contents.

The policy waits when self state is unknown, stale, or eliminated, or when the border is unknown or stale. Border escape needs a current border. Eating requires a current empty opponent observation and no recent remembered nearby threat. Stale opponents can guide a search for up to the validated memory limit, but are not attacked. Unknown opponent visibility does not prove the area is safe.

## Baseline behavior

The baseline applies these priorities:

1. Move toward the current border center when outside the safe margin.
2. Retreat from a nearby remembered or visible opponent at low health.
3. Eat when hungry, food is present, and a current opponent observation establishes a safe moment.
4. Equip the best known owned upgrade.
5. Approach or attack a currently visible opponent in range while above the retreat threshold.
6. Collect a useful visible drop or open a visible container.
7. Search a bounded last-seen position, then choose a short exploration point.

Visible opponents are ordered by exact squared integer distance and then entity ID. Loot is ordered by utility, Manhattan distance, then entity ID. A previous loot target remains selected when it is still equally useful and within the configured distance hysteresis band. Input vector order does not affect decisions.

All policy parameters enter as named `PolicyParamValues` and become `PolicyParams` only after validation. The closed `PolicyParameterVersion::V1` identifies this parameter contract; a profile parser must reject an unknown version before constructing these values. The typed baseline values are:

| Parameter | Baseline | Accepted range |
|---|---:|---:|
| Eat at hunger or below | 8 | 1–20 |
| Retreat at health half-hearts or below | 8 | 1–39 |
| Border margin | 2 blocks | 0–8 blocks |
| Fight range | 4 blocks | 1–8 blocks |
| Opponent memory | 100 ticks | 1–100 ticks |
| Loot hysteresis | 2 blocks | 0–16 blocks |
| Search radius | 8 blocks | 1–16 blocks |

`PolicyParams::baseline()` is the sole typed baseline default. Profile parsing and policy identity belong at the configuration boundary; arbitrary code or unvalidated parameter values are not accepted by the decision function.

## Determinism

`DeterministicRandom` pins SplitMix64 and its reference constants in `arena-core`. `RandomStream` derives separate streams for policy and search by stable seat ID, plus a setup stream. The fallback exploration choice uses the supplied stream; candidate order and hysteresis never depend on randomness. Replay must record the stream seed/key and the normalized `AgentObservation`, memory, params, and decisions. This proves only deterministic core decisions for those recorded inputs; it does not prove live client path determinism or cross-architecture replay.

`SeatId` accepts all 256 `u8` roster slots so benchmark streams remain distinct; the ordinary six-seat scenario limit is enforced by the spec and runner. Geometry uses integer block coordinates. Distances and border checks avoid floating-point comparison, and full `i32` coordinates cannot overflow squared-distance calculations. Checked offsets report coordinate overflow, and the policy returns `Wait(UnrepresentableTarget)` with `Hold` when retreat or exploration cannot be represented. Skill outcomes are closed variants; progress is strictly between pending and succeeded, timeout is a failure cause, and cancellation has its own outcome.

## Adapter and fairness proof seam

The named adapter seam is `arena-bots` converting each client's receipt-tracked view into `AgentObservationInput`. That conversion owns the assignment of current, stale, and unknown states. It must feed both navigation and policy from the same per-client knowledge; a shared pathfinder or evaluator state cannot widen this view.

This offline core slice does not prove receipt isolation. Before any fairness claim, the adapter must pass the live two-client test with disjoint chunk/entity receipt, hidden-state perturbation, and identical permitted observations producing identical decisions. That proof depends on the locked live stack, S1 route/container fixtures, and J1 preparation/telemetry, which are still pending. The core fixture tests are deterministic policy tests only.
