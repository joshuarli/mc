package dev.arena.foundation;

import com.google.gson.stream.JsonReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.math.BigInteger;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

final class CheckpointRecord {
    static final int SCHEMA_VERSION = 1;
    static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    static final int MAX_EXTENSION_BYTES = 1024 * 1024;
    private static final String TRAILER_PREFIX = "#arena-checkpoint-complete v1 sha256=";

    record Elimination(int seat, ControlProtocol.EliminationCause cause, BigInteger tick) {
        Elimination {
            Objects.requireNonNull(cause, "elimination cause");
            ControlProtocol.requireSeat(seat);
            if (tick == null || tick.signum() < 0) {
                throw new IllegalArgumentException("invalid elimination tick");
            }
        }
    }

    record InventoryItem(int slot, String itemBase64) {
        InventoryItem {
            if (slot < 0 || slot > 255 || itemBase64 == null || itemBase64.isEmpty()
                    || itemBase64.length() > 65_536) {
                throw new IllegalArgumentException("invalid checkpoint inventory item");
            }
            Base64.getDecoder().decode(itemBase64);
        }
    }

    record LivingState(
            double x, double y, double z, double yaw, double pitch,
            double health, int food, double saturation, int selectedSlot, List<InventoryItem> inventory) {
        LivingState {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z) || !Double.isFinite(yaw)
                    || !Double.isFinite(pitch) || !Double.isFinite(health) || !Double.isFinite(saturation)
                    || health <= 0.0 || food < 0 || food > 20 || selectedSlot < 0 || selectedSlot > 8) {
                throw new IllegalArgumentException("invalid living seat state");
            }
            inventory = List.copyOf(Objects.requireNonNull(inventory, "inventory"));
        }
    }

    record SeatState(int seat, boolean alive, UUID uuid, String username, Optional<LivingState> living) {
        SeatState {
            ControlProtocol.requireSeat(seat);
            Objects.requireNonNull(uuid, "seat uuid");
            if (username == null || !username.matches("[A-Za-z0-9_]{1,16}")) {
                throw new IllegalArgumentException("invalid seat username");
            }
            living = Objects.requireNonNull(living, "living state");
            if (alive != living.isPresent()) {
                throw new IllegalArgumentException("living state belongs exactly to living seats");
            }
        }
    }

    record Extension(int version, byte[] payload) {
        Extension {
            if (version < 1 || payload == null || payload.length > MAX_EXTENSION_BYTES) {
                throw new IllegalArgumentException("invalid checkpoint extension");
            }
            payload = payload.clone();
        }

        @Override
        public byte[] payload() {
            return payload.clone();
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Extension extension && version == extension.version
                    && java.util.Arrays.equals(payload, extension.payload);
        }

        @Override
        public int hashCode() {
            return 31 * version + java.util.Arrays.hashCode(payload);
        }
    }

    record Stored(CheckpointRecord record, String digest, long byteLength) {}

    private final String checkpointId;
    private final String runId;
    private final int epoch;
    private final String worldIdentity;
    private final ControlProtocol.PreparePayload prepare;
    private final BigInteger matchTick;
    private final double borderDiameterBlocks;
    private final List<Elimination> eliminations;
    private final List<SeatState> seats;
    private final Optional<Extension> extension;

    CheckpointRecord(
            String checkpointId,
            String runId,
            int epoch,
            String worldIdentity,
            ControlProtocol.PreparePayload prepare,
            BigInteger matchTick,
            double borderDiameterBlocks,
            List<Elimination> eliminations,
            List<SeatState> seats,
            Optional<Extension> extension) {
        if (checkpointId == null || !checkpointId.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
                || runId == null || !runId.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
                || epoch < 0 || epoch > ControlProtocol.MAX_EPOCH
                || worldIdentity == null || !worldIdentity.matches("[0-9a-f]{64}")
                || prepare == null || prepare.rosterVersion() != ControlProtocol.RosterVersion.GENERALIZED
                || prepare.resume().isPresent()
                || matchTick == null || matchTick.signum() < 0
                || !(borderDiameterBlocks > 0.0) || !Double.isFinite(borderDiameterBlocks)) {
            throw new IllegalArgumentException("invalid checkpoint header");
        }
        this.checkpointId = checkpointId;
        this.runId = runId;
        this.epoch = epoch;
        this.worldIdentity = worldIdentity;
        this.prepare = prepare;
        this.matchTick = matchTick;
        this.borderDiameterBlocks = borderDiameterBlocks;
        this.eliminations = eliminations.stream()
                .sorted(java.util.Comparator.comparingInt(Elimination::seat)).toList();
        this.seats = List.copyOf(seats);
        this.extension = Objects.requireNonNull(extension, "extension");
        validateSeats();
    }

    private void validateSeats() {
        List<ControlProtocol.Competitor> roster = prepare.roster();
        if (seats.size() != roster.size()) {
            throw new IllegalArgumentException("checkpoint must describe every roster seat");
        }
        Set<Integer> dead = new HashSet<>();
        int previous = -1;
        for (Elimination elimination : eliminations) {
            if (elimination.seat() <= previous || elimination.seat() >= roster.size()) {
                throw new IllegalArgumentException("eliminations must be ascending roster seats");
            }
            previous = elimination.seat();
            dead.add(elimination.seat());
        }
        int living = 0;
        for (int index = 0; index < seats.size(); index++) {
            SeatState seat = seats.get(index);
            ControlProtocol.Competitor competitor = roster.get(index);
            if (seat.seat() != index || !seat.username().equals(competitor.username())
                    || !seat.uuid().equals(competitor.offlineUuid()) || seat.alive() == dead.contains(index)) {
                throw new IllegalArgumentException("seat states must match the roster identities and eliminations");
            }
            if (seat.alive()) {
                living++;
            }
        }
        if (living < 2) {
            throw new IllegalArgumentException("a checkpoint needs at least two living seats");
        }
    }

    String checkpointId() { return checkpointId; }

    String runId() { return runId; }

    int epoch() { return epoch; }

    String worldIdentity() { return worldIdentity; }

    ControlProtocol.PreparePayload prepare() { return prepare; }

    BigInteger matchTick() { return matchTick; }

    double borderDiameterBlocks() { return borderDiameterBlocks; }

    List<Elimination> eliminations() { return eliminations; }

    List<SeatState> seats() { return seats; }

    Optional<Extension> extension() { return extension; }

    Set<Integer> deadSeats() {
        Set<Integer> dead = new HashSet<>();
        eliminations.forEach(elimination -> dead.add(elimination.seat()));
        return dead;
    }

    Optional<SeatState> livingSeat(int seat) {
        return seats.stream().filter(state -> state.seat() == seat && state.alive()).findFirst();
    }

    byte[] encodeBody() throws IOException {
        Map<String, Object> root = new TreeMap<>();
        root.put("schema", SCHEMA_VERSION);
        root.put("checkpoint_id", checkpointId);
        root.put("run_id", runId);
        root.put("epoch", epoch);
        root.put("world_identity", worldIdentity);
        root.put("prepare", ControlProtocol.payloadValue(prepare));
        root.put("match_tick", matchTick.toString());
        root.put("border_diameter_blocks", borderDiameterBlocks);
        root.put("eliminations", eliminations.stream().map(elimination -> {
            Map<String, Object> value = new TreeMap<>();
            value.put("seat", elimination.seat());
            value.put("cause", elimination.cause().wireName());
            value.put("tick", elimination.tick().toString());
            return value;
        }).toList());
        root.put("seats", seats.stream().map(CheckpointRecord::seatValue).toList());
        if (extension.isPresent()) {
            Map<String, Object> value = new TreeMap<>();
            value.put("version", extension.get().version());
            value.put("payload", Base64.getEncoder().encodeToString(extension.get().payload()));
            root.put("extension", value);
        } else {
            root.put("extension", null);
        }
        byte[] body = ControlProtocol.encodeJson(canonical(root));
        if (body.length > MAX_BODY_BYTES) {
            throw new IOException("checkpoint exceeds the body size limit");
        }
        return body;
    }

    private static Map<String, Object> seatValue(SeatState seat) {
        Map<String, Object> value = new TreeMap<>();
        value.put("seat", seat.seat());
        value.put("alive", seat.alive());
        value.put("uuid", seat.uuid().toString());
        value.put("username", seat.username());
        if (seat.living().isPresent()) {
            LivingState living = seat.living().get();
            Map<String, Object> state = new TreeMap<>();
            state.put("x", living.x());
            state.put("y", living.y());
            state.put("z", living.z());
            state.put("yaw", living.yaw());
            state.put("pitch", living.pitch());
            state.put("health", living.health());
            state.put("food", living.food());
            state.put("saturation", living.saturation());
            state.put("selected_slot", living.selectedSlot());
            state.put("inventory", living.inventory().stream().map(item -> {
                Map<String, Object> entry = new TreeMap<>();
                entry.put("slot", item.slot());
                entry.put("item", item.itemBase64());
                return entry;
            }).toList());
            value.put("state", state);
        }
        return value;
    }

    @SuppressWarnings("unchecked")
    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            ((Map<String, Object>) map).forEach((key, entry) -> sorted.put(key, canonical(entry)));
            return sorted;
        }
        if (value instanceof List<?> list) {
            return list.stream().map(CheckpointRecord::canonical).toList();
        }
        return value;
    }

    static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    static byte[] withTrailer(byte[] body) {
        String trailer = "\n" + TRAILER_PREFIX + sha256Hex(body) + " bytes=" + body.length + "\n";
        byte[] trailerBytes = trailer.getBytes(StandardCharsets.US_ASCII);
        byte[] complete = new byte[body.length + trailerBytes.length];
        System.arraycopy(body, 0, complete, 0, body.length);
        System.arraycopy(trailerBytes, 0, complete, body.length, trailerBytes.length);
        return complete;
    }

    Stored write(Path target) throws IOException {
        byte[] body = encodeBody();
        Path partial = target.resolveSibling(target.getFileName() + ".partial");
        Files.deleteIfExists(partial);
        try (java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(
                partial, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            byte[] complete = withTrailer(body);
            channel.write(java.nio.ByteBuffer.wrap(complete, 0, body.length));
            channel.force(true);
            channel.write(java.nio.ByteBuffer.wrap(complete, body.length, complete.length - body.length));
            channel.force(true);
        }
        Files.move(partial, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        return new Stored(this, sha256Hex(body), body.length);
    }

    static Stored read(Path source) throws IOException {
        byte[] bytes = Files.readAllBytes(source);
        return decode(bytes);
    }

    static Stored decode(byte[] bytes) throws IOException {
        int split = lastNewlineBeforeTrailer(bytes);
        if (split < 0) {
            throw new IOException("checkpoint has no completion trailer");
        }
        byte[] body = java.util.Arrays.copyOfRange(bytes, 0, split);
        String trailer = new String(bytes, split + 1, bytes.length - split - 1, StandardCharsets.US_ASCII);
        String expected = TRAILER_PREFIX + sha256Hex(body) + " bytes=" + body.length + "\n";
        if (body.length == 0 || body.length > MAX_BODY_BYTES || !trailer.equals(expected)) {
            throw new IOException("checkpoint trailer does not match its body");
        }
        try {
            return new Stored(parse(body), sha256Hex(body), body.length);
        } catch (IllegalArgumentException invalid) {
            throw new IOException("invalid checkpoint: " + invalid.getMessage(), invalid);
        }
    }

    private static int lastNewlineBeforeTrailer(byte[] bytes) {
        int end = bytes.length - 1;
        if (end < 1 || bytes[end] != '\n') {
            return -1;
        }
        for (int index = end - 1; index >= 0; index--) {
            if (bytes[index] == '\n') {
                return index;
            }
        }
        return -1;
    }

    private static CheckpointRecord parse(byte[] body) throws IOException {
        Object value;
        try (JsonReader reader = new JsonReader(new InputStreamReader(new ByteArrayInputStream(body),
                StandardCharsets.UTF_8.newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)))) {
            reader.setLenient(false);
            value = ControlProtocol.readJsonValue(reader, 0);
            if (reader.peek() != com.google.gson.stream.JsonToken.END_DOCUMENT) {
                throw new IOException("trailing JSON after checkpoint");
            }
        } catch (IllegalStateException | NumberFormatException invalidJson) {
            throw new IOException("invalid checkpoint JSON", invalidJson);
        }
        Set<String> keys = Set.of("schema", "checkpoint_id", "run_id", "epoch", "world_identity", "prepare",
                "match_tick", "border_diameter_blocks", "eliminations", "seats", "extension");
        Map<String, Object> root = ControlProtocol.object(value, "checkpoint", keys, keys);
        ControlProtocol.readInteger(root.get("schema"), "checkpoint.schema", SCHEMA_VERSION, SCHEMA_VERSION);
        ControlProtocol.Payload prepare = ControlProtocol.readPrepare(root.get("prepare"));
        if (!(prepare instanceof ControlProtocol.PreparePayload preparePayload)) {
            throw new IOException("checkpoint prepare is invalid");
        }
        List<Elimination> eliminations = new ArrayList<>();
        List<Object> eliminationValues = ControlProtocol.array(root.get("eliminations"), "checkpoint.eliminations", 0,
                MatchController.MAX_COMPETITORS);
        for (int index = 0; index < eliminationValues.size(); index++) {
            String path = "checkpoint.eliminations[" + index + "]";
            Map<String, Object> entry = ControlProtocol.object(eliminationValues.get(index), path,
                    Set.of("seat", "cause", "tick"), Set.of("seat", "cause", "tick"));
            eliminations.add(new Elimination(
                    ControlProtocol.readInteger(entry.get("seat"), path + ".seat", 0, ControlProtocol.MAX_SEAT),
                    ControlProtocol.EliminationCause.fromWire(
                            ControlProtocol.readString(entry.get("cause"), path + ".cause", 1, 32, null), path + ".cause"),
                    ControlProtocol.readU64String(entry.get("tick"), path + ".tick", false)));
        }
        List<SeatState> seats = new ArrayList<>();
        List<Object> seatValues = ControlProtocol.array(root.get("seats"), "checkpoint.seats", 1,
                MatchController.MAX_COMPETITORS);
        for (int index = 0; index < seatValues.size(); index++) {
            seats.add(readSeat(seatValues.get(index), "checkpoint.seats[" + index + "]"));
        }
        Optional<Extension> extension = Optional.empty();
        if (root.get("extension") != null) {
            Map<String, Object> entry = ControlProtocol.object(root.get("extension"), "checkpoint.extension",
                    Set.of("version", "payload"), Set.of("version", "payload"));
            extension = Optional.of(new Extension(
                    ControlProtocol.readInteger(entry.get("version"), "checkpoint.extension.version", 1, 65_535),
                    decodeBase64(ControlProtocol.readString(entry.get("payload"), "checkpoint.extension.payload", 0,
                            2 * MAX_EXTENSION_BYTES, null))));
        }
        return new CheckpointRecord(
                ControlProtocol.readString(root.get("checkpoint_id"), "checkpoint.checkpoint_id", 1, 64, null),
                ControlProtocol.readString(root.get("run_id"), "checkpoint.run_id", 1, 64, null),
                ControlProtocol.readInteger(root.get("epoch"), "checkpoint.epoch", 0, ControlProtocol.MAX_EPOCH),
                ControlProtocol.readString(root.get("world_identity"), "checkpoint.world_identity", 64, 64, null),
                preparePayload,
                ControlProtocol.readU64String(root.get("match_tick"), "checkpoint.match_tick", false),
                ControlProtocol.readFiniteNumber(root.get("border_diameter_blocks"), "checkpoint.border_diameter_blocks"),
                eliminations, seats, extension);
    }

    private static byte[] decodeBase64(String text) {
        return Base64.getDecoder().decode(text);
    }

    private static SeatState readSeat(Object value, String path) throws IOException {
        Map<String, Object> seat = ControlProtocol.object(value, path,
                Set.of("seat", "alive", "uuid", "username", "state"), Set.of("seat", "alive", "uuid", "username"));
        boolean alive = ControlProtocol.readBoolean(seat.get("alive"), path + ".alive");
        Optional<LivingState> living = Optional.empty();
        if (seat.containsKey("state")) {
            String statePath = path + ".state";
            Set<String> keys = Set.of("x", "y", "z", "yaw", "pitch", "health", "food", "saturation",
                    "selected_slot", "inventory");
            Map<String, Object> state = ControlProtocol.object(seat.get("state"), statePath, keys, keys);
            List<Object> items = ControlProtocol.array(state.get("inventory"), statePath + ".inventory", 0, 64);
            List<InventoryItem> inventory = new ArrayList<>();
            for (int index = 0; index < items.size(); index++) {
                String itemPath = statePath + ".inventory[" + index + "]";
                Map<String, Object> item = ControlProtocol.object(items.get(index), itemPath,
                        Set.of("slot", "item"), Set.of("slot", "item"));
                inventory.add(new InventoryItem(
                        ControlProtocol.readInteger(item.get("slot"), itemPath + ".slot", 0, 255),
                        ControlProtocol.readString(item.get("item"), itemPath + ".item", 1, 65_536, null)));
            }
            living = Optional.of(new LivingState(
                    ControlProtocol.readFiniteNumber(state.get("x"), statePath + ".x"),
                    ControlProtocol.readFiniteNumber(state.get("y"), statePath + ".y"),
                    ControlProtocol.readFiniteNumber(state.get("z"), statePath + ".z"),
                    ControlProtocol.readFiniteNumber(state.get("yaw"), statePath + ".yaw"),
                    ControlProtocol.readFiniteNumber(state.get("pitch"), statePath + ".pitch"),
                    ControlProtocol.readFiniteNumber(state.get("health"), statePath + ".health"),
                    ControlProtocol.readInteger(state.get("food"), statePath + ".food", 0, 20),
                    ControlProtocol.readFiniteNumber(state.get("saturation"), statePath + ".saturation"),
                    ControlProtocol.readInteger(state.get("selected_slot"), statePath + ".selected_slot", 0, 8),
                    inventory));
        }
        String uuidText = ControlProtocol.readString(seat.get("uuid"), path + ".uuid", 36, 36,
                "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
        return new SeatState(
                ControlProtocol.readInteger(seat.get("seat"), path + ".seat", 0, ControlProtocol.MAX_SEAT),
                alive, UUID.fromString(uuidText),
                ControlProtocol.readString(seat.get("username"), path + ".username", 1, 16, null), living);
    }
}
