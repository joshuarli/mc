package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.arena.foundation.MatchController.AbortReason;
import dev.arena.foundation.MatchController.Aborted;
import dev.arena.foundation.MatchController.BorderSchedule;
import dev.arena.foundation.MatchController.Draw;
import dev.arena.foundation.MatchController.DrawReason;
import dev.arena.foundation.MatchController.FixedBorder;
import dev.arena.foundation.MatchController.OutcomeAuthority;
import dev.arena.foundation.MatchController.Elimination;
import dev.arena.foundation.MatchController.EliminationCause;
import dev.arena.foundation.MatchController.CountdownTick;
import dev.arena.foundation.MatchController.MatchTick;
import dev.arena.foundation.MatchController.Phase;
import dev.arena.foundation.MatchController.ResolvedElimination;
import dev.arena.foundation.MatchController.Settings;
import dev.arena.foundation.MatchController.Winner;
import java.util.List;
import java.util.Optional;
import java.math.BigInteger;
import org.junit.jupiter.api.Test;

final class MatchControllerTest {
    @Test
    void competitiveActionsStartOnlyAtReleaseAndPlayersStayFrozenBeforeIt() {
        MatchController match = new MatchController(settings(2, 1, 4), 2);

        assertPhasePolicy(match, Phase.WAITING, true, false);
        match.startCountdown();
        assertPhasePolicy(match, Phase.COUNTDOWN, true, false);

        match.endServerTick(List.of());
        assertPhasePolicy(match, Phase.COUNTDOWN, true, false);
        match.endServerTick(List.of());
        assertPhasePolicy(match, Phase.GRACE, false, true);
        match.endServerTick(List.of());
        assertPhasePolicy(match, Phase.ACTIVE, false, true);

        match.endServerTick(List.of());
        match.endServerTick(List.of());
        match.endServerTick(List.of());
        match.endServerTick(List.of());
        assertPhasePolicy(match, Phase.FINISHED, false, false);

        MatchController aborted = new MatchController(settings(2, 1, 4), 2);
        aborted.abort(AbortReason.OPERATOR);
        assertPhasePolicy(aborted, Phase.ABORTED, false, false);
    }

    @Test
    void competitorPvpIsAllowedOnlyDuringActivePlay() {
        for (Phase phase : Phase.values()) {
            assertEquals(phase == Phase.ACTIVE, phase.allowsCompetitorPvp(), phase.name());
        }
    }

    private static void assertPhasePolicy(
            MatchController match,
            Phase expectedPhase,
            boolean expectedPreRelease,
            boolean expectedCompetitiveActions) {
        assertEquals(expectedPhase, match.phase());
        assertEquals(expectedPreRelease, match.phase().isPreRelease());
        assertEquals(expectedCompetitiveActions, match.phase().allowsCompetitiveActions());
    }

    @Test
    void countdownReleaseStartsMatchTickZeroAndGraceEndsBeforeTickTwo() {
        MatchController match = new MatchController(settings(2, 2, 6), 2);

        assertEquals(Phase.WAITING, match.phase());
        assertTrue(match.matchTick().isEmpty());
        match.startCountdown();
        assertEquals(Phase.COUNTDOWN, match.phase());

        match.endServerTick(List.of());
        assertEquals(BigInteger.ONE, match.countdownRemaining());
        assertEquals(Phase.COUNTDOWN, match.phase());

        match.endServerTick(List.of());
        assertEquals(Phase.GRACE, match.phase());
        assertEquals(Optional.of(BigInteger.ZERO), match.matchTick());

        match.endServerTick(List.of());
        assertEquals(Phase.GRACE, match.phase());
        assertEquals(Optional.of(BigInteger.ONE), match.matchTick());

        match.endServerTick(List.of());
        assertEquals(Phase.ACTIVE, match.phase());
        assertEquals(Optional.of(BigInteger.TWO), match.matchTick());
    }

    @Test
    void worldBorderUsesMatchTicksAndReachesBothConfiguredEndpoints() {
        MatchController match = new MatchController(new Settings(BigInteger.ZERO, BigInteger.ZERO, BigInteger.valueOf(6),
                new BorderSchedule(10, BigInteger.ONE, BigInteger.valueOf(4), 4)), 2);
        match.startCountdown();

        assertEquals(10.0, match.borderDiameterBlocks());
        match.endServerTick(List.of());
        assertEquals(10.0, match.borderDiameterBlocks());
        match.endServerTick(List.of());
        assertEquals(8.0, match.borderDiameterBlocks());
        match.endServerTick(List.of());
        assertEquals(6.0, match.borderDiameterBlocks());
        match.endServerTick(List.of());
        assertEquals(4.0, match.borderDiameterBlocks());
    }

    @Test
    void externalFactionOutcomeKeepsTheMatchActiveAfterOneSeatRemains() {
        MatchController match = new MatchController(new Settings(BigInteger.ZERO, BigInteger.ZERO,
                BigInteger.valueOf(2), new FixedBorder(192)), 6, OutcomeAuthority.EXTERNAL);
        match.startCountdown();

        match.endServerTick(List.of(
                new Elimination(1, EliminationCause.DEATH),
                new Elimination(2, EliminationCause.DEATH),
                new Elimination(3, EliminationCause.DEATH),
                new Elimination(4, EliminationCause.DEATH),
                new Elimination(5, EliminationCause.DEATH)));

        assertEquals(Phase.ACTIVE, match.phase());
        assertEquals(List.of(0), match.aliveSeats());
        assertTrue(match.outcome().isEmpty());
        assertEquals(192.0, match.borderDiameterBlocks());

        match.finishExternally(new MatchTick(BigInteger.ZERO));

        assertEquals(Phase.FINISHED, match.phase());
        assertEquals(Optional.of(BigInteger.ZERO), match.matchTick());
        assertTrue(match.outcome().isEmpty());
    }

    @Test
    void externalFactionOutcomeOwnsTheInclusiveTickLimitDecision() {
        MatchController match = new MatchController(new Settings(BigInteger.ZERO, BigInteger.ZERO,
                BigInteger.ONE, new FixedBorder(192)), 6, OutcomeAuthority.EXTERNAL);
        match.startCountdown();
        match.endServerTick(List.of());
        match.endServerTick(List.of());

        assertEquals(Phase.ACTIVE, match.phase());
        assertEquals(Optional.of(BigInteger.ONE), match.matchTick());
        assertTrue(match.outcome().isEmpty());
    }

    @Test
    void sameTickZeroSurvivorsResolveToDrawWithStableSeatOrdering() {
        MatchController match = new MatchController(settings(0, 0, 6), 2);
        match.startCountdown();

        List<ResolvedElimination> resolved = match.endServerTick(List.of(
                new Elimination(1, EliminationCause.DISCONNECT),
                new Elimination(0, EliminationCause.DEATH)));

        assertEquals(List.of(0, 1), resolved.stream().map(ResolvedElimination::seat).toList());
        assertEquals(new MatchTick(BigInteger.ZERO), resolved.getFirst().at());
        assertEquals(Phase.FINISHED, match.phase());
        assertEquals(new Draw(DrawReason.NO_SURVIVORS, List.of(), new MatchTick(BigInteger.ZERO)), match.outcome().orElseThrow());
    }

    @Test
    void countdownDisconnectsResolveBeforeReleaseAndCannotBeReplaced() {
        MatchController winner = new MatchController(settings(3, 0, 6), 2);
        winner.startCountdown();

        List<ResolvedElimination> resolved = winner.endServerTick(
                List.of(new Elimination(1, EliminationCause.DISCONNECT)));

        assertEquals(Phase.FINISHED, winner.phase());
        assertTrue(winner.matchTick().isEmpty());
        assertEquals(List.of(new ResolvedElimination(
                1, EliminationCause.DISCONNECT, new CountdownTick(BigInteger.ZERO))), resolved);
        assertEquals(new Winner(0, List.of(0), new CountdownTick(BigInteger.ZERO)), winner.outcome().orElseThrow());

        MatchController draw = new MatchController(settings(3, 0, 6), 2);
        draw.startCountdown();
        draw.endServerTick(List.of(
                new Elimination(1, EliminationCause.DISCONNECT),
                new Elimination(0, EliminationCause.DISCONNECT)));
        assertEquals(new Draw(DrawReason.NO_SURVIVORS, List.of(), new CountdownTick(BigInteger.ZERO)), draw.outcome().orElseThrow());
    }

    @Test
    void lastSurvivorWinsBeforeTickLimitIsConsidered() {
        MatchController match = new MatchController(settings(0, 0, 2), 2);
        match.startCountdown();
        match.endServerTick(List.of());
        match.endServerTick(List.of());

        match.endServerTick(List.of(new Elimination(1, EliminationCause.DEATH)));

        assertEquals(new Winner(0, List.of(0), new MatchTick(BigInteger.TWO)), match.outcome().orElseThrow());
        assertEquals(Phase.FINISHED, match.phase());
    }

    @Test
    void tickLimitWithMultipleSurvivorsIsACompletedDraw() {
        MatchController match = new MatchController(settings(0, 0, 2), 2);
        match.startCountdown();
        match.endServerTick(List.of());
        match.endServerTick(List.of());
        match.endServerTick(List.of());

        assertEquals(new Draw(DrawReason.TICK_LIMIT, List.of(0, 1), new MatchTick(BigInteger.TWO)), match.outcome().orElseThrow());
        assertEquals(Phase.FINISHED, match.phase());
    }

    @Test
    void oneSeatRosterWinsWhenTheMatchIsReleased() {
        MatchController match = new MatchController(settings(0, 0, 2), 1);

        match.startCountdown();

        assertEquals(new Winner(0, List.of(0), new MatchTick(BigInteger.ZERO)), match.outcome().orElseThrow());
        assertEquals(Phase.FINISHED, match.phase());
    }

    @Test
    void duplicateSameTickEliminationsChooseDeathAndApplyOnlyOnce() {
        MatchController match = new MatchController(settings(0, 0, 6), 2);
        match.startCountdown();

        List<ResolvedElimination> resolved = match.endServerTick(List.of(
                new Elimination(1, EliminationCause.DISCONNECT),
                new Elimination(1, EliminationCause.DEATH)));

        assertEquals(List.of(new ResolvedElimination(1, EliminationCause.DEATH, new MatchTick(BigInteger.ZERO))), resolved);
        assertEquals(new Winner(0, List.of(0), new MatchTick(BigInteger.ZERO)), match.outcome().orElseThrow());
    }

    @Test
    void abortBeforeReleaseHasNoMatchTickAndTerminalMatchCannotBeAbortedAgain() {
        MatchController beforeStart = new MatchController(settings(0, 0, 6), 2);
        beforeStart.abort(AbortReason.LEASE_LOST);

        assertEquals(new Aborted(AbortReason.LEASE_LOST, List.of(0, 1), Optional.empty()),
                beforeStart.outcome().orElseThrow());
        assertTrue(beforeStart.matchTick().isEmpty());

        MatchController duringCountdown = new MatchController(settings(3, 0, 6), 2);
        duringCountdown.startCountdown();
        duringCountdown.abort(AbortReason.OPERATOR);
        assertEquals(new Aborted(AbortReason.OPERATOR, List.of(0, 1), Optional.of(new CountdownTick(BigInteger.ZERO))),
                duringCountdown.outcome().orElseThrow());

        MatchController completed = new MatchController(settings(0, 0, 6), 2);
        completed.startCountdown();
        completed.endServerTick(List.of(new Elimination(0, EliminationCause.DEATH)));
        assertThrows(IllegalStateException.class, () -> completed.abort(AbortReason.OPERATOR));
    }

    @Test
    void rejectsAnEliminationForASeatOutsideTheConfiguredRoster() {
        MatchController match = new MatchController(settings(0, 0, 6), 2);
        match.startCountdown();

        assertThrows(IllegalArgumentException.class,
                () -> match.endServerTick(List.of(new Elimination(2, EliminationCause.DEATH))));
        assertFalse(match.outcome().isPresent());
    }

    @Test
    void rejectsInvalidTickAndBorderSettings() {
        assertThrows(IllegalArgumentException.class, () -> settings(0, 5, 5));
        assertThrows(IllegalArgumentException.class,
                () -> new BorderSchedule(10, BigInteger.valueOf(8), BigInteger.valueOf(8), 4));
    }

    @Test
    void advancesCountdownWithoutNarrowingUnsigned64TickValues() {
        BigInteger maximum = ControlProtocol.MAX_U64;
        MatchController match = new MatchController(new Settings(maximum, maximum.subtract(BigInteger.valueOf(4)),
                maximum, new BorderSchedule(126, maximum.subtract(BigInteger.valueOf(4)),
                        maximum.subtract(BigInteger.TWO), 16)), 2);

        match.startCountdown();
        assertEquals(maximum, match.countdownRemaining());
        match.endServerTick(List.of());

        assertEquals(maximum.subtract(BigInteger.ONE), match.countdownRemaining());
        assertEquals(Phase.COUNTDOWN, match.phase());
    }

    private static Settings settings(long countdownTicks, long graceTicks, long authoritativeMaxTicks) {
        return new Settings(BigInteger.valueOf(countdownTicks), BigInteger.valueOf(graceTicks),
                BigInteger.valueOf(authoritativeMaxTicks), new BorderSchedule(10, BigInteger.valueOf(graceTicks),
                        BigInteger.valueOf(authoritativeMaxTicks - 1), 4));
    }
}
