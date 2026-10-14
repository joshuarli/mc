package dev.arena.foundation;

import java.math.BigInteger;
import java.util.Collection;
import java.util.EnumSet;
import java.util.List;
import java.util.NavigableSet;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

final class CivilizationMatchController {
    static final int SEAT_COUNT = 6;
    static final BigInteger GRACE_TICKS = BigInteger.valueOf(2_400);
    static final BigInteger MAX_MATCH_TICK = BigInteger.valueOf(18_000);
    static final int CAPTURE_UNCONTESTED_TICKS = 200;
    static final BigInteger SCORE_POINTS_PER_OWNED_TICK = BigInteger.ONE;

    enum Faction {
        EMBER,
        TIDE;

        Faction opponent() {
            return this == EMBER ? TIDE : EMBER;
        }

        static Faction forSeat(int seat) {
            if (seat < 0 || seat >= SEAT_COUNT) {
                throw new IllegalArgumentException("civilization seat is out of range");
            }
            return seat < SEAT_COUNT / 2 ? EMBER : TIDE;
        }
    }

    enum WinnerReason {
        ELIMINATION,
        TICK_LIMIT
    }

    enum DrawReason {
        NO_SURVIVORS,
        TICK_LIMIT
    }

    sealed interface CaptureState permits Unowned, Owned {}

    record CaptureProgress(Faction faction, int uncontestedTicks) {
        CaptureProgress {
            Objects.requireNonNull(faction, "capture faction");
            if (uncontestedTicks < 1 || uncontestedTicks >= CAPTURE_UNCONTESTED_TICKS) {
                throw new IllegalArgumentException("unfinished capture progress must be below the capture threshold");
            }
        }
    }

    record Unowned(Optional<CaptureProgress> progress) implements CaptureState {
        Unowned {
            Objects.requireNonNull(progress, "unowned capture progress");
        }
    }

    record Owned(Faction owner, Optional<CaptureProgress> challenge) implements CaptureState {
        Owned {
            Objects.requireNonNull(owner, "capture owner");
            Objects.requireNonNull(challenge, "capture challenge");
            if (challenge.filter(value -> value.faction() == owner).isPresent()) {
                throw new IllegalArgumentException("a faction cannot challenge its own capture zone");
            }
        }
    }

    record FactionScores(BigInteger emberPoints, BigInteger tidePoints) {
        FactionScores {
            if (emberPoints == null || tidePoints == null
                    || emberPoints.signum() < 0 || tidePoints.signum() < 0) {
                throw new IllegalArgumentException("faction scores cannot be negative or missing");
            }
        }

        BigInteger points(Faction faction) {
            Objects.requireNonNull(faction, "score faction");
            return faction == Faction.EMBER ? emberPoints : tidePoints;
        }

        FactionScores award(Faction faction) {
            Objects.requireNonNull(faction, "score faction");
            return faction == Faction.EMBER
                    ? new FactionScores(emberPoints.add(SCORE_POINTS_PER_OWNED_TICK), tidePoints)
                    : new FactionScores(emberPoints, tidePoints.add(SCORE_POINTS_PER_OWNED_TICK));
        }
    }

    sealed interface Outcome permits FactionWinner, Draw {
        FactionScores scores();

        List<Integer> survivors();

        MatchController.MatchTick at();
    }

    record FactionWinner(
            Faction winner,
            WinnerReason reason,
            FactionScores scores,
            List<Integer> survivors,
            MatchController.MatchTick at) implements Outcome {
        FactionWinner {
            Objects.requireNonNull(winner, "winning faction");
            Objects.requireNonNull(reason, "winner reason");
            Objects.requireNonNull(scores, "faction scores");
            survivors = immutableSeatOrder(survivors);
            Objects.requireNonNull(at, "winner tick");
            boolean winnerSurvives = survivors.stream().anyMatch(seat -> Faction.forSeat(seat) == winner);
            boolean opponentSurvives = survivors.stream().anyMatch(seat -> Faction.forSeat(seat) != winner);
            if (!winnerSurvives || (reason == WinnerReason.ELIMINATION && opponentSurvives)
                    || (reason == WinnerReason.TICK_LIMIT
                            && (!at.value().equals(MAX_MATCH_TICK) || !opponentSurvives
                                    || scores.points(winner).compareTo(scores.points(winner.opponent())) <= 0))) {
                throw new IllegalArgumentException("faction winner does not match its reason, survivors, and scores");
            }
        }
    }

    record Draw(
            DrawReason reason,
            FactionScores scores,
            List<Integer> survivors,
            MatchController.MatchTick at) implements Outcome {
        Draw {
            Objects.requireNonNull(reason, "draw reason");
            Objects.requireNonNull(scores, "faction scores");
            survivors = immutableSeatOrder(survivors);
            Objects.requireNonNull(at, "draw tick");
            boolean emberSurvives = survivors.stream().anyMatch(seat -> Faction.forSeat(seat) == Faction.EMBER);
            boolean tideSurvives = survivors.stream().anyMatch(seat -> Faction.forSeat(seat) == Faction.TIDE);
            if ((reason == DrawReason.NO_SURVIVORS && !survivors.isEmpty())
                    || (reason == DrawReason.TICK_LIMIT
                            && (!at.value().equals(MAX_MATCH_TICK) || !emberSurvives || !tideSurvives
                                    || !scores.emberPoints().equals(scores.tidePoints())))) {
                throw new IllegalArgumentException("civilization draw does not match its reason, tick, and scores");
            }
        }
    }

    private final NavigableSet<Integer> aliveSeats = new TreeSet<>();
    private BigInteger nextMatchTick = BigInteger.ZERO;
    private CaptureState captureState = new Unowned(Optional.empty());
    private FactionScores scores = new FactionScores(BigInteger.ZERO, BigInteger.ZERO);
    private List<Integer> zoneOccupants = List.of();
    private Outcome outcome;

    CivilizationMatchController() {
        for (int seat = 0; seat < SEAT_COUNT; seat++) {
            aliveSeats.add(seat);
        }
    }

    CaptureState captureState() {
        return captureState;
    }

    Optional<Faction> ownerFaction() {
        return captureState instanceof Owned owned ? Optional.of(owned.owner()) : Optional.empty();
    }

    Optional<Faction> challengerFaction() {
        return captureState instanceof Unowned unowned
                ? unowned.progress().map(CaptureProgress::faction)
                : ((Owned) captureState).challenge().map(CaptureProgress::faction);
    }

    BigInteger captureProgressTicks() {
        return captureState instanceof Unowned unowned
                ? unowned.progress().map(progress -> BigInteger.valueOf(progress.uncontestedTicks())).orElse(BigInteger.ZERO)
                : ((Owned) captureState).challenge()
                        .map(progress -> BigInteger.valueOf(progress.uncontestedTicks())).orElse(BigInteger.ZERO);
    }

    FactionScores scores() {
        return scores;
    }

    List<Integer> aliveSeats() {
        return List.copyOf(aliveSeats);
    }

    List<Integer> zoneOccupants() {
        return zoneOccupants;
    }

    Optional<Outcome> outcome() {
        return Optional.ofNullable(outcome);
    }

    Optional<Outcome> endServerTick(
            MatchController.MatchTick at,
            Set<Integer> observedZoneOccupants,
            Collection<MatchController.Elimination> eliminations) {
        if (outcome != null) {
            return Optional.of(outcome);
        }
        Objects.requireNonNull(at, "match tick");
        Objects.requireNonNull(observedZoneOccupants, "capture-zone occupants");
        Objects.requireNonNull(eliminations, "same-tick eliminations");
        if (!at.value().equals(nextMatchTick)) {
            throw new IllegalArgumentException("civilization ticks must be supplied consecutively from match tick zero");
        }

        NavigableSet<Integer> remainingSeats = new TreeSet<>(aliveSeats);
        for (MatchController.Elimination elimination : eliminations) {
            Objects.requireNonNull(elimination, "same-tick elimination");
            if (elimination.seat() >= SEAT_COUNT) {
                throw new IllegalArgumentException("elimination references an unknown civilization seat");
            }
            remainingSeats.remove(elimination.seat());
        }

        NavigableSet<Integer> liveZoneOccupants = new TreeSet<>();
        EnumSet<Faction> presentFactions = EnumSet.noneOf(Faction.class);
        for (Integer seat : observedZoneOccupants) {
            if (seat == null || seat < 0 || seat >= SEAT_COUNT) {
                throw new IllegalArgumentException("capture-zone occupant references an unknown civilization seat");
            }
            if (remainingSeats.contains(seat)) {
                liveZoneOccupants.add(seat);
                presentFactions.add(Faction.forSeat(seat));
            }
        }

        CaptureState nextCaptureState = captureState;
        if (at.value().compareTo(GRACE_TICKS) >= 0) {
            nextCaptureState = advanceCapture(captureState, presentFactions);
        }
        FactionScores nextScores = ownerOf(nextCaptureState)
                .map(scores::award)
                .orElse(scores);
        Outcome nextOutcome = resolveOutcome(remainingSeats, nextScores, at);

        aliveSeats.clear();
        aliveSeats.addAll(remainingSeats);
        zoneOccupants = List.copyOf(liveZoneOccupants);
        captureState = nextCaptureState;
        scores = nextScores;
        outcome = nextOutcome;
        nextMatchTick = at.value().add(BigInteger.ONE);
        return Optional.ofNullable(outcome);
    }

    private static CaptureState advanceCapture(CaptureState current, Set<Faction> presentFactions) {
        if (presentFactions.size() == Faction.values().length) {
            return current;
        }
        if (presentFactions.isEmpty()) {
            return current instanceof Owned owned
                    ? new Owned(owned.owner(), Optional.empty())
                    : new Unowned(Optional.empty());
        }

        Faction onlyPresent = presentFactions.iterator().next();
        if (current instanceof Owned owned) {
            if (onlyPresent == owned.owner()) {
                return new Owned(owned.owner(), Optional.empty());
            }
            return advanceClaim(Optional.of(owned.owner()), owned.challenge(), onlyPresent);
        }

        return advanceClaim(Optional.empty(), ((Unowned) current).progress(), onlyPresent);
    }

    private static CaptureState advanceClaim(
            Optional<Faction> owner,
            Optional<CaptureProgress> currentProgress,
            Faction claimant) {
        int nextProgress = currentProgress
                .filter(progress -> progress.faction() == claimant)
                .map(progress -> progress.uncontestedTicks() + 1)
                .orElse(1);
        if (nextProgress == CAPTURE_UNCONTESTED_TICKS) {
            return new Owned(claimant, Optional.empty());
        }
        CaptureProgress progress = new CaptureProgress(claimant, nextProgress);
        return owner.<CaptureState>map(value -> new Owned(value, Optional.of(progress)))
                .orElseGet(() -> new Unowned(Optional.of(progress)));
    }

    private static Optional<Faction> ownerOf(CaptureState state) {
        return state instanceof Owned owned ? Optional.of(owned.owner()) : Optional.empty();
    }

    private static Outcome resolveOutcome(
            Set<Integer> remainingSeats,
            FactionScores scores,
            MatchController.MatchTick at) {
        boolean emberSurvives = hasSurvivor(remainingSeats, Faction.EMBER);
        boolean tideSurvives = hasSurvivor(remainingSeats, Faction.TIDE);
        if (!emberSurvives && !tideSurvives) {
            return new Draw(DrawReason.NO_SURVIVORS, scores, List.of(), at);
        }
        if (!emberSurvives) {
            return new FactionWinner(Faction.TIDE, WinnerReason.ELIMINATION, scores, List.copyOf(remainingSeats), at);
        }
        if (!tideSurvives) {
            return new FactionWinner(Faction.EMBER, WinnerReason.ELIMINATION, scores, List.copyOf(remainingSeats), at);
        }
        if (at.value().equals(MAX_MATCH_TICK)) {
            int scoreOrder = scores.emberPoints().compareTo(scores.tidePoints());
            if (scoreOrder > 0) {
                return new FactionWinner(Faction.EMBER, WinnerReason.TICK_LIMIT, scores,
                        List.copyOf(remainingSeats), at);
            }
            if (scoreOrder < 0) {
                return new FactionWinner(Faction.TIDE, WinnerReason.TICK_LIMIT, scores,
                        List.copyOf(remainingSeats), at);
            }
            return new Draw(DrawReason.TICK_LIMIT, scores, List.copyOf(remainingSeats), at);
        }
        return null;
    }

    private static boolean hasSurvivor(Set<Integer> seats, Faction faction) {
        return seats.stream().anyMatch(seat -> Faction.forSeat(seat) == faction);
    }

    private static List<Integer> immutableSeatOrder(Collection<Integer> seats) {
        Objects.requireNonNull(seats, "survivors");
        NavigableSet<Integer> sorted = new TreeSet<>();
        for (Integer seat : seats) {
            if (seat == null || seat < 0 || seat >= SEAT_COUNT || !sorted.add(seat)) {
                throw new IllegalArgumentException("outcome survivors must be unique known civilization seats");
            }
        }
        return List.copyOf(sorted);
    }
}
