package dev.arena.foundation;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.math.BigInteger;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class MapPlanReader {
    static final String GENERATION_PLAN_PROPERTY = "arena.generation-plan";
    static final long MAX_PLAN_BYTES = 128L * 1024 * 1024;
    private static final Set<String> ROOT_FIELDS = Set.of(
            "schema", "run_id", "world_seed", "map_semantic_id", "terrain", "dimensions", "blocks", "spawns", "loot_containers");
    private static final Set<String> PLANNED_ROOT_FIELDS = Set.of(
            "schema", "run_id", "map_semantic_id", "dimensions", "blocks", "spawns", "loot_containers");
    private static final Set<String> NATURAL_ROOT_FIELDS = Set.of(
            "schema", "run_id", "world_seed", "map_semantic_id", "terrain", "dimensions", "blocks", "spawns", "loot_containers");
    private static final Set<String> DIMENSION_FIELDS = Set.of("width", "depth", "min_y", "max_y");
    private static final Set<String> BLOCK_FIELDS = Set.of("position", "block");
    private static final Set<String> SPAWN_FIELDS = Set.of("seat", "position", "column");
    private static final Set<String> LOOT_FIELDS = Set.of("position", "column", "inventory");
    private static final Set<String> POSITION_FIELDS = Set.of("x", "y", "z");
    private static final Set<String> COLUMN_FIELDS = Set.of("x", "z");
    private static final Set<String> PLANNED_DIMENSION_FIELDS = Set.of("width", "depth", "min_y", "max_y");
    private static final Set<String> NATURAL_DIMENSION_FIELDS = Set.of("width", "depth");
    private static final Set<String> PLANNED_SPAWN_FIELDS = Set.of("seat", "position");
    private static final Set<String> NATURAL_SPAWN_FIELDS = Set.of("seat", "column");
    private static final Set<String> PLANNED_LOOT_FIELDS = Set.of("position", "inventory");
    private static final Set<String> NATURAL_LOOT_FIELDS = Set.of("column", "inventory");

    private record DimensionsInput(long width, long depth, Integer minY, Integer maxY, Set<String> fields) {
        MapPlan.Dimensions planned() {
            if (!fields.equals(PLANNED_DIMENSION_FIELDS) || minY == null || maxY == null) {
                throw new IllegalArgumentException("planned dimensions must contain width, depth, min_y, and max_y");
            }
            return new MapPlan.Dimensions(width, depth, minY, maxY);
        }

        WorldPlan.Footprint natural() {
            if (!fields.equals(NATURAL_DIMENSION_FIELDS)) {
                throw new IllegalArgumentException("natural dimensions must contain width and depth only");
            }
            return new WorldPlan.Footprint(width, depth);
        }
    }

    private record SpawnInput(int seat, MapPlan.Position position, NaturalMapPlan.SurfaceColumn column, Set<String> fields) {}

    private record LootInput(
            MapPlan.Position position,
            NaturalMapPlan.SurfaceColumn column,
            List<String> inventory,
            Set<String> fields) {}

    private MapPlanReader() {}

    static WorldPlan readConfiguredPlan() throws IOException {
        String configuredPath = System.getProperty(GENERATION_PLAN_PROPERTY);
        if (configuredPath == null || configuredPath.isBlank()) {
            throw new IOException("missing JVM property -D" + GENERATION_PLAN_PROPERTY);
        }
        try {
            return read(Path.of(configuredPath));
        } catch (java.nio.file.InvalidPathException invalidPath) {
            throw new IOException("invalid generation-plan path", invalidPath);
        }
    }

    static WorldPlan read(Path path) throws IOException {
        return read(path, MAX_PLAN_BYTES);
    }

    static WorldPlan read(Path path, long byteLimit) throws IOException {
        if (byteLimit < 0) {
            throw new IllegalArgumentException("generation-plan byte limit cannot be negative");
        }
        if (path == null) {
            throw new IOException("generation plan must be a regular file");
        }
        BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isRegularFile()) {
            throw new IOException("generation plan must be a regular file");
        }
        try (InputStream input = Files.newInputStream(
                     path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
                InputStream bounded = new BoundedInputStream(input, byteLimit);
                Reader decoded = new InputStreamReader(bounded, StandardCharsets.UTF_8.newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT));
                JsonReader json = new JsonReader(decoded)) {
            json.setLenient(false);
            return readJson(json);
        } catch (IllegalArgumentException | IllegalStateException invalidPlan) {
            throw new IOException("invalid generation plan: " + invalidPlan.getMessage(), invalidPlan);
        }
    }

    static WorldPlan readJson(JsonReader json) throws IOException {
        expect(json, JsonToken.BEGIN_OBJECT, "world plan");
        Set<String> seen = new HashSet<>();
        int schema = -1;
        String runId = null;
        String worldSeed = null;
        String mapSemanticId = null;
        String terrain = null;
        DimensionsInput dimensions = null;
        List<MapPlan.BlockPlacement> blocks = null;
        List<SpawnInput> spawns = null;
        List<LootInput> lootContainers = null;
        json.beginObject();
        while (json.hasNext()) {
            String field = field(json, seen, ROOT_FIELDS, "world plan");
            switch (field) {
                case "schema" -> schema = integer(json, "world plan.schema");
                case "run_id" -> runId = string(json, "world plan.run_id");
                case "world_seed" -> worldSeed = string(json, "world plan.world_seed");
                case "map_semantic_id" -> mapSemanticId = string(json, "world plan.map_semantic_id");
                case "terrain" -> terrain = string(json, "world plan.terrain");
                case "dimensions" -> dimensions = readDimensions(json);
                case "blocks" -> blocks = readBlocks(json);
                case "spawns" -> spawns = readSpawnInputs(json);
                case "loot_containers" -> lootContainers = readLootInputs(json);
                default -> throw new IllegalStateException("unreachable world-plan field");
            }
        }
        json.endObject();
        WorldPlan plan = switch (schema) {
            case 1 -> readPlannedPlan(seen, runId, mapSemanticId, dimensions, blocks, spawns, lootContainers);
            case 2 -> readNaturalPlan(seen, runId, worldSeed, mapSemanticId, terrain, dimensions, blocks, spawns, lootContainers);
            default -> throw new IllegalArgumentException("unsupported world-plan schema version");
        };
        if (json.peek() != JsonToken.END_DOCUMENT) {
            throw invalid("trailing JSON after world plan");
        }
        return plan;
    }

    private static WorldPlan readPlannedPlan(
            Set<String> seen,
            String runId,
            String mapSemanticId,
            DimensionsInput dimensions,
            List<MapPlan.BlockPlacement> blocks,
            List<SpawnInput> spawns,
            List<LootInput> lootContainers) throws IOException {
        requireExactFields(seen, PLANNED_ROOT_FIELDS, "world plan");
        if (dimensions == null || blocks == null || spawns == null || lootContainers == null) {
            throw invalid("planned world plan is incomplete");
        }
        MapPlan.Dimensions plannedDimensions = dimensions.planned();
        List<MapPlan.SpawnPoint> plannedSpawns = new ArrayList<>(spawns.size());
        for (int index = 0; index < spawns.size(); index++) {
            SpawnInput spawn = spawns.get(index);
            requireExactFields(spawn.fields(), PLANNED_SPAWN_FIELDS, "spawns[]");
            if (spawn.seat() != index || spawn.position() == null) {
                throw invalid("world plan.spawns must be ordered by contiguous seat from zero");
            }
            plannedSpawns.add(new MapPlan.SpawnPoint(spawn.seat(), spawn.position()));
        }
        List<MapPlan.LootContainer> plannedLoot = new ArrayList<>(lootContainers.size());
        for (int index = 0; index < lootContainers.size(); index++) {
            LootInput loot = lootContainers.get(index);
            requireExactFields(loot.fields(), PLANNED_LOOT_FIELDS, "loot_containers[]");
            if (loot.position() == null) {
                throw invalid("planned loot container requires a position");
            }
            MapPlan.LootContainer container = new MapPlan.LootContainer(loot.position(), loot.inventory());
            if (index > 0 && compare(plannedLoot.getLast().position(), container.position()) >= 0) {
                throw invalid("world plan.loot_containers must be uniquely ordered by x, y, z");
            }
            plannedLoot.add(container);
        }
        return new MapPlan(1, runId, mapSemanticId, plannedDimensions, blocks, plannedSpawns, plannedLoot);
    }

    private static WorldPlan readNaturalPlan(
            Set<String> seen,
            String runId,
            String worldSeed,
            String mapSemanticId,
            String terrain,
            DimensionsInput dimensions,
            List<MapPlan.BlockPlacement> blocks,
            List<SpawnInput> spawns,
            List<LootInput> lootContainers) throws IOException {
        requireExactFields(seen, NATURAL_ROOT_FIELDS, "world plan");
        if (dimensions == null || blocks == null || spawns == null || lootContainers == null) {
            throw invalid("natural world plan is incomplete");
        }
        if (!"vanilla".equals(terrain)) {
            throw invalid("natural world plan terrain must be vanilla");
        }
        if (!blocks.isEmpty()) {
            throw invalid("natural world plan blocks must be empty");
        }
        WorldPlan.Footprint footprint = dimensions.natural();
        BigInteger seed = parseWorldSeed(worldSeed);
        List<NaturalMapPlan.SurfaceSpawnPoint> naturalSpawns = new ArrayList<>(spawns.size());
        for (int index = 0; index < spawns.size(); index++) {
            SpawnInput spawn = spawns.get(index);
            requireExactFields(spawn.fields(), NATURAL_SPAWN_FIELDS, "spawns[]");
            if (spawn.seat() != index || spawn.column() == null) {
                throw invalid("natural world-plan spawns must be ordered by contiguous seat from zero");
            }
            naturalSpawns.add(new NaturalMapPlan.SurfaceSpawnPoint(spawn.seat(), spawn.column()));
        }
        List<NaturalMapPlan.SurfaceLootContainer> naturalLoot = new ArrayList<>(lootContainers.size());
        for (int index = 0; index < lootContainers.size(); index++) {
            LootInput loot = lootContainers.get(index);
            requireExactFields(loot.fields(), NATURAL_LOOT_FIELDS, "loot_containers[]");
            if (loot.column() == null) {
                throw invalid("natural loot container requires a column");
            }
            NaturalMapPlan.SurfaceLootContainer container =
                    new NaturalMapPlan.SurfaceLootContainer(loot.column(), loot.inventory());
            if (index > 0 && compare(naturalLoot.getLast().column(), container.column()) >= 0) {
                throw invalid("natural world-plan loot containers must be uniquely ordered by x, z");
            }
            naturalLoot.add(container);
        }
        return new NaturalMapPlan(runId, seed, mapSemanticId, footprint, naturalSpawns, naturalLoot);
    }

    private static BigInteger parseWorldSeed(String value) throws IOException {
        if (value == null || !value.matches("0|[1-9][0-9]{0,19}")) {
            throw invalid("world plan.world_seed must be a canonical unsigned decimal string");
        }
        BigInteger seed = new BigInteger(value);
        if (seed.compareTo(NaturalMapPlan.MAX_WORLD_SEED) > 0) {
            throw invalid("world plan.world_seed is outside the unsigned 64-bit range");
        }
        return seed;
    }

    private static DimensionsInput readDimensions(JsonReader json) throws IOException {
        expect(json, JsonToken.BEGIN_OBJECT, "world plan.dimensions");
        Set<String> seen = new HashSet<>();
        long width = -1;
        long depth = -1;
        Integer minY = null;
        Integer maxY = null;
        json.beginObject();
        while (json.hasNext()) {
            String field = field(json, seen, DIMENSION_FIELDS, "dimensions");
            switch (field) {
                case "width" -> width = longInteger(json, "dimensions.width");
                case "depth" -> depth = longInteger(json, "dimensions.depth");
                case "min_y" -> minY = integer(json, "dimensions.min_y");
                case "max_y" -> maxY = integer(json, "dimensions.max_y");
                default -> throw new IllegalStateException("unreachable dimensions field");
            }
        }
        json.endObject();
        if (!seen.contains("width") || !seen.contains("depth")) {
            throw invalid("world plan.dimensions is missing width or depth");
        }
        return new DimensionsInput(width, depth, minY, maxY, Set.copyOf(seen));
    }

    private static List<MapPlan.BlockPlacement> readBlocks(JsonReader json) throws IOException {
        expect(json, JsonToken.BEGIN_ARRAY, "world plan.blocks");
        List<MapPlan.BlockPlacement> blocks = new ArrayList<>();
        json.beginArray();
        while (json.hasNext()) {
            if (blocks.size() == MapPlan.MAX_BLOCK_PLACEMENTS) {
                throw invalid("world plan.blocks exceeds the block-placement limit");
            }
            expect(json, JsonToken.BEGIN_OBJECT, "blocks[]");
            Set<String> seen = new HashSet<>();
            MapPlan.Position position = null;
            String block = null;
            json.beginObject();
            while (json.hasNext()) {
                String field = field(json, seen, BLOCK_FIELDS, "blocks[]");
                switch (field) {
                    case "position" -> position = readPosition(json, "blocks[].position");
                    case "block" -> block = string(json, "blocks[].block");
                    default -> throw new IllegalStateException("unreachable block field");
                }
            }
            json.endObject();
            requireFields(seen, BLOCK_FIELDS, "blocks[]");
            MapPlan.BlockPlacement placement = new MapPlan.BlockPlacement(position, block);
            if (!blocks.isEmpty() && compare(blocks.getLast().position(), position) >= 0) {
                throw invalid("world plan.blocks must be uniquely ordered by x, y, z");
            }
            blocks.add(placement);
        }
        json.endArray();
        return List.copyOf(blocks);
    }

    private static List<SpawnInput> readSpawnInputs(JsonReader json) throws IOException {
        expect(json, JsonToken.BEGIN_ARRAY, "world plan.spawns");
        List<SpawnInput> spawns = new ArrayList<>();
        json.beginArray();
        while (json.hasNext()) {
            if (spawns.size() == MapPlan.MAX_SPAWNS) {
                throw invalid("world plan.spawns exceeds six seats");
            }
            expect(json, JsonToken.BEGIN_OBJECT, "spawns[]");
            Set<String> seen = new HashSet<>();
            int seat = -1;
            MapPlan.Position position = null;
            NaturalMapPlan.SurfaceColumn column = null;
            json.beginObject();
            while (json.hasNext()) {
                String field = field(json, seen, SPAWN_FIELDS, "spawns[]");
                switch (field) {
                    case "seat" -> seat = integer(json, "spawns[].seat");
                    case "position" -> position = readPosition(json, "spawns[].position");
                    case "column" -> column = readColumn(json, "spawns[].column");
                    default -> throw new IllegalStateException("unreachable spawn field");
                }
            }
            json.endObject();
            spawns.add(new SpawnInput(seat, position, column, Set.copyOf(seen)));
        }
        json.endArray();
        return List.copyOf(spawns);
    }

    private static List<LootInput> readLootInputs(JsonReader json) throws IOException {
        expect(json, JsonToken.BEGIN_ARRAY, "world plan.loot_containers");
        List<LootInput> containers = new ArrayList<>();
        json.beginArray();
        while (json.hasNext()) {
            if (containers.size() == NaturalMapPlan.MAX_LOOT_CONTAINERS) {
                throw invalid("world plan.loot_containers exceeds the container limit");
            }
            expect(json, JsonToken.BEGIN_OBJECT, "loot_containers[]");
            Set<String> seen = new HashSet<>();
            MapPlan.Position position = null;
            NaturalMapPlan.SurfaceColumn column = null;
            List<String> inventory = null;
            json.beginObject();
            while (json.hasNext()) {
                String field = field(json, seen, LOOT_FIELDS, "loot_containers[]");
                switch (field) {
                    case "position" -> position = readPosition(json, "loot_containers[].position");
                    case "column" -> column = readColumn(json, "loot_containers[].column");
                    case "inventory" -> inventory = readInventory(json);
                    default -> throw new IllegalStateException("unreachable loot field");
                }
            }
            json.endObject();
            containers.add(new LootInput(position, column, inventory, Set.copyOf(seen)));
        }
        json.endArray();
        return List.copyOf(containers);
    }

    private static NaturalMapPlan.SurfaceColumn readColumn(JsonReader json, String path) throws IOException {
        expect(json, JsonToken.BEGIN_OBJECT, path);
        Set<String> seen = new HashSet<>();
        int x = 0;
        int z = 0;
        json.beginObject();
        while (json.hasNext()) {
            String field = field(json, seen, COLUMN_FIELDS, path);
            switch (field) {
                case "x" -> x = integer(json, path + ".x");
                case "z" -> z = integer(json, path + ".z");
                default -> throw new IllegalStateException("unreachable column field");
            }
        }
        json.endObject();
        requireExactFields(seen, COLUMN_FIELDS, path);
        if (x < 0 || z < 0) {
            throw invalid(path + " coordinates must be nonnegative");
        }
        return new NaturalMapPlan.SurfaceColumn(x, z);
    }

    private static MapPlan.Position readPosition(JsonReader json, String path) throws IOException {
        expect(json, JsonToken.BEGIN_OBJECT, path);
        Set<String> seen = new HashSet<>();
        int x = 0;
        int y = 0;
        int z = 0;
        json.beginObject();
        while (json.hasNext()) {
            String field = field(json, seen, POSITION_FIELDS, path);
            switch (field) {
                case "x" -> x = integer(json, path + ".x");
                case "y" -> y = integer(json, path + ".y");
                case "z" -> z = integer(json, path + ".z");
                default -> throw new IllegalStateException("unreachable position field");
            }
        }
        json.endObject();
        requireFields(seen, Set.of("x", "y", "z"), path);
        return new MapPlan.Position(x, y, z);
    }

    private static List<String> readInventory(JsonReader json) throws IOException {
        expect(json, JsonToken.BEGIN_ARRAY, "loot inventory");
        List<String> inventory = new ArrayList<>();
        json.beginArray();
        while (json.hasNext()) {
            if (inventory.size() == 27) {
                throw invalid("loot inventory exceeds twenty-seven one-item entries");
            }
            inventory.add(string(json, "loot inventory[]"));
        }
        json.endArray();
        return List.copyOf(inventory);
    }

    private static String field(JsonReader json, Set<String> seen, Set<String> allowed, String path)
            throws IOException {
        String name = json.nextName();
        if (!seen.add(name)) {
            throw invalid(path + " contains duplicate JSON key " + name);
        }
        if (!allowed.contains(name)) {
            throw invalid(path + " contains unknown JSON key " + name);
        }
        return name;
    }

    private static String string(JsonReader json, String path) throws IOException {
        expect(json, JsonToken.STRING, path);
        return json.nextString();
    }

    private static int integer(JsonReader json, String path) throws IOException {
        long value = longInteger(json, path);
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw invalid(path + " is outside the signed 32-bit range");
        }
        return (int) value;
    }

    private static long longInteger(JsonReader json, String path) throws IOException {
        expect(json, JsonToken.NUMBER, path);
        return json.nextLong();
    }

    private static int compare(MapPlan.Position left, MapPlan.Position right) {
        int xOrder = Integer.compare(left.x(), right.x());
        if (xOrder != 0) {
            return xOrder;
        }
        int yOrder = Integer.compare(left.y(), right.y());
        return yOrder != 0 ? yOrder : Integer.compare(left.z(), right.z());
    }

    private static int compare(NaturalMapPlan.SurfaceColumn left, NaturalMapPlan.SurfaceColumn right) {
        int xOrder = Integer.compare(left.x(), right.x());
        return xOrder != 0 ? xOrder : Integer.compare(left.z(), right.z());
    }

    private static void expect(JsonReader json, JsonToken token, String path) throws IOException {
        if (json.peek() != token) {
            throw invalid(path + " must be " + token.name().toLowerCase(Locale.ROOT));
        }
    }

    private static void requireFields(Set<String> seen, Set<String> required, String path) throws IOException {
        if (!seen.containsAll(required)) {
            Set<String> missing = new HashSet<>(required);
            missing.removeAll(seen);
            throw invalid(path + " is missing required JSON keys " + missing);
        }
    }

    private static void requireExactFields(Set<String> seen, Set<String> expected, String path) throws IOException {
        if (!seen.equals(expected)) {
            Set<String> missing = new HashSet<>(expected);
            missing.removeAll(seen);
            Set<String> extra = new HashSet<>(seen);
            extra.removeAll(expected);
            throw invalid(path + " has an invalid field set; missing=" + missing + ", extra=" + extra);
        }
    }

    private static IOException invalid(String message) {
        return new IOException(message);
    }

    private static final class BoundedInputStream extends FilterInputStream {
        private final long limit;
        private long bytesRead;

        BoundedInputStream(InputStream input, long limit) {
            super(input);
            this.limit = limit;
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value != -1) {
                account(1);
            }
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int count = in.read(buffer, offset, length);
            if (count > 0) {
                account(count);
            }
            return count;
        }

        private void account(int count) throws IOException {
            bytesRead += count;
            if (bytesRead > limit) {
                throw new IOException("generation plan exceeds the input byte limit");
            }
        }
    }
}
