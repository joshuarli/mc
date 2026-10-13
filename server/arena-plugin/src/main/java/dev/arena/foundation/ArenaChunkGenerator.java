package dev.arena.foundation;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.generator.BlockPopulator;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.generator.WorldInfo;

/** Generates resolved map blocks from immutable data without querying or mutating other chunks. */
final class ArenaChunkGenerator extends ChunkGenerator {
    private record GeneratedBlock(MapPlan.Position position, Material material) {}

    private final MapPlan plan;
    private final Map<MapPlan.ChunkPosition, List<GeneratedBlock>> blocksByChunk;

    ArenaChunkGenerator(MapPlan plan) {
        if (plan == null) {
            throw new IllegalArgumentException("resolved map plan is required");
        }
        this.plan = plan;
        for (MapPlan.LootContainer container : plan.lootContainers()) {
            for (String item : container.inventory()) {
                requireItemMaterial(item);
            }
        }
        Map<MapPlan.ChunkPosition, List<GeneratedBlock>> mutableIndex = new HashMap<>();
        for (MapPlan.BlockPlacement placement : plan.blocks()) {
            Material material = requireBlockMaterial(placement.material());
            MapPlan.Position position = placement.position();
            MapPlan.ChunkPosition chunk = new MapPlan.ChunkPosition(
                    MapPlan.chunkCoordinate(position.x()), MapPlan.chunkCoordinate(position.z()));
            mutableIndex.computeIfAbsent(chunk, ignored -> new ArrayList<>())
                    .add(new GeneratedBlock(position, material));
        }
        Map<MapPlan.ChunkPosition, List<GeneratedBlock>> immutableIndex = new HashMap<>();
        mutableIndex.forEach((chunk, blocks) -> immutableIndex.put(chunk, List.copyOf(blocks)));
        this.blocksByChunk = Map.copyOf(immutableIndex);
    }

    @Override
    public void generateNoise(WorldInfo worldInfo, Random random, int chunkX, int chunkZ, ChunkData chunkData) {
        for (GeneratedBlock generated : blocksByChunk.getOrDefault(
                new MapPlan.ChunkPosition(chunkX, chunkZ), List.of())) {
            MapPlan.Position position = generated.position();
            if (position.y() < chunkData.getMinHeight() || position.y() >= chunkData.getMaxHeight()) {
                throw new IllegalStateException("resolved map block is outside Paper's world height");
            }
            chunkData.setBlock(
                    MapPlan.localCoordinate(position.x()),
                    position.y(),
                    MapPlan.localCoordinate(position.z()),
                    generated.material());
        }
    }

    @Override
    public boolean shouldGenerateNoise() {
        return false;
    }

    @Override
    public boolean shouldGenerateSurface() {
        return false;
    }

    @Override
    public boolean shouldGenerateCaves() {
        return false;
    }

    @Override
    public boolean shouldGenerateDecorations() {
        return false;
    }

    @Override
    public boolean shouldGenerateMobs() {
        return false;
    }

    @Override
    public boolean shouldGenerateStructures() {
        return false;
    }

    @Override
    public List<BlockPopulator> getDefaultPopulators(World world) {
        return List.of();
    }

    @Override
    public Location getFixedSpawnLocation(World world, Random random) {
        MapPlan.Position spawn = plan.spawns().getFirst().position();
        return new Location(world, spawn.x() + 0.5, spawn.y(), spawn.z() + 0.5);
    }

    static Material requireBlockMaterial(String resourceId) {
        Material material = requireMinecraftMaterial(resourceId);
        if (!material.isBlock() || material.isAir()) {
            throw new IllegalArgumentException("map block id is not a placeable non-air block: " + resourceId);
        }
        return material;
    }

    static Material requireItemMaterial(String resourceId) {
        Material material = requireMinecraftMaterial(resourceId);
        if (!material.isItem()) {
            throw new IllegalArgumentException("loot id is not an obtainable Minecraft item: " + resourceId);
        }
        return material;
    }

    private static Material requireMinecraftMaterial(String resourceId) {
        if (!resourceId.startsWith("minecraft:")) {
            throw new IllegalArgumentException("unsupported non-Minecraft material id: " + resourceId);
        }
        String enumName = resourceId.substring("minecraft:".length()).toUpperCase(Locale.ROOT);
        Material material = Material.getMaterial(enumName);
        if (material == null) {
            throw new IllegalArgumentException("unknown Minecraft material id: " + resourceId);
        }
        return material;
    }
}
