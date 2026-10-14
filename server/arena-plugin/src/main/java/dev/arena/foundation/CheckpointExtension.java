package dev.arena.foundation;

import java.util.Optional;

interface CheckpointExtension {
    Optional<CheckpointRecord.Extension> capture();

    void restore(Optional<CheckpointRecord.Extension> saved);
}
