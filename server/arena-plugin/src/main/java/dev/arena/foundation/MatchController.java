package dev.arena.foundation;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.NavigableMap;
import java.util.NavigableSet;
import java.math.BigInteger;
import java.util.Optional;
import java.util.TreeMap;
import java.util.TreeSet;

/** Owns tick-driven match phases and resolves all eliminations at one server-tick boundary. */
final class MatchController {
    enum Phase {
        WAITING,
        COUNTDOWN,
        GRACE,
        ACTIVE,
        FINISHED,
        ABORTED
    }

    enum EliminationCause {
        DEATH,
        DISCONNECT
    }

    enum DrawReason {
        NO_SURVIVORS,
        TICK_LIMIT
    }

    enum AbortReason {
        OPERATOR,
        LEASE_LOST,
        INVALID_WORLD,
        PROTOCOL_ERROR,
        HUMAN_WAIT_TIMEOUT,
        RUNTIME_TIMEOUT
    }

    sealed interface ResolutionTick permits CountdownTick, MatchTick {}

    record CountdownTick(BigInteger value) implements ResolutionTick {
        CountdownTick {
            if (value == null || value.signum() < 0) {
                throw new IllegalArgumentException("countdown tick cannot be negative");
            }
        }
    }

    record MatchTick(BigInteger value) implements ResolutionTick {
        MatchTick {
            if (value == null || value.signum() < 0) {
                throw new IllegalArgumentException("match tick cannot be negative");
            }
        }
    }

    sealed interface Outcome permits Winner, Draw, Aborted {
        Optional<ResolutionTick> resolutionTick();
    }

    record Winner(int seat, List<Integer> survivors, ResolutionTick at) implements Outcome {
        Winner {
            survivors = List.copyOf(survivors);
            if (survivors.size() != 1 || survivors.getFirst() != seat || at == null) {
                throw new IllegalArgumentException("winner outcome must contain its sole surviving seat and resolution tick");
            }
        }

        @Override
        public Optional<ResolutionTick> resolutionTick() {
            return Optional.of(at);
        }
    }

    record Draw(DrawReason reason, List<Integer> survivors, ResolutionTick at) implements Outcome {
        Draw {
            survivors = List.copyOf(survivors);
            if (reason == null || at == null || (reason == DrawReason.NO_SURVIVORS && !survivors.isEmpty())
                    || (reason == DrawReason.TICK_LIMIT && survivors.size() < 2)) {
                throw new IllegalArgumentException("draw outcome does not match its reason and survivors");
            }
        }

        @Override
        public Optional<ResolutionTick> resolutionTick() {
            return Optional.of(at);
        }
    }

    record Aborted(AbortReason reason, List<Integer> survivors, Optional<ResolutionTick> at) implements Outcome {
        Aborted {
            survivors = List.copyOf(survivors);
            if (reason == null || at == null) {
                throw new IllegalArgumentException("abort outcome requires a reason and tick option");
            }
        }

        @Override
        public Optional<ResolutionTick> resolutionTick() {
            return at;
        }
    }

    record Elimination(int seat, EliminationCause cause) {
        Elimination {
            if (seat < 0 || cause == null) {
                throw new IllegalArgumentException("elimination requires a nonnegative seat and cause");
            }
        }
    }

    record ResolvedElimination(int seat, EliminationCause cause, ResolutionTick at) {}

    record BorderSchedule(
            double initialDiameterBlocks,
            BigInteger shrinkStartTick,
            BigInteger shrinkEndTick,
            double finalDiameterBlocks) {
        BorderSchedule {
            if (!Double.isFinite(initialDiameterBlocks) || !Double.isFinite(finalDiameterBlocks)
                    || initialDiameterBlocks <= 0 || finalDiameterBlocks <= 0
                    || finalDiameterBlocks >= initialDiameterBlocks
                    || shrinkStartTick == null || shrinkEndTick == null || shrinkStartTick.signum() < 0
                    || shrinkEndTick.compareTo(shrinkStartTick) <= 0) {
                throw new IllegalArgumentException("invalid world-border schedule");
            }
        }
    }

    record Settings(
            BigInteger countdownTicks,
            BigInteger graceTicks,
            BigInteger authoritativeMaxTicks,
            BorderSchedule border) {
        Settings {
            if (countdownTicks == null || graceTicks == null || authoritativeMaxTicks == null
                    || countdownTicks.signum() < 0 || graceTicks.signum() < 0 || authoritativeMaxTicks.signum() <= 0
                    || graceTicks.compareTo(authoritativeMaxTicks) >= 0 || border == null
                    || border.shrinkStartTick().compareTo(graceTicks) < 0
                    || border.shrinkEndTick().compareTo(authoritativeMaxTicks) >= 0) {
                throw new IllegalArgumentException("invalid match tick or border settings");
            }
        }
    }

    private final Settings settings;
    private final int competitorCount;
    private final NavigableSet<Integer> aliveSeats = new TreeSet<>();
    private Phase phase = Phase.WAITING;
    private BigInteger countdownRemaining = BigInteger.ZERO;
    private BigInteger matchTick;
    private Outcome outcome;

    MatchController(Settings settings, int competitorCount) {
        if (settings == null || competitorCount < 1 || competitorCount > 6) {
            throw new IllegalArgumentException("competitor count must be between one and six");
        }
        this.settings = settings;
        this.competitorCount = competitorCount;
        for (int seat = 0; seat < competitorCount; seat++) {
            aliveSeats.add(seat);
        }
    }

    Phase phase() {
        return phase;
    }

    Optional<BigInteger> matchTick() {
        return Optional.ofNullable(matchTick);
    }

    BigInteger countdownRemaining() {
        return countdownRemaining;
    }

    List<Integer> aliveSeats() {
        return List.copyOf(aliveSeats);
    }

    Optional<Outcome> outcome() {
        return Optional.ofNullable(outcome);
    }

    double borderDiameterBlocks() {
        if (matchTick == null || matchTick.compareTo(settings.border().shrinkStartTick()) < 0) {
            return settings.border().initialDiameterBlocks();
        }
        if (matchTick.compareTo(settings.border().shrinkEndTick()) >= 0) {
            return settings.border().finalDiameterBlocks();
        }
        double progress = matchTick.subtract(settings.border().shrinkStartTick()).doubleValue()
                / settings.border().shrinkEndTick().subtract(settings.border().shrinkStartTick()).doubleValue();
        return settings.border().initialDiameterBlocks()
                + progress * (settings.border().finalDiameterBlocks() - settings.border().initialDiameterBlocks());
    }

    void startCountdown() {
        if (phase != Phase.WAITING) {
            throw new IllegalStateException("match countdown can start only while waiting");
        }
        if (settings.countdownTicks().signum() == 0) {
            release();
        } else {
            phase = Phase.COUNTDOWN;
            countdownRemaining = settings.countdownTicks();
        }
    }

    /** Advances one completed Paper server tick and resolves events observed during that tick. */
    List<ResolvedElimination> endServerTick(Collection<Elimination> eliminations) {
        if (phase == Phase.WAITING || phase == Phase.FINISHED || phase == Phase.ABORTED) {
            return List.of();
        }
        if (phase == Phase.COUNTDOWN) {
            BigInteger countdownTick = settings.countdownTicks().subtract(countdownRemaining);
            CountdownTick at = new CountdownTick(countdownTick);
            List<ResolvedElimination> resolved = resolveEliminations(eliminations, at);
            if (!resolved.isEmpty()) {
                finishSurvivorOutcome(at);
                if (outcome != null) {
                    return resolved;
                }
            }
            countdownRemaining = countdownRemaining.subtract(BigInteger.ONE);
            if (countdownRemaining.signum() == 0) {
                release();
            }
            return resolved;
        }

        List<ResolvedElimination> resolved = resolveEliminations(eliminations, new MatchTick(matchTick));
        if (!resolved.isEmpty()) {
            finishSurvivorOutcome(new MatchTick(matchTick));
        }
        if (outcome == null && matchTick.equals(settings.authoritativeMaxTicks())) {
            finish(new Draw(DrawReason.TICK_LIMIT, aliveSeats(), new MatchTick(matchTick)));
        } else if (outcome == null) {
            matchTick = matchTick.add(BigInteger.ONE);
            phase = matchTick.compareTo(settings.graceTicks()) < 0 ? Phase.GRACE : Phase.ACTIVE;
        }
        return List.copyOf(resolved);
    }

    void abort(AbortReason reason) {
        if (reason == null) {
            throw new IllegalArgumentException("abort reason is required");
        }
        if (phase == Phase.FINISHED || phase == Phase.ABORTED) {
            throw new IllegalStateException("terminal match cannot be aborted again");
        }
        Optional<ResolutionTick> at = switch (phase) {
            case WAITING -> Optional.empty();
            case COUNTDOWN -> Optional.of(new CountdownTick(settings.countdownTicks().subtract(countdownRemaining)));
            case GRACE, ACTIVE -> Optional.of(new MatchTick(matchTick));
            case FINISHED, ABORTED -> throw new IllegalStateException("terminal match cannot be aborted again");
        };
        finish(new Aborted(reason, aliveSeats(), at));
    }

    private List<ResolvedElimination> resolveEliminations(
            Collection<Elimination> eliminations,
            ResolutionTick at) {
        NavigableMap<Integer, EliminationCause> causesBySeat = new TreeMap<>();
        for (Elimination elimination : eliminations) {
            if (elimination.seat() >= competitorCount) {
                throw new IllegalArgumentException("elimination references an unknown seat");
            }
            if (aliveSeats.contains(elimination.seat())) {
                causesBySeat.merge(elimination.seat(), elimination.cause(), MatchController::preferredCause);
            }
        }

        List<ResolvedElimination> resolved = new ArrayList<>(causesBySeat.size());
        for (var entry : causesBySeat.entrySet()) {
            aliveSeats.remove(entry.getKey());
            resolved.add(new ResolvedElimination(entry.getKey(), entry.getValue(), at));
        }
        return List.copyOf(resolved);
    }

    private void finishSurvivorOutcome(ResolutionTick at) {
        if (aliveSeats.size() == 1) {
            finish(new Winner(aliveSeats.first(), aliveSeats(), at));
        } else if (aliveSeats.isEmpty()) {
            finish(new Draw(DrawReason.NO_SURVIVORS, aliveSeats(), at));
        }
    }

    private static EliminationCause preferredCause(EliminationCause current, EliminationCause incoming) {
        return current == EliminationCause.DEATH || incoming == EliminationCause.DEATH
                ? EliminationCause.DEATH
                : EliminationCause.DISCONNECT;
    }

    private void release() {
        matchTick = BigInteger.ZERO;
        phase = settings.graceTicks().signum() == 0 ? Phase.ACTIVE : Phase.GRACE;
        finishSurvivorOutcome(new MatchTick(matchTick));
    }

    private void finish(Outcome result) {
        outcome = result;
        phase = result instanceof Aborted ? Phase.ABORTED : Phase.FINISHED;
    }
}
