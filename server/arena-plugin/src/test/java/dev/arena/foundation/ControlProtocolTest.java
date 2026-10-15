package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

final class ControlProtocolTest {
    private static final List<String> VALID_FIXTURES = List.of(
            "control-abort.json",
            "control-ack.json",
            "control-build-progress.json",
            "control-civilization-state.json",
            "control-elimination.json",
            "control-elimination-wide-seats.json",
            "control-error.json",
            "control-heartbeat.json",
            "control-hello.json",
            "control-metrics.json",
            "control-metrics-tick-durations.json",
            "control-outcome-draw.json",
            "control-outcome-civilization-draw.json",
            "control-outcome-faction-winner.json",
            "control-outcome-runtime-timeout.json",
            "control-outcome-winner.json",
            "control-outcome-winner-wide-seat.json",
            "control-prepare-bots.json",
            "control-prepare-roster-v2.json",
            "control-prepare-resume.json",
            "control-prepare-damage-events.json",
            "control-damage.json",
            "control-mechanics-receipt.json",
            "control-checkpoint.json",
            "control-checkpoint-written.json",
            "control-prepare-rules-frontier.json",
            "control-prepare-rules-squads.json",
            "control-prepare-rules-uhc.json",
            "control-prepare-roster-v2-256.json",
            "control-prepare-civilization.json",
            "control-public-clock.json",
            "control-public-state.json",
            "control-public-state-wide-seats.json",
            "control-ready.json",
            "control-start.json");

    private static final List<String> INVALID_FIXTURES = List.of(
            "control-invalid-civilization.json",
            "control-invalid-civilization-faction-wide-seat.json",
            "control-invalid-civilization-roster-v2.json",
            "control-invalid-duplicate-key.json",
            "control-invalid-dynamic-capability.json",
            "control-invalid-finish.json",
            "control-invalid-human-roster.json",
            "control-invalid-human-wait-timeout.json",
            "control-invalid-leading-zero.json",
            "control-invalid-roster-gap.json",
            "control-invalid-checkpoint-epoch.json",
            "control-invalid-metrics-tick-durations-count.json",
            "control-invalid-metrics-tick-durations-negative.json",
            "control-invalid-metrics-tick-durations-empty.json",
            "control-invalid-damage-empty.json",
            "control-invalid-damage-competitor-flag.json",
            "control-invalid-damage-amount.json",
            "control-invalid-damage-cause.json",
            "control-invalid-damage-environment-attacker.json",
            "control-invalid-damage-seat.json",
            "control-invalid-damage-unknown-field.json",
            "control-invalid-damage-events-legacy-roster.json",
            "control-invalid-mechanics-receipt-duplicate.json",
            "control-invalid-checkpoint-written-digest.json",
            "control-invalid-resume-legacy-roster.json",
            "control-invalid-resume-epoch-zero.json",
            "control-invalid-rules-frontier-no-editing.json",
            "control-invalid-rules-frontier-radius.json",
            "control-invalid-rules-frontier-random-ticks.json",
            "control-invalid-rules-squads-gap.json",
            "control-invalid-rules-uhc-food.json",
            "control-invalid-rules-uhc-kit.json",
            "control-invalid-rules-uhc-respawn.json",
            "control-invalid-rules-uhc-roster.json",
            "control-invalid-rules-without-roster-version.json",
            "control-invalid-roster-v1-external.json",
            "control-invalid-roster-v1-seven-seats.json",
            "control-invalid-roster-v2-257.json",
            "control-invalid-roster-v2-case-duplicate.json",
            "control-invalid-roster-v2-reserved-username.json",
            "control-invalid-roster-v2-unknown-kind.json",
            "control-invalid-roster-v2-uuid-mismatch.json",
            "control-invalid-roster-v2-version.json",
            "control-invalid-seat-256.json",
            "control-invalid-sequence-number.json",
            "control-invalid-u64-overflow.json",
            "control-invalid-unknown-field.json");

    @Test
    void decodesAndReencodesEveryValidCrossLanguageControlFixture() throws IOException {
        for (String fixture : VALID_FIXTURES) {
            ControlProtocol.Envelope decoded = ControlProtocol.decodeBody(Files.readAllBytes(fixturePath(fixture)));
            byte[] frame = ControlProtocol.encodeFrame(decoded);
            assertEquals(frame.length - Integer.BYTES, ByteBuffer.wrap(frame).getInt(), fixture);
            byte[] encodedBody = Arrays.copyOfRange(frame, Integer.BYTES, frame.length);
            assertEquals(JsonParser.parseString(Files.readString(fixturePath(fixture))),
                    JsonParser.parseString(new String(encodedBody, StandardCharsets.UTF_8)), fixture);
            assertEquals(decoded,
                    ControlProtocol.decodeBody(encodedBody), fixture);
        }
    }

    @Test
    void rejectsEveryInvalidCrossLanguageControlFixture() throws IOException {
        for (String fixture : INVALID_FIXTURES) {
            byte[] body = Files.readAllBytes(fixturePath(fixture));
            assertThrows(IOException.class, () -> ControlProtocol.decodeBody(body), fixture);
        }
    }

    @Test
    void civilizationPrepareDecodesOnlyIntoItsSixSeatSettingsVariant() throws IOException {
        ControlProtocol.Envelope envelope = ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-civilization.json")));
        ControlProtocol.PreparePayload prepare = (ControlProtocol.PreparePayload) envelope.payload();

        assertEquals("civilization", prepare.mode());
        assertTrue(prepare.settings() instanceof ControlProtocol.CivilizationPrepareSettings);
        ControlProtocol.CivilizationPrepareSettings settings =
                (ControlProtocol.CivilizationPrepareSettings) prepare.settings();
        assertEquals(6, prepare.roster().size());
        assertEquals(192, settings.border().diameterBlocks());
        assertEquals(200, settings.civilization().captureZone().uncontestedTicks());
        assertEquals(List.of(0, 1, 2), settings.civilization().factions().getFirst().members().stream()
                .map(ControlProtocol.FactionMember::seat).toList());
    }

    @Test
    void generalizedRosterCarriesExternalSeatsUpToTheCompetitorLimit() throws IOException {
        ControlProtocol.PreparePayload small = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-roster-v2.json"))).payload();
        assertEquals(ControlProtocol.RosterVersion.GENERALIZED, small.rosterVersion());
        assertEquals(List.of(3, 6), small.roster().stream()
                .filter(competitor -> competitor.kind() == ControllerKind.EXTERNAL)
                .map(ControlProtocol.Competitor::seat).toList());

        ControlProtocol.PreparePayload full = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-roster-v2-256.json"))).payload();
        assertEquals(MatchController.MAX_COMPETITORS, full.roster().size());
        assertEquals(ControllerKind.EXTERNAL, full.roster().getLast().kind());
    }

    @Test
    void rulePrepareDecodesFrontierBudgetsAndSquadPartitions() throws IOException {
        ControlProtocol.PreparePayload frontier = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-rules-frontier.json"))).payload();
        assertEquals(new ControlProtocol.FrontierSurvivalRules(96, 2000), frontier.rules().orElseThrow());

        ControlProtocol.PreparePayload squads = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-rules-squads.json"))).payload();
        ControlProtocol.SquadsRules rules = (ControlProtocol.SquadsRules) squads.rules().orElseThrow();
        assertEquals(java.util.Optional.of("bravo"), rules.squadOf(5));
        assertEquals(java.util.Optional.of("alpha"), rules.squadOf(0));

        ControlProtocol.PreparePayload uhc = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-rules-uhc.json"))).payload();
        assertFalse(ControlProtocol.naturalRegeneration(uhc.rules()));
        assertTrue(ControlProtocol.naturalRegeneration(squads.rules()));
        assertTrue(ControlProtocol.naturalRegeneration(java.util.Optional.empty()));
        ControlProtocol.UhcKit kit = ((ControlProtocol.UhcDuelRules) uhc.rules().orElseThrow()).kit();
        List<ControlProtocol.UhcKit.Grant> grants = kit.grants();
        assertEquals(new ControlProtocol.UhcKit("iron", "iron", 16, 2, "minecraft:cooked_beef", 8, true).grants(),
                grants);
        assertEquals(ControlProtocol.UhcKit.Slot.OFFHAND, grants.getLast().slot());
        assertEquals(List.of(
                "minecraft:iron_helmet",
                "minecraft:iron_chestplate",
                "minecraft:iron_leggings",
                "minecraft:iron_boots",
                "minecraft:iron_sword",
                "minecraft:bow",
                "minecraft:arrow",
                "minecraft:golden_apple",
                "minecraft:cooked_beef",
                "minecraft:shield"),
                grants.stream().map(ControlProtocol.UhcKit.Grant::itemId).toList());
        for (ControlProtocol.UhcKit.Grant grant : grants) {
            assertKnownMinecraftItem(grant.itemId());
        }
        for (String item : ControlProtocol.UhcKit.FOOD_STACKS.keySet()) {
            assertKnownMinecraftItem(item);
        }
        for (String tier : ControlProtocol.UhcKit.ARMOR_TIERS) {
            for (String piece : List.of("helmet", "chestplate", "leggings", "boots")) {
                assertKnownMinecraftItem("minecraft:" + tier + "_" + piece);
            }
        }
        for (String material : ControlProtocol.UhcKit.SWORD_MATERIALS) {
            assertKnownMinecraftItem("minecraft:" + material + "_sword");
        }
        assertTrue(new ControlProtocol.UhcKit("iron", "iron", 16, 2, "minecraft:cooked_beef", 8, false).grants()
                .stream().noneMatch(grant -> grant.slot() == ControlProtocol.UhcKit.Slot.OFFHAND));
        assertThrows(IllegalArgumentException.class, () -> new ControlProtocol.UhcKit(
                "iron", "iron", 1, 1, "minecraft:mushroom_stew", 2, false));
        assertThrows(IllegalArgumentException.class, () -> new ControlProtocol.UhcKit(
                "iron", "iron", 1, 1, "minecraft:diamond_sword", 1, false));
    }

    @Test
    void plannedSchema1UhcPrepareCarriesRulesAndLegacyPrepareDoesNot() throws IOException {
        ControlProtocol.PreparePayload uhc = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-rules-uhc.json"))).payload();
        MapPlan plan = twoSpawnPlan();
        assertEquals(Optional.empty(), ArenaFoundationPlugin.rosterPlanMismatch(plan, uhc));
        assertFalse(ControlProtocol.naturalRegeneration(uhc.rules()));

        ControlProtocol.PreparePayload classicRoster = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-roster-v2.json"))).payload();
        assertEquals("prepare roster version does not match the staged world-plan schema",
                ArenaFoundationPlugin.rosterPlanMismatch(plan, classicRoster).orElseThrow());

        ControlProtocol.PreparePayload legacy = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-bots.json"))).payload();
        assertEquals(Optional.empty(), ArenaFoundationPlugin.rosterPlanMismatch(plan, legacy));
        assertTrue(legacy.rules().isEmpty());
        assertThrows(IOException.class, () -> ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-invalid-rules-without-roster-version.json"))));

        MapPlan.Dimensions dimensions = new MapPlan.Dimensions(64, 64, 0, 128);
        List<MapPlan.BlockPlacement> blocks = List.of(
                new MapPlan.BlockPlacement(new MapPlan.Position(0, 64, 0), "minecraft:stone"),
                new MapPlan.BlockPlacement(new MapPlan.Position(1, 64, 0), "minecraft:stone"),
                new MapPlan.BlockPlacement(new MapPlan.Position(1, 65, 0), "minecraft:chest"));
        List<MapPlan.SpawnPoint> spawns = List.of(new MapPlan.SpawnPoint(0, new MapPlan.Position(0, 65, 0)));
        List<MapPlan.LootContainer> loot = List.of(
                new MapPlan.LootContainer(new MapPlan.Position(1, 65, 0), List.of("minecraft:bread")));
        MapPlan oneSpawn = new MapPlan(1, "test-run", MapPlan.computeSemanticId(dimensions, blocks, spawns, loot),
                dimensions, blocks, spawns, loot);
        assertEquals("prepare roster does not match the staged world-plan roster",
                ArenaFoundationPlugin.rosterPlanMismatch(oneSpawn, uhc).orElseThrow());
    }

    private static MapPlan twoSpawnPlan() {
        MapPlan.Dimensions dimensions = new MapPlan.Dimensions(64, 64, 0, 128);
        List<MapPlan.BlockPlacement> blocks = List.of(
                new MapPlan.BlockPlacement(new MapPlan.Position(0, 64, 0), "minecraft:stone"),
                new MapPlan.BlockPlacement(new MapPlan.Position(4, 64, 0), "minecraft:stone"),
                new MapPlan.BlockPlacement(new MapPlan.Position(1, 64, 0), "minecraft:stone"),
                new MapPlan.BlockPlacement(new MapPlan.Position(1, 65, 0), "minecraft:chest"));
        List<MapPlan.SpawnPoint> spawns = List.of(
                new MapPlan.SpawnPoint(0, new MapPlan.Position(0, 65, 0)),
                new MapPlan.SpawnPoint(1, new MapPlan.Position(4, 65, 0)));
        List<MapPlan.LootContainer> loot = List.of(
                new MapPlan.LootContainer(new MapPlan.Position(1, 65, 0), List.of("minecraft:bread")));
        return new MapPlan(1, "test-run", MapPlan.computeSemanticId(dimensions, blocks, spawns, loot),
                dimensions, blocks, spawns, loot);
    }

    @Test
    void legacyPrepareKeepsItsSixBotSeatContract() throws IOException {
        ControlProtocol.PreparePayload legacy = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-bots.json"))).payload();
        assertEquals(ControlProtocol.RosterVersion.BOTS_ONLY, legacy.rosterVersion());
        assertEquals(6, legacy.roster().size());
    }

    @Test
    void rejectsCivilizationSettingsWhenTheDiscriminantNamesHungerGames() throws IOException {
        String fixture = Files.readString(fixturePath("control-prepare-civilization.json"));
        String mismatchedMode = fixture.replace("\"mode\":\"civilization\"", "\"mode\":\"hunger_games\"");

        assertThrows(IOException.class,
                () -> ControlProtocol.decodeBody(mismatchedMode.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void civilizationPositionsAllowSignedSafeHeightButKeepHorizontalCoordinatesNonnegative() throws IOException {
        String fixture = Files.readString(fixturePath("control-prepare-civilization.json"));
        String negativeHeight = fixture.replace("\"y\":60", "\"y\":-35");
        ControlProtocol.PreparePayload decoded = (ControlProtocol.PreparePayload) ControlProtocol.decodeBody(
                negativeHeight.getBytes(StandardCharsets.UTF_8)).payload();

        ControlProtocol.CivilizationPrepareSettings settings =
                (ControlProtocol.CivilizationPrepareSettings) decoded.settings();
        assertEquals(-35, settings.civilization().captureZone().min().y());

        String minimumSafeHeight = fixture.replace("\"y\":60", "\"y\":-9007199254740991");
        ControlProtocol.PreparePayload minimumSafeHeightDecoded = (ControlProtocol.PreparePayload)
                ControlProtocol.decodeBody(minimumSafeHeight.getBytes(StandardCharsets.UTF_8)).payload();
        ControlProtocol.CivilizationPrepareSettings minimumSafeHeightSettings =
                (ControlProtocol.CivilizationPrepareSettings) minimumSafeHeightDecoded.settings();
        assertEquals(-9_007_199_254_740_991L,
                minimumSafeHeightSettings.civilization().captureZone().min().y());

        String negativeX = fixture.replace("\"x\":80", "\"x\":-1");
        assertThrows(IOException.class,
                () -> ControlProtocol.decodeBody(negativeX.getBytes(StandardCharsets.UTF_8)));

        String unsafeHeight = fixture.replace("\"y\":60", "\"y\":-9007199254740992");
        assertThrows(IOException.class,
                () -> ControlProtocol.decodeBody(unsafeHeight.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void retainsTheFullUnsigned64SeedForBotRosters() throws IOException {
        ControlProtocol.Envelope botPrepare = ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-bots.json")));
        ControlProtocol.PreparePayload original = (ControlProtocol.PreparePayload) botPrepare.payload();
        ControlProtocol.PreparePayload maxSeed = new ControlProtocol.PreparePayload(
                original.mapSemanticId(), original.scenarioSemanticId(), ControlProtocol.MAX_U64,
                original.settings(), original.roster());
        byte[] frame = ControlProtocol.encodeFrame(new ControlProtocol.Envelope(
                botPrepare.header(), ControlProtocol.Type.PREPARE, maxSeed));
        byte[] body = Arrays.copyOfRange(frame, Integer.BYTES, frame.length);
        ControlProtocol.PreparePayload decoded = (ControlProtocol.PreparePayload)
                ControlProtocol.decodeBody(body).payload();

        assertEquals(ControlProtocol.MAX_U64, decoded.seed());
        assertEquals(original.roster(), decoded.roster());
    }

    @Test
    void rejectsLossyIntegerNumbersAndUnderflow() throws IOException {
        String ready = Files.readString(fixturePath("control-ready.json"));
        String fractionalProtocol = ready.replace("\"protocol_version\":775",
                "\"protocol_version\":775.00000000000000001");
        String underflowCounter = "{\"protocol\":1,\"run_id\":\"fixture-run\",\"sequence\":\"1\","
                + "\"type\":\"metrics\",\"payload\":{\"server_tick_duration_micros\":1e-324,"
                + "\"critical_queue_depth\":0,\"dropped_optional_metrics\":0}}";

        assertThrows(IOException.class,
                () -> ControlProtocol.decodeBody(fractionalProtocol.getBytes(StandardCharsets.UTF_8)));
        assertThrows(IOException.class,
                () -> ControlProtocol.decodeBody(underflowCounter.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void measuresStringLimitsInUnicodeCodePoints() throws IOException {
        String ready = Files.readString(fixturePath("control-ready.json"));
        String serverName = "😀".repeat(128);
        String unicodeReady = ready.replace("\"name\":\"paper\"", "\"name\":\"" + serverName + "\"");
        ControlProtocol.ReadyPayload payload = (ControlProtocol.ReadyPayload)
                ControlProtocol.decodeBody(unicodeReady.getBytes(StandardCharsets.UTF_8)).payload();

        assertEquals(serverName, payload.server().name());
        assertThrows(IllegalArgumentException.class,
                () -> new ControlProtocol.ServerIdentity("😀".repeat(129), "1", "1", 775));
    }

    @Test
    void rejectsUnpairedSurrogatesAtTheControlBoundary() throws IOException {
        String error = Files.readString(fixturePath("control-error.json"));
        String escapedSurrogate = "\\" + "uD800";
        String malformed = error.replace("\"message\":\"match is not prepared\"",
                "\"message\":\"" + escapedSurrogate + "\"");

        assertThrows(IOException.class,
                () -> ControlProtocol.decodeBody(malformed.getBytes(StandardCharsets.UTF_8)));
        assertThrows(IllegalArgumentException.class,
                () -> new ControlProtocol.ErrorPayload(ControlProtocol.ErrorCode.INTERNAL,
                        String.valueOf((char) 0xd800)));
    }

    private static void assertKnownMinecraftItem(String resourceId) {
        assertTrue(resourceId.startsWith("minecraft:"), resourceId);
        assertTrue(Material.getMaterial(resourceId.substring("minecraft:".length()).toUpperCase(Locale.ROOT)) != null,
                resourceId);
    }

    private static Path fixturePath(String filename) {
        String configuredDirectory = System.getenv("ARENA_CONTROL_FIXTURE_DIR");
        Path directory = configuredDirectory == null
                ? Path.of(System.getProperty("user.dir")).resolve("../../fixtures/protocol")
                : Path.of(configuredDirectory);
        Path fixture = directory.resolve(filename);
        assertTrue(Files.isRegularFile(fixture), "missing canonical control fixture " + fixture);
        return fixture;
    }
}
