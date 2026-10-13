package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.ByteBuffer;
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
            "control-invalid-finish.json",
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
