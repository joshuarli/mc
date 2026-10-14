package dev.arena.foundation;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.JsonWriter;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

final class ControlProtocol {
    static final int VERSION = 1;
    static final int MAX_FRAME_BYTES = 1_048_576;
    static final BigInteger MAX_U64 = new BigInteger("18446744073709551615");
    private static final long MAX_SAFE_INTEGER_LONG = 9_007_199_254_740_991L;
    private static final BigInteger MAX_SAFE_INTEGER = BigInteger.valueOf(MAX_SAFE_INTEGER_LONG);
    private static final String RUN_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
    private static final String SEMANTIC_ID_PATTERN = "[0-9a-f]{64}";
    private static final String PARTICIPANT_PATTERN = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
    private static final String USERNAME_PATTERN = "[A-Za-z0-9_]{1,16}";
    private static final String TOKEN_PATTERN = "[A-Za-z0-9_-]+";

    private ControlProtocol() {}

    enum Type {
        HELLO("hello"),
        READY("ready"),
        HEARTBEAT("heartbeat"),
        BUILD_PROGRESS("build_progress"),
        PREPARE("prepare"),
        START("start"),
        ABORT("abort"),
        PUBLIC_CLOCK("public_clock"),
        PUBLIC_STATE("public_state"),
        ELIMINATION("elimination"),
        CIVILIZATION_STATE("civilization_state"),
        OUTCOME("outcome"),
        METRICS("metrics"),
        ACK("ack"),
        ERROR("error");

        private final String wireName;

        Type(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static Type fromWire(String value) throws IOException {
            for (Type type : values()) {
                if (type.wireName.equals(value)) {
                    return type;
                }
            }
            throw invalid("type", "unknown control message type");
        }
    }

    enum Capability {
        HUNGER_GAMES_V1("hunger_games_v1"),
        CIVILIZATION_V1("civilization_v1");

        static final List<Capability> SUPPORTED = List.of(HUNGER_GAMES_V1, CIVILIZATION_V1);

        private final String wireName;

        Capability(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static Capability fromWire(String value, String path) throws IOException {
            for (Capability capability : values()) {
                if (capability.wireName.equals(value)) {
                    return capability;
                }
            }
            throw invalid(path, "unsupported control capability");
        }
    }

    enum AbortReason {
        OPERATOR("operator"),
        LEASE_LOST("lease_lost"),
        INVALID_WORLD("invalid_world"),
        PROTOCOL_ERROR("protocol_error"),
        RUNTIME_TIMEOUT("runtime_timeout");

        private final String wireName;

        AbortReason(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static AbortReason fromWire(String value, String path) throws IOException {
            for (AbortReason reason : values()) {
                if (reason.wireName.equals(value)) {
                    return reason;
                }
            }
            throw invalid(path, "unknown abort reason");
        }
    }

    enum ErrorCode {
        AUTHENTICATION_FAILED("authentication_failed"),
        UNSUPPORTED_CAPABILITY("unsupported_capability"),
        INVALID_COMMAND("invalid_command"),
        INVALID_STATE("invalid_state"),
        INVALID_WORLD("invalid_world"),
        INTERNAL("internal");

        private final String wireName;

        ErrorCode(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static ErrorCode fromWire(String value, String path) throws IOException {
            for (ErrorCode code : values()) {
                if (code.wireName.equals(value)) {
                    return code;
                }
            }
            throw invalid(path, "unknown control error code");
        }
    }

    enum Phase {
        WAITING("waiting"),
        COUNTDOWN("countdown"),
        GRACE("grace"),
        ACTIVE("active"),
        FINISHED("finished"),
        ABORTED("aborted");

        private final String wireName;

        Phase(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static Phase fromWire(String value, String path) throws IOException {
            for (Phase phase : values()) {
                if (phase.wireName.equals(value)) {
                    return phase;
                }
            }
            throw invalid(path, "unknown public phase");
        }
    }

    enum TickDomain {
        COUNTDOWN("countdown"),
        MATCH("match");

        private final String wireName;

        TickDomain(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static TickDomain fromWire(String value, String path) throws IOException {
            for (TickDomain domain : values()) {
                if (domain.wireName.equals(value)) {
                    return domain;
                }
            }
            throw invalid(path, "tick domain must be countdown or match");
        }
    }

    enum DrawReason {
        NO_SURVIVORS("no_survivors"),
        TICK_LIMIT("tick_limit");

        private final String wireName;

        DrawReason(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static DrawReason fromWire(String value, String path) throws IOException {
            for (DrawReason reason : values()) {
                if (reason.wireName.equals(value)) {
                    return reason;
                }
            }
            throw invalid(path, "unknown draw reason");
        }
    }

    enum EliminationCause {
        DEATH("death"),
        DISCONNECT("disconnect");

        private final String wireName;

        EliminationCause(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static EliminationCause fromWire(String value, String path) throws IOException {
            for (EliminationCause cause : values()) {
                if (cause.wireName.equals(value)) {
                    return cause;
                }
            }
            throw invalid(path, "unknown elimination cause");
        }
    }

    enum FactionId {
        EMBER("ember"),
        TIDE("tide");

        private final String wireName;

        FactionId(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        FactionId opponent() {
            return this == EMBER ? TIDE : EMBER;
        }

        static FactionId forSeat(int seat) {
            if (seat < 0 || seat >= 6) {
                throw new IllegalArgumentException("civilization seat is out of range");
            }
            return seat < 3 ? EMBER : TIDE;
        }

        static FactionId fromWire(String value, String path) throws IOException {
            for (FactionId faction : values()) {
                if (faction.wireName.equals(value)) {
                    return faction;
                }
            }
            throw invalid(path, "unknown civilization faction id");
        }
    }

    enum CivilizationRole {
        GATHERER_CRAFTER("gatherer_crafter"),
        BUILDER("builder"),
        DEFENDER_SCOUT("defender_scout");

        private final String wireName;

        CivilizationRole(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static CivilizationRole fromWire(String value, String path) throws IOException {
            for (CivilizationRole role : values()) {
                if (role.wireName.equals(value)) {
                    return role;
                }
            }
            throw invalid(path, "unknown civilization role");
        }
    }

    record Header(String runId, BigInteger sequence, Optional<BigInteger> correlation) {
        Header {
            require(Objects.requireNonNull(runId, "run id").matches(RUN_ID_PATTERN), "invalid control run id");
            require(isPositiveU64(Objects.requireNonNull(sequence, "sequence")), "invalid control sequence");
            correlation = Objects.requireNonNull(correlation, "correlation");
            correlation.ifPresent(value -> require(isPositiveU64(value), "invalid control correlation"));
        }
    }

    sealed interface Payload permits EmptyPayload, HelloPayload, ReadyPayload, BuildProgressPayload,
            PreparePayload, AbortPayload, ClockPayload, PublicStatePayload, EliminationPayload,
            CivilizationStatePayload, Outcome, MetricsPayload, ErrorPayload {}

    record EmptyPayload() implements Payload {}

    record HelloPayload(String token, List<Capability> capabilities) implements Payload {
        HelloPayload {
            require(token != null && token.matches(TOKEN_PATTERN) && token.length() <= 256, "invalid hello token");
            capabilities = distinctList(capabilities, "hello capabilities");
            require(!capabilities.isEmpty(), "hello must announce capabilities");
        }
    }

    record ServerIdentity(String name, String version, String minecraftVersion, int protocolVersion) {
        ServerIdentity {
            require(text(name, 1, 128), "invalid server name");
            require(text(version, 1, 128), "invalid server version");
            require(text(minecraftVersion, 1, 64), "invalid Minecraft version");
            require(protocolVersion >= 0, "invalid protocol version");
        }
    }

    record PluginIdentity(String name, String version) {
        PluginIdentity {
            require(text(name, 1, 128), "invalid plugin name");
            require(text(version, 1, 128), "invalid plugin version");
        }
    }

    record ReadyPayload(ServerIdentity server, PluginIdentity plugin, List<Capability> capabilities) implements Payload {
        ReadyPayload {
            Objects.requireNonNull(server, "server identity");
            Objects.requireNonNull(plugin, "plugin identity");
            capabilities = distinctList(capabilities, "ready capabilities");
            require(!capabilities.isEmpty(), "ready must announce capabilities");
        }
    }

    record BuildProgressPayload(String stage, int completed, int total) implements Payload {
        BuildProgressPayload {
            require(Set.of("validating", "preparing_world", "snapshotting").contains(stage), "invalid build stage");
            require(completed >= 0 && total >= 0 && completed <= total, "invalid build progress");
        }
    }

    record BotCompetitor(int seat, String participantId, String username, UUID offlineUuid) {
        BotCompetitor {
            require(seat >= 0 && seat <= 5, "bot seat is out of range");
            require(participantId != null && participantId.matches(PARTICIPANT_PATTERN), "invalid participant id");
            require(username != null && username.matches(USERNAME_PATTERN), "invalid bot username");
            Objects.requireNonNull(offlineUuid, "bot offline UUID");
        }
    }

    record MatchSettings(
            BigInteger countdownTicks,
            BigInteger graceTicks,
            BigInteger authoritativeMaxTicks,
            boolean respawn,
            boolean blockBreaking,
            boolean blockPlacing,
            boolean naturalMobs,
            boolean naturalRandomTicks) {
        MatchSettings {
            require(isU64(countdownTicks) && isU64(graceTicks) && isPositiveU64(authoritativeMaxTicks),
                    "invalid match tick settings");
            require(graceTicks.compareTo(authoritativeMaxTicks) < 0, "grace must end before the tick limit");
        }
    }

    record BorderSettings(
            double initialDiameterBlocks,
            BigInteger shrinkStartTick,
            BigInteger shrinkEndTick,
            double finalDiameterBlocks) {
        BorderSettings {
            require(Double.isFinite(initialDiameterBlocks) && initialDiameterBlocks > 0.0
                            && Double.isFinite(finalDiameterBlocks) && finalDiameterBlocks > 0.0
                            && finalDiameterBlocks < initialDiameterBlocks,
                    "invalid border diameters");
            require(isU64(shrinkStartTick) && isU64(shrinkEndTick), "invalid border ticks");
            require(shrinkEndTick.compareTo(shrinkStartTick) > 0, "border must shrink over a positive interval");
        }
    }

    record FixedBorderSettings(int diameterBlocks) {
        FixedBorderSettings {
            require(diameterBlocks == 192, "civilization requires a fixed 192-block border");
        }
    }

    sealed interface PrepareSettings permits HungerGamesPrepareSettings, CivilizationPrepareSettings {
        MatchSettings match();

        double initialBorderDiameterBlocks();

        String modeName();
    }

    record HungerGamesPrepareSettings(MatchSettings match, BorderSettings border) implements PrepareSettings {
        HungerGamesPrepareSettings {
            Objects.requireNonNull(match, "Hunger Games match settings");
            Objects.requireNonNull(border, "Hunger Games border settings");
            require(border.shrinkStartTick().compareTo(match.graceTicks()) >= 0,
                    "border cannot shrink before grace ends");
            require(border.shrinkEndTick().compareTo(match.authoritativeMaxTicks()) < 0,
                    "border must finish before the tick limit");
        }

        @Override
        public double initialBorderDiameterBlocks() {
            return border.initialDiameterBlocks();
        }

        @Override
        public String modeName() {
            return "hunger_games";
        }
    }

    record CivilizationPrepareSettings(
            MatchSettings match,
            FixedBorderSettings border,
            CivilizationSettings civilization) implements PrepareSettings {
        CivilizationPrepareSettings {
            Objects.requireNonNull(match, "civilization match settings");
            Objects.requireNonNull(border, "civilization border settings");
            Objects.requireNonNull(civilization, "civilization scenario settings");
            require(match.graceTicks().equals(BigInteger.valueOf(2_400))
                            && match.authoritativeMaxTicks().equals(BigInteger.valueOf(18_000))
                            && !match.respawn() && match.blockBreaking() && match.blockPlacing(),
                    "civilization requires its fixed match rules");
        }

        @Override
        public double initialBorderDiameterBlocks() {
            return border.diameterBlocks();
        }

        @Override
        public String modeName() {
            return "civilization";
        }
    }

    record BlockPosition(long x, long y, long z) {
        BlockPosition {
            require(x >= 0 && x <= MAX_SAFE_INTEGER_LONG
                            && y >= -MAX_SAFE_INTEGER_LONG && y <= MAX_SAFE_INTEGER_LONG
                            && z >= 0 && z <= MAX_SAFE_INTEGER_LONG,
                    "civilization block position must use nonnegative X/Z and safe-integer coordinates");
        }
    }

    record FactionMember(int seat, CivilizationRole role) {
        FactionMember {
            require(seat >= 0 && seat <= 5, "civilization faction seat is out of range");
            Objects.requireNonNull(role, "civilization role");
        }
    }

    record FactionDefinition(FactionId id, List<FactionMember> members) {
        FactionDefinition {
            Objects.requireNonNull(id, "civilization faction id");
            members = List.copyOf(Objects.requireNonNull(members, "civilization faction members"));
            List<FactionMember> expected = id == FactionId.EMBER
                    ? List.of(new FactionMember(0, CivilizationRole.GATHERER_CRAFTER),
                            new FactionMember(1, CivilizationRole.BUILDER),
                            new FactionMember(2, CivilizationRole.DEFENDER_SCOUT))
                    : List.of(new FactionMember(3, CivilizationRole.GATHERER_CRAFTER),
                            new FactionMember(4, CivilizationRole.BUILDER),
                            new FactionMember(5, CivilizationRole.DEFENDER_SCOUT));
            require(members.equals(expected), "civilization faction membership must match the fixed six-seat roster");
        }
    }

    enum StartingItem {
        BREAD("minecraft:bread", 4),
        WOODEN_AXE("minecraft:wooden_axe", 1),
        WOODEN_PICKAXE("minecraft:wooden_pickaxe", 1),
        WOODEN_SWORD("minecraft:wooden_sword", 1);

        private final String resourceId;
        private final int count;

        StartingItem(String resourceId, int count) {
            this.resourceId = resourceId;
            this.count = count;
        }

        String resourceId() {
            return resourceId;
        }

        int count() {
            return count;
        }

        static StartingItem fromWire(String item, int count, String path) throws IOException {
            for (StartingItem startingItem : values()) {
                if (startingItem.resourceId.equals(item) && startingItem.count == count) {
                    return startingItem;
                }
            }
            throw invalid(path, "civilization starting kit differs from the canonical finite-food kit");
        }
    }

    record CaptureZone(BlockPosition min, BlockPosition max, int uncontestedTicks, int scorePointsPerTick) {
        CaptureZone {
            Objects.requireNonNull(min, "capture-zone minimum");
            Objects.requireNonNull(max, "capture-zone maximum");
            require(min.x() <= max.x() && min.y() <= max.y() && min.z() <= max.z(),
                    "capture-zone minimum must not exceed its maximum");
            require(uncontestedTicks == 200 && scorePointsPerTick == 1,
                    "civilization capture requires 200 uncontested ticks and one point per owned end tick");
        }
    }

    record BlueprintAnchor(BlockPosition position, int rotationDegrees) {
        BlueprintAnchor {
            Objects.requireNonNull(position, "outpost blueprint anchor");
            require(rotationDegrees == 0 || rotationDegrees == 180, "outpost anchor rotation must be 0 or 180 degrees");
        }
    }

    record OutpostBlueprint(String id, Map<FactionId, BlueprintAnchor> anchors) {
        OutpostBlueprint {
            require("oak-outpost-v1".equals(id), "unsupported civilization outpost blueprint");
            anchors = Map.copyOf(Objects.requireNonNull(anchors, "outpost blueprint anchors"));
            require(anchors.size() == 2
                            && anchors.get(FactionId.EMBER) != null && anchors.get(FactionId.EMBER).rotationDegrees() == 0
                            && anchors.get(FactionId.TIDE) != null && anchors.get(FactionId.TIDE).rotationDegrees() == 180,
                    "outpost anchors must match the faction rotations");
        }
    }

    record CivilizationSettings(
            List<FactionDefinition> factions,
            List<StartingItem> startingKit,
            CaptureZone captureZone,
            OutpostBlueprint blueprint) {
        CivilizationSettings {
            factions = List.copyOf(Objects.requireNonNull(factions, "civilization factions"));
            startingKit = List.copyOf(Objects.requireNonNull(startingKit, "civilization starting kit"));
            require(factions.size() == 2 && factions.get(0).id() == FactionId.EMBER
                            && factions.get(1).id() == FactionId.TIDE,
                    "civilization factions must be ordered Ember then Tide with three fixed roles each");
            require(startingKit.equals(List.of(StartingItem.BREAD, StartingItem.WOODEN_AXE,
                            StartingItem.WOODEN_PICKAXE, StartingItem.WOODEN_SWORD)),
                    "civilization starting kit differs from the canonical finite-food kit");
            Objects.requireNonNull(captureZone, "civilization capture zone");
            Objects.requireNonNull(blueprint, "civilization outpost blueprint");
        }
    }

    record PreparePayload(
            String mapSemanticId,
            String scenarioSemanticId,
            BigInteger seed,
            PrepareSettings settings,
            List<BotCompetitor> roster) implements Payload {
        PreparePayload {
            require(mapSemanticId != null && mapSemanticId.matches(SEMANTIC_ID_PATTERN), "invalid map semantic id");
            require(scenarioSemanticId != null && scenarioSemanticId.matches(SEMANTIC_ID_PATTERN),
                    "invalid scenario semantic id");
            require(isU64(seed), "invalid prepare seed");
            Objects.requireNonNull(settings, "prepare settings");
            roster = List.copyOf(Objects.requireNonNull(roster, "roster"));
            validateRoster(roster);
            require(!(settings instanceof CivilizationPrepareSettings) || roster.size() == 6,
                    "civilization requires exactly six bot competitors");
        }

        String mode() {
            return settings.modeName();
        }

        MatchSettings match() {
            return settings.match();
        }

        double initialBorderDiameterBlocks() {
            return settings.initialBorderDiameterBlocks();
        }
    }

    record AbortPayload(AbortReason reason) implements Payload {
        AbortPayload {
            Objects.requireNonNull(reason, "abort reason");
        }
    }

    record Tick(TickDomain domain, BigInteger value) {
        Tick {
            Objects.requireNonNull(domain, "tick domain");
            require(isU64(value), "invalid authoritative tick");
        }
    }

    record ClockPayload(Phase phase, Optional<Tick> tick, double borderDiameterBlocks) implements Payload {
        ClockPayload {
            Objects.requireNonNull(phase, "phase");
            tick = Objects.requireNonNull(tick, "tick");
            require(Double.isFinite(borderDiameterBlocks) && borderDiameterBlocks > 0.0, "invalid border diameter");
            require((phase == Phase.WAITING && tick.isEmpty())
                            || (phase == Phase.COUNTDOWN && tick.map(Tick::domain).orElse(null) == TickDomain.COUNTDOWN)
                            || ((phase == Phase.GRACE || phase == Phase.ACTIVE)
                                    && tick.map(Tick::domain).orElse(null) == TickDomain.MATCH)
                            || (phase == Phase.FINISHED && tick.isPresent())
                            || phase == Phase.ABORTED,
                    "tick domain does not match phase");
        }
    }

    record PublicStatePayload(Tick at, List<Integer> aliveSeats) implements Payload {
        PublicStatePayload {
            Objects.requireNonNull(at, "public state tick");
            aliveSeats = orderedSeats(aliveSeats, "alive seats");
        }
    }

    record Elimination(int seat, EliminationCause cause) {
        Elimination {
            require(seat >= 0 && seat <= 5, "elimination seat is out of range");
            Objects.requireNonNull(cause, "elimination cause");
        }
    }

    record EliminationPayload(Tick at, List<Elimination> eliminations) implements Payload {
        EliminationPayload {
            Objects.requireNonNull(at, "elimination tick");
            eliminations = List.copyOf(Objects.requireNonNull(eliminations, "eliminations"));
            require(!eliminations.isEmpty() && eliminations.size() <= 6, "invalid elimination count");
            int previousSeat = -1;
            for (Elimination elimination : eliminations) {
                Objects.requireNonNull(elimination, "elimination");
                require(elimination.seat() > previousSeat, "eliminations must be seat ordered and unique");
                previousSeat = elimination.seat();
            }
        }
    }

    record FactionScores(BigInteger emberPoints, BigInteger tidePoints) {
        FactionScores {
            require(isU64(emberPoints) && isU64(tidePoints), "civilization scores must be unsigned 64-bit values");
        }

        BigInteger points(FactionId faction) {
            Objects.requireNonNull(faction, "score faction");
            return faction == FactionId.EMBER ? emberPoints : tidePoints;
        }
    }

    record CivilizationStatePayload(
            Tick at,
            List<Integer> occupants,
            Optional<FactionId> ownerFaction,
            Optional<FactionId> challengerFaction,
            BigInteger captureProgressTicks,
            FactionScores scores) implements Payload {
        CivilizationStatePayload {
            Objects.requireNonNull(at, "civilization-state tick");
            require(at.domain() == TickDomain.MATCH, "civilization state requires a match tick");
            occupants = orderedSeats(occupants, "capture-zone occupants");
            ownerFaction = Objects.requireNonNull(ownerFaction, "capture owner");
            challengerFaction = Objects.requireNonNull(challengerFaction, "capture challenger");
            require(ownerFaction.isEmpty() || !ownerFaction.equals(challengerFaction),
                    "capture challenger must differ from the current owner");
            require(isU64(captureProgressTicks), "capture progress must be an unsigned 64-bit value");
            Objects.requireNonNull(scores, "civilization scores");
        }
    }

    enum FactionWinnerReason {
        ELIMINATION("elimination"),
        TICK_LIMIT("tick_limit");

        private final String wireName;

        FactionWinnerReason(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }

        static FactionWinnerReason fromWire(String value, String path) throws IOException {
            for (FactionWinnerReason reason : values()) {
                if (reason.wireName.equals(value)) {
                    return reason;
                }
            }
            throw invalid(path, "faction winner reason must be elimination or tick_limit");
        }
    }

    sealed interface Outcome extends Payload permits WinnerOutcome, FactionWinnerOutcome,
            DrawOutcome, CivilizationDrawOutcome, AbortOutcome {
        List<Integer> survivors();

        Optional<Tick> at();
    }

    record WinnerOutcome(int winnerSeat, List<Integer> survivors, Tick tick) implements Outcome {
        WinnerOutcome {
            require(winnerSeat >= 0 && winnerSeat <= 5, "winner seat is out of range");
            survivors = orderedSeats(survivors, "winner survivors");
            require(survivors.equals(List.of(winnerSeat)), "winner must be its sole survivor");
            Objects.requireNonNull(tick, "winner tick");
        }

        @Override
        public Optional<Tick> at() {
            return Optional.of(tick);
        }
    }

    record FactionWinnerOutcome(
            FactionId winnerFaction,
            FactionWinnerReason reason,
            FactionScores scores,
            List<Integer> survivors,
            Tick tick) implements Outcome {
        FactionWinnerOutcome {
            Objects.requireNonNull(winnerFaction, "winning faction");
            Objects.requireNonNull(reason, "faction winner reason");
            Objects.requireNonNull(scores, "faction scores");
            survivors = orderedSeats(survivors, "faction winner survivors");
            Objects.requireNonNull(tick, "faction winner tick");
            require(tick.domain() == TickDomain.MATCH, "faction winner requires an authoritative match tick");
            boolean hasEmber = survivors.stream().anyMatch(seat -> FactionId.forSeat(seat) == FactionId.EMBER);
            boolean hasTide = survivors.stream().anyMatch(seat -> FactionId.forSeat(seat) == FactionId.TIDE);
            require(reason != FactionWinnerReason.ELIMINATION
                            || (!survivors.isEmpty() && survivors.stream()
                                    .allMatch(seat -> FactionId.forSeat(seat) == winnerFaction)),
                    "elimination winner survivors must belong to the winning faction");
            require(reason != FactionWinnerReason.TICK_LIMIT || (hasEmber && hasTide
                            && scores.points(winnerFaction).compareTo(scores.points(winnerFaction.opponent())) > 0),
                    "tick-limit winner requires both factions and a strictly higher score");
        }

        @Override
        public Optional<Tick> at() {
            return Optional.of(tick);
        }
    }

    record DrawOutcome(DrawReason reason, List<Integer> survivors, Tick tick) implements Outcome {
        DrawOutcome {
            Objects.requireNonNull(reason, "draw reason");
            survivors = orderedSeats(survivors, "draw survivors");
            Objects.requireNonNull(tick, "draw tick");
            require((reason == DrawReason.NO_SURVIVORS && survivors.isEmpty())
                            || (reason == DrawReason.TICK_LIMIT && survivors.size() >= 2),
                    "draw survivors do not match reason");
        }

        @Override
        public Optional<Tick> at() {
            return Optional.of(tick);
        }
    }

    record CivilizationDrawOutcome(
            DrawReason reason,
            FactionScores scores,
            List<Integer> survivors,
            Tick tick) implements Outcome {
        CivilizationDrawOutcome {
            Objects.requireNonNull(reason, "civilization draw reason");
            Objects.requireNonNull(scores, "faction scores");
            survivors = orderedSeats(survivors, "civilization draw survivors");
            Objects.requireNonNull(tick, "civilization draw tick");
            boolean hasEmber = survivors.stream().anyMatch(seat -> FactionId.forSeat(seat) == FactionId.EMBER);
            boolean hasTide = survivors.stream().anyMatch(seat -> FactionId.forSeat(seat) == FactionId.TIDE);
            require(tick.domain() == TickDomain.MATCH
                            && ((reason == DrawReason.NO_SURVIVORS && survivors.isEmpty())
                                    || (reason == DrawReason.TICK_LIMIT && survivors.size() >= 2 && hasEmber && hasTide
                                            && scores.emberPoints().equals(scores.tidePoints()))),
                    "civilization draw survivors, tick, and scores do not match its reason");
        }

        @Override
        public Optional<Tick> at() {
            return Optional.of(tick);
        }
    }

    record AbortOutcome(AbortReason reason, List<Integer> survivors, Optional<Tick> tick) implements Outcome {
        AbortOutcome {
            Objects.requireNonNull(reason, "abort reason");
            survivors = orderedSeats(survivors, "abort survivors");
            tick = Objects.requireNonNull(tick, "abort tick");
        }

        @Override
        public Optional<Tick> at() {
            return tick;
        }
    }

    record MetricsPayload(long serverTickDurationMicros, int criticalQueueDepth, int droppedOptionalMetrics)
            implements Payload {
        MetricsPayload {
            require(serverTickDurationMicros >= 0 && criticalQueueDepth >= 0 && droppedOptionalMetrics >= 0,
                    "invalid control metrics");
        }
    }

    record ErrorPayload(ErrorCode code, String message) implements Payload {
        ErrorPayload {
            Objects.requireNonNull(code, "error code");
            require(text(message, 1, 1024), "invalid control error message");
        }
    }

    record Envelope(Header header, Type type, Payload payload) {
        Envelope {
            Objects.requireNonNull(header, "control header");
            Objects.requireNonNull(type, "control type");
            Objects.requireNonNull(payload, "control payload");
            require(payloadMatches(type, payload), "control type and payload do not match");
            require((type != Type.ACK && type != Type.READY) || header.correlation().isPresent(),
                    "ack and ready require response correlation");
        }
    }

    static Envelope decodeBody(byte[] body) throws IOException {
        if (body.length == 0 || body.length > MAX_FRAME_BYTES) {
            throw invalid("frame", "control frame body is empty or exceeds one MiB");
        }
        Object value;
        try (JsonReader reader = new JsonReader(new InputStreamReader(new ByteArrayInputStream(body),
                StandardCharsets.UTF_8.newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)))) {
            reader.setLenient(false);
            value = readJsonValue(reader, 0);
            if (reader.peek() != JsonToken.END_DOCUMENT) {
                throw invalid("frame", "trailing JSON after control message");
            }
        } catch (IllegalStateException | NumberFormatException invalidJson) {
            throw new IOException("invalid control JSON", invalidJson);
        }
        try {
            return readEnvelope(value);
        } catch (IllegalArgumentException invalidMessage) {
            throw new IOException("invalid control message", invalidMessage);
        }
    }

    static byte[] encodeFrame(Envelope envelope) throws IOException {
        Objects.requireNonNull(envelope, "control envelope");
        Map<String, Object> root = object(
                "protocol", VERSION,
                "run_id", envelope.header().runId(),
                "sequence", envelope.header().sequence().toString(),
                "type", envelope.type().wireName(),
                "payload", payloadValue(envelope.payload()));
        envelope.header().correlation().ifPresent(value -> root.put("correlation", value.toString()));
        byte[] body = encodeJson(root);
        if (body.length == 0 || body.length > MAX_FRAME_BYTES) {
            throw invalid("frame", "control message exceeds the one MiB frame limit");
        }
        ByteBuffer frame = ByteBuffer.allocate(body.length + Integer.BYTES).order(ByteOrder.BIG_ENDIAN);
        frame.putInt(body.length);
        frame.put(body);
        return frame.array();
    }

    private static Envelope readEnvelope(Object value) throws IOException {
        Map<String, Object> root = object(value, "envelope",
                Set.of("protocol", "run_id", "sequence", "correlation", "type", "payload"),
                Set.of("protocol", "run_id", "sequence", "type", "payload"));
        if (readInteger(root.get("protocol"), "protocol", 1, 1) != VERSION) {
            throw invalid("protocol", "unsupported control protocol version");
        }
        String runId = readString(root.get("run_id"), "run_id", 1, 64, RUN_ID_PATTERN);
        BigInteger sequence = readU64String(root.get("sequence"), "sequence", true);
        Optional<BigInteger> correlation = root.containsKey("correlation")
                ? Optional.of(readU64String(root.get("correlation"), "correlation", true))
                : Optional.empty();
        Type type = Type.fromWire(readString(root.get("type"), "type", 1, 64, null));
        Object payloadValue = root.get("payload");
        Payload payload = switch (type) {
            case HELLO -> readHello(payloadValue);
            case READY -> readReady(payloadValue);
            case HEARTBEAT, START, ACK -> readEmpty(payloadValue);
            case BUILD_PROGRESS -> readBuildProgress(payloadValue);
            case PREPARE -> readPrepare(payloadValue);
            case ABORT -> readAbort(payloadValue);
            case PUBLIC_CLOCK -> readClock(payloadValue);
            case PUBLIC_STATE -> readPublicState(payloadValue);
            case ELIMINATION -> readElimination(payloadValue);
            case CIVILIZATION_STATE -> readCivilizationState(payloadValue);
            case OUTCOME -> readOutcome(payloadValue);
            case METRICS -> readMetrics(payloadValue);
            case ERROR -> readError(payloadValue);
        };
        return new Envelope(new Header(runId, sequence, correlation), type, payload);
    }

    private static Payload readHello(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("token", "capabilities"), Set.of("token", "capabilities"));
        return new HelloPayload(readString(payload.get("token"), "payload.token", 1, 256, TOKEN_PATTERN),
                readCapabilities(payload.get("capabilities"), "payload.capabilities"));
    }

    private static Payload readReady(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("server", "plugin", "capabilities"),
                Set.of("server", "plugin", "capabilities"));
        Map<String, Object> server = object(payload.get("server"), "payload.server",
                Set.of("name", "version", "minecraft_version", "protocol_version"),
                Set.of("name", "version", "minecraft_version", "protocol_version"));
        Map<String, Object> plugin = object(payload.get("plugin"), "payload.plugin",
                Set.of("name", "version"), Set.of("name", "version"));
        return new ReadyPayload(
                new ServerIdentity(
                        readString(server.get("name"), "payload.server.name", 1, 128, null),
                        readString(server.get("version"), "payload.server.version", 1, 128, null),
                        readString(server.get("minecraft_version"), "payload.server.minecraft_version", 1, 64, null),
                        readInteger(server.get("protocol_version"), "payload.server.protocol_version", 0, Integer.MAX_VALUE)),
                new PluginIdentity(
                        readString(plugin.get("name"), "payload.plugin.name", 1, 128, null),
                        readString(plugin.get("version"), "payload.plugin.version", 1, 128, null)),
                readCapabilities(payload.get("capabilities"), "payload.capabilities"));
    }

    private static Payload readBuildProgress(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("stage", "completed", "total"),
                Set.of("stage", "completed", "total"));
        return new BuildProgressPayload(
                readString(payload.get("stage"), "payload.stage", 1, 64, null),
                readInteger(payload.get("completed"), "payload.completed", 0, Integer.MAX_VALUE),
                readInteger(payload.get("total"), "payload.total", 0, Integer.MAX_VALUE));
    }

    private static Payload readPrepare(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload",
                Set.of("map_semantic_id", "scenario_semantic_id", "seed", "mode", "settings", "roster"),
                Set.of("map_semantic_id", "scenario_semantic_id", "seed", "mode", "settings", "roster"));
        String mode = readString(payload.get("mode"), "payload.mode", 1, 64, null);
        List<BotCompetitor> roster = readRoster(payload.get("roster"));
        PrepareSettings settings = switch (mode) {
            case "hunger_games" -> readHungerGamesPrepareSettings(payload.get("settings"));
            case "civilization" -> {
                if (roster.size() != 6) {
                    throw invalid("payload.roster", "civilization requires exactly six bot competitors");
                }
                yield readCivilizationPrepareSettings(payload.get("settings"));
            }
            default -> throw invalid("payload.mode", "mode is unsupported by control-v1");
        };
        return new PreparePayload(
                readString(payload.get("map_semantic_id"), "payload.map_semantic_id", 64, 64, SEMANTIC_ID_PATTERN),
                readString(payload.get("scenario_semantic_id"), "payload.scenario_semantic_id", 64, 64, SEMANTIC_ID_PATTERN),
                readU64String(payload.get("seed"), "payload.seed", false),
                settings,
                roster);
    }

    private static HungerGamesPrepareSettings readHungerGamesPrepareSettings(Object value) throws IOException {
        Map<String, Object> settings = object(value, "payload.settings",
                Set.of("match", "border"), Set.of("match", "border"));
        return new HungerGamesPrepareSettings(readMatchSettings(settings.get("match")),
                readBorderSettings(settings.get("border")));
    }

    private static CivilizationPrepareSettings readCivilizationPrepareSettings(Object value) throws IOException {
        Map<String, Object> settings = object(value, "payload.settings",
                Set.of("match", "border", "civilization"), Set.of("match", "border", "civilization"));
        return new CivilizationPrepareSettings(readMatchSettings(settings.get("match")),
                readFixedBorderSettings(settings.get("border")), readCivilizationSettings(settings.get("civilization")));
    }

    private static MatchSettings readMatchSettings(Object value) throws IOException {
        String path = "payload.settings.match";
        Map<String, Object> match = object(value, path,
                Set.of("countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking",
                        "block_placing", "natural_mobs", "natural_random_ticks"),
                Set.of("countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking",
                        "block_placing", "natural_mobs", "natural_random_ticks"));
        return new MatchSettings(
                readU64String(match.get("countdown_ticks"), path + ".countdown_ticks", false),
                readU64String(match.get("grace_ticks"), path + ".grace_ticks", false),
                readU64String(match.get("authoritative_max_ticks"), path + ".authoritative_max_ticks", true),
                readBoolean(match.get("respawn"), path + ".respawn"),
                readBoolean(match.get("block_breaking"), path + ".block_breaking"),
                readBoolean(match.get("block_placing"), path + ".block_placing"),
                readBoolean(match.get("natural_mobs"), path + ".natural_mobs"),
                readBoolean(match.get("natural_random_ticks"), path + ".natural_random_ticks"));
    }

    private static BorderSettings readBorderSettings(Object value) throws IOException {
        String path = "payload.settings.border";
        Map<String, Object> border = object(value, path,
                Set.of("initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"),
                Set.of("initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"));
        return new BorderSettings(
                readFiniteNumber(border.get("initial_diameter_blocks"), path + ".initial_diameter_blocks"),
                readU64String(border.get("shrink_start_tick"), path + ".shrink_start_tick", false),
                readU64String(border.get("shrink_end_tick"), path + ".shrink_end_tick", false),
                readFiniteNumber(border.get("final_diameter_blocks"), path + ".final_diameter_blocks"));
    }

    private static FixedBorderSettings readFixedBorderSettings(Object value) throws IOException {
        String path = "payload.settings.border";
        Map<String, Object> border = object(value, path, Set.of("kind", "diameter_blocks"),
                Set.of("kind", "diameter_blocks"));
        if (!"fixed".equals(readString(border.get("kind"), path + ".kind", 1, 16, null))) {
            throw invalid(path + ".kind", "civilization requires a fixed border");
        }
        return new FixedBorderSettings(readInteger(border.get("diameter_blocks"), path + ".diameter_blocks", 192, 192));
    }

    private static CivilizationSettings readCivilizationSettings(Object value) throws IOException {
        String path = "payload.settings.civilization";
        Map<String, Object> civilization = object(value, path,
                Set.of("factions", "starting_kit", "capture_zone", "blueprint"),
                Set.of("factions", "starting_kit", "capture_zone", "blueprint"));
        return new CivilizationSettings(readFactions(civilization.get("factions"), path + ".factions"),
                readStartingKit(civilization.get("starting_kit"), path + ".starting_kit"),
                readCaptureZone(civilization.get("capture_zone"), path + ".capture_zone"),
                readOutpostBlueprint(civilization.get("blueprint"), path + ".blueprint"));
    }

    private static List<FactionDefinition> readFactions(Object value, String path) throws IOException {
        List<Object> factions = array(value, path, 2, 2);
        List<FactionDefinition> result = new ArrayList<>(factions.size());
        for (int index = 0; index < factions.size(); index++) {
            String factionPath = path + "[" + index + "]";
            Map<String, Object> faction = object(factions.get(index), factionPath,
                    Set.of("id", "members"), Set.of("id", "members"));
            FactionId id = FactionId.fromWire(readString(faction.get("id"), factionPath + ".id", 1, 16, null),
                    factionPath + ".id");
            List<Object> members = array(faction.get("members"), factionPath + ".members", 3, 3);
            List<FactionMember> parsedMembers = new ArrayList<>(members.size());
            for (int memberIndex = 0; memberIndex < members.size(); memberIndex++) {
                String memberPath = factionPath + ".members[" + memberIndex + "]";
                Map<String, Object> member = object(members.get(memberIndex), memberPath,
                        Set.of("seat", "role"), Set.of("seat", "role"));
                parsedMembers.add(new FactionMember(
                        readInteger(member.get("seat"), memberPath + ".seat", 0, 5),
                        CivilizationRole.fromWire(readString(member.get("role"), memberPath + ".role", 1, 32, null),
                                memberPath + ".role")));
            }
            result.add(new FactionDefinition(id, parsedMembers));
        }
        return List.copyOf(result);
    }

    private static List<StartingItem> readStartingKit(Object value, String path) throws IOException {
        List<Object> entries = array(value, path, 4, 4);
        List<StartingItem> kit = new ArrayList<>(entries.size());
        for (int index = 0; index < entries.size(); index++) {
            String itemPath = path + "[" + index + "]";
            Map<String, Object> entry = object(entries.get(index), itemPath,
                    Set.of("item", "count"), Set.of("item", "count"));
            String item = readString(entry.get("item"), itemPath + ".item", 1, 128, null);
            int count = readInteger(entry.get("count"), itemPath + ".count", 1, 64);
            kit.add(StartingItem.fromWire(item, count, itemPath));
        }
        return List.copyOf(kit);
    }

    private static CaptureZone readCaptureZone(Object value, String path) throws IOException {
        Map<String, Object> zone = object(value, path,
                Set.of("min", "max", "uncontested_ticks", "score_points_per_tick"),
                Set.of("min", "max", "uncontested_ticks", "score_points_per_tick"));
        return new CaptureZone(readBlockPosition(zone.get("min"), path + ".min"),
                readBlockPosition(zone.get("max"), path + ".max"),
                readInteger(zone.get("uncontested_ticks"), path + ".uncontested_ticks", 200, 200),
                readInteger(zone.get("score_points_per_tick"), path + ".score_points_per_tick", 1, 1));
    }

    private static OutpostBlueprint readOutpostBlueprint(Object value, String path) throws IOException {
        Map<String, Object> blueprint = object(value, path, Set.of("id", "anchors"), Set.of("id", "anchors"));
        String id = readString(blueprint.get("id"), path + ".id", 1, 64, null);
        Map<String, Object> anchors = object(blueprint.get("anchors"), path + ".anchors",
                Set.of("ember", "tide"), Set.of("ember", "tide"));
        return new OutpostBlueprint(id, Map.of(
                FactionId.EMBER, readBlueprintAnchor(anchors.get("ember"), path + ".anchors.ember", 0),
                FactionId.TIDE, readBlueprintAnchor(anchors.get("tide"), path + ".anchors.tide", 180)));
    }

    private static BlueprintAnchor readBlueprintAnchor(Object value, String path, int expectedRotation)
            throws IOException {
        Map<String, Object> anchor = object(value, path,
                Set.of("position", "rotation_degrees"), Set.of("position", "rotation_degrees"));
        int rotation = readInteger(anchor.get("rotation_degrees"), path + ".rotation_degrees", expectedRotation,
                expectedRotation);
        return new BlueprintAnchor(readBlockPosition(anchor.get("position"), path + ".position"), rotation);
    }

    private static BlockPosition readBlockPosition(Object value, String path) throws IOException {
        Map<String, Object> position = object(value, path, Set.of("x", "y", "z"), Set.of("x", "y", "z"));
        return new BlockPosition(readIntegerLong(position.get("x"), path + ".x", 0, MAX_SAFE_INTEGER_LONG),
                readIntegerLong(position.get("y"), path + ".y", -MAX_SAFE_INTEGER_LONG, MAX_SAFE_INTEGER_LONG),
                readIntegerLong(position.get("z"), path + ".z", 0, MAX_SAFE_INTEGER_LONG));
    }

    private static List<BotCompetitor> readRoster(Object value) throws IOException {
        List<Object> entries = array(value, "payload.roster", 1, 6);
        List<BotCompetitor> roster = new ArrayList<>(entries.size());
        for (int index = 0; index < entries.size(); index++) {
            String path = "payload.roster[" + index + "]";
            Map<String, Object> member = object(entries.get(index), path,
                    Set.of("kind", "seat", "participant_id", "username", "offline_uuid"),
                    Set.of("kind", "seat", "participant_id", "username", "offline_uuid"));
            String kind = readString(member.get("kind"), path + ".kind", 1, 16, null);
            int seat = readInteger(member.get("seat"), path + ".seat", 0, 5);
            String participantId = readString(member.get("participant_id"), path + ".participant_id", 1, 128,
                    PARTICIPANT_PATTERN);
            if (seat != index) {
                throw invalid(path + ".seat", "roster seats must be ordered and contiguous from zero");
            }
            if (!"bot".equals(kind)) {
                throw invalid(path + ".kind", "all roster members must be bots");
            }
            String username = readString(member.get("username"), path + ".username", 1, 16, USERNAME_PATTERN);
            String uuidText = readString(member.get("offline_uuid"), path + ".offline_uuid", 36, 36,
                    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
            UUID uuid;
            try {
                uuid = UUID.fromString(uuidText);
            } catch (IllegalArgumentException invalidUuid) {
                throw invalid(path + ".offline_uuid", "invalid offline UUID");
            }
            roster.add(new BotCompetitor(seat, participantId, username, uuid));
        }
        validateRoster(roster);
        return List.copyOf(roster);
    }

    private static Payload readAbort(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("reason"), Set.of("reason"));
        return new AbortPayload(AbortReason.fromWire(readString(payload.get("reason"), "payload.reason", 1, 64, null),
                "payload.reason"));
    }

    private static Payload readClock(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload",
                Set.of("phase", "tick", "border_diameter_blocks"), Set.of("phase", "tick", "border_diameter_blocks"));
        Phase phase = Phase.fromWire(readString(payload.get("phase"), "payload.phase", 1, 32, null), "payload.phase");
        Optional<Tick> tick = payload.get("tick") == null ? Optional.empty() : Optional.of(readTick(payload.get("tick"), "payload.tick"));
        return new ClockPayload(phase, tick, readFiniteNumber(payload.get("border_diameter_blocks"),
                "payload.border_diameter_blocks"));
    }

    private static Payload readPublicState(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("at", "alive_seats"), Set.of("at", "alive_seats"));
        return new PublicStatePayload(readTick(payload.get("at"), "payload.at"),
                readSeatList(payload.get("alive_seats"), "payload.alive_seats"));
    }

    private static Payload readElimination(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("at", "eliminations"), Set.of("at", "eliminations"));
        List<Object> values = array(payload.get("eliminations"), "payload.eliminations", 1, 6);
        List<Elimination> eliminations = new ArrayList<>(values.size());
        for (int index = 0; index < values.size(); index++) {
            String path = "payload.eliminations[" + index + "]";
            Map<String, Object> elimination = object(values.get(index), path,
                    Set.of("seat", "cause"), Set.of("seat", "cause"));
            eliminations.add(new Elimination(
                    readInteger(elimination.get("seat"), path + ".seat", 0, 5),
                    EliminationCause.fromWire(readString(elimination.get("cause"), path + ".cause", 1, 32, null),
                            path + ".cause")));
        }
        return new EliminationPayload(readTick(payload.get("at"), "payload.at"), eliminations);
    }

    private static Payload readCivilizationState(Object value) throws IOException {
        String path = "payload";
        Map<String, Object> payload = object(value, path,
                Set.of("at", "occupants", "owner_faction", "challenger_faction", "capture_progress_ticks", "scores"),
                Set.of("at", "occupants", "owner_faction", "challenger_faction", "capture_progress_ticks", "scores"));
        Optional<FactionId> owner = readNullableFaction(payload.get("owner_faction"), path + ".owner_faction");
        Optional<FactionId> challenger = readNullableFaction(payload.get("challenger_faction"), path + ".challenger_faction");
        return new CivilizationStatePayload(readTick(payload.get("at"), path + ".at"),
                readSeatList(payload.get("occupants"), path + ".occupants"), owner, challenger,
                readU64String(payload.get("capture_progress_ticks"), path + ".capture_progress_ticks", false),
                readFactionScores(payload.get("scores"), path + ".scores"));
    }

    private static Optional<FactionId> readNullableFaction(Object value, String path) throws IOException {
        return value == null ? Optional.empty()
                : Optional.of(FactionId.fromWire(readString(value, path, 1, 16, null), path));
    }

    private static FactionScores readFactionScores(Object value, String path) throws IOException {
        List<Object> scores = array(value, path, 2, 2);
        String firstPath = path + "[0]";
        String secondPath = path + "[1]";
        Map<String, Object> ember = object(scores.get(0), firstPath,
                Set.of("faction_id", "points"), Set.of("faction_id", "points"));
        Map<String, Object> tide = object(scores.get(1), secondPath,
                Set.of("faction_id", "points"), Set.of("faction_id", "points"));
        if (FactionId.fromWire(readString(ember.get("faction_id"), firstPath + ".faction_id", 1, 16, null),
                        firstPath + ".faction_id") != FactionId.EMBER
                || FactionId.fromWire(readString(tide.get("faction_id"), secondPath + ".faction_id", 1, 16, null),
                        secondPath + ".faction_id") != FactionId.TIDE) {
            throw invalid(path, "faction scores must be ordered Ember then Tide");
        }
        return new FactionScores(readU64String(ember.get("points"), firstPath + ".points", false),
                readU64String(tide.get("points"), secondPath + ".points", false));
    }

    private static Payload readOutcome(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload",
                Set.of("kind", "winner_seat", "winner_faction_id", "reason", "scores", "survivors", "at"),
                Set.of("kind", "survivors", "at"));
        String kind = readString(payload.get("kind"), "payload.kind", 1, 16, null);
        List<Integer> survivors = readSeatList(payload.get("survivors"), "payload.survivors");
        Optional<Tick> tick = payload.get("at") == null ? Optional.empty() : Optional.of(readTick(payload.get("at"), "payload.at"));
        if ("winner".equals(kind)) {
            if (!payload.keySet().equals(Set.of("kind", "winner_seat", "survivors", "at")) || tick.isEmpty()) {
                throw invalid("payload", "winner outcome requires a winner seat and authoritative tick only");
            }
            return new WinnerOutcome(readInteger(payload.get("winner_seat"), "payload.winner_seat", 0, 5), survivors,
                    tick.orElseThrow());
        }
        if ("faction_winner".equals(kind)) {
            if (!payload.keySet().equals(Set.of("kind", "winner_faction_id", "reason", "scores", "survivors", "at"))
                    || tick.isEmpty()) {
                throw invalid("payload", "faction winner requires its faction, reason, scores, survivors, and tick");
            }
            return new FactionWinnerOutcome(
                    FactionId.fromWire(readString(payload.get("winner_faction_id"),
                            "payload.winner_faction_id", 1, 16, null), "payload.winner_faction_id"),
                    FactionWinnerReason.fromWire(readString(payload.get("reason"), "payload.reason", 1, 32, null),
                            "payload.reason"),
                    readFactionScores(payload.get("scores"), "payload.scores"), survivors, tick.orElseThrow());
        }
        if ("draw".equals(kind)) {
            if (!payload.containsKey("reason") || payload.containsKey("winner_seat") || tick.isEmpty()) {
                throw invalid("payload", "draw outcome requires a reason and authoritative tick only");
            }
            DrawReason reason = DrawReason.fromWire(readString(payload.get("reason"), "payload.reason", 1, 32, null),
                    "payload.reason");
            if (payload.containsKey("scores")) {
                if (!payload.keySet().equals(Set.of("kind", "reason", "scores", "survivors", "at"))) {
                    throw invalid("payload", "civilization draw has an invalid field set");
                }
                return new CivilizationDrawOutcome(reason, readFactionScores(payload.get("scores"), "payload.scores"),
                        survivors, tick.orElseThrow());
            }
            if (!payload.keySet().equals(Set.of("kind", "reason", "survivors", "at"))) {
                throw invalid("payload", "Hunger Games draw has an invalid field set");
            }
            return new DrawOutcome(reason, survivors, tick.orElseThrow());
        }
        if ("abort".equals(kind)) {
            if (!payload.keySet().equals(Set.of("kind", "reason", "survivors", "at"))) {
                throw invalid("payload", "abort outcome requires a reason and no winner seat");
            }
            return new AbortOutcome(AbortReason.fromWire(readString(payload.get("reason"), "payload.reason", 1, 64, null),
                    "payload.reason"), survivors, tick);
        }
        throw invalid("payload.kind", "outcome kind must be winner, faction_winner, draw, or abort");
    }

    private static Payload readMetrics(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload",
                Set.of("server_tick_duration_micros", "critical_queue_depth", "dropped_optional_metrics"),
                Set.of("server_tick_duration_micros", "critical_queue_depth", "dropped_optional_metrics"));
        return new MetricsPayload(
                readIntegerLong(payload.get("server_tick_duration_micros"), "payload.server_tick_duration_micros", 0,
                        MAX_SAFE_INTEGER.longValue()),
                readInteger(payload.get("critical_queue_depth"), "payload.critical_queue_depth", 0, Integer.MAX_VALUE),
                readInteger(payload.get("dropped_optional_metrics"), "payload.dropped_optional_metrics", 0, Integer.MAX_VALUE));
    }

    private static Payload readError(Object value) throws IOException {
        Map<String, Object> payload = object(value, "payload", Set.of("code", "message"), Set.of("code", "message"));
        return new ErrorPayload(
                ErrorCode.fromWire(readString(payload.get("code"), "payload.code", 1, 64, null), "payload.code"),
                readString(payload.get("message"), "payload.message", 1, 1024, null));
    }

    private static Payload readEmpty(Object value) throws IOException {
        object(value, "payload", Set.of(), Set.of());
        return new EmptyPayload();
    }

    private static Tick readTick(Object value, String path) throws IOException {
        Map<String, Object> tick = object(value, path, Set.of("domain", "value"), Set.of("domain", "value"));
        return new Tick(
                TickDomain.fromWire(readString(tick.get("domain"), path + ".domain", 1, 16, null), path + ".domain"),
                readU64String(tick.get("value"), path + ".value", false));
    }

    private static List<Integer> readSeatList(Object value, String path) throws IOException {
        List<Object> values = array(value, path, 0, 6);
        List<Integer> seats = new ArrayList<>(values.size());
        for (int index = 0; index < values.size(); index++) {
            seats.add(readInteger(values.get(index), path + "[" + index + "]", 0, 5));
        }
        return orderedSeats(seats, path);
    }

    private static List<Capability> readCapabilities(Object value, String path) throws IOException {
        List<Object> values = array(value, path, 1, Capability.values().length);
        List<Capability> capabilities = new ArrayList<>(values.size());
        for (int index = 0; index < values.size(); index++) {
            capabilities.add(Capability.fromWire(readString(values.get(index), path + "[" + index + "]", 1, 64, null),
                    path + "[" + index + "]"));
        }
        return distinctList(capabilities, path);
    }

    private static Object payloadValue(Payload payload) {
        if (payload instanceof EmptyPayload) {
            return object();
        }
        if (payload instanceof HelloPayload hello) {
            return object("token", hello.token(), "capabilities", hello.capabilities().stream().map(Capability::wireName).toList());
        }
        if (payload instanceof ReadyPayload ready) {
            return object("server", object(
                            "name", ready.server().name(),
                            "version", ready.server().version(),
                            "minecraft_version", ready.server().minecraftVersion(),
                            "protocol_version", ready.server().protocolVersion()),
                    "plugin", object("name", ready.plugin().name(), "version", ready.plugin().version()),
                    "capabilities", ready.capabilities().stream().map(Capability::wireName).toList());
        }
        if (payload instanceof BuildProgressPayload progress) {
            return object("stage", progress.stage(), "completed", progress.completed(), "total", progress.total());
        }
        if (payload instanceof PreparePayload prepare) {
            Object modeSettings;
            if (prepare.settings() instanceof HungerGamesPrepareSettings hungerGames) {
                modeSettings = object("match", matchSettingsValue(hungerGames.match()),
                        "border", borderSettingsValue(hungerGames.border()));
            } else {
                CivilizationPrepareSettings civilization = (CivilizationPrepareSettings) prepare.settings();
                modeSettings = object("match", matchSettingsValue(civilization.match()),
                        "border", object("kind", "fixed", "diameter_blocks", civilization.border().diameterBlocks()),
                        "civilization", civilizationSettingsValue(civilization.civilization()));
            }
            return object(
                    "map_semantic_id", prepare.mapSemanticId(),
                    "scenario_semantic_id", prepare.scenarioSemanticId(),
                    "seed", prepare.seed().toString(),
                    "mode", prepare.mode(),
                    "settings", modeSettings,
                    "roster", prepare.roster().stream().map(ControlProtocol::competitorValue).toList());
        }
        if (payload instanceof AbortPayload abort) {
            return object("reason", abort.reason().wireName());
        }
        if (payload instanceof ClockPayload clock) {
            return object("phase", clock.phase().wireName(), "tick", clock.tick().map(ControlProtocol::tickValue).orElse(null),
                    "border_diameter_blocks", clock.borderDiameterBlocks());
        }
        if (payload instanceof PublicStatePayload state) {
            return object("at", tickValue(state.at()), "alive_seats", state.aliveSeats());
        }
        if (payload instanceof EliminationPayload elimination) {
            return object("at", tickValue(elimination.at()), "eliminations", elimination.eliminations().stream()
                    .map(item -> object("seat", item.seat(), "cause", item.cause().wireName())).toList());
        }
        if (payload instanceof CivilizationStatePayload state) {
            return object("at", tickValue(state.at()), "occupants", state.occupants(),
                    "owner_faction", state.ownerFaction().map(FactionId::wireName).orElse(null),
                    "challenger_faction", state.challengerFaction().map(FactionId::wireName).orElse(null),
                    "capture_progress_ticks", state.captureProgressTicks().toString(),
                    "scores", factionScoresValue(state.scores()));
        }
        if (payload instanceof WinnerOutcome winner) {
            return object("kind", "winner", "winner_seat", winner.winnerSeat(), "survivors", winner.survivors(),
                    "at", tickValue(winner.tick()));
        }
        if (payload instanceof FactionWinnerOutcome winner) {
            return object("kind", "faction_winner", "winner_faction_id", winner.winnerFaction().wireName(),
                    "reason", winner.reason().wireName(), "scores", factionScoresValue(winner.scores()),
                    "survivors", winner.survivors(), "at", tickValue(winner.tick()));
        }
        if (payload instanceof DrawOutcome draw) {
            return object("kind", "draw", "reason", draw.reason().wireName(), "survivors", draw.survivors(),
                    "at", tickValue(draw.tick()));
        }
        if (payload instanceof CivilizationDrawOutcome draw) {
            return object("kind", "draw", "reason", draw.reason().wireName(), "scores",
                    factionScoresValue(draw.scores()), "survivors", draw.survivors(), "at", tickValue(draw.tick()));
        }
        if (payload instanceof AbortOutcome abort) {
            return object("kind", "abort", "reason", abort.reason().wireName(), "survivors", abort.survivors(),
                    "at", abort.at().map(ControlProtocol::tickValue).orElse(null));
        }
        if (payload instanceof MetricsPayload metrics) {
            return object("server_tick_duration_micros", metrics.serverTickDurationMicros(),
                    "critical_queue_depth", metrics.criticalQueueDepth(),
                    "dropped_optional_metrics", metrics.droppedOptionalMetrics());
        }
        if (payload instanceof ErrorPayload error) {
            return object("code", error.code().wireName(), "message", error.message());
        }
        throw new IllegalArgumentException("unknown control payload type");
    }

    private static Object matchSettingsValue(MatchSettings match) {
        return object("countdown_ticks", match.countdownTicks().toString(),
                "grace_ticks", match.graceTicks().toString(),
                "authoritative_max_ticks", match.authoritativeMaxTicks().toString(),
                "respawn", match.respawn(),
                "block_breaking", match.blockBreaking(),
                "block_placing", match.blockPlacing(),
                "natural_mobs", match.naturalMobs(),
                "natural_random_ticks", match.naturalRandomTicks());
    }

    private static Object borderSettingsValue(BorderSettings border) {
        return object("initial_diameter_blocks", border.initialDiameterBlocks(),
                "shrink_start_tick", border.shrinkStartTick().toString(),
                "shrink_end_tick", border.shrinkEndTick().toString(),
                "final_diameter_blocks", border.finalDiameterBlocks());
    }

    private static Object civilizationSettingsValue(CivilizationSettings civilization) {
        return object("factions", civilization.factions().stream().map(faction -> object(
                        "id", faction.id().wireName(),
                        "members", faction.members().stream().map(member -> object(
                                "seat", member.seat(), "role", member.role().wireName())).toList())).toList(),
                "starting_kit", civilization.startingKit().stream().map(item -> object(
                        "item", item.resourceId(), "count", item.count())).toList(),
                "capture_zone", object("min", blockPositionValue(civilization.captureZone().min()),
                        "max", blockPositionValue(civilization.captureZone().max()),
                        "uncontested_ticks", civilization.captureZone().uncontestedTicks(),
                        "score_points_per_tick", civilization.captureZone().scorePointsPerTick()),
                "blueprint", object("id", civilization.blueprint().id(), "anchors", object(
                        "ember", blueprintAnchorValue(civilization.blueprint().anchors().get(FactionId.EMBER)),
                        "tide", blueprintAnchorValue(civilization.blueprint().anchors().get(FactionId.TIDE)))));
    }

    private static Object blockPositionValue(BlockPosition position) {
        return object("x", position.x(), "y", position.y(), "z", position.z());
    }

    private static Object blueprintAnchorValue(BlueprintAnchor anchor) {
        return object("position", blockPositionValue(anchor.position()), "rotation_degrees", anchor.rotationDegrees());
    }

    private static List<Object> factionScoresValue(FactionScores scores) {
        return List.of(object("faction_id", FactionId.EMBER.wireName(), "points", scores.emberPoints().toString()),
                object("faction_id", FactionId.TIDE.wireName(), "points", scores.tidePoints().toString()));
    }

    private static Object competitorValue(BotCompetitor bot) {
        return object("kind", "bot", "seat", bot.seat(), "participant_id", bot.participantId(),
                "username", bot.username(), "offline_uuid", bot.offlineUuid().toString());
    }

    private static Object tickValue(Tick tick) {
        return object("domain", tick.domain().wireName(), "value", tick.value().toString());
    }

    private static byte[] encodeJson(Object value) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (JsonWriter writer = new JsonWriter(new OutputStreamWriter(bytes, StandardCharsets.UTF_8))) {
            writer.setLenient(false);
            writer.setHtmlSafe(false);
            writer.setSerializeNulls(true);
            writeJsonValue(writer, value);
        }
        return bytes.toByteArray();
    }

    private static void writeJsonValue(JsonWriter writer, Object value) throws IOException {
        if (value == null) {
            writer.nullValue();
        } else if (value instanceof String string) {
            if (!wellFormedUnicode(string)) {
                throw new IOException("control JSON string contains an unpaired surrogate");
            }
            writer.value(string);
        } else if (value instanceof Boolean bool) {
            writer.value(bool);
        } else if (value instanceof Integer integer) {
            writer.value(integer);
        } else if (value instanceof Long number) {
            writer.value(number);
        } else if (value instanceof Double number) {
            writer.value(number);
        } else if (value instanceof BigDecimal number) {
            writer.value(number);
        } else if (value instanceof List<?> list) {
            writer.beginArray();
            for (Object entry : list) {
                writeJsonValue(writer, entry);
            }
            writer.endArray();
        } else if (value instanceof Map<?, ?> map) {
            writer.beginObject();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String name) || !wellFormedUnicode(name)) {
                    throw new IOException("control JSON object key contains an unpaired surrogate");
                }
                writer.name(name);
                writeJsonValue(writer, entry.getValue());
            }
            writer.endObject();
        } else {
            throw new IllegalArgumentException("unsupported control JSON value");
        }
    }

    private static Object readJsonValue(JsonReader reader, int depth) throws IOException {
        JsonToken token = reader.peek();
        return switch (token) {
            case BEGIN_OBJECT -> {
                if (depth >= 32) {
                    throw invalid("frame", "control JSON nesting exceeds 32 containers");
                }
                reader.beginObject();
                Map<String, Object> object = new LinkedHashMap<>();
                while (reader.hasNext()) {
                    String name = reader.nextName();
                    if (object.containsKey(name)) {
                        throw invalid("frame", "control JSON contains a duplicate object field");
                    }
                    object.put(name, readJsonValue(reader, depth + 1));
                }
                reader.endObject();
                yield object;
            }
            case BEGIN_ARRAY -> {
                if (depth >= 32) {
                    throw invalid("frame", "control JSON nesting exceeds 32 containers");
                }
                reader.beginArray();
                List<Object> array = new ArrayList<>();
                while (reader.hasNext()) {
                    array.add(readJsonValue(reader, depth + 1));
                }
                reader.endArray();
                yield array;
            }
            case STRING -> {
                String value = reader.nextString();
                if (!wellFormedUnicode(value)) {
                    throw invalid("frame", "control JSON string contains an unpaired surrogate");
                }
                yield value;
            }
            case NUMBER -> {
                BigDecimal number = new BigDecimal(reader.nextString());
                if (number.stripTrailingZeros().scale() <= 0
                        && number.toBigIntegerExact().abs().compareTo(MAX_SAFE_INTEGER) > 0) {
                    throw invalid("frame", "control JSON integer exceeds the safe numeric range");
                }
                if (!Double.isFinite(number.doubleValue())) {
                    throw invalid("frame", "control JSON number is not finite");
                }
                yield number;
            }
            case BOOLEAN -> reader.nextBoolean();
            case NULL -> {
                reader.nextNull();
                yield null;
            }
            default -> throw invalid("frame", "invalid control JSON value");
        };
    }

    private static Map<String, Object> object(Object value, String path, Set<String> allowed, Set<String> required)
            throws IOException {
        if (!(value instanceof Map<?, ?> raw)) {
            throw invalid(path, "must be an object");
        }
        Map<String, Object> object = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key) || !allowed.contains(key)) {
                throw invalid(path + "." + entry.getKey(), "unknown field");
            }
            object.put(key, entry.getValue());
        }
        for (String key : required) {
            if (!object.containsKey(key)) {
                throw invalid(path + "." + key, "required field is missing");
            }
        }
        return object;
    }

    private static List<Object> array(Object value, String path, int min, int max) throws IOException {
        if (!(value instanceof List<?> values) || values.size() < min || values.size() > max) {
            throw invalid(path, "must be an array with " + min + " to " + max + " entries");
        }
        return new ArrayList<>(values);
    }

    private static String readString(Object value, String path, int min, int max, String pattern) throws IOException {
        if (!(value instanceof String string) || !wellFormedUnicode(string)
                || codePointLength(string) < min || codePointLength(string) > max
                || (pattern != null && !string.matches(pattern))) {
            throw invalid(path, "must be a string with the required length and format");
        }
        return string;
    }

    private static boolean readBoolean(Object value, String path) throws IOException {
        if (!(value instanceof Boolean result)) {
            throw invalid(path, "must be a boolean");
        }
        return result;
    }

    private static int readInteger(Object value, String path, int min, int max) throws IOException {
        long number = readIntegerLong(value, path, min, max);
        if (number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) {
            throw invalid(path, "must be an integer in range");
        }
        return (int) number;
    }

    private static long readIntegerLong(Object value, String path, long min, long max) throws IOException {
        if (!(value instanceof BigDecimal decimal)) {
            throw invalid(path, "must be an integer in range");
        }
        BigInteger integer;
        try {
            integer = decimal.toBigIntegerExact();
        } catch (ArithmeticException notInteger) {
            throw invalid(path, "must be an integer in range");
        }
        if (integer.abs().compareTo(MAX_SAFE_INTEGER) > 0 || integer.compareTo(BigInteger.valueOf(min)) < 0
                || integer.compareTo(BigInteger.valueOf(max)) > 0) {
            throw invalid(path, "must be an integer in range");
        }
        return integer.longValueExact();
    }

    private static double readFiniteNumber(Object value, String path) throws IOException {
        if (!(value instanceof BigDecimal decimal)) {
            throw invalid(path, "must be a finite number");
        }
        double number = decimal.doubleValue();
        if (!Double.isFinite(number)) {
            throw invalid(path, "must be a finite number");
        }
        return number;
    }

    private static BigInteger readU64String(Object value, String path, boolean positive) throws IOException {
        if (!(value instanceof String text) || text.length() > 20 || !text.matches("0|[1-9][0-9]*")) {
            throw invalid(path, positive ? "must be a positive canonical u64 decimal string" : "must be a canonical u64 decimal string");
        }
        BigInteger number = new BigInteger(text);
        if (number.compareTo(MAX_U64) > 0 || (positive && number.signum() == 0)) {
            throw invalid(path, "u64 value is out of range");
        }
        return number;
    }

    private static boolean payloadMatches(Type type, Payload payload) {
        return switch (type) {
            case HELLO -> payload instanceof HelloPayload;
            case READY -> payload instanceof ReadyPayload;
            case HEARTBEAT, START, ACK -> payload instanceof EmptyPayload;
            case BUILD_PROGRESS -> payload instanceof BuildProgressPayload;
            case PREPARE -> payload instanceof PreparePayload;
            case ABORT -> payload instanceof AbortPayload;
            case PUBLIC_CLOCK -> payload instanceof ClockPayload;
            case PUBLIC_STATE -> payload instanceof PublicStatePayload;
            case ELIMINATION -> payload instanceof EliminationPayload;
            case CIVILIZATION_STATE -> payload instanceof CivilizationStatePayload;
            case OUTCOME -> payload instanceof Outcome;
            case METRICS -> payload instanceof MetricsPayload;
            case ERROR -> payload instanceof ErrorPayload;
        };
    }

    private static void validateRoster(List<BotCompetitor> roster) {
        require(!roster.isEmpty() && roster.size() <= 6, "roster must contain one to six competitors");
        Set<String> participants = new HashSet<>();
        Set<String> usernames = new HashSet<>();
        Set<UUID> uuids = new HashSet<>();
        for (int index = 0; index < roster.size(); index++) {
            BotCompetitor bot = Objects.requireNonNull(roster.get(index), "roster competitor");
            require(bot.seat() == index, "roster seats must be ordered and contiguous from zero");
            require(participants.add(bot.participantId()), "participant ids must be unique");
            require(usernames.add(bot.username()), "bot usernames must be unique");
            require(uuids.add(bot.offlineUuid()), "bot offline UUIDs must be unique");
        }
    }

    private static <T> List<T> distinctList(List<T> values, String label) {
        List<T> copy = List.copyOf(Objects.requireNonNull(values, label));
        require(new HashSet<>(copy).size() == copy.size(), label + " must be unique");
        return copy;
    }

    private static List<Integer> orderedSeats(List<Integer> values, String label) {
        List<Integer> copy = List.copyOf(Objects.requireNonNull(values, label));
        require(copy.size() <= 6, label + " cannot contain more than six seats");
        int previous = -1;
        for (Integer seat : copy) {
            require(seat != null && seat >= 0 && seat <= 5 && seat > previous, label + " must be ordered and unique");
            previous = seat;
        }
        return copy;
    }

    private static Map<String, Object> object(Object... entries) {
        if (entries.length % 2 != 0) {
            throw new IllegalArgumentException("object entries must be key/value pairs");
        }
        Map<String, Object> object = new LinkedHashMap<>();
        for (int index = 0; index < entries.length; index += 2) {
            object.put((String) entries[index], entries[index + 1]);
        }
        return object;
    }

    private static boolean isU64(BigInteger value) {
        return value != null && value.signum() >= 0 && value.compareTo(MAX_U64) <= 0;
    }

    private static boolean isPositiveU64(BigInteger value) {
        return value != null && value.signum() > 0 && value.compareTo(MAX_U64) <= 0;
    }

    private static boolean text(String value, int min, int max) {
        return value != null && wellFormedUnicode(value) && codePointLength(value) >= min
                && codePointLength(value) <= max;
    }

    private static int codePointLength(String value) {
        return value.codePointCount(0, value.length());
    }

    private static boolean wellFormedUnicode(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return false;
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                return false;
            }
        }
        return true;
    }

    private static IOException invalid(String path, String message) {
        return new IOException(path + ": " + message);
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalArgumentException(message);
        }
    }
}
