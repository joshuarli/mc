package dev.arena.foundation;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.Difficulty;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.Chest;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

public final class ArenaFoundationPlugin extends JavaPlugin implements Listener {
    private static final int FLOOR_Y = 63;
    private static final int CHEST_X = 2;
    private static final int CHEST_Z = 0;
    private final Set<UUID> reportedMovement = new HashSet<>();

    @Override
    public void onEnable() {
        World world = Bukkit.getWorld("world");
        if (world == null) {
            throw new IllegalStateException("Paper did not create the default world");
        }

        createFixture(world);
        Bukkit.getPluginManager().registerEvents(this, this);
        getLogger().info("ARENA_READY|protocol=776|port=" + Bukkit.getServer().getPort());
    }

    private void createFixture(World world) {
        world.setDifficulty(Difficulty.EASY);
        world.setTime(1000);
        world.setStorm(false);
        world.setThundering(false);
        world.setSpawnLocation(0, FLOOR_Y + 1, 0);

        for (int x = -4; x <= 4; x++) {
            for (int z = -4; z <= 4; z++) {
                Block floor = world.getBlockAt(x, FLOOR_Y, z);
                floor.setType(Material.STONE, false);
                world.getBlockAt(x, FLOOR_Y + 1, z).setType(Material.AIR, false);
                world.getBlockAt(x, FLOOR_Y + 2, z).setType(Material.AIR, false);
            }
        }

        Block chestBlock = world.getBlockAt(CHEST_X, FLOOR_Y + 1, CHEST_Z);
        chestBlock.setType(Material.CHEST, false);
        if (!(chestBlock.getState() instanceof Chest chest)) {
            throw new IllegalStateException("fixture chest did not create a chest state");
        }
        chest.getBlockInventory().clear();
        chest.getBlockInventory().setItem(0, new ItemStack(Material.DIAMOND, 2));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        getLogger().info("ARENA_JOIN|" + event.getPlayer().getName());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onMove(PlayerMoveEvent event) {
        if (event.getTo() == null || event.getFrom().distanceSquared(event.getTo()) < 0.01) {
            return;
        }
        if (reportedMovement.add(event.getPlayer().getUniqueId())) {
            getLogger().info("ARENA_MOVE|" + event.getPlayer().getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onInventoryOpen(InventoryOpenEvent event) {
        if (event.getPlayer() instanceof Player player && isFixtureChest(event.getInventory())) {
            getLogger().info("ARENA_CHEST_OPEN|" + player.getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onInventoryClick(InventoryClickEvent event) {
        Inventory top = event.getView().getTopInventory();
        if (!(event.getWhoClicked() instanceof Player player)
                || !isFixtureChest(top)
                || event.getClickedInventory() != top) {
            return;
        }

        getLogger().info("ARENA_CHEST_CLICK|" + player.getName() + "|" + event.getRawSlot());
        Bukkit.getScheduler().runTaskLater(this, () -> {
            int diamonds = count(player.getInventory(), Material.DIAMOND);
            if (diamonds > 0) {
                getLogger().info("ARENA_TRANSFER|" + player.getName() + "|diamonds=" + diamonds);
            }
        }, 2L);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlayerDamage(EntityDamageByEntityEvent event) {
        if (event.getDamager() instanceof Player attacker
                && event.getEntity() instanceof Player victim
                && event.getFinalDamage() > 0.0) {
            getLogger().info("ARENA_DAMAGE|" + attacker.getName() + "|" + victim.getName()
                    + "|amount=" + event.getFinalDamage());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        getLogger().info("ARENA_QUIT|" + event.getPlayer().getName());
    }

    private static boolean isFixtureChest(Inventory inventory) {
        Location location = inventory.getLocation();
        return location != null
                && location.getWorld() != null
                && "world".equals(location.getWorld().getName())
                && location.getBlockX() == CHEST_X
                && location.getBlockY() == FLOOR_Y + 1
                && location.getBlockZ() == CHEST_Z
                && location.getBlock().getType() == Material.CHEST;
    }

    private static int count(Inventory inventory, Material material) {
        int total = 0;
        for (ItemStack item : inventory.getStorageContents()) {
            if (item != null && item.getType() == material) {
                total += item.getAmount();
            }
        }
        return total;
    }
}
