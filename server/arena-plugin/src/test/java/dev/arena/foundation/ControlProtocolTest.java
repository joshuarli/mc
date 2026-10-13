package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
            "control-elimination.json",
            "control-error.json",
            "control-heartbeat.json",
            "control-hello.json",
            "control-metrics.json",
            "control-outcome-draw.json",
            "control-outcome-runtime-timeout.json",
            "control-outcome-winner.json",
            "control-prepare-bots.json",
            "control-public-clock.json",
            "control-public-state.json",
            "control-ready.json",
            "control-start.json");

    private static final List<String> INVALID_FIXTURES = List.of(
            "control-invalid-civilization.json",
            "control-invalid-duplicate-key.json",
            "control-invalid-dynamic-capability.json",
            "control-invalid-finish.json",
            "control-invalid-human-roster.json",
            "control-invalid-human-wait-timeout.json",
            "control-invalid-leading-zero.json",
            "control-invalid-roster-gap.json",
            "control-invalid-sequence-number.json",
            "control-invalid-u64-overflow.json",
            "control-invalid-unknown-field.json");

    @Test
    void decodesAndReencodesEveryValidCrossLanguageControlFixture() throws IOException {
        for (String fixture : VALID_FIXTURES) {
            ControlProtocol.Envelope decoded = ControlProtocol.decodeBody(Files.readAllBytes(fixturePath(fixture)));
            byte[] frame = ControlProtocol.encodeFrame(decoded);
            assertEquals(frame.length - Integer.BYTES, ByteBuffer.wrap(frame).getInt(), fixture);
            assertEquals(decoded,
                    ControlProtocol.decodeBody(Arrays.copyOfRange(frame, Integer.BYTES, frame.length)), fixture);
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
    void retainsTheFullUnsigned64SeedForBotRosters() throws IOException {
        ControlProtocol.Envelope botPrepare = ControlProtocol.decodeBody(
                Files.readAllBytes(fixturePath("control-prepare-bots.json")));
        ControlProtocol.PreparePayload original = (ControlProtocol.PreparePayload) botPrepare.payload();
        ControlProtocol.PreparePayload maxSeed = new ControlProtocol.PreparePayload(
                original.mapSemanticId(), original.scenarioSemanticId(), ControlProtocol.MAX_U64,
                original.mode(), original.match(), original.border(), original.roster());
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
