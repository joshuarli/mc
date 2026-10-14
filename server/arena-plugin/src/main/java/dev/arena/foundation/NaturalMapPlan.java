package dev.arena.foundation;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

final class NaturalMapPlan extends WorldPlan {
    private static final long NATURAL_FOOTPRINT_BLOCKS = 1024;
    static final int MAX_LOOT_CONTAINERS = MapPlan.MAX_LOOT_CONTAINERS;
    static final int MAX_PREPARED_CHUNKS = MapPlan.MAX_PREPARED_CHUNKS;
    static final BigInteger MAX_WORLD_SEED = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
    private static final Comparator<SurfaceSpawnPoint> SPAWN_ORDER = Comparator.comparingInt(SurfaceSpawnPoint::seat);
    private static final Comparator<SurfaceLootContainer> LOOT_ORDER = Comparator
            .comparingInt((SurfaceLootContainer loot) -> loot.column().x())
            .thenComparingInt(loot -> loot.column().z());

    record SurfaceColumn(int x, int z) {}

    record SurfaceSpawnPoint(int seat, SurfaceColumn column) {
        SurfaceSpawnPoint {
            if (seat < 0 || column == null) {
                throw new IllegalArgumentException("natural spawn requires a nonnegative seat and column");
            }
        }
    }

    record SurfaceLootContainer(SurfaceColumn column, List<String> inventory) {
        SurfaceLootContainer {
            if (column == null || inventory == null || inventory.isEmpty() || inventory.size() > MapPlan.MAX_CHEST_ITEMS
                    || inventory.stream().anyMatch(item -> !isResourceId(item))) {
                throw new IllegalArgumentException("natural loot requires a column and one to twenty-seven valid items");
            }
            inventory = List.copyOf(inventory);
        }
    }

    record ChunkPosition(int x, int z) implements Comparable<ChunkPosition> {
        @Override
        public int compareTo(ChunkPosition other) {
            int xOrder = Integer.compare(x, other.x);
            return xOrder != 0 ? xOrder : Integer.compare(z, other.z);
        }
    }

    private final String runId;
    private final BigInteger worldSeed;
    private final String mapSemanticId;
    private final Footprint footprint;
    private final List<SurfaceSpawnPoint> spawns;
    private final List<SurfaceLootContainer> lootContainers;

    NaturalMapPlan(
            String runId,
            BigInteger worldSeed,
            String mapSemanticId,
            Footprint footprint,
            Collection<SurfaceSpawnPoint> spawns,
            Collection<SurfaceLootContainer> lootContainers) {
        requireRunId(runId);
        requireSemanticId(mapSemanticId);
        if (worldSeed == null || worldSeed.signum() < 0 || worldSeed.compareTo(MAX_WORLD_SEED) > 0) {
            throw new IllegalArgumentException("world seed must be an unsigned 64-bit integer");
        }
        if (footprint == null || footprint.width() != NATURAL_FOOTPRINT_BLOCKS
                || footprint.depth() != NATURAL_FOOTPRINT_BLOCKS
                || spawns == null || lootContainers == null
                || spawns.isEmpty() || spawns.size() > MapPlan.MAX_SPAWNS
                || lootContainers.isEmpty() || lootContainers.size() > MAX_LOOT_CONTAINERS) {
            throw new IllegalArgumentException("natural map plans require a 1024 by 1024 footprint and bounded world content");
        }

        this.runId = runId;
        this.worldSeed = worldSeed;
        this.mapSemanticId = mapSemanticId;
        this.footprint = footprint;
        this.spawns = spawns.stream().sorted(SPAWN_ORDER).toList();
        this.lootContainers = lootContainers.stream().sorted(LOOT_ORDER).toList();
        validateColumns();
        validateSpawns();
        if (!mapSemanticId.equals(computeSemanticId(footprint, this.spawns, this.lootContainers))) {
            throw new IllegalArgumentException("world-plan map semantic id does not match its natural map content");
        }
    }

    @Override
    String runId() {
        return runId;
    }

    BigInteger worldSeed() {
        return worldSeed;
    }

    @Override
    String mapSemanticId() {
        return mapSemanticId;
    }

    @Override
    WorldPlan.Footprint footprint() {
        return footprint;
    }

    List<SurfaceSpawnPoint> spawns() {
        return spawns;
    }

    List<SurfaceLootContainer> lootContainers() {
        return lootContainers;
    }

    List<ChunkPosition> chunksWithViewHalo(int viewDistanceChunks) {
        if (viewDistanceChunks < 0 || viewDistanceChunks > 32) {
            throw new IllegalArgumentException("view-distance halo must be between zero and thirty-two chunks");
        }
        Set<ChunkPosition> chunks = new TreeSet<>();
        List<SurfaceColumn> anchors = new ArrayList<>(spawns.size() + lootContainers.size());
        spawns.stream().map(SurfaceSpawnPoint::column).forEach(anchors::add);
        lootContainers.stream().map(SurfaceLootContainer::column).forEach(anchors::add);
        for (SurfaceColumn anchor : anchors) {
            int centerX = MapPlan.chunkCoordinate(anchor.x());
            int centerZ = MapPlan.chunkCoordinate(anchor.z());
            for (int x = centerX - viewDistanceChunks; x <= centerX + viewDistanceChunks; x++) {
                for (int z = centerZ - viewDistanceChunks; z <= centerZ + viewDistanceChunks; z++) {
                    chunks.add(new ChunkPosition(x, z));
                    if (chunks.size() > MAX_PREPARED_CHUNKS) {
                        throw new IllegalArgumentException("natural map and view-distance halos exceed the prepared-chunk limit");
                    }
                }
            }
        }
        return List.copyOf(chunks);
    }

    static String computeSemanticId(
            Footprint footprint,
            List<SurfaceSpawnPoint> spawns,
            List<SurfaceLootContainer> lootContainers) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update("arena.map.ir.v2\0".getBytes(StandardCharsets.US_ASCII));
            updateString(digest, "vanilla");
            updateU32(digest, footprint.width());
            updateU32(digest, footprint.depth());
            List<SurfaceSpawnPoint> canonicalSpawns = spawns.stream().sorted(SPAWN_ORDER).toList();
            updateU64(digest, canonicalSpawns.size());
            for (SurfaceSpawnPoint spawn : canonicalSpawns) {
                updateU16(digest, spawn.seat());
                updateI32(digest, spawn.column().x());
                updateI32(digest, spawn.column().z());
            }
            List<SurfaceLootContainer> canonicalLoot = lootContainers.stream().sorted(LOOT_ORDER).toList();
            updateU64(digest, canonicalLoot.size());
            for (SurfaceLootContainer container : canonicalLoot) {
                updateI32(digest, container.column().x());
                updateI32(digest, container.column().z());
                updateU64(digest, container.inventory().size());
                for (String item : container.inventory()) {
                    updateString(digest, item);
                }
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private void validateColumns() {
        for (SurfaceSpawnPoint spawn : spawns) {
            if (!footprint.contains(spawn.column().x(), spawn.column().z())) {
                throw new IllegalArgumentException("natural spawn column is outside map dimensions");
            }
        }
        Set<SurfaceColumn> columns = new HashSet<>();
        for (SurfaceLootContainer container : lootContainers) {
            if (!footprint.contains(container.column().x(), container.column().z())
                    || !columns.add(container.column())) {
                throw new IllegalArgumentException("natural loot columns must be unique and inside map dimensions");
            }
        }
    }

    private void validateSpawns() {
        for (int index = 0; index < spawns.size(); index++) {
            SurfaceSpawnPoint spawn = spawns.get(index);
            if (spawn.seat() != index) {
                throw new IllegalArgumentException("natural spawn seats must be contiguous from zero");
            }
            for (int previous = 0; previous < index; previous++) {
                SurfaceColumn other = spawns.get(previous).column();
                long dx = Math.abs((long) spawn.column().x() - other.x());
                long dz = Math.abs((long) spawn.column().z() - other.z());
                if (dx < 2 && dz < 2) {
                    throw new IllegalArgumentException("natural spawn seats must be separated by at least two blocks");
                }
            }
        }
    }

    private static void requireRunId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")) {
            throw new IllegalArgumentException("run id must be one to sixty-four safe ASCII characters");
        }
    }

    private static void requireSemanticId(String value) {
        if (value == null || value.length() != 64 || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("map semantic id must be lowercase SHA-256 hex");
        }
    }

    private static boolean isResourceId(String value) {
        return value != null && value.matches("[a-z0-9_.-]+:[a-z0-9_.-]+(/[a-z0-9_.-]+)*");
    }

    private static void updateString(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        updateU64(digest, bytes.length);
        digest.update(bytes);
    }

    private static void updateU16(MessageDigest digest, int value) {
        digest.update((byte) value);
        digest.update((byte) (value >>> 8));
    }

    private static void updateI32(MessageDigest digest, int value) {
        updateU32(digest, Integer.toUnsignedLong(value));
    }

    private static void updateU32(MessageDigest digest, long value) {
        for (int byteIndex = 0; byteIndex < Integer.BYTES; byteIndex++) {
            digest.update((byte) (value >>> (byteIndex * Byte.SIZE)));
        }
    }

    private static void updateU64(MessageDigest digest, long value) {
        for (int byteIndex = 0; byteIndex < Long.BYTES; byteIndex++) {
            digest.update((byte) (value >>> (byteIndex * Byte.SIZE)));
        }
    }
}
