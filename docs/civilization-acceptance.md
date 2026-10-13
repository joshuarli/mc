# Civilization Acceptance Evidence

## Live scenarios

`tests/integration/civilization-six.ts` drives all six configured seats through both faction material chains, captures the configured zone with each faction in sequence, observes a gatherer die with its remaining log cargo, and requires an ordinary faction elimination outcome. Its assertions use completed client actions, authenticated public events, and the evaluator-only server material census.

`tests/integration/civilization-rules.ts` exercises an in-progress client cancellation, a stale natural-log target after another client removes that block, competing withdrawals of the final chest plank, and a client route that is replanned after it crosses the cells later occupied by an outpost. It then requires a normal faction elimination outcome and checks the authoritative material census.

`tests/acceptance/civilization-baseline.ts` runs the unchanged six-seat scenario with the real Civilization policy driver. It compares per-seat live activity with serialized Civilization policy decisions and effects, checks each configured role's useful action against authoritative public state or the material census, verifies fixed-map wood conservation, and records the runtime's resource samples and peaks.

The acceptance helper temporarily adds `-Darena.civilization-evaluator=true` through `JAVA_TOOL_OPTIONS` only while the owned Paper run executes. It rejects the same property in inherited Java option variables or the prepared Paper arguments, then restores the caller's exact prior `JAVA_TOOL_OPTIONS` value.

## Material checkpoint cadence

The material stream starts with a match-tick-zero checkpoint. At each later match-tick boundary, the producer emits a checkpoint when the tracked material state changes. After any successful ordinary player death, the producer also emits a checkpoint at that death's match tick, even when the tracked state is unchanged. One checkpoint can close several death-cargo records from the same tick.

The reader requires that same-tick checkpoint after each death-cargo record. It does not treat a missing checkpoint as evidence that a zero-cargo death left material unchanged. Unchanged checkpoints without pending same-tick death-cargo records remain invalid.
