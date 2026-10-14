package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

final class TickDurationRingTest {
    @Test
    void emptyRingHasNoSnapshot() {
        assertTrue(new TickDurationRing().snapshot(0, 0).isEmpty());
    }

    @Test
    void keepsTheLastTwentyDurationsOldestFirstWithTheLatestAsTheSingleValue() {
        TickDurationRing ring = new TickDurationRing();
        for (int tick = 1; tick <= 25; tick++) {
            ring.record(tick * 0.5);
        }

        ControlProtocol.MetricsPayload snapshot = ring.snapshot(3, 7).orElseThrow();

        assertEquals(12_500L, snapshot.serverTickDurationMicros());
        assertEquals(3, snapshot.criticalQueueDepth());
        assertEquals(7, snapshot.droppedOptionalMetrics());
        List<Long> samples = snapshot.tickDurationsMicros().orElseThrow();
        assertEquals(20, samples.size());
        assertEquals(3_000L, samples.getFirst());
        assertEquals(12_500L, samples.getLast());
    }

    @Test
    void partialRingKeepsInsertionOrder() {
        TickDurationRing ring = new TickDurationRing();
        ring.record(1.0);
        ring.record(2.5);

        assertEquals(List.of(1_000L, 2_500L), ring.snapshot(0, 0).orElseThrow().tickDurationsMicros().orElseThrow());
    }
}
