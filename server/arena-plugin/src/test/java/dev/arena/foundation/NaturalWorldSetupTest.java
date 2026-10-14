package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

final class NaturalWorldSetupTest {
    private static final ArenaChunkGenerator.MaterialCatalog TEST_MATERIALS = new ArenaChunkGenerator.MaterialCatalog() {
        @Override
        public boolean isBlock(Material material) {
            return material != Material.AIR && material != Material.WATER;
        }

        @Override
        public boolean isAir(Material material) {
            return material == Material.AIR;
        }

        @Override
        public boolean isItem(Material material) {
            return material == Material.APPLE;
        }

        @Override
        public boolean isSafeSpawnSupport(Material material) {
            return material == Material.STONE;
        }
    };

    @Test
    void resolvesSafeNaturalSurfacesFillsCacheAndPreparesSparseChunkHalos() {
        NaturalMapPlan plan = plan(
                List.of(spawn(0, 100, 100), spawn(1, 800, 800)),
                List.of(loot(104, 100)));
        TestWorld world = new TestWorld();

        NaturalWorldSetup.PreparedWorld prepared = NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS);

        assertEquals(List.of(
                new MapPlan.SpawnPoint(0, new MapPlan.Position(100, 65, 100)),
                new MapPlan.SpawnPoint(1, new MapPlan.Position(800, 65, 800))), prepared.spawns());
        assertEquals(List.of(new MapPlan.LootContainer(
                new MapPlan.Position(104, 65, 100), List.of("minecraft:apple"))), prepared.lootContainers());
        assertEquals(new MapPlan.Position(100, 65, 100), world.worldSpawn);
        assertEquals(List.of(new PlacedChest(
                new MapPlan.Position(104, 65, 100), List.of(Material.APPLE))), world.placedChests);
        assertEquals(50, prepared.preparedChunkCount());
        assertFalse(world.preparedChunks.contains(new NaturalMapPlan.ChunkPosition(0, 0)));
    }

    @Test
    void searchPlanMovesAnUnsafeDeclaredSpawnToTheFirstSafeRingColumn() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(120, 100)));
        TestWorld world = new TestWorld();
        world.waterColumns.add(columnKey(100, 100));

        NaturalWorldSetup.PreparedWorld prepared = NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS);

        assertEquals(List.of(new MapPlan.SpawnPoint(0, new MapPlan.Position(99, 65, 100))), prepared.spawns());
        assertEquals(NaturalWorldSetup.BOUNDED_SEARCH_RECIPE, prepared.spawnRecipe());
        TestWorld repeat = new TestWorld();
        repeat.waterColumns.add(columnKey(100, 100));
        NaturalWorldSetup.PreparedWorld again = NaturalWorldSetup.prepare(plan, repeat, 2, TEST_MATERIALS);
        assertEquals(prepared.worldIdentity(), again.worldIdentity());
        NaturalWorldSetup.PreparedWorld unmoved = NaturalWorldSetup.prepare(plan, new TestWorld(), 2, TEST_MATERIALS);
        assertEquals(new MapPlan.Position(100, 65, 100), unmoved.spawns().getFirst().position());
        assertFalse(prepared.worldIdentity().equals(unmoved.worldIdentity()));
    }

    @Test
    void searchPlanReportsDiagnosticsInsteadOfRerollingWhenNoCandidateIsSafe() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(120, 100)));
        TestWorld world = new TestWorld();
        for (int x = 60; x <= 140; x++) {
            for (int z = 60; z <= 140; z++) {
                world.waterColumns.add(columnKey(x, z));
            }
        }

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS));

        assertTrue(failure.getMessage().contains("seat 0 declared at (100,100) examined 1024 candidates"));
        assertTrue(failure.getMessage().contains("unsafe-support=1024"));
        assertEquals(List.of(), world.placedChests);
    }

    @Test
    void searchPlanRejectsHazardsAndSpawnsWithoutAnEscapeColumn() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(120, 100)));
        TestWorld hazard = new TestWorld();
        hazard.hazardPositions.add(new MapPlan.Position(101, 65, 100));
        assertEquals(new MapPlan.Position(99, 65, 100),
                NaturalWorldSetup.prepare(plan, hazard, 2, TEST_MATERIALS).spawns().getFirst().position());

        TestWorld boxed = new TestWorld();
        boxed.blockedPositions.addAll(List.of(
                new MapPlan.Position(99, 65, 100), new MapPlan.Position(101, 65, 100),
                new MapPlan.Position(100, 65, 99), new MapPlan.Position(100, 65, 101)));
        assertEquals("no-escape", NaturalWorldSetup.spawnRejection(boxed, new MapPlan.Position(100, 65, 100), TEST_MATERIALS));
    }

    @Test
    void hungerSixShapedDeclaredColumnsResolveThroughTheSearchButStayStrictInLegacyPlans() {
        List<NaturalMapPlan.SurfaceSpawnPoint> spawns = List.of(
                spawn(0, 425, 620), spawn(1, 425, 557), spawn(2, 484, 598),
                spawn(3, 380, 588), spawn(4, 471, 650), spawn(5, 380, 649));
        List<NaturalMapPlan.SurfaceLootContainer> loot = List.of(loot(437, 600));
        TestWorld water = new TestWorld();
        water.waterColumns.add(columnKey(380, 588));
        water.waterColumns.add(columnKey(380, 649));
        water.blockedPositions.add(new MapPlan.Position(425, 66, 557));

        NaturalWorldSetup.PreparedWorld prepared =
                NaturalWorldSetup.prepare(searchPlan(spawns, loot), water, 2, TEST_MATERIALS);

        assertEquals(6, prepared.spawns().size());
        assertTrue(prepared.spawns().stream().noneMatch(spawn -> spawn.position().equals(new MapPlan.Position(380, 65, 588))));
        assertEquals(new MapPlan.Position(425, 65, 620), prepared.spawns().getFirst().position());
        TestWorld legacyWorld = new TestWorld();
        legacyWorld.waterColumns.add(columnKey(380, 588));
        assertThrows(IllegalStateException.class,
                () -> NaturalWorldSetup.prepare(plan(spawns, loot), legacyWorld, 2, TEST_MATERIALS));
    }

    @Test
    void searchPrefersASpawnAwayFromACliffEdgeButKeepsAnEdgeWhenNothingElseFits() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(120, 100)));
        TestWorld cliff = new TestWorld();
        cliff.surfaceByColumn.put(columnKey(100, 99), 58);
        cliff.surfaceByColumn.put(columnKey(99, 99), 58);
        cliff.surfaceByColumn.put(columnKey(101, 99), 58);

        NaturalWorldSetup.PreparedWorld prepared = NaturalWorldSetup.prepare(plan, cliff, 2, TEST_MATERIALS);

        assertFalse(prepared.spawns().getFirst().position().equals(new MapPlan.Position(100, 65, 100)));
        assertFalse(NaturalWorldSetup.cliffEdge(cliff, prepared.spawns().getFirst().position()));
        assertTrue(NaturalWorldSetup.cliffEdge(cliff, new MapPlan.Position(100, 65, 100)));

        TestWorld edgeEverywhere = new TestWorld();
        for (int x = 90; x <= 110; x++) {
            for (int z = 90; z <= 110; z++) {
                if (x % 2 == 0) {
                    edgeEverywhere.surfaceByColumn.put(columnKey(x, z), 62);
                }
            }
        }
        assertEquals(1, NaturalWorldSetup.prepare(plan, edgeEverywhere, 2, TEST_MATERIALS).spawns().size());
    }

    @Test
    void searchCandidatesAreBoundedAndOrderedDeterministically() {
        List<NaturalMapPlan.SurfaceColumn> candidates = NaturalWorldSetup.searchCandidates(
                new NaturalMapPlan.SurfaceColumn(0, 0), new WorldPlan.Footprint(1024, 1024),
                new NaturalMapPlan.BorderCenter(512, 512));

        assertEquals(new NaturalMapPlan.SurfaceColumn(0, 0), candidates.getFirst());
        assertEquals(new NaturalMapPlan.SurfaceColumn(0, 0), candidates.get(0));
        assertEquals(new NaturalMapPlan.SurfaceColumn(1, 1), candidates.get(1));
        assertTrue(candidates.size() <= NaturalWorldSetup.SEARCH_MAX_CANDIDATES_PER_SEAT);
        assertTrue(candidates.stream().allMatch(column -> column.x() >= 0 && column.z() >= 0));
    }

    @Test
    void rejectsUnsafeSpawnSupportAndHeadroomBeforeChestMutation() {
        NaturalMapPlan plan = plan(List.of(spawn(0, 100, 100), spawn(1, 200, 200)), List.of(loot(104, 100)));
        TestWorld waterSupport = new TestWorld();
        waterSupport.waterColumns.add(columnKey(100, 100));
        waterSupport.waterColumns.add(columnKey(200, 200));

        IllegalStateException unsafeSupport = assertThrows(
                IllegalStateException.class,
                () -> NaturalWorldSetup.prepare(plan, waterSupport, 2, TEST_MATERIALS));
        assertTrue(unsafeSupport.getMessage().contains("seat 0 at Position[x=100, y=65, z=100]"));
        assertTrue(unsafeSupport.getMessage().contains("seat 1 at Position[x=200, y=65, z=200]"));
        assertTrue(unsafeSupport.getMessage().contains("support=BlockState[material=WATER"));
        assertEquals(List.of(), waterSupport.placedChests);

        TestWorld blockedHeadroom = new TestWorld();
        blockedHeadroom.blockedPositions.add(new MapPlan.Position(100, 66, 100));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, blockedHeadroom, 2, TEST_MATERIALS));
        assertEquals(List.of(), blockedHeadroom.placedChests);
    }

    @Test
    void rejectsUnsafeCacheSupportAndHeadroomBeforeChestMutation() {
        NaturalMapPlan plan = plan(List.of(spawn(0, 100, 100)), List.of(loot(104, 100)));
        TestWorld waterSupport = new TestWorld();
        waterSupport.waterColumns.add(columnKey(104, 100));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, waterSupport, 2, TEST_MATERIALS));
        assertEquals(List.of(), waterSupport.placedChests);

        TestWorld blockedHeadroom = new TestWorld();
        blockedHeadroom.blockedPositions.add(new MapPlan.Position(104, 66, 100));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, blockedHeadroom, 2, TEST_MATERIALS));
        assertEquals(List.of(), blockedHeadroom.placedChests);
    }

    @Test
    void reusesAnExistingCacheChestAtItsConfiguredColumn() {
        NaturalMapPlan plan = plan(List.of(spawn(0, 100, 100)), List.of(loot(104, 100)));
        TestWorld world = new TestWorld();
        world.existingCacheColumns.add(columnKey(104, 100));

        NaturalWorldSetup.PreparedWorld prepared = NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS);

        assertEquals(List.of(new MapPlan.LootContainer(
                new MapPlan.Position(104, 65, 100), List.of("minecraft:apple"))), prepared.lootContainers());
        assertEquals(List.of(new PlacedChest(
                new MapPlan.Position(104, 65, 100), List.of(Material.APPLE))), world.placedChests);
    }

    @Test
    void validatesSupportAndHeadroomOfAnExistingCacheChestBeforeMutation() {
        NaturalMapPlan plan = plan(List.of(spawn(0, 100, 100)), List.of(loot(104, 100)));
        TestWorld unsafeSupport = new TestWorld();
        unsafeSupport.existingCacheColumns.add(columnKey(104, 100));
        unsafeSupport.waterColumns.add(columnKey(104, 100));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, unsafeSupport, 2, TEST_MATERIALS));
        assertEquals(List.of(), unsafeSupport.placedChests);

        TestWorld blockedHeadroom = new TestWorld();
        blockedHeadroom.existingCacheColumns.add(columnKey(104, 100));
        blockedHeadroom.blockedPositions.add(new MapPlan.Position(104, 66, 100));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, blockedHeadroom, 2, TEST_MATERIALS));
        assertEquals(List.of(), blockedHeadroom.placedChests);
    }

    @Test
    void rejectsCachesWithoutSafeAdjacentAccess() {
        NaturalMapPlan plan = plan(List.of(spawn(0, 100, 100)), List.of(loot(104, 100)));
        TestWorld world = new TestWorld();
        world.blockedPositions.addAll(List.of(
                new MapPlan.Position(103, 65, 100),
                new MapPlan.Position(105, 65, 100),
                new MapPlan.Position(104, 65, 99),
                new MapPlan.Position(104, 65, 101)));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS));
        assertEquals(List.of(), world.placedChests);
    }

    @Test
    void rejectsCacheAccessThatUsesAnotherCacheAsItsSupport() {
        NaturalMapPlan plan = plan(
                List.of(spawn(0, 100, 100)),
                List.of(loot(104, 100), loot(105, 100)));
        TestWorld world = new TestWorld();
        world.surfaceByColumn.put(columnKey(105, 100), 63);
        world.surfaceByColumn.put(columnKey(106, 100), 63);
        world.passableSturdyPositions.add(new MapPlan.Position(105, 64, 100));
        world.blockedPositions.addAll(List.of(
                new MapPlan.Position(103, 65, 100),
                new MapPlan.Position(103, 66, 100),
                new MapPlan.Position(104, 65, 99),
                new MapPlan.Position(104, 66, 99),
                new MapPlan.Position(104, 65, 101),
                new MapPlan.Position(104, 66, 101)));

        assertThrows(IllegalStateException.class, () -> NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS));
        assertEquals(List.of(), world.placedChests);
    }

    @Test
    void rejectsSparsePreparedChunkHalosAboveTheSharedLimit() {
        NaturalMapPlan plan = plan(List.of(spawn(0, 0, 0)), List.of(loot(1023, 1023)));

        assertThrows(IllegalArgumentException.class, () -> plan.chunksWithViewHalo(32));
    }

    @Test
    void centersNaturalBorderOnTheFlooredMeanSpawnColumn() {
        NaturalMapPlan plan = plan(List.of(
                spawn(0, 425, 620),
                spawn(1, 425, 557),
                spawn(2, 484, 598),
                spawn(3, 380, 588),
                spawn(4, 471, 650),
                spawn(5, 380, 649)), List.of(loot(437, 600)));

        assertEquals(new NaturalMapPlan.BorderCenter(427, 610), plan.borderCenter());
    }

    @Test
    void rejectsSpawnColumnsThatAreTooClose() {
        assertThrows(IllegalArgumentException.class, () -> plan(
                List.of(spawn(0, 100, 100), spawn(1, 101, 101)),
                List.of(loot(104, 100))));
    }

    private static NaturalMapPlan plan(
            List<NaturalMapPlan.SurfaceSpawnPoint> spawns,
            List<NaturalMapPlan.SurfaceLootContainer> loot) {
        WorldPlan.Footprint footprint = new WorldPlan.Footprint(1024, 1024);
        String semanticId = NaturalMapPlan.computeSemanticId(footprint, spawns, loot);
        return new NaturalMapPlan("natural-test", BigInteger.ONE, semanticId, footprint, spawns, loot);
    }

    private static NaturalMapPlan searchPlan(
            List<NaturalMapPlan.SurfaceSpawnPoint> spawns,
            List<NaturalMapPlan.SurfaceLootContainer> loot) {
        WorldPlan.Footprint footprint = new WorldPlan.Footprint(1024, 1024);
        String semanticId = NaturalMapPlan.computeSemanticId(footprint, spawns, loot);
        List<NaturalMapPlan.RosterSeat> roster = spawns.stream()
                .map(spawn -> NaturalMapPlan.RosterSeat.bot(spawn.seat())).toList();
        return new NaturalMapPlan(NaturalMapPlan.SCHEMA_VERSION_GENERALIZED_ROSTER, "natural-test", BigInteger.ONE,
                semanticId, footprint, spawns, loot, roster);
    }

    private static NaturalMapPlan.SurfaceSpawnPoint spawn(int seat, int x, int z) {
        return new NaturalMapPlan.SurfaceSpawnPoint(seat, new NaturalMapPlan.SurfaceColumn(x, z));
    }

    private static NaturalMapPlan.SurfaceLootContainer loot(int x, int z) {
        return new NaturalMapPlan.SurfaceLootContainer(
                new NaturalMapPlan.SurfaceColumn(x, z), List.of("minecraft:apple"));
    }

    private static String columnKey(int x, int z) {
        return x + "," + z;
    }

    private record PlacedChest(MapPlan.Position position, List<Material> contents) {}

    private static final class TestWorld implements NaturalWorldSetup.SurfaceAccess {
        private final Set<NaturalMapPlan.ChunkPosition> preparedChunks = new HashSet<>();
        private final Set<String> waterColumns = new HashSet<>();
        private final Set<String> existingCacheColumns = new HashSet<>();
        private final Set<MapPlan.Position> blockedPositions = new HashSet<>();
        private final Set<MapPlan.Position> passableSturdyPositions = new HashSet<>();
        private final Set<MapPlan.Position> hazardPositions = new HashSet<>();
        private final List<PlacedChest> placedChests = new ArrayList<>();
        private final Map<String, Integer> surfaceByColumn = new HashMap<>();
        private MapPlan.Position worldSpawn;

        @Override
        public int minHeight() {
            return -64;
        }

        @Override
        public int maxHeight() {
            return 320;
        }

        @Override
        public void prepareChunks(List<NaturalMapPlan.ChunkPosition> chunks) {
            preparedChunks.addAll(chunks);
        }

        @Override
        public int highestBlockY(int x, int z) {
            int surfaceY = surfaceByColumn.getOrDefault(columnKey(x, z), 64);
            return existingCacheColumns.contains(columnKey(x, z)) ? surfaceY + 1 : surfaceY;
        }

        @Override
        public NaturalWorldSetup.BlockState blockAt(MapPlan.Position position) {
            if (blockedPositions.contains(position)) {
                return new NaturalWorldSetup.BlockState(Material.DIRT, false, false, true);
            }
            if (hazardPositions.contains(position)) {
                return new NaturalWorldSetup.BlockState(Material.LAVA, true, true, false);
            }
            if (passableSturdyPositions.contains(position)) {
                return new NaturalWorldSetup.BlockState(Material.STONE, false, true, true);
            }
            String key = columnKey(position.x(), position.z());
            int terrainSurfaceY = surfaceByColumn.getOrDefault(key, 64);
            if (position.y() == terrainSurfaceY + 1 && existingCacheColumns.contains(key)) {
                return new NaturalWorldSetup.BlockState(Material.CHEST, false, false, false);
            }
            if (position.y() == terrainSurfaceY && waterColumns.contains(key)) {
                return new NaturalWorldSetup.BlockState(Material.WATER, true, false, false);
            }
            if (position.y() <= terrainSurfaceY) {
                return new NaturalWorldSetup.BlockState(Material.STONE, false, false, true);
            }
            return new NaturalWorldSetup.BlockState(Material.AIR, false, true, false);
        }

        @Override
        public void placeLootChest(MapPlan.Position position, List<Material> contents) {
            placedChests.add(new PlacedChest(position, contents));
        }

        @Override
        public void setWorldSpawn(MapPlan.Position position) {
            worldSpawn = position;
        }
    }
}
