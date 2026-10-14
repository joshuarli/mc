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

        List<MapPlan.SpawnPoint> resolved = resolve(plan, world);

        assertEquals(List.of(new MapPlan.SpawnPoint(0, new MapPlan.Position(99, 65, 100))), resolved);
        TestWorld repeat = new TestWorld();
        repeat.waterColumns.add(columnKey(100, 100));
        assertEquals(resolved, resolve(plan, repeat));
        List<MapPlan.SpawnPoint> unmoved = resolve(plan, new TestWorld());
        assertEquals(new MapPlan.Position(100, 65, 100), unmoved.getFirst().position());
        List<MapPlan.LootContainer> noLoot = List.of();
        assertFalse(NaturalWorldSetup.worldIdentity(plan, NaturalWorldSetup.BOUNDED_SEARCH_RECIPE, resolved, noLoot)
                .equals(NaturalWorldSetup.worldIdentity(plan, NaturalWorldSetup.BOUNDED_SEARCH_RECIPE, unmoved, noLoot)));
    }

    @Test
    void searchPlanReportsDiagnosticsInsteadOfRerollingWhenNoCandidateIsSafe() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(200, 200)));
        TestWorld world = new TestWorld();
        for (int x = 60; x <= 140; x++) {
            for (int z = 60; z <= 140; z++) {
                world.waterColumns.add(columnKey(x, z));
            }
        }

        world.allWater = true;
        IllegalStateException failure = assertThrows(IllegalStateException.class, () -> resolve(plan, world));

        assertTrue(failure.getMessage().contains("natural world resolution failed"));
        assertTrue(failure.getMessage().contains("cache declared at (200,200) examined 2048 candidates"));
        assertTrue(failure.getMessage().contains("unsafe-column=2048"));
    }

    @Test
    void searchPlanRejectsHazardsAndSpawnsWithoutAnEscapeColumn() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(120, 100)));
        TestWorld hazard = new TestWorld();
        hazard.hazardPositions.add(new MapPlan.Position(101, 65, 100));
        assertEquals(new MapPlan.Position(99, 65, 100), resolve(plan, hazard).getFirst().position());

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

        List<MapPlan.SpawnPoint> resolved = resolve(searchPlan(spawns, loot), water);

        assertEquals(6, resolved.size());
        assertTrue(resolved.stream().noneMatch(spawn -> spawn.position().equals(new MapPlan.Position(380, 65, 588))));
        assertEquals(new MapPlan.Position(425, 65, 620), resolved.getFirst().position());
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

        List<MapPlan.SpawnPoint> resolved = resolve(plan, cliff);

        assertFalse(resolved.getFirst().position().equals(new MapPlan.Position(100, 65, 100)));
        assertFalse(NaturalWorldSetup.cliffEdge(cliff, resolved.getFirst().position()));
        assertTrue(NaturalWorldSetup.cliffEdge(cliff, new MapPlan.Position(100, 65, 100)));

        TestWorld edgeEverywhere = new TestWorld();
        for (int x = 90; x <= 110; x++) {
            for (int z = 90; z <= 110; z++) {
                if (x % 2 == 0) {
                    edgeEverywhere.surfaceByColumn.put(columnKey(x, z), 62);
                }
            }
        }
        assertEquals(1, resolve(plan, edgeEverywhere).size());
    }

    @Test
    void spawnsWalledOffFromTheBorderCenterAreRejectedAsUnreachable() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 60, 100), spawn(1, 140, 100)), List.of(loot(100, 110)));
        TestWorld walled = new TestWorld();
        for (int x = 136; x <= 144; x++) {
            for (int z = 96; z <= 104; z++) {
                boolean inside = x >= 138 && x <= 142 && z >= 98 && z <= 102;
                if (!inside) {
                    walled.surfaceByColumn.put(columnKey(x, z), 80);
                }
            }
        }
        NaturalWorldSetup.prepare(plan, walled, 2, TEST_MATERIALS);
        MapPlan.Position inside = new MapPlan.Position(140, 65, 100);
        NaturalMapPlan.BorderCenter center = new NaturalMapPlan.BorderCenter(100, 100);

        assertFalse(NaturalWorldSetup.reachableFromCenter(walled, inside, center, 60.0));
        assertTrue(NaturalWorldSetup.reachableFromCenter(new TestWorld(), inside, center, 60.0));

        List<MapPlan.SpawnPoint> resolved = NaturalWorldSetup.resolveWorld(
                plan, walled, TEST_MATERIALS, 6, 60.0, false).spawns();
        MapPlan.Position chosen = resolved.get(1).position();
        assertFalse(chosen.x() >= 138 && chosen.x() <= 142 && chosen.z() >= 98 && chosen.z() <= 102);
        assertTrue(NaturalWorldSetup.reachableFromCenter(walled, chosen, center, 60.0));
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

    private static List<MapPlan.SpawnPoint> resolve(NaturalMapPlan plan, TestWorld world) {
        NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS);
        return NaturalWorldSetup.resolveWorld(plan, world, TEST_MATERIALS, 6, 0.0, true).spawns();
    }

    @Test
    void cacheSearchMovesAChestOffWaterToTheNearestSafeColumnAndFailsLoudlyWhenExhausted() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(300, 300)));
        TestWorld water = new TestWorld();
        water.waterColumns.add(columnKey(300, 300));

        NaturalWorldSetup.prepare(plan, water, 2, TEST_MATERIALS);
        NaturalWorldSetup.ResolvedWorld resolved = NaturalWorldSetup.resolveWorld(plan, water, TEST_MATERIALS, 6, 0.0, true);

        MapPlan.Position chest = resolved.lootContainers().getFirst().position();
        assertEquals(new MapPlan.Position(299, 65, 299), chest);
        assertEquals(List.of(new PlacedChest(chest, List.of(Material.APPLE))), water.placedChests);
        assertTrue(resolved.recipe().startsWith("world-search-v6"));

        TestWorld lake = new TestWorld();
        for (int x = 250; x <= 350; x++) {
            for (int z = 250; z <= 350; z++) {
                lake.waterColumns.add(columnKey(x, z));
            }
        }
        lake.allWater = true;
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> NaturalWorldSetup.resolveWorld(plan, lake, TEST_MATERIALS, 6, 0.0, true));
        assertTrue(failure.getMessage().contains("cache declared at (300,300) examined"));
        assertTrue(failure.getMessage().contains("unsafe-column="));
        assertEquals(List.of(), lake.placedChests);
    }

    @Test
    void anOceanFormationTranslatesToTheNearestLandFormationAndKeepsTheBorderCenterConsistent() {
        NaturalMapPlan plan = searchPlan(
                List.of(spawn(0, 500, 500), spawn(1, 540, 500)), List.of(loot(520, 520), loot(520, 480)));
        TestWorld ocean = new TestWorld();
        for (int x = 400; x <= 660; x++) {
            for (int z = 400; z <= 640; z++) {
                ocean.waterColumns.add(columnKey(x, z));
            }
        }
        NaturalWorldSetup.prepare(plan, ocean, 2, TEST_MATERIALS);

        NaturalWorldSetup.ResolvedWorld resolved = NaturalWorldSetup.resolveWorld(plan, ocean, TEST_MATERIALS, 6, 0.0, true);

        assertTrue(resolved.recipe().contains(";translation="));
        assertFalse(resolved.recipe().endsWith("translation=0,0"));
        int dx = resolved.spawns().getFirst().position().x() - 500;
        int dz = resolved.spawns().getFirst().position().z() - 500;
        assertEquals(new NaturalMapPlan.BorderCenter(520 + (dx / 48) * 48, 500 + (dz / 48) * 48), resolved.borderCenter());
        assertEquals(2, resolved.lootContainers().size());
        assertTrue(resolved.spawns().stream().allMatch(point -> !ocean.waterColumns.contains(
                columnKey(point.position().x(), point.position().z()))));
    }

    @Test
    void cacheSearchSkipsDeclaredSpawnColumnsAndDuplicates() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(100, 100), loot(100, 101)));
        TestWorld world = new TestWorld();
        NaturalWorldSetup.prepare(plan, world, 2, TEST_MATERIALS);

        NaturalWorldSetup.ResolvedWorld resolved = NaturalWorldSetup.resolveWorld(plan, world, TEST_MATERIALS, 6, 0.0, false);

        List<MapPlan.Position> positions = resolved.lootContainers().stream().map(MapPlan.LootContainer::position).toList();
        assertEquals(2, positions.stream().distinct().count());
        assertTrue(positions.stream().noneMatch(position -> position.x() == 100 && position.z() == 100));
        assertEquals(List.of(), world.placedChests);
    }

    @Test
    void searchStaysInsideTheInitialBorderAndPreparedHalo() {
        NaturalMapPlan plan = searchPlan(List.of(spawn(0, 100, 100)), List.of(loot(200, 200)));
        TestWorld lake = new TestWorld();
        for (int x = 90; x <= 130; x++) {
            for (int z = 90; z <= 130; z++) {
                lake.waterColumns.add(columnKey(x, z));
            }
        }
        NaturalWorldSetup.prepare(plan, lake, 2, TEST_MATERIALS);

        List<MapPlan.SpawnPoint> wide = NaturalWorldSetup.resolveWorld(plan, lake, TEST_MATERIALS, 6, 0.0, true).spawns();
        assertTrue(Math.abs(wide.getFirst().position().x() - 100) > 10
                || Math.abs(wide.getFirst().position().z() - 100) > 10);

        lake.allWater = true;
        IllegalStateException exhausted = assertThrows(IllegalStateException.class,
                () -> NaturalWorldSetup.resolveWorld(plan, lake, TEST_MATERIALS, 6, 6.0, true));
        assertTrue(exhausted.getMessage().contains("cache declared at (200,200)"));
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
        private boolean allWater;
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
            if (position.y() == terrainSurfaceY && (allWater || waterColumns.contains(key))) {
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
