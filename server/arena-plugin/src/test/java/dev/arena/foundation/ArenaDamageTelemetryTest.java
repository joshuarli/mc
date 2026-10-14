package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.junit.jupiter.api.Test;

final class ArenaDamageTelemetryTest {
    @Test
    void damageMonitorReceivesCancelledPlayerHits() throws NoSuchMethodException {
        EventHandler handler = ArenaFoundationPlugin.class
                .getDeclaredMethod("onPlayerDamage", EntityDamageByEntityEvent.class)
                .getAnnotation(EventHandler.class);

        assertNotNull(handler);
        assertEquals(EventPriority.MONITOR, handler.priority());
        assertFalse(handler.ignoreCancelled());
    }
}
