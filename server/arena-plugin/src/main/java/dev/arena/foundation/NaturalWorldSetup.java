package dev.arena.foundation;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.bukkit.Material;

final class NaturalWorldSetup {
    record BlockState(Material material, boolean liquid, boolean passable, boolean sturdyTop) {}

    interface SurfaceAccess {
        int minHeight();

        int maxHeight();

        void prepareChunks(List<NaturalMapPlan.ChunkPosition> chunks);

        int highestBlockY(int x, int z);

        BlockState blockAt(MapPlan.Position position);

        void placeLootChest(MapPlan.Position position, List<Material> contents);

        void setWorldSpawn(MapPlan.Position position);
    }

    record PreparedWorld(
            List<MapPlan.SpawnPoint> spawns,
            List<MapPlan.LootContainer> lootContainers,
            int preparedChunkCount) {
        PreparedWorld {
            spawns = List.copyOf(spawns);
            lootContainers = List.copyOf(lootContainers);
        }
    }

    private NaturalWorldSetup() {}

    static PreparedWorld prepare(
            NaturalMapPlan plan,
            SurfaceAccess world,
            int viewDistanceChunks,
            ArenaChunkGenerator.MaterialCatalog materials) {
        if (plan == null || world == null || materials == null) {
            throw new IllegalArgumentException("natural world plan, loaded world access, and material catalog are required");
        }
        List<NaturalMapPlan.ChunkPosition> chunks = plan.chunksWithViewHalo(viewDistanceChunks);
        world.prepareChunks(chunks);

        List<MapPlan.SpawnPoint> resolvedSpawns = new ArrayList<>(plan.spawns().size());
        List<IllegalStateException> unsafeSpawns = new ArrayList<>();
        for (NaturalMapPlan.SurfaceSpawnPoint spawn : plan.spawns()) {
            MapPlan.Position feet = resolveSpawnPosition(world, spawn.column());
            try {
                validateSpawn(world, feet, spawn.seat(), materials);
            } catch (IllegalStateException unsafeSpawn) {
                unsafeSpawns.add(unsafeSpawn);
            }
            resolvedSpawns.add(new MapPlan.SpawnPoint(spawn.seat(), feet));
        }
        if (!unsafeSpawns.isEmpty()) {
            String details = unsafeSpawns.stream().map(IllegalStateException::getMessage).collect(Collectors.joining("; "));
            IllegalStateException failure = new IllegalStateException("natural spawn validation failed: " + details, unsafeSpawns.getFirst());
            unsafeSpawns.stream().skip(1).forEach(failure::addSuppressed);
            throw failure;
        }
        validateSpawnSeparation(resolvedSpawns);

        List<MapPlan.LootContainer> resolvedLoot = new ArrayList<>(plan.lootContainers().size());
        List<List<Material>> contents = new ArrayList<>(plan.lootContainers().size());
        Set<MapPlan.Position> chestPositions = new HashSet<>();
        for (NaturalMapPlan.SurfaceLootContainer container : plan.lootContainers()) {
            MapPlan.Position chestPosition = resolveLootPosition(world, container.column());
            validateChest(world, chestPosition, materials);
            if (!chestPositions.add(chestPosition)) {
                throw new IllegalStateException("natural cache columns resolve to the same chest position");
            }
            List<Material> items = container.inventory().stream()
                    .map(resourceId -> ArenaChunkGenerator.requireItemMaterial(resourceId, materials))
                    .toList();
            resolvedLoot.add(new MapPlan.LootContainer(chestPosition, container.inventory()));
            contents.add(items);
        }
        validateSpawnCacheSeparation(resolvedSpawns, resolvedLoot);
        for (int index = 0; index < resolvedLoot.size(); index++) {
            MapPlan.LootContainer container = resolvedLoot.get(index);
            validateChestAccess(world, container.position(), chestPositions, materials);
        }
        for (int index = 0; index < resolvedLoot.size(); index++) {
            world.placeLootChest(resolvedLoot.get(index).position(), contents.get(index));
        }

        MapPlan.Position firstSpawn = resolvedSpawns.getFirst().position();
        world.setWorldSpawn(firstSpawn);
        return new PreparedWorld(resolvedSpawns, resolvedLoot, chunks.size());
    }

    private static MapPlan.Position resolveSpawnPosition(SurfaceAccess world, NaturalMapPlan.SurfaceColumn column) {
        return positionAboveSurface(world, resolveTerrainSurface(world, column));
    }

    private static MapPlan.Position resolveLootPosition(SurfaceAccess world, NaturalMapPlan.SurfaceColumn column) {
        MapPlan.Position surface = resolveTerrainSurface(world, column);
        if (world.blockAt(surface).material() == Material.CHEST) {
            return surface;
        }
        return positionAboveSurface(world, surface);
    }

    private static MapPlan.Position resolveTerrainSurface(SurfaceAccess world, NaturalMapPlan.SurfaceColumn column) {
        int surfaceY = world.highestBlockY(column.x(), column.z());
        if (surfaceY < world.minHeight() || surfaceY >= world.maxHeight()) {
            throw new IllegalStateException("natural surface height is outside the loaded world's build height");
        }
        return new MapPlan.Position(column.x(), surfaceY, column.z());
    }

    private static MapPlan.Position positionAboveSurface(SurfaceAccess world, MapPlan.Position surface) {
        int positionY;
        try {
            positionY = Math.addExact(surface.y(), 1);
        } catch (ArithmeticException overflow) {
            throw new IllegalStateException("natural surface height cannot contain a standing position", overflow);
        }
        if (positionY >= world.maxHeight()) {
            throw new IllegalStateException("natural surface height is outside the loaded world's build height");
        }
        return new MapPlan.Position(surface.x(), positionY, surface.z());
    }

    private static void validateSpawn(
            SurfaceAccess world,
            MapPlan.Position feet,
            int seat,
            ArenaChunkGenerator.MaterialCatalog materials) {
        MapPlan.Position supportPosition = new MapPlan.Position(feet.x(), feet.y() - 1, feet.z());
        MapPlan.Position headPosition;
        try {
            headPosition = new MapPlan.Position(feet.x(), Math.addExact(feet.y(), 1), feet.z());
        } catch (ArithmeticException overflow) {
            throw new IllegalStateException("natural spawn headroom exceeds block coordinates for seat " + seat, overflow);
        }
        if (headPosition.y() >= world.maxHeight()) {
            throw new IllegalStateException("loaded natural world has insufficient headroom for seat " + seat + " at " + feet);
        }
        BlockState support = world.blockAt(supportPosition);
        BlockState feetState = world.blockAt(feet);
        BlockState head = world.blockAt(headPosition);
        if (!isSafeSupport(support, materials)
                || !isClearStandingBlock(feetState)
                || !isClearStandingBlock(head)) {
            throw new IllegalStateException("loaded natural world has unsafe support or headroom for seat " + seat
                    + " at " + feet + "; support=" + support + "; feet=" + feetState + "; head=" + head);
        }
    }

    private static void validateChest(
            SurfaceAccess world,
            MapPlan.Position chestPosition,
            ArenaChunkGenerator.MaterialCatalog materials) {
        MapPlan.Position support = new MapPlan.Position(chestPosition.x(), chestPosition.y() - 1, chestPosition.z());
        MapPlan.Position headroom;
        try {
            headroom = new MapPlan.Position(chestPosition.x(), Math.addExact(chestPosition.y(), 1), chestPosition.z());
        } catch (ArithmeticException overflow) {
            throw new IllegalStateException("natural cache chest headroom exceeds block coordinates", overflow);
        }
        BlockState existingChest = world.blockAt(chestPosition);
        if (headroom.y() >= world.maxHeight()
                || !isSafeSupport(world.blockAt(support), materials)
                || (existingChest.material() != Material.CHEST && !isClearStandingBlock(existingChest))
                || !isClearStandingBlock(world.blockAt(headroom))) {
            throw new IllegalStateException("natural cache chest column has unsafe support or headroom");
        }
    }

    private static void validateChestAccess(
            SurfaceAccess world,
            MapPlan.Position chest,
            Set<MapPlan.Position> plannedChests,
            ArenaChunkGenerator.MaterialCatalog materials) {
        int y = chest.y();
        List<MapPlan.Position> approaches = new ArrayList<>(4);
        if (chest.x() > Integer.MIN_VALUE) approaches.add(new MapPlan.Position(chest.x() - 1, y, chest.z()));
        if (chest.x() < Integer.MAX_VALUE) approaches.add(new MapPlan.Position(chest.x() + 1, y, chest.z()));
        if (chest.z() > Integer.MIN_VALUE) approaches.add(new MapPlan.Position(chest.x(), y, chest.z() - 1));
        if (chest.z() < Integer.MAX_VALUE) approaches.add(new MapPlan.Position(chest.x(), y, chest.z() + 1));
        boolean accessible = approaches.stream().anyMatch(feet -> {
            MapPlan.Position head = new MapPlan.Position(feet.x(), feet.y() + 1, feet.z());
            MapPlan.Position support = new MapPlan.Position(feet.x(), feet.y() - 1, feet.z());
            return !plannedChests.contains(support) && !plannedChests.contains(feet) && !plannedChests.contains(head)
                    && isSafeSupport(world.blockAt(support), materials)
                    && isClearStandingBlock(world.blockAt(feet))
                    && isClearStandingBlock(world.blockAt(head));
        });
        if (!accessible) {
            throw new IllegalStateException("natural cache chest has no safe adjacent access position");
        }
    }

    private static boolean isSafeSupport(BlockState state, ArenaChunkGenerator.MaterialCatalog materials) {
        return materials.isSafeSpawnSupport(state.material())
                && !state.liquid()
                && state.sturdyTop();
    }

    private static boolean isClearStandingBlock(BlockState state) {
        return state.passable() && !state.liquid();
    }

    private static void validateSpawnSeparation(List<MapPlan.SpawnPoint> spawns) {
        for (int index = 0; index < spawns.size(); index++) {
            MapPlan.Position current = spawns.get(index).position();
            for (int previous = 0; previous < index; previous++) {
                MapPlan.Position other = spawns.get(previous).position();
                long dx = Math.abs((long) current.x() - other.x());
                long dz = Math.abs((long) current.z() - other.z());
                if (dx < 2 && dz < 2) {
                    throw new IllegalStateException("loaded natural spawn positions are not separated");
                }
            }
        }
    }

    private static void validateSpawnCacheSeparation(
            List<MapPlan.SpawnPoint> spawns,
            List<MapPlan.LootContainer> lootContainers) {
        for (MapPlan.SpawnPoint spawn : spawns) {
            for (MapPlan.LootContainer container : lootContainers) {
                if (spawn.position().x() == container.position().x()
                        && spawn.position().z() == container.position().z()) {
                    throw new IllegalStateException("natural spawn and cache columns resolve to the same position");
                }
            }
        }
    }
}
