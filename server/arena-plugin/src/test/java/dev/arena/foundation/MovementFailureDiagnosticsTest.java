package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.papermc.paper.event.player.PlayerFailMoveEvent;
import io.papermc.paper.event.player.PlayerFailMoveEvent.FailReason;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.junit.jupiter.api.Test;

final class MovementFailureDiagnosticsTest {
    private static final UUID PLAYER_ID = UUID.fromString("00000000-0000-0000-0000-000000000001");

    @Test
    void diagnosticsDefaultOffAndListenerRunsAtMonitor() throws NoSuchMethodException {
        assertFalse(MovementFailureDiagnostics.fromProperty(null).isEnabled());
        assertFalse(MovementFailureDiagnostics.fromProperty("false").isEnabled());

        EventHandler handler = ArenaFoundationPlugin.class
                .getDeclaredMethod("onPlayerFailMove", PlayerFailMoveEvent.class)
                .getAnnotation(EventHandler.class);

        assertNotNull(handler);
        assertEquals(EventPriority.MONITOR, handler.priority());
    }

    @Test
    void disabledUnseatedAndPreMatchFailuresProduceNoLines() {
        PlayerFailMoveEvent event = failedMove();
        List<String> lines = new ArrayList<>();

        ArenaFoundationPlugin.capturePlayerFailMove(event, Map.of(PLAYER_ID, 0), MatchController.Phase.ACTIVE,
                Optional.of(BigInteger.valueOf(4)), MovementFailureDiagnostics.fromProperty(null), lines::add);
        MovementFailureDiagnostics enabled = MovementFailureDiagnostics.fromProperty("true");
        ArenaFoundationPlugin.capturePlayerFailMove(event, Map.of(), MatchController.Phase.ACTIVE,
                Optional.of(BigInteger.valueOf(4)), enabled, lines::add);
        ArenaFoundationPlugin.capturePlayerFailMove(event, Map.of(PLAYER_ID, 0), MatchController.Phase.COUNTDOWN,
                Optional.empty(), enabled, lines::add);

        assertTrue(lines.isEmpty());
    }

    @Test
    void capturesThePaperReasonDecisionAndExactPositionsForASeatedPlayer() {
        PlayerFailMoveEvent event = failedMove();
        List<String> lines = new ArrayList<>();
        MovementFailureDiagnostics diagnostics = MovementFailureDiagnostics.fromProperty("true");

        ArenaFoundationPlugin.capturePlayerFailMove(event, Map.of(PLAYER_ID, 0), MatchController.Phase.ACTIVE,
                Optional.of(BigInteger.valueOf(432)), diagnostics, lines::add);

        assertEquals(List.of("ARENA_FAIL_MOVE|seat=0|phase=ACTIVE|tick=432|reason=MOVED_WRONGLY"
                + "|allowed=false|from=world:30.75,65.0,21.5|to=world:31.0,66.25,21.875"), lines);
        assertFalse(event.isAllowed());
    }

    @Test
    void capsCapturedLinesAndWritesOneTruncationMarker() {
        PlayerFailMoveEvent event = failedMove();
        List<String> lines = new ArrayList<>();
        MovementFailureDiagnostics diagnostics = MovementFailureDiagnostics.fromProperty("true");
        int attempts = MovementFailureDiagnostics.MAX_CAPTURED_EVENTS + 3;

        for (int attempt = 0; attempt < attempts; attempt++) {
            ArenaFoundationPlugin.capturePlayerFailMove(event, Map.of(PLAYER_ID, 0), MatchController.Phase.GRACE,
                    Optional.of(BigInteger.valueOf(attempt)), diagnostics, lines::add);
        }

        assertEquals(MovementFailureDiagnostics.MAX_CAPTURED_EVENTS + 1, lines.size());
        assertEquals(MovementFailureDiagnostics.MAX_CAPTURED_EVENTS,
                lines.stream().filter(line -> line.startsWith("ARENA_FAIL_MOVE|")).count());
        assertEquals(1, lines.stream().filter(line -> line.startsWith("ARENA_FAIL_MOVE_TRUNCATED|")).count());
        assertEquals("ARENA_FAIL_MOVE_TRUNCATED|limit=256", lines.getLast());
    }

    private static PlayerFailMoveEvent failedMove() {
        Player player = proxy(Player.class, (object, method, arguments) ->
                method.getName().equals("getUniqueId") ? PLAYER_ID : null);
        World world = proxy(World.class, (object, method, arguments) ->
                method.getName().equals("getName") ? "world" : null);
        return new PlayerFailMoveEvent(player, FailReason.MOVED_WRONGLY, false, false,
                new org.bukkit.Location(world, 30.75, 65.0, 21.5),
                new org.bukkit.Location(world, 31.0, 66.25, 21.875));
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler));
    }
}
