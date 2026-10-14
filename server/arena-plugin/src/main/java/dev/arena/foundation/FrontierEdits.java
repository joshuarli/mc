package dev.arena.foundation;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

final class FrontierEdits {
    enum Verdict {
        ALLOWED,
        OUTSIDE_REGION,
        PROTECTED_BLOCK,
        BUDGET_EXHAUSTED
    }

    private final int centerX;
    private final int centerZ;
    private final long radiusSquared;
    private final int budgetPerSeat;
    private final Set<MapPlan.Position> protectedPositions;
    private final Map<Integer, Integer> editsBySeat = new HashMap<>();

    FrontierEdits(
            NaturalMapPlan.BorderCenter center,
            ControlProtocol.FrontierSurvivalRules rules,
            Set<MapPlan.Position> protectedPositions) {
        this.centerX = center.x();
        this.centerZ = center.z();
        this.radiusSquared = (long) rules.editRadiusBlocks() * rules.editRadiusBlocks();
        this.budgetPerSeat = rules.maxBlockEditsPerSeat();
        this.protectedPositions = Set.copyOf(protectedPositions);
    }

    Verdict tryEdit(int seat, MapPlan.Position position) {
        long dx = (long) position.x() - centerX;
        long dz = (long) position.z() - centerZ;
        if (dx * dx + dz * dz > radiusSquared) {
            return Verdict.OUTSIDE_REGION;
        }
        if (protectedPositions.contains(position)) {
            return Verdict.PROTECTED_BLOCK;
        }
        int used = editsBySeat.getOrDefault(seat, 0);
        if (used >= budgetPerSeat) {
            return Verdict.BUDGET_EXHAUSTED;
        }
        editsBySeat.put(seat, used + 1);
        return Verdict.ALLOWED;
    }

    int editsUsed(int seat) {
        return editsBySeat.getOrDefault(seat, 0);
    }
}
