package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertFalse;

import dev.arena.foundation.MapPlan.BlockPlacement;
import dev.arena.foundation.MapPlan.Dimensions;
import dev.arena.foundation.MapPlan.LootContainer;
import dev.arena.foundation.MapPlan.Position;
import dev.arena.foundation.MapPlan.SpawnPoint;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import org.bukkit.Material;
import org.bukkit.generator.ChunkGenerator;
import org.junit.jupiter.api.Test;

final class ArenaChunkGeneratorTest {
    private record Generated(int x, int y, int z, Material material) {}

    private static final ArenaChunkGenerator.MaterialCatalog TEST_MATERIALS =
            new ArenaChunkGenerator.MaterialCatalog() {
                @Override
                public boolean isBlock(Material material) {
                    return material == Material.STONE || material == Material.CHEST || material == Material.WATER
                            || material == Material.CACTUS;
                }

                @Override
                public boolean isAir(Material material) {
                    return material == Material.AIR || material == Material.CAVE_AIR || material == Material.VOID_AIR;
                }

                @Override
                public boolean isItem(Material material) {
                    return material == Material.STONE || material == Material.CHEST || material == Material.BREAD;
                }

                @Override
                public boolean isSafeSpawnSupport(Material material) {
                    return material == Material.STONE;
                }
            };

    @Test
    void generatesOnlyThePassedChunkFromResolvedImmutablePlacements() {
        ArenaChunkGenerator generator = new ArenaChunkGenerator(plan(), TEST_MATERIALS);
        List<Generated> chunkZero = new ArrayList<>();
        List<Generated> chunkOne = new ArrayList<>();

        generator.generateNoise(null, new Random(0), 0, 0, chunkData(chunkZero, -64, 320));
        generator.generateNoise(null, new Random(0), 1, 0, chunkData(chunkOne, -64, 320));

        assertEquals(List.of(
                new Generated(0, 64, 0, Material.STONE),
                new Generated(1, 64, 0, Material.STONE),
                new Generated(1, 65, 0, Material.CHEST),
                new Generated(15, 64, 0, Material.STONE)), chunkZero);
        assertEquals(List.of(new Generated(0, 64, 0, Material.STONE)), chunkOne);
    }

    @Test
    void outsideMapChunksGenerateNoVanillaTerrainOrDecoration() {
        ArenaChunkGenerator generator = new ArenaChunkGenerator(plan(), TEST_MATERIALS);
        List<Generated> generated = new ArrayList<>();

        generator.generateNoise(null, new Random(0), -1, -1, chunkData(generated, -64, 320));

        assertEquals(List.of(), generated);
        assertFalse(generator.shouldGenerateNoise());
        assertFalse(generator.shouldGenerateSurface());
        assertFalse(generator.shouldGenerateCaves());
        assertFalse(generator.shouldGenerateDecorations());
        assertFalse(generator.shouldGenerateMobs());
        assertFalse(generator.shouldGenerateStructures());
    }

    @Test
    void rejectsResolvedBlocksOutsideThePaperWorldHeight() {
        ArenaChunkGenerator generator = new ArenaChunkGenerator(plan(), TEST_MATERIALS);

        assertThrows(IllegalStateException.class,
                () -> generator.generateNoise(null, new Random(0), 0, 0, chunkData(new ArrayList<>(), -64, 65)));
    }

    @Test
    void rejectsUnknownAndNonBlockMaterialIdsBeforeGenerationStarts() {
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithBlock("minecraft:not_a_real_block"), TEST_MATERIALS));
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithBlock("minecraft:bread"), TEST_MATERIALS));
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithBlock("custom:stone"), TEST_MATERIALS));
    }

    @Test
    void rejectsUnknownAndNonItemLootIdsBeforeGenerationStarts() {
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithLootItem("minecraft:not_a_real_item"), TEST_MATERIALS));
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithLootItem("minecraft:water"), TEST_MATERIALS));
    }

    @Test
    void rejectsWaterAsSpawnSupportBeforeGenerationStarts() {
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithSpawnSupport("minecraft:water"), TEST_MATERIALS));
    }

    @Test
    void rejectsHazardousSolidMaterialAsSpawnSupportBeforeGenerationStarts() {
        assertThrows(IllegalArgumentException.class,
                () -> new ArenaChunkGenerator(planWithSpawnSupport("minecraft:cactus"), TEST_MATERIALS));
    }

    private static ChunkGenerator.ChunkData chunkData(List<Generated> generated, int minHeight, int maxHeight) {
        return (ChunkGenerator.ChunkData) Proxy.newProxyInstance(
                ChunkGenerator.ChunkData.class.getClassLoader(),
                new Class<?>[] {ChunkGenerator.ChunkData.class},
                (proxy, method, arguments) -> {
                    return switch (method.getName()) {
                        case "getMinHeight" -> minHeight;
                        case "getMaxHeight" -> maxHeight;
                        case "setBlock" -> {
                            generated.add(new Generated(
                                    (int) arguments[0],
                                    (int) arguments[1],
                                    (int) arguments[2],
                                    (Material) arguments[3]));
                            yield null;
                        }
                        case "toString" -> "recording ChunkData";
                        case "hashCode" -> System.identityHashCode(proxy);
                        case "equals" -> proxy == arguments[0];
                        default -> throw new UnsupportedOperationException("unexpected ChunkData method " + method.getName());
                    };
                });
    }

    private static MapPlan plan() {
        Dimensions dimensions = new Dimensions(32, 32, 0, 128);
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 65, 0), "minecraft:chest"),
                new BlockPlacement(new Position(15, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(16, 64, 0), "minecraft:stone"));
        List<SpawnPoint> spawns = List.of(new SpawnPoint(0, new Position(0, 65, 0)));
        List<LootContainer> loot = List.of(new LootContainer(new Position(1, 65, 0), List.of("minecraft:bread")));
        return mapPlan(dimensions, blocks, spawns, loot);
    }

    private static MapPlan planWithBlock(String material) {
        Dimensions dimensions = new Dimensions(32, 32, 0, 128);
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 65, 0), "minecraft:chest"),
                new BlockPlacement(new Position(2, 64, 0), material));
        List<SpawnPoint> spawns = List.of(new SpawnPoint(0, new Position(0, 65, 0)));
        List<LootContainer> loot = List.of(new LootContainer(new Position(1, 65, 0), List.of("minecraft:bread")));
        return mapPlan(dimensions, blocks, spawns, loot);
    }

    private static MapPlan planWithLootItem(String item) {
        Dimensions dimensions = new Dimensions(32, 32, 0, 128);
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 65, 0), "minecraft:chest"));
        List<SpawnPoint> spawns = List.of(new SpawnPoint(0, new Position(0, 65, 0)));
        List<LootContainer> loot = List.of(new LootContainer(new Position(1, 65, 0), List.of(item)));
        return mapPlan(dimensions, blocks, spawns, loot);
    }

    private static MapPlan planWithSpawnSupport(String support) {
        Dimensions dimensions = new Dimensions(32, 32, 0, 128);
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 64, 0), support),
                new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 65, 0), "minecraft:chest"));
        List<SpawnPoint> spawns = List.of(new SpawnPoint(0, new Position(0, 65, 0)));
        List<LootContainer> loot = List.of(new LootContainer(new Position(1, 65, 0), List.of("minecraft:bread")));
        return mapPlan(dimensions, blocks, spawns, loot);
    }

    private static MapPlan mapPlan(
            Dimensions dimensions,
            List<BlockPlacement> blocks,
            List<SpawnPoint> spawns,
            List<LootContainer> loot) {
        return new MapPlan(1, "test-run", MapPlan.computeSemanticId(dimensions, blocks, spawns, loot),
                dimensions, blocks, spawns, loot);
    }
}
