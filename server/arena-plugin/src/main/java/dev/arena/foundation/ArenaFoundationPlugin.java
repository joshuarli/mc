package dev.arena.foundation;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
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
import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerAnimationType;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.world.WorldLoadEvent;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

public final class ArenaFoundationPlugin extends JavaPlugin implements Listener {
    // Paper 26.2's default flat world surface is at Y -60.
    private static final int FLOOR_Y = -60;
    private static final int CHEST_X = 2;
    private static final int CHEST_Z = 0;
    private static final String ARENA_WORLD = "world";
    private static final String PLAN_GENERATOR_ID = "plan";
    private final Set<UUID> reportedMovement = new HashSet<>();
    private MapPlan generationPlan;
    private ArenaChunkGenerator chunkGenerator;
    private boolean generatorRequested;
    private boolean worldInitialized;

    @Override
    public void onLoad() {
        if (System.getProperty(MapPlanReader.GENERATION_PLAN_PROPERTY) == null) {
            return;
        }

        try {
            generationPlan = MapPlanReader.readConfiguredPlan();
        } catch (IOException invalidPlan) {
            throw new IllegalStateException("could not load the staged world plan", invalidPlan);
        }
    }

    @Override
    public ChunkGenerator getDefaultWorldGenerator(String worldName, String id) {
        if (!ARENA_WORLD.equals(worldName)) {
            return null;
        }
        if (generationPlan == null) {
            throw new IllegalStateException("the arena world generator requires a staged world plan");
        }
        if (!PLAN_GENERATOR_ID.equals(id)) {
            throw new IllegalArgumentException("the arena world generator id must be 'plan'");
        }
        if (chunkGenerator == null) {
            chunkGenerator = new ArenaChunkGenerator(generationPlan);
        }
        generatorRequested = true;
        return chunkGenerator;
    }

    @Override
    public void onEnable() {
        Bukkit.getPluginManager().registerEvents(this, this);
        World world = Bukkit.getWorld(ARENA_WORLD);
        if (world != null) {
            initializeWorld(world);
        }
    }

    @EventHandler
    public void onWorldLoad(WorldLoadEvent event) {
        if (ARENA_WORLD.equals(event.getWorld().getName())) {
            initializeWorld(event.getWorld());
        }
    }

    private void initializeWorld(World world) {
        if (worldInitialized) {
            return;
        }
        if (!Bukkit.isPrimaryThread()) {
            throw new IllegalStateException("arena world setup must run on Paper's server thread");
        }

        int preparedChunks = 0;
        if (generationPlan == null) {
            // The local stack smoke run omits a staged plan and exercises the protocol fixture.
            createStackSmokeFixture(world);
        } else {
            if (!generatorRequested) {
                throw new IllegalStateException(
                        "the staged world plan is loaded, but Paper did not request the arena generator; "
                                + "configure world as ArenaFoundation:plan");
            }
            preparedChunks = prepareMapWorld(world);
        }

        worldInitialized = true;
        if (generationPlan != null) {
            getLogger().info("ARENA_MAP_READY|run_id=" + generationPlan.runId()
                    + "|map_semantic_id=" + generationPlan.mapSemanticId()
                    + "|prepared_chunks=" + preparedChunks);
        }
        getLogger().info("ARENA_READY|protocol=776|port=" + Bukkit.getServer().getPort());
    }

    private int prepareMapWorld(World world) {
        MapPlan.Dimensions dimensions = generationPlan.dimensions();
        if (dimensions.minY() < world.getMinHeight() || dimensions.maxY() >= world.getMaxHeight()) {
            throw new IllegalStateException("world-plan vertical bounds do not fit the arena world's build height");
        }

        List<MapPlan.ChunkPosition> chunks = generationPlan.chunksWithViewHalo(world.getViewDistance());
        for (MapPlan.ChunkPosition chunk : chunks) {
            world.getChunkAt(chunk.x(), chunk.z());
        }

        for (MapPlan.LootContainer container : generationPlan.lootContainers()) {
            MapPlan.Position position = container.position();
            Block block = world.getBlockAt(position.x(), position.y(), position.z());
            if (!(block.getState() instanceof Chest chest)) {
                throw new IllegalStateException("world-plan loot position did not generate a chest");
            }
            Inventory inventory = chest.getBlockInventory();
            inventory.clear();
            for (int slot = 0; slot < container.inventory().size(); slot++) {
                Material item = ArenaChunkGenerator.requireItemMaterial(container.inventory().get(slot));
                inventory.setItem(slot, new ItemStack(item));
            }
        }

        MapPlan.Position firstSpawn = generationPlan.spawns().getFirst().position();
        world.setSpawnLocation(firstSpawn.x(), firstSpawn.y(), firstSpawn.z());
        return chunks.size();
    }

    private void createStackSmokeFixture(World world) {
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
        if (event.getPlayer() instanceof Player player && isArenaChest(event.getInventory())) {
            getLogger().info("ARENA_CHEST_OPEN|" + player.getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onInventoryClick(InventoryClickEvent event) {
        Inventory top = event.getView().getTopInventory();
        if (!(event.getWhoClicked() instanceof Player player)
                || !isArenaChest(top)
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
                && event.getEntity() instanceof Player victim) {
            getLogger().info("ARENA_DAMAGE_ATTEMPT|" + attacker.getName() + "|" + victim.getName()
                    + "|cancelled=" + event.isCancelled() + "|amount=" + event.getFinalDamage());
            if (!event.isCancelled() && event.getFinalDamage() > 0.0) {
                getLogger().info("ARENA_DAMAGE|" + attacker.getName() + "|" + victim.getName()
                        + "|amount=" + event.getFinalDamage());
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onAnimation(PlayerAnimationEvent event) {
        if (event.getAnimationType() == PlayerAnimationType.ARM_SWING) {
            getLogger().info("ARENA_SWING|" + event.getPlayer().getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        getLogger().info("ARENA_QUIT|" + event.getPlayer().getName());
    }

    private boolean isArenaChest(Inventory inventory) {
        Location location = inventory.getLocation();
        if (location == null || location.getWorld() == null
                || !ARENA_WORLD.equals(location.getWorld().getName())
                || location.getBlock().getType() != Material.CHEST) {
            return false;
        }
        if (generationPlan == null) {
            return location.getBlockX() == CHEST_X
                    && location.getBlockY() == FLOOR_Y + 1
                    && location.getBlockZ() == CHEST_Z;
        }
        for (MapPlan.LootContainer container : generationPlan.lootContainers()) {
            MapPlan.Position position = container.position();
            if (position.x() == location.getBlockX()
                    && position.y() == location.getBlockY()
                    && position.z() == location.getBlockZ()) {
                return true;
            }
        }
        return false;
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
