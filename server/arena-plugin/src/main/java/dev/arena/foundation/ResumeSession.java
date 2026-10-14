package dev.arena.foundation;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

final class ResumeSession {
    enum BindingPlan {
        RESTORE_SAVED_STATE,
        FRESH_RESET_AND_STARTING_KIT
    }

    private final CheckpointRecord checkpoint;
    private final int epoch;
    private final Map<Integer, UUID> restored = new HashMap<>();

    ResumeSession(CheckpointRecord checkpoint, int epoch) {
        if (epoch != checkpoint.epoch() + 1) {
            throw new IllegalArgumentException("resume epoch must follow the checkpoint epoch");
        }
        this.checkpoint = checkpoint;
        this.epoch = epoch;
    }

    int epoch() {
        return epoch;
    }

    CheckpointRecord checkpoint() {
        return checkpoint;
    }

    Set<Integer> deadSeats() {
        return checkpoint.deadSeats();
    }

    BindingPlan planFor(int seat) {
        if (checkpoint.livingSeat(seat).isEmpty()) {
            throw new IllegalStateException("only living checkpoint seats can be bound");
        }
        return BindingPlan.RESTORE_SAVED_STATE;
    }

    SeatAdmission.Decision admit(String username, UUID playerId) {
        return SeatAdmission.admit(checkpoint.prepare().roster(), true, restored, deadSeats(), username, playerId);
    }

    CheckpointRecord.LivingState markRestored(int seat, UUID playerId) {
        CheckpointRecord.SeatState state = checkpoint.livingSeat(seat).orElseThrow(
                () -> new IllegalStateException("only living checkpoint seats can be restored"));
        if (!state.uuid().equals(playerId)) {
            throw new IllegalStateException("restored player does not own the checkpoint seat");
        }
        restored.put(seat, playerId);
        return state.living().orElseThrow();
    }

    void markDisconnected(int seat) {
        restored.remove(seat);
    }

    boolean allLivingSeatsRestored() {
        Set<Integer> living = new HashSet<>();
        checkpoint.seats().forEach(seat -> {
            if (seat.alive()) {
                living.add(seat.seat());
            }
        });
        return restored.keySet().containsAll(living);
    }

    Optional<UUID> holder(int seat) {
        return Optional.ofNullable(restored.get(seat));
    }
}
