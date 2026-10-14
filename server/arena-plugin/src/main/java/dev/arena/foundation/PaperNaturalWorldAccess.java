package dev.arena.foundation;

import java.util.List;
import org.bukkit.HeightMap;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.Chest;
import org.bukkit.inventory.ItemStack;

final class PaperNaturalWorldAccess implements NaturalWorldSetup.SurfaceAccess {
    private final World world;

    PaperNaturalWorldAccess(World world) {
        if (world == null) {
            throw new IllegalArgumentException("loaded Paper world is required");
        }
        this.world = world;
    }

    @Override
    public int minHeight() {
        return world.getMinHeight();
    }

    @Override
    public int maxHeight() {
        return world.getMaxHeight();
    }

    @Override
    public void prepareChunks(List<NaturalMapPlan.ChunkPosition> chunks) {
        for (NaturalMapPlan.ChunkPosition chunk : chunks) {
            world.getChunkAt(chunk.x(), chunk.z());
        }
    }

    @Override
    public int highestBlockY(int x, int z) {
        return world.getHighestBlockYAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
    }

    @Override
    public NaturalWorldSetup.BlockState blockAt(MapPlan.Position position) {
        Block block = world.getBlockAt(position.x(), position.y(), position.z());
        return new NaturalWorldSetup.BlockState(
                block.getType(), block.isLiquid(), block.isPassable(),
                block.getBlockData().isFaceSturdy(org.bukkit.block.BlockFace.UP, org.bukkit.block.BlockSupport.CENTER));
    }

    @Override
    public void placeLootChest(MapPlan.Position position, List<Material> contents) {
        Block block = world.getBlockAt(position.x(), position.y(), position.z());
        block.setType(Material.CHEST, false);
        if (!(block.getState() instanceof Chest chest)) {
            throw new IllegalStateException("natural cache position did not create a chest");
        }
        chest.getBlockInventory().clear();
        for (int slot = 0; slot < contents.size(); slot++) {
            chest.getBlockInventory().setItem(slot, new ItemStack(contents.get(slot)));
        }
    }

    @Override
    public void setWorldSpawn(MapPlan.Position position) {
        world.setSpawnLocation(position.x(), position.y(), position.z());
    }
}
