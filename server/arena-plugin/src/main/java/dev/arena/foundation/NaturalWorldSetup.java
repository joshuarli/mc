package dev.arena.foundation;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.bukkit.Material;

final class NaturalWorldSetup {
    static final String DECLARED_COLUMN_RECIPE = "declared-columns-v1";
    static final int SEARCH_RING_RADIUS_BLOCKS = 48;
    static final int SEARCH_MAX_CANDIDATES_PER_SEAT = 2048;
    static final int CACHE_SEARCH_RING_RADIUS_BLOCKS = 24;
    static final double SEARCH_BORDER_INSET_BLOCKS = 1.0;
    static final String DEFERRED_SEARCH_RECIPE = "spawn-search-deferred";
    static final String BOUNDED_SEARCH_RECIPE = "world-search-v6;cache-radius=" + CACHE_SEARCH_RING_RADIUS_BLOCKS + ";ring-radius=" + SEARCH_RING_RADIUS_BLOCKS
            + ";max-candidates=" + SEARCH_MAX_CANDIDATES_PER_SEAT
            + ";border-inset=1;order=declared,chebyshev-ring,center-distance,x-then-z;preference=no-cliff-edge";
    private static final Set<Material> HAZARDS = Set.of(
            Material.LAVA, Material.FIRE, Material.SOUL_FIRE, Material.MAGMA_BLOCK, Material.CACTUS,
            Material.CAMPFIRE, Material.SOUL_CAMPFIRE, Material.SWEET_BERRY_BUSH, Material.WITHER_ROSE,
            Material.POWDER_SNOW, Material.COBWEB);

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

    record ResolvedWorld(
            List<MapPlan.SpawnPoint> spawns,
            List<MapPlan.LootContainer> lootContainers,
            String recipe,
            String worldIdentity,
            NaturalMapPlan.BorderCenter borderCenter) {}

    record PreparedWorld(
            List<MapPlan.SpawnPoint> spawns,
            List<MapPlan.LootContainer> lootContainers,
            int preparedChunkCount,
            String spawnRecipe,
            String worldIdentity) {
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
        return prepare(plan, world, viewDistanceChunks, materials, true);
    }

    static PreparedWorld prepare(
            NaturalMapPlan plan,
            SurfaceAccess world,
            int viewDistanceChunks,
            ArenaChunkGenerator.MaterialCatalog materials,
            boolean placeCaches) {
        if (plan == null || world == null || materials == null) {
            throw new IllegalArgumentException("natural world plan, loaded world access, and material catalog are required");
        }
        List<NaturalMapPlan.ChunkPosition> chunks = plan.chunksWithViewHalo(viewDistanceChunks);
        world.prepareChunks(chunks);

        boolean searching = plan.schemaVersion() == NaturalMapPlan.SCHEMA_VERSION_GENERALIZED_ROSTER;
        if (searching) {
            return new PreparedWorld(provisionalSpawns(plan, world), List.of(), chunks.size(),
                    DEFERRED_SEARCH_RECIPE, "");
        }
        List<MapPlan.SpawnPoint> resolvedSpawns = resolveDeclaredSpawns(plan, world, materials);

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
        if (placeCaches) {
            for (int index = 0; index < resolvedLoot.size(); index++) {
                world.placeLootChest(resolvedLoot.get(index).position(), contents.get(index));
            }
            world.setWorldSpawn(resolvedSpawns.getFirst().position());
        }
        return new PreparedWorld(resolvedSpawns, resolvedLoot, chunks.size(), DECLARED_COLUMN_RECIPE,
                worldIdentity(plan, DECLARED_COLUMN_RECIPE, resolvedSpawns, resolvedLoot));
    }

    record Formation(
            int translationX,
            int translationZ,
            List<NaturalMapPlan.SurfaceSpawnPoint> spawns,
            List<NaturalMapPlan.SurfaceLootContainer> caches,
            NaturalMapPlan.BorderCenter center) {}

    static final int TRANSLATION_STEP_BLOCKS = 48;
    static final int TRANSLATION_MAX_RINGS = 7;
    static final int TRANSLATION_MAX_SCREENED = 80;
    static final int TRANSLATION_MAX_SEARCHED = 6;

    static List<int[]> translationCandidates(NaturalMapPlan plan) {
        int minX = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int minZ = Integer.MAX_VALUE;
        int maxZ = Integer.MIN_VALUE;
        List<NaturalMapPlan.SurfaceColumn> columns = new ArrayList<>();
        plan.spawns().forEach(spawn -> columns.add(spawn.column()));
        plan.lootContainers().forEach(container -> columns.add(container.column()));
        for (NaturalMapPlan.SurfaceColumn column : columns) {
            minX = Math.min(minX, column.x());
            maxX = Math.max(maxX, column.x());
            minZ = Math.min(minZ, column.z());
            maxZ = Math.max(maxZ, column.z());
        }
        int margin = CACHE_SEARCH_RING_RADIUS_BLOCKS;
        List<int[]> candidates = new ArrayList<>();
        candidates.add(new int[] {0, 0});
        for (int ring = 1; ring <= TRANSLATION_MAX_RINGS; ring++) {
            List<int[]> ringTranslations = new ArrayList<>();
            for (int a = -ring; a <= ring; a++) {
                for (int b = -ring; b <= ring; b++) {
                    if (Math.max(Math.abs(a), Math.abs(b)) != ring) {
                        continue;
                    }
                    int dx = a * TRANSLATION_STEP_BLOCKS;
                    int dz = b * TRANSLATION_STEP_BLOCKS;
                    boolean fits = minX + dx - margin >= 0 && minZ + dz - margin >= 0
                            && maxX + dx + margin < plan.footprint().width()
                            && maxZ + dz + margin < plan.footprint().depth();
                    if (fits) {
                        ringTranslations.add(new int[] {dx, dz});
                    }
                }
            }
            ringTranslations.sort(java.util.Comparator
                    .comparingInt((int[] value) -> value[0] * value[0] + value[1] * value[1])
                    .thenComparingInt(value -> value[0])
                    .thenComparingInt(value -> value[1]));
            candidates.addAll(ringTranslations);
        }
        return candidates;
    }

    private static Formation translated(NaturalMapPlan plan, int dx, int dz) {
        List<NaturalMapPlan.SurfaceSpawnPoint> spawns = plan.spawns().stream()
                .map(spawn -> new NaturalMapPlan.SurfaceSpawnPoint(spawn.seat(),
                        new NaturalMapPlan.SurfaceColumn(spawn.column().x() + dx, spawn.column().z() + dz)))
                .toList();
        List<NaturalMapPlan.SurfaceLootContainer> caches = plan.lootContainers().stream()
                .map(container -> new NaturalMapPlan.SurfaceLootContainer(
                        new NaturalMapPlan.SurfaceColumn(container.column().x() + dx, container.column().z() + dz),
                        container.inventory()))
                .toList();
        NaturalMapPlan.BorderCenter center = plan.borderCenter();
        return new Formation(dx, dz, spawns, caches,
                new NaturalMapPlan.BorderCenter(center.x() + dx, center.z() + dz));
    }

    private static boolean landColumn(SurfaceAccess world, NaturalMapPlan.SurfaceColumn column) {
        try {
            BlockState top = world.blockAt(resolveTerrainSurface(world, column));
            return !top.liquid() && top.sturdyTop();
        } catch (IllegalStateException outside) {
            return false;
        }
    }

    private static boolean screens(Formation formation, SurfaceAccess world) {
        for (NaturalMapPlan.SurfaceSpawnPoint spawn : formation.spawns()) {
            if (!landColumn(world, spawn.column())) {
                return false;
            }
        }
        for (NaturalMapPlan.SurfaceLootContainer cache : formation.caches()) {
            if (!landColumn(world, cache.column())) {
                return false;
            }
        }
        return true;
    }

    static ResolvedWorld resolveWorld(
            NaturalMapPlan plan,
            SurfaceAccess world,
            ArenaChunkGenerator.MaterialCatalog materials,
            int viewDistanceChunks,
            double initialBorderRadiusBlocks,
            boolean placeCaches) {
        int halo = Math.max(0, viewDistanceChunks) * 16;
        List<String> attempts = new ArrayList<>();
        int screened = 0;
        int searched = 0;
        for (int[] translation : translationCandidates(plan)) {
            boolean identity = translation[0] == 0 && translation[1] == 0;
            Formation formation = identity ? translated(plan, 0, 0) : translated(plan, translation[0], translation[1]);
            if (!identity) {
                if (screened >= TRANSLATION_MAX_SCREENED || searched >= TRANSLATION_MAX_SEARCHED) {
                    break;
                }
                screened++;
                if (!screens(formation, world)) {
                    continue;
                }
            }
            searched++;
            try {
                List<MapPlan.LootContainer> loot = searchCaches(plan, formation, world, materials,
                        Math.min(CACHE_SEARCH_RING_RADIUS_BLOCKS, halo), initialBorderRadiusBlocks);
                Set<NaturalMapPlan.SurfaceColumn> cacheColumns = loot.stream()
                        .map(container -> new NaturalMapPlan.SurfaceColumn(
                                container.position().x(), container.position().z()))
                        .collect(Collectors.toSet());
                List<MapPlan.SpawnPoint> spawns = searchSpawns(plan, formation, world, materials,
                        Math.min(SEARCH_RING_RADIUS_BLOCKS, halo), initialBorderRadiusBlocks, cacheColumns);
                if (placeCaches) {
                    for (int index = 0; index < loot.size(); index++) {
                        List<Material> items = loot.get(index).inventory().stream()
                                .map(resourceId -> ArenaChunkGenerator.requireItemMaterial(resourceId, materials))
                                .toList();
                        world.placeLootChest(loot.get(index).position(), items);
                    }
                    world.setWorldSpawn(spawns.getFirst().position());
                }
                String recipe = BOUNDED_SEARCH_RECIPE + ";translation=" + formation.translationX() + ","
                        + formation.translationZ();
                return new ResolvedWorld(spawns, loot, recipe, worldIdentity(plan, recipe, spawns, loot),
                        formation.center());
            } catch (IllegalStateException failed) {
                attempts.add("translation (" + translation[0] + "," + translation[1] + "): " + failed.getMessage());
            }
        }
        String first = attempts.isEmpty() ? "no translation passed the land screen" : attempts.getFirst();
        throw new IllegalStateException("natural world resolution failed after " + searched + " searched and "
                + screened + " screened formation translations (step " + TRANSLATION_STEP_BLOCKS + "); first: "
                + first);
    }

    private static List<MapPlan.LootContainer> searchCaches(
            NaturalMapPlan plan,
            Formation formation,
            SurfaceAccess world,
            ArenaChunkGenerator.MaterialCatalog materials,
            int searchRadius,
            double borderRadius) {
        Set<NaturalMapPlan.SurfaceColumn> spawnColumns = formation.spawns().stream()
                .map(NaturalMapPlan.SurfaceSpawnPoint::column)
                .collect(Collectors.toSet());
        List<MapPlan.LootContainer> chosen = new ArrayList<>(formation.caches().size());
        Set<MapPlan.Position> chosenPositions = new HashSet<>();
        List<String> failures = new ArrayList<>();
        for (NaturalMapPlan.SurfaceLootContainer container : formation.caches()) {
            Map<String, Integer> rejections = new LinkedHashMap<>();
            MapPlan.Position found = null;
            List<NaturalMapPlan.SurfaceColumn> candidates = searchCandidates(
                    container.column(), plan.footprint(), formation.center(), searchRadius, borderRadius);
            for (NaturalMapPlan.SurfaceColumn candidate : candidates) {
                String rejection = null;
                MapPlan.Position position = null;
                if (spawnColumns.contains(candidate)) {
                    rejection = "spawn-column";
                } else {
                    try {
                        position = resolveLootPosition(world, candidate);
                        validateChest(world, position, materials);
                    } catch (IllegalStateException unsafe) {
                        rejection = "unsafe-column";
                    }
                }
                if (rejection == null && hazardNear(world, position)) {
                    rejection = "hazard";
                }
                if (rejection == null && chosenPositions.contains(position)) {
                    rejection = "duplicate";
                }
                if (rejection == null) {
                    Set<MapPlan.Position> withCandidate = new HashSet<>(chosenPositions);
                    withCandidate.add(position);
                    try {
                        validateChestAccess(world, position, withCandidate, materials);
                    } catch (IllegalStateException blocked) {
                        rejection = "no-access";
                    }
                }
                if (rejection == null) {
                    found = position;
                    break;
                }
                rejections.merge(rejection, 1, Integer::sum);
            }
            if (found == null) {
                failures.add("cache declared at (" + container.column().x() + "," + container.column().z()
                        + ") examined " + candidates.size() + " candidates, rejections " + rejections);
            } else {
                chosenPositions.add(found);
                chosen.add(new MapPlan.LootContainer(found, container.inventory()));
            }
        }
        if (!failures.isEmpty()) {
            throw new IllegalStateException("natural cache search failed with recipe " + BOUNDED_SEARCH_RECIPE
                    + " for world seed " + plan.worldSeed() + ": " + String.join("; ", failures));
        }
        for (MapPlan.LootContainer container : chosen) {
            validateChestAccess(world, container.position(), chosenPositions, materials);
        }
        return chosen;
    }

    private static List<MapPlan.SpawnPoint> provisionalSpawns(NaturalMapPlan plan, SurfaceAccess world) {
        List<MapPlan.SpawnPoint> provisional = new ArrayList<>(plan.spawns().size());
        for (NaturalMapPlan.SurfaceSpawnPoint spawn : plan.spawns()) {
            provisional.add(new MapPlan.SpawnPoint(spawn.seat(), resolveSpawnPosition(world, spawn.column())));
        }
        return provisional;
    }

    private static List<MapPlan.SpawnPoint> resolveDeclaredSpawns(
            NaturalMapPlan plan,
            SurfaceAccess world,
            ArenaChunkGenerator.MaterialCatalog materials) {
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
        return resolvedSpawns;
    }

    static List<NaturalMapPlan.SurfaceColumn> searchCandidates(
            NaturalMapPlan.SurfaceColumn declared,
            WorldPlan.Footprint footprint,
            NaturalMapPlan.BorderCenter center) {
        return searchCandidates(declared, footprint, center, SEARCH_RING_RADIUS_BLOCKS, 0.0);
    }

    static List<NaturalMapPlan.SurfaceColumn> searchCandidates(
            NaturalMapPlan.SurfaceColumn declared,
            WorldPlan.Footprint footprint,
            NaturalMapPlan.BorderCenter center,
            int searchRadius,
            double borderRadius) {
        List<NaturalMapPlan.SurfaceColumn> candidates = new ArrayList<>();
        candidates.add(declared);
        for (int ring = 1; ring <= searchRadius
                && candidates.size() < SEARCH_MAX_CANDIDATES_PER_SEAT; ring++) {
            List<NaturalMapPlan.SurfaceColumn> ringColumns = new ArrayList<>();
            for (int dx = -ring; dx <= ring; dx++) {
                for (int dz = -ring; dz <= ring; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) != ring) {
                        continue;
                    }
                    long x = (long) declared.x() + dx;
                    long z = (long) declared.z() + dz;
                    if (x >= 0 && z >= 0 && x <= Integer.MAX_VALUE && z <= Integer.MAX_VALUE
                            && footprint.contains((int) x, (int) z)) {
                        ringColumns.add(new NaturalMapPlan.SurfaceColumn((int) x, (int) z));
                    }
                }
            }
            ringColumns.sort(java.util.Comparator
                    .comparingLong((NaturalMapPlan.SurfaceColumn column) -> {
                        long cx = (long) column.x() - center.x();
                        long cz = (long) column.z() - center.z();
                        return cx * cx + cz * cz;
                    })
                    .thenComparingInt(NaturalMapPlan.SurfaceColumn::x)
                    .thenComparingInt(NaturalMapPlan.SurfaceColumn::z));
            for (NaturalMapPlan.SurfaceColumn column : ringColumns) {
                if (candidates.size() >= SEARCH_MAX_CANDIDATES_PER_SEAT) {
                    break;
                }
                if (borderRadius > 0.0) {
                    double cx = column.x() + 0.5 - center.x();
                    double cz = column.z() + 0.5 - center.z();
                    if (Math.sqrt(cx * cx + cz * cz) > borderRadius - SEARCH_BORDER_INSET_BLOCKS) {
                        continue;
                    }
                }
                candidates.add(column);
            }
        }
        return candidates;
    }

    private static List<MapPlan.SpawnPoint> searchSpawns(
            NaturalMapPlan plan,
            Formation formation,
            SurfaceAccess world,
            ArenaChunkGenerator.MaterialCatalog materials,
            int searchRadius,
            double borderRadius,
            Set<NaturalMapPlan.SurfaceColumn> cacheColumns) {
        List<MapPlan.SpawnPoint> chosen = new ArrayList<>(formation.spawns().size());
        List<String> failures = new ArrayList<>();
        for (NaturalMapPlan.SurfaceSpawnPoint spawn : formation.spawns()) {
            Map<String, Integer> rejections = new LinkedHashMap<>();
            MapPlan.SpawnPoint found = null;
            MapPlan.SpawnPoint cliffFallback = null;
            List<NaturalMapPlan.SurfaceColumn> candidates = searchCandidates(spawn.column(), plan.footprint(), formation.center(), searchRadius, borderRadius);
            for (NaturalMapPlan.SurfaceColumn candidate : candidates) {
                String rejection = cacheColumns.contains(candidate) ? "cache-column" : null;
                MapPlan.Position feet = null;
                if (rejection == null) {
                    try {
                        feet = resolveSpawnPosition(world, candidate);
                    } catch (IllegalStateException outsideHeight) {
                        rejection = "outside-build-height";
                    }
                }
                if (rejection == null) {
                    rejection = spawnRejection(world, feet, materials);
                }
                if (rejection == null) {
                    for (MapPlan.SpawnPoint other : chosen) {
                        if (Math.abs((long) feet.x() - other.position().x()) < 2
                                && Math.abs((long) feet.z() - other.position().z()) < 2) {
                            rejection = "separation";
                            break;
                        }
                    }
                }
                if (rejection == null) {
                    MapPlan.SpawnPoint accepted = new MapPlan.SpawnPoint(spawn.seat(), feet);
                    if (!cliffEdge(world, feet)) {
                        found = accepted;
                        break;
                    }
                    if (cliffFallback == null) {
                        cliffFallback = accepted;
                    }
                    rejections.merge("cliff-edge", 1, Integer::sum);
                    continue;
                }
                rejections.merge(rejection, 1, Integer::sum);
            }
            if (found == null) {
                found = cliffFallback;
            }
            if (found == null) {
                failures.add("seat " + spawn.seat() + " declared at (" + spawn.column().x() + "," + spawn.column().z()
                        + ") examined " + candidates.size() + " candidates, rejections " + rejections);
            } else {
                chosen.add(found);
            }
        }
        if (!failures.isEmpty()) {
            throw new IllegalStateException("natural spawn search failed with recipe " + BOUNDED_SEARCH_RECIPE
                    + " for world seed " + plan.worldSeed() + ": " + String.join("; ", failures));
        }
        return chosen;
    }

    static boolean cliffEdge(SurfaceAccess world, MapPlan.Position feet) {
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                if (dx == 0 && dz == 0) {
                    continue;
                }
                boolean near = !world.blockAt(new MapPlan.Position(feet.x() + dx, feet.y() - 1, feet.z() + dz)).passable()
                        || !world.blockAt(new MapPlan.Position(feet.x() + dx, feet.y() - 2, feet.z() + dz)).passable();
                if (!near) {
                    return true;
                }
            }
        }
        return false;
    }

    static String spawnRejection(
            SurfaceAccess world,
            MapPlan.Position feet,
            ArenaChunkGenerator.MaterialCatalog materials) {
        if (feet.y() + 2 >= world.maxHeight()) {
            return "insufficient-headroom";
        }
        MapPlan.Position support = new MapPlan.Position(feet.x(), feet.y() - 1, feet.z());
        BlockState supportState = world.blockAt(support);
        if (!isSafeSupport(supportState, materials)) {
            return "unsafe-support";
        }
        if (!isClearStandingBlock(world.blockAt(feet))
                || !isClearStandingBlock(world.blockAt(new MapPlan.Position(feet.x(), feet.y() + 1, feet.z())))) {
            return "blocked-headroom";
        }
        if (hazardNear(world, feet)) {
            return "hazard";
        }
        int[][] steps = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
        for (int[] step : steps) {
            MapPlan.Position side = new MapPlan.Position(feet.x() + step[0], feet.y(), feet.z() + step[1]);
            MapPlan.Position sideSupport = new MapPlan.Position(side.x(), side.y() - 1, side.z());
            MapPlan.Position sideHead = new MapPlan.Position(side.x(), side.y() + 1, side.z());
            if (isSafeSupport(world.blockAt(sideSupport), materials)
                    && isClearStandingBlock(world.blockAt(side))
                    && isClearStandingBlock(world.blockAt(sideHead))) {
                return null;
            }
        }
        return "no-escape";
    }

    private static boolean hazardNear(SurfaceAccess world, MapPlan.Position center) {
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                for (int dy = -1; dy <= 1; dy++) {
                    BlockState near = world.blockAt(
                            new MapPlan.Position(center.x() + dx, center.y() + dy, center.z() + dz));
                    if (HAZARDS.contains(near.material())) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    static String worldIdentity(
            NaturalMapPlan plan,
            String recipe,
            List<MapPlan.SpawnPoint> spawns,
            List<MapPlan.LootContainer> loot) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            StringBuilder text = new StringBuilder("arena.world.identity.v1\n")
                    .append(plan.mapSemanticId()).append('\n')
                    .append(plan.worldSeed()).append('\n')
                    .append(recipe).append('\n');
            for (MapPlan.SpawnPoint spawn : spawns) {
                text.append("s:").append(spawn.seat()).append(',').append(spawn.position().x()).append(',')
                        .append(spawn.position().y()).append(',').append(spawn.position().z()).append('\n');
            }
            for (MapPlan.LootContainer container : loot) {
                text.append("c:").append(container.position().x()).append(',').append(container.position().y())
                        .append(',').append(container.position().z()).append('\n');
            }
            return HexFormat.of().formatHex(digest.digest(text.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
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
