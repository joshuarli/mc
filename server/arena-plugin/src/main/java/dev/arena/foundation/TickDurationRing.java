package dev.arena.foundation;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

final class TickDurationRing {
    private final long[] samples = new long[ControlProtocol.MAX_TICK_DURATION_SAMPLES];
    private int next;
    private int count;
    private long last;

    void record(double durationMillis) {
        long micros = Double.isFinite(durationMillis) && durationMillis > 0.0 ? Math.round(durationMillis * 1000.0) : 0L;
        samples[next] = micros;
        next = (next + 1) % samples.length;
        count = Math.min(count + 1, samples.length);
        last = micros;
    }

    Optional<ControlProtocol.MetricsPayload> snapshot(int queueDepth, int dropped) {
        if (count == 0) {
            return Optional.empty();
        }
        List<Long> ordered = new ArrayList<>(count);
        int start = count < samples.length ? 0 : next;
        for (int index = 0; index < count; index++) {
            ordered.add(samples[(start + index) % samples.length]);
        }
        return Optional.of(new ControlProtocol.MetricsPayload(last, queueDepth, dropped, Optional.of(ordered)));
    }
}
