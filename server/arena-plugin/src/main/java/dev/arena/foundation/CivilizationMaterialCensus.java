package dev.arena.foundation;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Consumer;

final class CivilizationMaterialCensus {
    static final String PROPERTY = "arena.civilization-evaluator";
    static final String MARKER_PREFIX = "ARENA_CIV_MATERIAL_V1|";
    static final int MAX_MARKERS = 256;
    static final int MAX_MARKER_BYTES = 16 * 1024;
    private static final BigInteger FIRST_SEQUENCE = BigInteger.ONE;
    private static final String OAK_LOG = "minecraft:oak_log";
    private static final String OAK_PLANKS = "minecraft:oak_planks";
    private static final Comparator<Position> POSITION_ORDER = Comparator.comparingInt(Position::x)
            .thenComparingInt(Position::y)
            .thenComparingInt(Position::z);

    private CivilizationMaterialCensus() {}

    static boolean enabledFromProperty(String value) {
        if (value == null || "false".equals(value)) {
            return false;
        }
        if ("true".equals(value)) {
            return true;
        }
        throw new IllegalArgumentException("-D" + PROPERTY + " must be true or false when configured");
    }

    record Position(int x, int y, int z) implements Comparable<Position> {
        @Override
        public int compareTo(Position other) {
            return POSITION_ORDER.compare(this, other);
        }
    }

    record StackCount(String material, int count) {
        StackCount {
            if (material == null || material.isBlank() || count <= 0) {
                throw new IllegalArgumentException("material stack requires a name and positive count");
            }
        }
    }

    record InventorySnapshot(int seat, List<StackCount> items) {
        InventorySnapshot {
            if (seat < 0 || seat > 5) {
                throw new IllegalArgumentException("material census seat must be between zero and five");
            }
            items = List.copyOf(Objects.requireNonNull(items, "inventory items"));
        }
    }

    record ItemEntitySnapshot(String entityId, List<StackCount> items) {
        ItemEntitySnapshot {
            if (entityId == null || entityId.isBlank()) {
                throw new IllegalArgumentException("material item entity requires an id");
            }
            items = List.copyOf(Objects.requireNonNull(items, "item entity items"));
        }
    }

    record ContainerSnapshot(Position position, List<StackCount> items) {
        ContainerSnapshot {
            Objects.requireNonNull(position, "container position");
            items = List.copyOf(Objects.requireNonNull(items, "container items"));
        }
    }

    record MaterialCounts(long oakLogs, long oakPlanks) {
        MaterialCounts {
            if (oakLogs < 0 || oakPlanks < 0) {
                throw new IllegalArgumentException("material census counts cannot be negative");
            }
        }

        MaterialCounts plus(MaterialCounts other) {
            Objects.requireNonNull(other, "material counts");
            return new MaterialCounts(Math.addExact(oakLogs, other.oakLogs),
                    Math.addExact(oakPlanks, other.oakPlanks));
        }
    }

    record InventoryCount(int seat, long oakLogs, long oakPlanks) {
        InventoryCount {
            if (seat < 0 || seat > 5 || oakLogs < 0 || oakPlanks < 0) {
                throw new IllegalArgumentException("invalid material inventory count");
            }
        }
    }

    record ItemEntityCount(String entityId, long oakLogs, long oakPlanks) {
        ItemEntityCount {
            if (entityId == null || entityId.isBlank() || oakLogs < 0 || oakPlanks < 0
                    || (oakLogs == 0 && oakPlanks == 0)) {
                throw new IllegalArgumentException("material item entity count must contain an oak material");
            }
        }
    }

    record ContainerCount(Position position, long oakLogs, long oakPlanks) {
        ContainerCount {
            Objects.requireNonNull(position, "container position");
            if (oakLogs < 0 || oakPlanks < 0) {
                throw new IllegalArgumentException("container material counts cannot be negative");
            }
        }
    }

    record MaterialState(
            List<Position> naturalLogPositions,
            List<InventoryCount> inventories,
            List<ItemEntityCount> itemEntities,
            List<ContainerCount> containers,
            List<Position> placedOakPlanks) {
        MaterialState {
            naturalLogPositions = sortedUniquePositions(naturalLogPositions, "natural oak log positions");
            inventories = sortedInventories(inventories);
            itemEntities = sortedUnique(itemEntities, Comparator.comparing(ItemEntityCount::entityId),
                    ItemEntityCount::entityId, "item entity id");
            containers = sortedUnique(containers, Comparator.comparing(ContainerCount::position),
                    item -> item.position().toString(), "container position");
            placedOakPlanks = sortedUniquePositions(placedOakPlanks, "placed oak plank positions");
        }

        static MaterialState sample(
                List<Position> remainingNaturalLogPositions,
                List<InventorySnapshot> inventorySnapshots,
                List<ItemEntitySnapshot> itemEntitySnapshots,
                List<ContainerSnapshot> containerSnapshots,
                List<Position> placedOakPlankPositions) {
            List<InventoryCount> inventories = new ArrayList<>(inventorySnapshots.size());
            for (InventorySnapshot inventory : inventorySnapshots) {
                MaterialCounts counts = count(inventory.items());
                inventories.add(new InventoryCount(inventory.seat(), counts.oakLogs(), counts.oakPlanks()));
            }
            List<ItemEntityCount> itemEntities = new ArrayList<>(itemEntitySnapshots.size());
            Set<String> seenEntityIds = new HashSet<>();
            for (ItemEntitySnapshot entity : itemEntitySnapshots) {
                if (!seenEntityIds.add(entity.entityId())) {
                    throw new IllegalArgumentException("duplicate item entity id " + entity.entityId());
                }
                MaterialCounts counts = count(entity.items());
                if (counts.oakLogs() > 0 || counts.oakPlanks() > 0) {
                    itemEntities.add(new ItemEntityCount(entity.entityId(), counts.oakLogs(), counts.oakPlanks()));
                }
            }
            List<ContainerCount> containers = new ArrayList<>(containerSnapshots.size());
            for (ContainerSnapshot container : containerSnapshots) {
                MaterialCounts counts = count(container.items());
                containers.add(new ContainerCount(container.position(), counts.oakLogs(), counts.oakPlanks()));
            }
            return new MaterialState(remainingNaturalLogPositions, inventories, itemEntities, containers,
                    placedOakPlankPositions);
        }
    }

    record DeathCargo(
            String runId,
            BigInteger sequence,
            BigInteger matchTick,
            int seat,
            BigInteger beforeCheckpointSequence,
            long oakLogs,
            long oakPlanks,
            long droppedOakLogs,
            long droppedOakPlanks) {
        DeathCargo {
            requireRunId(runId);
            requireSequence(sequence);
            requireMatchTick(matchTick);
            requireSequence(beforeCheckpointSequence);
            if (seat < 0 || seat > 5 || oakLogs < 0 || oakPlanks < 0
                    || droppedOakLogs < 0 || droppedOakPlanks < 0) {
                throw new IllegalArgumentException("invalid material death cargo");
            }
        }
    }

    static final class Recorder {
        private final String runId;
        private final Consumer<String> markerSink;
        private BigInteger nextSequence = FIRST_SEQUENCE;
        private BigInteger lastCheckpointSequence;
        private BigInteger pendingDeathMatchTick;
        private MaterialState lastMaterialState;
        private int markerCount;
        private RuntimeException failure;

        Recorder(String runId, Consumer<String> markerSink) {
            requireRunId(runId);
            this.runId = runId;
            this.markerSink = Objects.requireNonNull(markerSink, "material marker sink");
        }

        boolean hasInitialCheckpoint() {
            requireHealthy();
            return lastCheckpointSequence != null;
        }

        void checkpoint(BigInteger matchTick, MaterialState state) {
            requireHealthy();
            try {
                requireMatchTick(matchTick);
                Objects.requireNonNull(state, "material state");
                if (lastCheckpointSequence == null && matchTick.signum() != 0) {
                    throw new IllegalStateException("material census initial checkpoint must be at match tick zero");
                }
                if (pendingDeathMatchTick != null && !pendingDeathMatchTick.equals(matchTick)) {
                    throw new IllegalStateException("material census death requires a checkpoint at the death tick");
                }
                if (pendingDeathMatchTick == null && state.equals(lastMaterialState)) {
                    return;
                }
                BigInteger sequence = nextSequence;
                String json = checkpointJson(runId, sequence, matchTick, state);
                emit(json);
                nextSequence = nextSequence.add(BigInteger.ONE);
                lastCheckpointSequence = sequence;
                lastMaterialState = state;
                pendingDeathMatchTick = null;
            } catch (RuntimeException failedCheckpoint) {
                poison(failedCheckpoint);
                throw failedCheckpoint;
            }
        }

        void deathCargo(BigInteger matchTick, int seat, List<StackCount> inventoryItems, List<StackCount> eventDrops) {
            requireHealthy();
            try {
                requireMatchTick(matchTick);
                if (lastCheckpointSequence == null) {
                    throw new IllegalStateException("material census death cargo has no preceding checkpoint");
                }
                if (pendingDeathMatchTick != null && !pendingDeathMatchTick.equals(matchTick)) {
                    throw new IllegalStateException("material census death markers must share one pending tick");
                }
                MaterialCounts inventory = count(inventoryItems);
                MaterialCounts drops = count(eventDrops);
                BigInteger sequence = nextSequence;
                DeathCargo cargo = new DeathCargo(runId, sequence, matchTick, seat, lastCheckpointSequence,
                        inventory.oakLogs(), inventory.oakPlanks(), drops.oakLogs(), drops.oakPlanks());
                emit(deathCargoJson(cargo));
                nextSequence = nextSequence.add(BigInteger.ONE);
                pendingDeathMatchTick = matchTick;
            } catch (RuntimeException failedDeathCargo) {
                poison(failedDeathCargo);
                throw failedDeathCargo;
            }
        }

        void poison(RuntimeException cause) {
            Objects.requireNonNull(cause, "material census failure");
            if (failure == null) {
                failure = cause;
            }
        }

        private void requireHealthy() {
            if (failure != null) {
                throw failure;
            }
        }

        private void emit(String json) {
            String marker = MARKER_PREFIX + json;
            int encodedBytes = marker.getBytes(StandardCharsets.UTF_8).length;
            if (encodedBytes > MAX_MARKER_BYTES) {
                throw new IllegalStateException("civilization material census marker exceeds the byte limit");
            }
            if (markerCount == MAX_MARKERS) {
                throw new IllegalStateException("civilization material census marker count exceeds the limit");
            }
            markerSink.accept(marker);
            markerCount++;
        }
    }

    static MaterialCounts count(List<StackCount> items) {
        long oakLogs = 0;
        long oakPlanks = 0;
        for (StackCount item : Objects.requireNonNull(items, "item stacks")) {
            if (OAK_LOG.equals(item.material())) {
                oakLogs = Math.addExact(oakLogs, item.count());
            } else if (OAK_PLANKS.equals(item.material())) {
                oakPlanks = Math.addExact(oakPlanks, item.count());
            }
        }
        return new MaterialCounts(oakLogs, oakPlanks);
    }

    static void requireLoadedChunks(
            List<MapPlan.ChunkPosition> mapChunks,
            BiPredicate<Integer, Integer> isChunkLoaded) {
        Objects.requireNonNull(mapChunks, "material census map chunks");
        Objects.requireNonNull(isChunkLoaded, "chunk-loaded check");
        for (MapPlan.ChunkPosition chunk : mapChunks) {
            if (!isChunkLoaded.test(chunk.x(), chunk.z())) {
                throw new IllegalStateException("civilization material census map chunk is not loaded: "
                        + chunk.x() + "," + chunk.z());
            }
        }
    }

    static void requirePositionChunkLoaded(
            int blockX,
            int blockZ,
            BiPredicate<Integer, Integer> isChunkLoaded) {
        int chunkX = Math.floorDiv(blockX, 16);
        int chunkZ = Math.floorDiv(blockZ, 16);
        if (!Objects.requireNonNull(isChunkLoaded, "chunk-loaded check").test(chunkX, chunkZ)) {
            throw new IllegalStateException("civilization material census source chunk is not loaded: "
                    + chunkX + "," + chunkZ);
        }
    }

    private static List<InventoryCount> sortedInventories(List<InventoryCount> inventories) {
        List<InventoryCount> sorted = new ArrayList<>(Objects.requireNonNull(inventories, "inventories"));
        sorted.sort(Comparator.comparingInt(InventoryCount::seat));
        if (sorted.size() != 6) {
            throw new IllegalArgumentException("material checkpoint requires all six bound inventories");
        }
        for (int seat = 0; seat < sorted.size(); seat++) {
            if (sorted.get(seat).seat() != seat) {
                throw new IllegalArgumentException(
                        "material checkpoint inventories must contain seats zero through five once");
            }
        }
        return List.copyOf(sorted);
    }

    private static List<Position> sortedUniquePositions(List<Position> positions, String label) {
        return sortedUnique(positions, POSITION_ORDER, Position::toString, label);
    }

    private static <T> List<T> sortedUnique(
            List<T> values,
            Comparator<T> comparator,
            java.util.function.Function<T, String> display,
            String label) {
        List<T> sorted = new ArrayList<>(Objects.requireNonNull(values, label));
        sorted.sort(comparator);
        for (int index = 1; index < sorted.size(); index++) {
            if (comparator.compare(sorted.get(index - 1), sorted.get(index)) == 0) {
                throw new IllegalArgumentException("duplicate " + label + " " + display.apply(sorted.get(index)));
            }
        }
        return List.copyOf(sorted);
    }

    private static String checkpointJson(String runId, BigInteger sequence, BigInteger matchTick, MaterialState state) {
        StringBuilder json = new StringBuilder(256);
        json.append("{\"kind\":\"checkpoint\",\"run_id\":").append(quote(runId))
                .append(",\"sequence\":").append(quote(sequence.toString()))
                .append(",\"match_tick\":").append(quote(matchTick.toString()))
                .append(",\"natural_log_positions\":");
        appendPositions(json, state.naturalLogPositions());
        json.append(",\"inventories\":[");
        for (int index = 0; index < state.inventories().size(); index++) {
            if (index > 0) {
                json.append(',');
            }
            InventoryCount inventory = state.inventories().get(index);
            json.append("{\"seat\":").append(inventory.seat())
                    .append(",\"oak_logs\":").append(inventory.oakLogs())
                    .append(",\"oak_planks\":").append(inventory.oakPlanks()).append('}');
        }
        json.append("],\"item_entities\":[");
        for (int index = 0; index < state.itemEntities().size(); index++) {
            if (index > 0) {
                json.append(',');
            }
            ItemEntityCount entity = state.itemEntities().get(index);
            json.append("{\"entity_id\":").append(quote(entity.entityId()))
                    .append(",\"oak_logs\":").append(entity.oakLogs())
                    .append(",\"oak_planks\":").append(entity.oakPlanks()).append('}');
        }
        json.append("],\"containers\":[");
        for (int index = 0; index < state.containers().size(); index++) {
            if (index > 0) {
                json.append(',');
            }
            ContainerCount container = state.containers().get(index);
            json.append("{\"position\":");
            appendPosition(json, container.position());
            json.append(",\"oak_logs\":").append(container.oakLogs())
                    .append(",\"oak_planks\":").append(container.oakPlanks()).append('}');
        }
        json.append("],\"placed_oak_planks\":");
        appendPositions(json, state.placedOakPlanks());
        return json.append('}').toString();
    }

    private static String deathCargoJson(DeathCargo cargo) {
        return "{\"kind\":\"death_cargo\",\"run_id\":" + quote(cargo.runId())
                + ",\"sequence\":" + quote(cargo.sequence().toString())
                + ",\"match_tick\":" + quote(cargo.matchTick().toString())
                + ",\"seat\":" + cargo.seat()
                + ",\"cause\":\"death\",\"before_checkpoint_sequence\":"
                + quote(cargo.beforeCheckpointSequence().toString())
                + ",\"oak_logs\":" + cargo.oakLogs()
                + ",\"oak_planks\":" + cargo.oakPlanks()
                + ",\"dropped_oak_logs\":" + cargo.droppedOakLogs()
                + ",\"dropped_oak_planks\":" + cargo.droppedOakPlanks() + '}';
    }

    private static void appendPositions(StringBuilder json, List<Position> positions) {
        json.append('[');
        for (int index = 0; index < positions.size(); index++) {
            if (index > 0) {
                json.append(',');
            }
            appendPosition(json, positions.get(index));
        }
        json.append(']');
    }

    private static void appendPosition(StringBuilder json, Position position) {
        json.append("{\"x\":").append(position.x())
                .append(",\"y\":").append(position.y())
                .append(",\"z\":").append(position.z()).append('}');
    }

    private static String quote(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> escaped.append("\\\"");
                case '\\' -> escaped.append("\\\\");
                case '\b' -> escaped.append("\\b");
                case '\f' -> escaped.append("\\f");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) {
                        escaped.append("\\u");
                        String hex = Integer.toHexString(character);
                        escaped.append("0".repeat(4 - hex.length())).append(hex);
                    } else {
                        escaped.append(character);
                    }
                }
            }
        }
        return escaped.append('"').toString();
    }

    private static void requireRunId(String runId) {
        if (runId == null || runId.isBlank()) {
            throw new IllegalArgumentException("material census run id is required");
        }
    }

    private static void requireSequence(BigInteger sequence) {
        if (sequence == null || sequence.signum() <= 0) {
            throw new IllegalArgumentException("material census sequence must be positive");
        }
    }

    private static void requireMatchTick(BigInteger matchTick) {
        if (matchTick == null || matchTick.signum() < 0) {
            throw new IllegalArgumentException("material census match tick cannot be negative");
        }
    }
}
