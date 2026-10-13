package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.arena.foundation.CivilizationMatchController.CaptureProgress;
import dev.arena.foundation.CivilizationMatchController.Draw;
import dev.arena.foundation.CivilizationMatchController.DrawReason;
import dev.arena.foundation.CivilizationMatchController.Faction;
import dev.arena.foundation.CivilizationMatchController.FactionScores;
import dev.arena.foundation.CivilizationMatchController.FactionWinner;
import dev.arena.foundation.CivilizationMatchController.Owned;
import dev.arena.foundation.CivilizationMatchController.WinnerReason;
import java.math.BigInteger;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

final class CivilizationMatchControllerTest {
    @Test
    void capturesOnlyAfterGraceAndAwardsTheCompletionTickToTheNewOwner() {
        CivilizationMatchController match = new CivilizationMatchController();

        for (int tick = 0; tick < CivilizationMatchController.GRACE_TICKS.intValueExact(); tick++) {
            endTick(match, tick, Set.of(0));
        }
        assertEquals(Optional.empty(), match.ownerFaction());
        assertEquals(Optional.empty(), match.challengerFaction());
        assertEquals(BigInteger.ZERO, match.captureProgressTicks());
        assertEquals(new FactionScores(BigInteger.ZERO, BigInteger.ZERO), match.scores());

        int firstCaptureTick = CivilizationMatchController.GRACE_TICKS.intValueExact();
        for (int tick = firstCaptureTick; tick < firstCaptureTick + 199; tick++) {
            endTick(match, tick, Set.of(0));
        }
        assertEquals(Optional.empty(), match.ownerFaction());
        assertEquals(Optional.of(Faction.EMBER), match.challengerFaction());
        assertEquals(BigInteger.valueOf(199), match.captureProgressTicks());
        assertEquals(BigInteger.ZERO, match.scores().emberPoints());

        endTick(match, firstCaptureTick + 199, Set.of(0));

        assertEquals(Optional.of(Faction.EMBER), match.ownerFaction());
        assertEquals(Optional.empty(), match.challengerFaction());
        assertEquals(BigInteger.ZERO, match.captureProgressTicks());
        assertEquals(BigInteger.ONE, match.scores().emberPoints());
        assertEquals(new Owned(Faction.EMBER, Optional.empty()), match.captureState());
    }

    @Test
    void contestPausesProgressAndAChallengerLeavingResetsIt() {
        CivilizationMatchController match = new CivilizationMatchController();
        captureEmber(match);

        for (int tick = 2_600; tick < 2_700; tick++) {
            endTick(match, tick, Set.of(3));
        }
        assertEquals(Optional.of(Faction.EMBER), match.ownerFaction());
        assertEquals(Optional.of(Faction.TIDE), match.challengerFaction());
        assertEquals(BigInteger.valueOf(100), match.captureProgressTicks());
        assertEquals(BigInteger.valueOf(101), match.scores().emberPoints());

        endTick(match, 2_700, Set.of(0, 3));
        assertEquals(BigInteger.valueOf(100), match.captureProgressTicks());
        assertEquals(BigInteger.valueOf(102), match.scores().emberPoints());

        endTick(match, 2_701, Set.of(0));
        assertEquals(Optional.of(Faction.EMBER), match.ownerFaction());
        assertEquals(Optional.empty(), match.challengerFaction());
        assertEquals(BigInteger.ZERO, match.captureProgressTicks());
        assertEquals(BigInteger.valueOf(103), match.scores().emberPoints());

        endTick(match, 2_702, Set.of(3));
        assertEquals(Optional.of(Faction.TIDE), match.challengerFaction());
        assertEquals(BigInteger.ONE, match.captureProgressTicks());
        assertEquals(BigInteger.valueOf(104), match.scores().emberPoints());
    }

    @Test
    void aNewUnownedFactionStartsAtOneAfterThePriorChallengerLeaves() {
        CivilizationMatchController match = new CivilizationMatchController();
        int firstCaptureTick = CivilizationMatchController.GRACE_TICKS.intValueExact();
        for (int tick = 0; tick < firstCaptureTick; tick++) {
            endTick(match, tick, Set.of());
        }
        for (int tick = firstCaptureTick; tick < firstCaptureTick + 50; tick++) {
            endTick(match, tick, Set.of(0));
        }
        assertEquals(BigInteger.valueOf(50), match.captureProgressTicks());

        endTick(match, firstCaptureTick + 50, Set.of(0, 3));
        assertEquals(BigInteger.valueOf(50), match.captureProgressTicks());

        endTick(match, firstCaptureTick + 51, Set.of(3));
        assertEquals(Optional.empty(), match.ownerFaction());
        assertEquals(Optional.of(Faction.TIDE), match.challengerFaction());
        assertEquals(BigInteger.ONE, match.captureProgressTicks());
    }

    @Test
    void sameTickEliminationsAreAppliedBeforeCaptureOccupantsAndEliminationWins() {
        CivilizationMatchController match = new CivilizationMatchController();
        captureEmber(match);
        endTick(match, 2_600, Set.of(3));
        assertEquals(BigInteger.ONE, match.captureProgressTicks());

        Optional<CivilizationMatchController.Outcome> outcome = match.endServerTick(
                new MatchController.MatchTick(BigInteger.valueOf(2_601)),
                Set.of(0, 3),
                List.of(
                        new MatchController.Elimination(3, MatchController.EliminationCause.DEATH),
                        new MatchController.Elimination(4, MatchController.EliminationCause.DISCONNECT),
                        new MatchController.Elimination(5, MatchController.EliminationCause.DEATH)));

        assertEquals(new FactionWinner(Faction.EMBER, WinnerReason.ELIMINATION,
                new FactionScores(BigInteger.valueOf(3), BigInteger.ZERO), List.of(0, 1, 2),
                new MatchController.MatchTick(BigInteger.valueOf(2_601))), outcome.orElseThrow());
        assertEquals(List.of(0), match.zoneOccupants());
        assertEquals(Optional.empty(), match.challengerFaction());
        assertEquals(BigInteger.ZERO, match.captureProgressTicks());
        assertEquals(List.of(0, 1, 2), match.aliveSeats());
        assertEquals(outcome, match.endServerTick(
                new MatchController.MatchTick(BigInteger.valueOf(2_602)), Set.of(3), List.of()));
        assertEquals(List.of(0, 1, 2), match.aliveSeats());
    }

    @Test
    void countdownFactionWipeResolvesAtMatchTickZeroWithoutScoringTheDeadFaction() {
        CivilizationMatchController match = new CivilizationMatchController();
        MatchController.MatchTick tickZero = new MatchController.MatchTick(BigInteger.ZERO);

        Optional<CivilizationMatchController.Outcome> outcome = match.endServerTick(tickZero, Set.of(0), List.of(
                new MatchController.Elimination(0, MatchController.EliminationCause.DISCONNECT),
                new MatchController.Elimination(1, MatchController.EliminationCause.DEATH),
                new MatchController.Elimination(2, MatchController.EliminationCause.DEATH)));

        assertEquals(new FactionWinner(Faction.TIDE, WinnerReason.ELIMINATION,
                new FactionScores(BigInteger.ZERO, BigInteger.ZERO), List.of(3, 4, 5), tickZero), outcome.orElseThrow());
        assertEquals(List.of(), match.zoneOccupants());
        assertEquals(BigInteger.ZERO, match.scores().emberPoints());
        assertEquals(BigInteger.ZERO, match.scores().tidePoints());
    }

    @Test
    void simultaneousFactionWipeDrawsEvenWhenTheOwnerHasMorePoints() {
        CivilizationMatchController match = new CivilizationMatchController();
        captureEmber(match);

        Optional<CivilizationMatchController.Outcome> outcome = match.endServerTick(
                new MatchController.MatchTick(BigInteger.valueOf(2_600)),
                Set.of(0, 3),
                List.of(
                        new MatchController.Elimination(0, MatchController.EliminationCause.DEATH),
                        new MatchController.Elimination(1, MatchController.EliminationCause.DEATH),
                        new MatchController.Elimination(2, MatchController.EliminationCause.DISCONNECT),
                        new MatchController.Elimination(3, MatchController.EliminationCause.DEATH),
                        new MatchController.Elimination(4, MatchController.EliminationCause.DISCONNECT),
                        new MatchController.Elimination(5, MatchController.EliminationCause.DEATH)));

        Draw expected = new Draw(DrawReason.NO_SURVIVORS,
                new FactionScores(BigInteger.valueOf(2), BigInteger.ZERO), List.of(),
                new MatchController.MatchTick(BigInteger.valueOf(2_600)));
        assertEquals(expected, outcome.orElseThrow());
        assertEquals(List.of(), match.zoneOccupants());
        assertTrue(match.scores().emberPoints().compareTo(match.scores().tidePoints()) > 0);
    }

    @Test
    void inclusiveTickLimitScoresTheOwnerAndDrawsOnAnUncapturedTie() {
        CivilizationMatchController captured = new CivilizationMatchController();
        captureEmber(captured);
        Optional<CivilizationMatchController.Outcome> atLimit = Optional.empty();
        for (int tick = 2_600; tick <= CivilizationMatchController.MAX_MATCH_TICK.intValueExact(); tick++) {
            atLimit = endTick(captured, tick, Set.of());
        }

        BigInteger expectedEmberScore = BigInteger.valueOf(15_402);
        assertEquals(new FactionWinner(Faction.EMBER, WinnerReason.TICK_LIMIT,
                new FactionScores(expectedEmberScore, BigInteger.ZERO), List.of(0, 1, 2, 3, 4, 5),
                new MatchController.MatchTick(CivilizationMatchController.MAX_MATCH_TICK)), atLimit.orElseThrow());

        CivilizationMatchController tied = new CivilizationMatchController();
        Optional<CivilizationMatchController.Outcome> tieAtLimit = Optional.empty();
        for (int tick = 0; tick <= CivilizationMatchController.MAX_MATCH_TICK.intValueExact(); tick++) {
            tieAtLimit = endTick(tied, tick, Set.of());
        }
        assertEquals(new Draw(DrawReason.TICK_LIMIT, new FactionScores(BigInteger.ZERO, BigInteger.ZERO),
                List.of(0, 1, 2, 3, 4, 5), new MatchController.MatchTick(CivilizationMatchController.MAX_MATCH_TICK)),
                tieAtLimit.orElseThrow());
    }

    @Test
    void fixedSeatsAndCaptureProgressRejectInvalidStates() {
        assertEquals(Faction.EMBER, Faction.forSeat(0));
        assertEquals(Faction.EMBER, Faction.forSeat(2));
        assertEquals(Faction.TIDE, Faction.forSeat(3));
        assertEquals(Faction.TIDE, Faction.forSeat(5));
        assertThrows(IllegalArgumentException.class, () -> Faction.forSeat(6));
        assertThrows(IllegalArgumentException.class, () -> new CaptureProgress(Faction.EMBER, 0));
        assertThrows(IllegalArgumentException.class, () -> new CaptureProgress(Faction.EMBER, 200));
        assertThrows(IllegalArgumentException.class,
                () -> new Owned(Faction.EMBER, Optional.of(new CaptureProgress(Faction.EMBER, 1))));
    }

    private static void captureEmber(CivilizationMatchController match) {
        for (int tick = 0; tick <= 2_599; tick++) {
            endTick(match, tick, tick < CivilizationMatchController.GRACE_TICKS.intValueExact()
                    ? Set.of() : Set.of(0));
        }
        assertEquals(Optional.of(Faction.EMBER), match.ownerFaction());
        assertEquals(BigInteger.ONE, match.scores().emberPoints());
    }

    private static Optional<CivilizationMatchController.Outcome> endTick(
            CivilizationMatchController match,
            int tick,
            Set<Integer> occupants) {
        return match.endServerTick(new MatchController.MatchTick(BigInteger.valueOf(tick)), occupants, List.of());
    }
}
