package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
            "control-outcome-draw.json",
            "control-outcome-civilization-draw.json",
            "control-outcome-faction-winner.json",
            "control-outcome-runtime-timeout.json",
            "control-outcome-winner.json",
            "control-outcome-winner-wide-seat.json",
            "control-prepare-bots.json",
            "control-prepare-roster-v2.json",
            "control-prepare-resume.json",
            "control-checkpoint.json",
            "control-checkpoint-written.json",
            "control-prepare-rules-frontier.json",
            "control-prepare-rules-squads.json",
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
            "control-invalid-checkpoint-written-digest.json",
            "control-invalid-resume-legacy-roster.json",
            "control-invalid-resume-epoch-zero.json",
            "control-invalid-rules-frontier-no-editing.json",
            "control-invalid-rules-frontier-radius.json",
            "control-invalid-rules-frontier-random-ticks.json",
            "control-invalid-rules-squads-gap.json",
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
