package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.Set;
import java.util.UUID;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.entity.EntityDamageEvent;
import org.junit.jupiter.api.Test;

final class ArenaPlayerDamageTest {
    @Test
    void resolvesDirectAndProjectilePlayerDamageSources() {
        UUID competitorId = UUID.fromString("00000000-0000-0000-0000-000000000001");
        Player attacker = proxy(Player.class, (proxy, method, arguments) -> {
            if (method.getName().equals("getUniqueId")) {
                return competitorId;
            }
            return null;
        });
        Projectile arrow = proxy(Projectile.class, (proxy, method, arguments) -> {
            if (method.getName().equals("getShooter")) {
                return attacker;
            }
            return null;
        });
        Projectile mobProjectile = proxy(Projectile.class, (proxy, method, arguments) -> null);
        Entity mob = proxy(Entity.class, (proxy, method, arguments) -> null);
        Set<UUID> competitors = Set.of(competitorId);

        assertTrue(ArenaFoundationPlugin.isDamageFromCompetitor(attacker, competitors));
        assertTrue(ArenaFoundationPlugin.isDamageFromCompetitor(arrow, competitors));
        assertFalse(ArenaFoundationPlugin.isDamageFromCompetitor(mobProjectile, competitors));
        assertFalse(ArenaFoundationPlugin.isDamageFromCompetitor(mob, competitors));
        assertFalse(ArenaFoundationPlugin.isDamageFromCompetitor(attacker, Set.of()));
    }

    @Test
    void damageGuardIsRegisteredForAllEntityDamageAtHighestPriority() throws NoSuchMethodException {
        EventHandler handler = ArenaFoundationPlugin.class
                .getDeclaredMethod("onPreReleaseDamage", EntityDamageEvent.class)
                .getAnnotation(EventHandler.class);

        assertNotNull(handler);
        assertEquals(EventPriority.HIGHEST, handler.priority());
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler));
    }
}
