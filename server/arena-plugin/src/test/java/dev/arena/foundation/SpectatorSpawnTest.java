package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.arena.foundation.MapPlan.Position;
import dev.arena.foundation.MapPlan.SpawnPoint;
import java.util.List;
import org.junit.jupiter.api.Test;

final class SpectatorSpawnTest {
    @Test
    void centersSpectatorsAmongAllConfiguredBotSpawns() {
        assertEquals(new Position(64, 65, 64), ArenaFoundationPlugin.spawnCenter(List.of(
                new SpawnPoint(0, new Position(64, 65, 40)),
                new SpawnPoint(1, new Position(84, 65, 52)),
                new SpawnPoint(2, new Position(84, 65, 76)),
                new SpawnPoint(3, new Position(64, 65, 88)),
                new SpawnPoint(4, new Position(44, 65, 76)),
                new SpawnPoint(5, new Position(44, 65, 52)))));
    }

    @Test
    void requiresAtLeastOneBotSpawnForSpectatorPlacement() {
        assertThrows(IllegalArgumentException.class, () -> ArenaFoundationPlugin.spawnCenter(List.of()));
    }
}
