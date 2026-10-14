package dev.arena.foundation;

import io.papermc.paper.event.player.PlayerFailMoveEvent;
import java.math.BigInteger;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Consumer;
import org.bukkit.Location;

final class MovementFailureDiagnostics {
    static final int MAX_CAPTURED_EVENTS = 256;

    private final boolean enabled;
    private int capturedEvents;
    private boolean truncationReported;

    private MovementFailureDiagnostics(boolean enabled) {
        this.enabled = enabled;
    }

    static MovementFailureDiagnostics fromProperty(String value) {
        if (value == null || value.equals("false")) {
            return new MovementFailureDiagnostics(false);
        }
        if (value.equals("true")) {
            return new MovementFailureDiagnostics(true);
        }
        throw new IllegalArgumentException("arena.movement-diagnostics must be exactly 'true' or 'false'");
    }

    boolean isEnabled() {
        return enabled;
    }

    void capture(
            PlayerFailMoveEvent event,
            Integer seat,
            MatchController.Phase phase,
            Optional<BigInteger> tick,
            Consumer<String> log) {
        Objects.requireNonNull(event, "event");
        Objects.requireNonNull(phase, "phase");
        Objects.requireNonNull(tick, "tick");
        Objects.requireNonNull(log, "log");
        if (!enabled || seat == null || (phase != MatchController.Phase.GRACE && phase != MatchController.Phase.ACTIVE)) {
            return;
        }
        if (seat < 0) {
            throw new IllegalArgumentException("movement diagnostic seat cannot be negative");
        }
        BigInteger matchTick = tick.orElseThrow(
                () -> new IllegalStateException("movement diagnostic match phase requires a match tick"));
        if (capturedEvents >= MAX_CAPTURED_EVENTS) {
            if (!truncationReported) {
                log.accept("ARENA_FAIL_MOVE_TRUNCATED|limit=" + MAX_CAPTURED_EVENTS);
                truncationReported = true;
            }
            return;
        }

        log.accept("ARENA_FAIL_MOVE"
                + "|seat=" + seat
                + "|phase=" + phase.name()
                + "|tick=" + matchTick
                + "|reason=" + event.getFailReason().name()
                + "|allowed=" + event.isAllowed()
                + "|from=" + position(event.getFrom())
                + "|to=" + position(event.getTo()));
        capturedEvents += 1;
    }

    private static String position(Location location) {
        Location value = Objects.requireNonNull(location, "movement diagnostic location");
        String world = Objects.requireNonNull(value.getWorld(), "movement diagnostic world").getName();
        return world + ":"
                + Double.toString(value.getX()) + ","
                + Double.toString(value.getY()) + ","
                + Double.toString(value.getZ());
    }
}
