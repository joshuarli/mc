package dev.arena.foundation;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

final class DamageAccumulator {
    private record Key(int victim, int attacker, ControlProtocol.DamageCause cause) {}

    private static final int NO_ATTACKER = -1;
    private final Map<Key, Double> totals = new TreeMap<>(Comparator
            .comparingInt(Key::victim)
            .thenComparingInt(Key::attacker)
            .thenComparing(Key::cause));

    void add(int victim, Optional<Integer> attacker, ControlProtocol.DamageCause cause, double amount) {
        if (!(amount > 0.0) || !Double.isFinite(amount)) {
            return;
        }
        totals.merge(new Key(victim, attacker.orElse(NO_ATTACKER), cause), amount, Double::sum);
    }

    boolean isEmpty() {
        return totals.isEmpty();
    }

    void clear() {
        totals.clear();
    }

    List<ControlProtocol.DamageEntry> drain() {
        List<ControlProtocol.DamageEntry> entries = new ArrayList<>();
        List<Map.Entry<Key, Double>> victimGroups = new ArrayList<>();
        int currentVictim = -1;
        for (Map.Entry<Key, Double> total : totals.entrySet()) {
            if (total.getKey().victim() != currentVictim) {
                emitVictim(entries, currentVictim, victimGroups);
                victimGroups.clear();
                currentVictim = total.getKey().victim();
            }
            victimGroups.add(total);
        }
        emitVictim(entries, currentVictim, victimGroups);
        totals.clear();
        return entries;
    }

    private static void emitVictim(
            List<ControlProtocol.DamageEntry> entries,
            int victim,
            List<Map.Entry<Key, Double>> groups) {
        if (groups.isEmpty()) {
            return;
        }
        int limit = ControlProtocol.MAX_DAMAGE_ENTRIES_PER_VICTIM;
        int individual = groups.size() <= limit ? groups.size() : limit - 1;
        for (int index = 0; index < individual; index++) {
            entries.add(entry(groups.get(index).getKey(), groups.get(index).getValue()));
        }
        double folded = 0.0;
        for (int index = individual; index < groups.size(); index++) {
            folded += groups.get(index).getValue();
        }
        if (folded > 0.0) {
            entries.add(new ControlProtocol.DamageEntry(victim, Optional.empty(),
                    ControlProtocol.DamageCause.OTHER, folded, false));
        }
    }

    private static ControlProtocol.DamageEntry entry(Key key, double amount) {
        Optional<Integer> attacker = key.attacker() == NO_ATTACKER ? Optional.empty() : Optional.of(key.attacker());
        return new ControlProtocol.DamageEntry(key.victim(), attacker, key.cause(), amount, attacker.isPresent());
    }
}
