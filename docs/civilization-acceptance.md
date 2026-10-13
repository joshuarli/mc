# Civilization Acceptance Evidence

## Material checkpoint cadence

The material stream starts with a match-tick-zero checkpoint. At each later match-tick boundary, the producer emits a checkpoint when the tracked material state changes. After any successful ordinary player death, the producer also emits a checkpoint at that death's match tick, even when the tracked state is unchanged. One checkpoint can close several death-cargo records from the same tick.

The reader requires that same-tick checkpoint after each death-cargo record. It does not treat a missing checkpoint as evidence that a zero-cargo death left material unchanged. Unchanged checkpoints without pending same-tick death-cargo records remain invalid.
