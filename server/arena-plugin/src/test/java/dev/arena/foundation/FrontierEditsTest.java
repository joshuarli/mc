package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Set;
import org.junit.jupiter.api.Test;

final class FrontierEditsTest {
    private static FrontierEdits edits(int radius, int budget) {
        return new FrontierEdits(
                new NaturalMapPlan.BorderCenter(500, 500),
                new ControlProtocol.FrontierSurvivalRules(radius, budget),
                Set.of(new MapPlan.Position(510, 70, 500)));
    }

    @Test
    void editsAreBoundedByRegionProtectedChestsAndSeatBudget() {
        FrontierEdits edits = edits(16, 2);

        assertEquals(FrontierEdits.Verdict.ALLOWED, edits.tryEdit(0, new MapPlan.Position(505, 70, 505)));
        assertEquals(FrontierEdits.Verdict.OUTSIDE_REGION, edits.tryEdit(0, new MapPlan.Position(520, 70, 500)));
        assertEquals(FrontierEdits.Verdict.PROTECTED_BLOCK, edits.tryEdit(0, new MapPlan.Position(510, 70, 500)));
        assertEquals(FrontierEdits.Verdict.ALLOWED, edits.tryEdit(0, new MapPlan.Position(506, 70, 505)));
        assertEquals(FrontierEdits.Verdict.BUDGET_EXHAUSTED, edits.tryEdit(0, new MapPlan.Position(507, 70, 505)));
        assertEquals(FrontierEdits.Verdict.ALLOWED, edits.tryEdit(1, new MapPlan.Position(507, 70, 505)));
        assertEquals(2, edits.editsUsed(0));
    }
}
