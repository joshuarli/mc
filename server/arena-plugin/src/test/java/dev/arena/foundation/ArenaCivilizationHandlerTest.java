package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.math.BigInteger;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import dev.arena.foundation.MatchController.CountdownTick;
import dev.arena.foundation.MatchController.Elimination;
import dev.arena.foundation.MatchController.EliminationCause;
import dev.arena.foundation.MatchController.MatchTick;
import dev.arena.foundation.MatchController.ResolvedElimination;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.junit.jupiter.api.Test;

final class ArenaCivilizationHandlerTest {
    @Test
    void blockEditHandlersRemainAtTheHighestNonCancelledBoundary() throws NoSuchMethodException {
        assertHandler(BlockBreakEvent.class, "onBlockBreak");
        assertHandler(BlockPlaceEvent.class, "onBlockPlace");
    }

    @Test
    void civilizationAllowsOrdinaryBreakingAndPlacingOnlyDuringCompetitivePlay() {
        ControlProtocol.MatchSettings settings = new ControlProtocol.MatchSettings(
                BigInteger.valueOf(100), BigInteger.valueOf(2_400), BigInteger.valueOf(18_000),
                false, true, true, false, false);

        for (ArenaFoundationPlugin.BlockAction action : ArenaFoundationPlugin.BlockAction.values()) {
            assertFalse(ArenaFoundationPlugin.matchRulesAllowBlockEdit(
                    settings, MatchController.Phase.WAITING, action));
            assertFalse(ArenaFoundationPlugin.matchRulesAllowBlockEdit(
                    settings, MatchController.Phase.COUNTDOWN, action));
            assertTrue(ArenaFoundationPlugin.matchRulesAllowBlockEdit(
                    settings, MatchController.Phase.GRACE, action));
            assertTrue(ArenaFoundationPlugin.matchRulesAllowBlockEdit(
                    settings, MatchController.Phase.ACTIVE, action));
            assertFalse(ArenaFoundationPlugin.matchRulesAllowBlockEdit(
                    settings, MatchController.Phase.FINISHED, action));
        }
    }

    @Test
    void countdownEliminationsKeepTheirClockTicksAndReachCivilizationTickZero() {
        ResolvedElimination duringCountdown = new ResolvedElimination(
                0, EliminationCause.DEATH, new CountdownTick(BigInteger.valueOf(3)));
        ResolvedElimination duringMatch = new ResolvedElimination(
                5, EliminationCause.DISCONNECT, new MatchTick(BigInteger.ZERO));
        List<ResolvedElimination> batch = ArenaFoundationPlugin.civilizationEliminationBatch(
                List.of(duringCountdown), List.of(duringMatch));

        assertEquals(new CountdownTick(BigInteger.valueOf(3)), batch.getFirst().at());
        assertEquals(new MatchTick(BigInteger.ZERO), batch.getLast().at());
        List<Elimination> eliminations = ArenaFoundationPlugin.civilizationEliminationsSinceLastTick(
                List.of(1, 2, 3, 4), List.of(0, 1, 2, 3, 4, 5), batch);
        assertEquals(List.of(
                new Elimination(0, EliminationCause.DEATH),
                new Elimination(5, EliminationCause.DISCONNECT)),
                eliminations);

        CivilizationMatchController civilization = new CivilizationMatchController();
        assertTrue(civilization.endServerTick(new MatchTick(BigInteger.ZERO), Set.of(0, 5), eliminations).isEmpty());
        assertEquals(List.of(), civilization.zoneOccupants());
        for (int tick = 1; tick <= CivilizationMatchController.GRACE_TICKS.intValueExact(); tick++) {
            civilization.endServerTick(new MatchTick(BigInteger.valueOf(tick)), Set.of(0, 5), List.of());
        }
        assertEquals(Optional.empty(), civilization.ownerFaction());
        assertEquals(Optional.empty(), civilization.challengerFaction());
        assertEquals(BigInteger.ZERO, civilization.scores().emberPoints());
        assertEquals(BigInteger.ZERO, civilization.scores().tidePoints());
    }

    private static void assertHandler(Class<?> eventType, String methodName) throws NoSuchMethodException {
        Method method = ArenaFoundationPlugin.class.getDeclaredMethod(methodName, eventType);
        EventHandler handler = method.getAnnotation(EventHandler.class);

        assertNotNull(handler);
        assertEquals(EventPriority.HIGHEST, handler.priority());
        assertTrue(handler.ignoreCancelled());
    }
}
