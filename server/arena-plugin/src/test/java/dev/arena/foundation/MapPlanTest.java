package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.arena.foundation.MapPlan.BlockPlacement;
import dev.arena.foundation.MapPlan.Dimensions;
import dev.arena.foundation.MapPlan.LootContainer;
import dev.arena.foundation.MapPlan.Position;
import dev.arena.foundation.MapPlan.SpawnPoint;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;

final class MapPlanTest {
    @Test
    void indexesResolvedBlocksByEuclideanChunkAndStableCoordinateOrder() {
        MapPlan plan = plan(validBlocks());

        assertEquals(List.of(
                new Position(0, 64, 0),
                new Position(1, 64, 0),
                new Position(1, 65, 0),
                new Position(15, 64, 0)),
                plan.blocksForChunk(0, 0).stream().map(BlockPlacement::position).toList());
        assertEquals(List.of(new Position(16, 64, 0)),
                plan.blocksForChunk(1, 0).stream().map(BlockPlacement::position).toList());
        assertEquals(List.of(new Position(31, 64, 31)),
                plan.blocksForChunk(1, 1).stream().map(BlockPlacement::position).toList());
        assertEquals(List.of(), plan.blocksForChunk(-1, 0));
    }

    @Test
    void chunkConversionUsesFloorDivisionAndNonnegativeLocalCoordinates() {
        assertEquals(-2, MapPlan.chunkCoordinate(-17));
        assertEquals(-1, MapPlan.chunkCoordinate(-16));
        assertEquals(-1, MapPlan.chunkCoordinate(-1));
        assertEquals(0, MapPlan.chunkCoordinate(15));
        assertEquals(1, MapPlan.chunkCoordinate(16));

        assertEquals(15, MapPlan.localCoordinate(-17));
        assertEquals(0, MapPlan.localCoordinate(-16));
        assertEquals(15, MapPlan.localCoordinate(-1));
        assertEquals(15, MapPlan.localCoordinate(15));
        assertEquals(0, MapPlan.localCoordinate(16));
    }

    @Test
    void semanticIdMatchesTheCrossLanguageWorldPlanVector() {
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 0, 0), "minecraft:stone"),
                new BlockPlacement(new Position(0, 0, 1), "minecraft:stone"),
                new BlockPlacement(new Position(0, 0, 2), "minecraft:stone"),
                new BlockPlacement(new Position(1, 0, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 0, 1), "minecraft:stone"),
                new BlockPlacement(new Position(1, 0, 2), "minecraft:stone"),
                new BlockPlacement(new Position(2, 0, 0), "minecraft:stone"),
                new BlockPlacement(new Position(2, 0, 1), "minecraft:stone"),
                new BlockPlacement(new Position(2, 0, 2), "minecraft:stone"),
                new BlockPlacement(new Position(2, 1, 2), "minecraft:chest"));
        MapPlan plan = plan(new Dimensions(4, 4, 0, 3), blocks,
                List.of(new SpawnPoint(0, new Position(0, 1, 0))),
                List.of(new LootContainer(new Position(2, 1, 2), List.of("minecraft:apple"))));

        assertEquals("94f1cf73fef47c767b574477350ee7ce59f139e4a680464d88f99c1a25b2eedb",
                plan.mapSemanticId());
    }

    @Test
    void viewDistancePregenContainsTheWholeMapAndHaloInStableOrder() {
        MapPlan plan = plan(validBlocks());
        List<MapPlan.ChunkPosition> chunks = plan.chunksWithViewHalo(1);

        assertEquals(36, chunks.size());
        assertEquals(new MapPlan.ChunkPosition(-1, -1), chunks.getFirst());
        assertEquals(new MapPlan.ChunkPosition(4, 4), chunks.getLast());
        assertEquals(new MapPlan.ChunkPosition(0, 0), chunks.get(7));
        assertEquals(256, plan.chunksWithViewHalo(6).size());
    }

    @Test
    void rejectsPlansThatExceedThePreparedChunkLimit() {
        MapPlan large = plan(new Dimensions(432, 432, 0, 128),
                List.of(new BlockPlacement(new Position(0, 64, 0), "minecraft:stone"),
                        new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                        new BlockPlacement(new Position(1, 65, 0), "minecraft:chest")),
                List.of(new SpawnPoint(0, new Position(0, 65, 0))),
                List.of(new LootContainer(new Position(1, 65, 0), List.of("minecraft:bread"))));

        assertThrows(IllegalArgumentException.class, () -> large.chunksWithViewHalo(32));
    }

    @Test
    void preparesTheCampaignMaximumMapAndViewDistance() {
        MapPlan large = plan(new Dimensions(192, 192, 0, 128), validBlocks(), spawns(), loot());

        assertEquals(5_776, large.chunksWithViewHalo(32).size());
    }

    @Test
    void retainsImmutableResolvedDataAndDoesNotDependOnInputOrder() {
        ArrayList<BlockPlacement> input = new ArrayList<>(validBlocks());
        List<BlockPlacement> original = List.copyOf(input);
        MapPlan plan = plan(input);
        input.clear();

        assertEquals(validBlocks(), original);
        assertEquals(List.of(
                new BlockPlacement(new Position(0, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 65, 0), "minecraft:chest"),
                new BlockPlacement(new Position(15, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(16, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(31, 64, 31), "minecraft:dirt")), plan.blocks());
        assertThrows(UnsupportedOperationException.class, () -> plan.blocks().clear());
    }

    @Test
    void rejectsUnsupportedSchemaDuplicateBlocksInvalidSpawnsAndUnbackedLoot() {
        assertThrows(IllegalArgumentException.class, () -> new MapPlan(2, "test-run",
                MapPlan.computeSemanticId(dimensions(), validBlocks(), spawns(), loot()),
                dimensions(), validBlocks(), spawns(), loot()));

        ArrayList<BlockPlacement> duplicate = new ArrayList<>(validBlocks());
        duplicate.add(validBlocks().getFirst());
        assertThrows(IllegalArgumentException.class, () -> plan(duplicate));

        assertThrows(IllegalArgumentException.class, () -> plan(dimensions(), validBlocks(),
                List.of(new SpawnPoint(1, new Position(0, 65, 0))), loot()));

        assertThrows(IllegalArgumentException.class, () -> plan(dimensions(),
                validBlocks(), List.of(new SpawnPoint(0, new Position(0, 65, 0)),
                        new SpawnPoint(1, new Position(0, 65, 0))), loot()));

        assertThrows(IllegalArgumentException.class, () -> plan(
                new Dimensions(64, 64, 0, 65), validBlocks(), spawns(), loot()));

        assertThrows(IllegalArgumentException.class, () -> plan(dimensions(),
                validBlocks(), spawns(), List.of(new LootContainer(new Position(2, 65, 0), List.of("minecraft:bread")))));

        assertThrows(IllegalArgumentException.class, () -> new LootContainer(new Position(0, 0, 0),
                java.util.Collections.nCopies(28, "minecraft:bread")));
    }

    @Test
    void rejectsSpawnSeatsThatAreLessThanTwoHorizontalBlocksApart() {
        Dimensions dimensions = new Dimensions(8, 8, 0, 8);
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 1, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 1, 0), "minecraft:stone"),
                new BlockPlacement(new Position(4, 1, 4), "minecraft:stone"),
                new BlockPlacement(new Position(4, 2, 4), "minecraft:chest"));

        assertThrows(IllegalArgumentException.class, () -> plan(dimensions, blocks,
                List.of(new SpawnPoint(0, new Position(0, 2, 0)), new SpawnPoint(1, new Position(1, 2, 0))),
                List.of(new LootContainer(new Position(4, 2, 4), List.of("minecraft:bread")))));
    }

    @Test
    void validatesSpawnSeparationWithoutOverflowingAtCoordinateLimits() {
        Dimensions dimensions = new Dimensions(2_147_483_648L, 2_147_483_648L, 0, 3);
        List<BlockPlacement> blocks = List.of(
                new BlockPlacement(new Position(0, 1, 0), "minecraft:stone"),
                new BlockPlacement(new Position(4, 0, 4), "minecraft:stone"),
                new BlockPlacement(new Position(4, 1, 4), "minecraft:chest"),
                new BlockPlacement(new Position(Integer.MAX_VALUE, 1, Integer.MAX_VALUE), "minecraft:stone"));

        MapPlan plan = plan(dimensions, blocks,
                List.of(new SpawnPoint(0, new Position(0, 2, 0)),
                        new SpawnPoint(1, new Position(Integer.MAX_VALUE, 2, Integer.MAX_VALUE))),
                List.of(new LootContainer(new Position(4, 1, 4), List.of("minecraft:bread"))));

        assertEquals(2, plan.spawns().size());
    }

    @Test
    void rejectsPlansAboveTheLootContainerLimit() {
        assertThrows(IllegalArgumentException.class, () -> new MapPlan(1, "test-run", id('a'), dimensions(),
                validBlocks(), spawns(),
                Collections.nCopies(MapPlan.MAX_LOOT_CONTAINERS + 1, loot().getFirst())));
    }

    @Test
    void rejectsMalformedSemanticIdsAndOutOfBoundsBlocks() {
        assertThrows(IllegalArgumentException.class, () -> new MapPlan(1, "test-run", "not-an-id", dimensions(),
                validBlocks(), spawns(), loot()));
        assertThrows(IllegalArgumentException.class, () -> new MapPlan(1, "test-run", id('a'), dimensions(),
                validBlocks(), spawns(), loot()));

        ArrayList<BlockPlacement> outOfBounds = new ArrayList<>(validBlocks());
        outOfBounds.add(new BlockPlacement(new Position(64, 64, 0), "minecraft:stone"));
        assertThrows(IllegalArgumentException.class, () -> plan(outOfBounds));
    }

    private static MapPlan plan(List<BlockPlacement> blocks) {
        return plan(dimensions(), blocks, spawns(), loot());
    }

    private static MapPlan plan(
            Dimensions dimensions,
            List<BlockPlacement> blocks,
            List<SpawnPoint> spawns,
            List<LootContainer> loot) {
        return new MapPlan(1, "test-run", MapPlan.computeSemanticId(dimensions, blocks, spawns, loot),
                dimensions, blocks, spawns, loot);
    }

    private static Dimensions dimensions() {
        return new Dimensions(64, 64, 0, 128);
    }

    private static List<BlockPlacement> validBlocks() {
        return List.of(
                new BlockPlacement(new Position(31, 64, 31), "minecraft:dirt"),
                new BlockPlacement(new Position(15, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 65, 0), "minecraft:chest"),
                new BlockPlacement(new Position(16, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(1, 64, 0), "minecraft:stone"),
                new BlockPlacement(new Position(0, 64, 0), "minecraft:stone"));
    }

    private static List<SpawnPoint> spawns() {
        return List.of(new SpawnPoint(0, new Position(0, 65, 0)));
    }

    private static List<LootContainer> loot() {
        return List.of(new LootContainer(new Position(1, 65, 0), List.of("minecraft:bread")));
    }

    private static String id(char digit) {
        return String.valueOf(digit).repeat(64);
    }

}
