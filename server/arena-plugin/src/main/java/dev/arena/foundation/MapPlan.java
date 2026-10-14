package dev.arena.foundation;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

final class MapPlan extends WorldPlan {
    static final int SCHEMA_VERSION = 1;
    static final int MAX_BLOCK_PLACEMENTS = 1_000_000;
    static final int MAX_LOOT_CONTAINERS = 100_000;
    static final int MAX_PLANNED_SPAWNS = 6;
    static final int MAX_PREPARED_CHUNKS = 8_192;
    static final int MAX_CHEST_ITEMS = 27;

    record Position(int x, int y, int z) {}

    record Dimensions(long width, long depth, int minY, int maxY) {
        Dimensions {
            if (width < 1 || width > 2_147_483_648L || depth < 1 || depth > 2_147_483_648L || minY > maxY) {
                throw new IllegalArgumentException("map dimensions must be positive with ordered vertical bounds");
            }
        }

        boolean contains(Position position) {
            return position.x() >= 0 && position.x() < width
                    && position.z() >= 0 && position.z() < depth
                    && position.y() >= minY && position.y() <= maxY;
        }
    }

    record BlockPlacement(Position position, String material) {
        BlockPlacement {
            if (position == null || !isResourceId(material) || material.equals("minecraft:air")
                    || material.equals("minecraft:cave_air") || material.equals("minecraft:void_air")) {
                throw new IllegalArgumentException("block placement requires a non-air resource id and position");
            }
        }
    }

    record SpawnPoint(int seat, Position position) {
        SpawnPoint {
            if (seat < 0 || position == null) {
                throw new IllegalArgumentException("spawn requires a nonnegative seat and position");
            }
        }
    }

    record LootContainer(Position position, List<String> inventory) {
        LootContainer {
            if (position == null || inventory == null || inventory.isEmpty() || inventory.size() > MAX_CHEST_ITEMS
                    || inventory.stream().anyMatch(item -> !isResourceId(item))) {
                throw new IllegalArgumentException("loot container requires a position and one to twenty-seven valid items");
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

    private static final Comparator<BlockPlacement> BLOCK_ORDER = Comparator
            .comparingInt((BlockPlacement block) -> block.position().x())
            .thenComparingInt(block -> block.position().y())
            .thenComparingInt(block -> block.position().z());

    private static final Comparator<SpawnPoint> SPAWN_ORDER = Comparator.comparingInt(SpawnPoint::seat);
    private static final Comparator<LootContainer> LOOT_ORDER = Comparator
            .comparingInt((LootContainer container) -> container.position().x())
            .thenComparingInt(container -> container.position().y())
            .thenComparingInt(container -> container.position().z());

    private final String runId;
    private final String mapSemanticId;
    private final Dimensions dimensions;
    private final List<BlockPlacement> blocks;
    private final List<SpawnPoint> spawns;
    private final List<LootContainer> lootContainers;
    private final Map<ChunkPosition, List<BlockPlacement>> blocksByChunk;

    MapPlan(
            int schemaVersion,
            String runId,
            String mapSemanticId,
            Dimensions dimensions,
            Collection<BlockPlacement> blocks,
            Collection<SpawnPoint> spawns,
            Collection<LootContainer> lootContainers) {
        if (schemaVersion != SCHEMA_VERSION) {
            throw new IllegalArgumentException("unsupported map-plan schema version");
        }
        requireRunId(runId);
        requireSemanticId(mapSemanticId, "map");
        if (dimensions == null || blocks == null || spawns == null || lootContainers == null
                || blocks.isEmpty() || blocks.size() > MAX_BLOCK_PLACEMENTS
                || spawns.isEmpty() || spawns.size() > MAX_PLANNED_SPAWNS
                || lootContainers.isEmpty() || lootContainers.size() > MAX_LOOT_CONTAINERS) {
            throw new IllegalArgumentException("map plan is missing bounded resolved world content");
        }

        this.runId = runId;
        this.mapSemanticId = mapSemanticId;
        this.dimensions = dimensions;
        this.blocks = blocks.stream().sorted(BLOCK_ORDER).toList();
        this.spawns = spawns.stream().sorted(SPAWN_ORDER).toList();
        this.lootContainers = lootContainers.stream().sorted(LOOT_ORDER).toList();
        this.blocksByChunk = indexBlocks(this.blocks, dimensions);
        validateSpawns(this.spawns, this.blocks, dimensions);
        validateLoot(this.lootContainers, this.blocks, dimensions);
        if (!this.mapSemanticId.equals(computeSemanticId(dimensions, this.blocks, this.spawns, this.lootContainers))) {
            throw new IllegalArgumentException("world plan map semantic id does not match its resolved content");
        }
    }

    @Override
    String runId() {
        return runId;
    }

    @Override
    String mapSemanticId() {
        return mapSemanticId;
    }

    Dimensions dimensions() {
        return dimensions;
    }

    @Override
    WorldPlan.Footprint footprint() {
        return new WorldPlan.Footprint(dimensions.width(), dimensions.depth());
    }

    List<BlockPlacement> blocks() {
        return blocks;
    }

    List<SpawnPoint> spawns() {
        return spawns;
    }

    BorderCenter borderCenter() {
        if (spawns.isEmpty()) {
            throw new IllegalArgumentException("planned map border center requires a spawn");
        }
        long sumX = 0;
        long sumZ = 0;
        for (SpawnPoint spawn : spawns) {
            sumX += spawn.position().x();
            sumZ += spawn.position().z();
        }
        return new BorderCenter(
                (int) Math.floorDiv(sumX, spawns.size()),
                (int) Math.floorDiv(sumZ, spawns.size()));
    }

    record BorderCenter(int x, int z) {}

    List<LootContainer> lootContainers() {
        return lootContainers;
    }

    List<BlockPlacement> blocksForChunk(int chunkX, int chunkZ) {
        return blocksByChunk.getOrDefault(new ChunkPosition(chunkX, chunkZ), List.of());
    }

    List<ChunkPosition> chunksWithViewHalo(int viewDistanceChunks) {
        if (viewDistanceChunks < 0 || viewDistanceChunks > 32) {
            throw new IllegalArgumentException("view-distance halo must be between zero and thirty-two chunks");
        }
        long maxX = Math.floorDiv(dimensions.width() - 1, 16);
        long maxZ = Math.floorDiv(dimensions.depth() - 1, 16);
        long minHalo = -((long) viewDistanceChunks);
        long maxHaloX = (long) maxX + viewDistanceChunks;
        long maxHaloZ = (long) maxZ + viewDistanceChunks;
        long chunkCount = (maxHaloX - minHalo + 1) * (maxHaloZ - minHalo + 1);
        if (chunkCount > MAX_PREPARED_CHUNKS) {
            throw new IllegalArgumentException("map and view-distance halo exceed the prepared-chunk limit");
        }

        List<ChunkPosition> chunks = new ArrayList<>((int) chunkCount);
        for (long x = minHalo; x <= maxHaloX; x++) {
            for (long z = minHalo; z <= maxHaloZ; z++) {
                chunks.add(new ChunkPosition(Math.toIntExact(x), Math.toIntExact(z)));
            }
        }
        return List.copyOf(chunks);
    }

    static int chunkCoordinate(int blockCoordinate) {
        return Math.floorDiv(blockCoordinate, 16);
    }

    static int localCoordinate(int blockCoordinate) {
        return Math.floorMod(blockCoordinate, 16);
    }

    static String computeSemanticId(
            Dimensions dimensions,
            List<BlockPlacement> blocks,
            List<SpawnPoint> spawns,
            List<LootContainer> lootContainers) {
        List<BlockPlacement> canonicalBlocks = blocks.stream().sorted(BLOCK_ORDER).toList();
        List<SpawnPoint> canonicalSpawns = spawns.stream().sorted(SPAWN_ORDER).toList();
        List<LootContainer> canonicalLootContainers = lootContainers.stream().sorted(LOOT_ORDER).toList();
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update("arena.map.ir.v1\0".getBytes(StandardCharsets.US_ASCII));
            updateU32(digest, dimensions.width());
            updateU32(digest, dimensions.depth());
            updateI32(digest, dimensions.minY());
            updateI32(digest, dimensions.maxY());
            updateU64(digest, canonicalBlocks.size());
            for (BlockPlacement block : canonicalBlocks) {
                updatePosition(digest, block.position());
                updateString(digest, block.material());
            }
            updateU64(digest, canonicalSpawns.size());
            for (SpawnPoint spawn : canonicalSpawns) {
                updateU16(digest, spawn.seat());
                updatePosition(digest, spawn.position());
            }
            updateU64(digest, canonicalLootContainers.size());
            for (LootContainer container : canonicalLootContainers) {
                updatePosition(digest, container.position());
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

    private static Map<ChunkPosition, List<BlockPlacement>> indexBlocks(
            List<BlockPlacement> placements,
            Dimensions dimensions) {
        Map<ChunkPosition, List<BlockPlacement>> mutableIndex = new HashMap<>();
        Set<Position> positions = new HashSet<>();
        for (BlockPlacement placement : placements) {
            if (!dimensions.contains(placement.position())) {
                throw new IllegalArgumentException("block placement is outside map dimensions");
            }
            if (!positions.add(placement.position())) {
                throw new IllegalArgumentException("map plan contains duplicate block coordinates");
            }
            ChunkPosition chunk = new ChunkPosition(
                    chunkCoordinate(placement.position().x()), chunkCoordinate(placement.position().z()));
            mutableIndex.computeIfAbsent(chunk, ignored -> new ArrayList<>()).add(placement);
        }
        Map<ChunkPosition, List<BlockPlacement>> immutableIndex = new HashMap<>();
        mutableIndex.forEach((chunk, chunkBlocks) -> immutableIndex.put(chunk, List.copyOf(chunkBlocks)));
        return Map.copyOf(immutableIndex);
    }

    private static void validateSpawns(List<SpawnPoint> points, List<BlockPlacement> placements, Dimensions dimensions) {
        Map<Position, String> blockAt = new HashMap<>();
        Set<Position> spawnPositions = new HashSet<>();
        for (BlockPlacement placement : placements) {
            blockAt.put(placement.position(), placement.material());
        }
        for (int index = 0; index < points.size(); index++) {
            SpawnPoint spawn = points.get(index);
            Position feet = spawn.position();
            Position headroom = feet.y() == Integer.MAX_VALUE
                    ? feet
                    : new Position(feet.x(), feet.y() + 1, feet.z());
            if (spawn.seat() != index || !dimensions.contains(feet)
                    || feet.y() == Integer.MIN_VALUE || feet.y() == Integer.MAX_VALUE
                    || !dimensions.contains(headroom) || !spawnPositions.add(feet)
                    || !blockAt.containsKey(new Position(feet.x(), feet.y() - 1, feet.z()))
                    || blockAt.containsKey(feet)
                    || blockAt.containsKey(headroom)) {
                throw new IllegalArgumentException("spawn seats must be contiguous with support and two clear blocks");
            }
            for (int previous = 0; previous < index; previous++) {
                Position other = points.get(previous).position();
                long dx = (long) feet.x() - other.x();
                long dz = (long) feet.z() - other.z();
                if (Math.abs(dx) < 2 && Math.abs(dz) < 2) {
                    throw new IllegalArgumentException("spawn seats must be separated by at least two horizontal blocks");
                }
            }
        }
    }

    private static void validateLoot(
            List<LootContainer> containers,
            List<BlockPlacement> placements,
            Dimensions dimensions) {
        Map<Position, String> blockAt = new HashMap<>();
        for (BlockPlacement placement : placements) {
            blockAt.put(placement.position(), placement.material());
        }
        Set<Position> positions = new HashSet<>();
        for (LootContainer container : containers) {
            Position position = container.position();
            if (!dimensions.contains(position) || position.y() == Integer.MIN_VALUE) {
                throw new IllegalArgumentException("loot container must be a unique supported chest in map dimensions");
            }
            Position support = new Position(position.x(), position.y() - 1, position.z());
            if (!positions.add(position)
                    || !"minecraft:chest".equals(blockAt.get(position))
                    || !blockAt.containsKey(support)) {
                throw new IllegalArgumentException("loot container must be a unique supported chest in map dimensions");
            }
        }
    }

    private static void requireRunId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")) {
            throw new IllegalArgumentException("run id must be one to sixty-four safe ASCII characters");
        }
    }

    private static void requireSemanticId(String value, String kind) {
        if (value == null || value.length() != 64 || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException(kind + " semantic id must be lowercase SHA-256 hex");
        }
    }

    private static boolean isResourceId(String value) {
        if (value == null) {
            return false;
        }
        int separator = value.indexOf(':');
        if (separator <= 0 || separator == value.length() - 1 || value.indexOf(':', separator + 1) >= 0) {
            return false;
        }
        String namespace = value.substring(0, separator);
        String path = value.substring(separator + 1);
        return namespace.chars().allMatch(MapPlan::isNamespaceCharacter)
                && path.chars().allMatch(MapPlan::isPathCharacter)
                && !path.startsWith("/")
                && !path.endsWith("/")
                && !path.contains("//");
    }

    private static boolean isNamespaceCharacter(int character) {
        return character >= 'a' && character <= 'z'
                || character >= '0' && character <= '9'
                || character == '_' || character == '-' || character == '.';
    }

    private static boolean isPathCharacter(int character) {
        return isNamespaceCharacter(character) || character == '/';
    }

    private static void updatePosition(MessageDigest digest, Position position) {
        updateI32(digest, position.x());
        updateI32(digest, position.y());
        updateI32(digest, position.z());
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
        digest.update((byte) value);
        digest.update((byte) (value >>> 8));
        digest.update((byte) (value >>> 16));
        digest.update((byte) (value >>> 24));
    }

    private static void updateU64(MessageDigest digest, long value) {
        for (int byteIndex = 0; byteIndex < Long.BYTES; byteIndex++) {
            digest.update((byte) (value >>> (byteIndex * Byte.SIZE)));
        }
    }
}
