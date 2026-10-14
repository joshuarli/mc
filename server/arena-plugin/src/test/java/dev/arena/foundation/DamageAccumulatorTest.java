package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

final class DamageAccumulatorTest {
    @Test
    void aggregatesPerVictimAttackerAndCauseInSeatOrder() {
        DamageAccumulator accumulator = new DamageAccumulator();
        accumulator.add(4, Optional.of(1), ControlProtocol.DamageCause.MELEE, 2.0);
        accumulator.add(2, Optional.empty(), ControlProtocol.DamageCause.BORDER, 1.0);
        accumulator.add(4, Optional.of(1), ControlProtocol.DamageCause.MELEE, 3.0);
        accumulator.add(4, Optional.empty(), ControlProtocol.DamageCause.FALL, 4.0);

        List<ControlProtocol.DamageEntry> entries = accumulator.drain();

        assertEquals(List.of(
                new ControlProtocol.DamageEntry(2, Optional.empty(), ControlProtocol.DamageCause.BORDER, 1.0, false),
                new ControlProtocol.DamageEntry(4, Optional.empty(), ControlProtocol.DamageCause.FALL, 4.0, false),
                new ControlProtocol.DamageEntry(4, Optional.of(1), ControlProtocol.DamageCause.MELEE, 5.0, true)),
                entries);
        assertTrue(accumulator.isEmpty());
    }

    @Test
    void foldsAttackersBeyondTheVictimLimitWithoutLosingTotalDamage() {
        DamageAccumulator accumulator = new DamageAccumulator();
        double total = 0.0;
        for (int attacker = 0; attacker < 20; attacker++) {
            accumulator.add(30, Optional.of(attacker), ControlProtocol.DamageCause.MELEE, 1.5);
            total += 1.5;
        }

        List<ControlProtocol.DamageEntry> entries = accumulator.drain();

        assertEquals(ControlProtocol.MAX_DAMAGE_ENTRIES_PER_VICTIM, entries.size());
        assertEquals(total, entries.stream().mapToDouble(ControlProtocol.DamageEntry::amount).sum(), 1e-9);
        ControlProtocol.DamageEntry folded = entries.getLast();
        assertEquals(Optional.empty(), folded.attacker());
        assertEquals(ControlProtocol.DamageCause.OTHER, folded.cause());
        assertEquals(1.5 * 13, folded.amount(), 1e-9);
    }

    @Test
    void ignoresNonPositiveDamage() {
        DamageAccumulator accumulator = new DamageAccumulator();
        accumulator.add(0, Optional.empty(), ControlProtocol.DamageCause.FIRE, 0.0);

        assertTrue(accumulator.isEmpty());
    }
}
