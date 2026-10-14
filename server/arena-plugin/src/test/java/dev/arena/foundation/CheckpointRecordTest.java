package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class CheckpointRecordTest {
    private static final Path DIRECTORY = Path.of("../../fixtures/checkpoint");
    private static final List<String> INVALID = List.of(
            "checkpoint-invalid-incomplete.ckpt",
            "checkpoint-invalid-digest.ckpt",
            "checkpoint-invalid-unknown-field.ckpt",
            "checkpoint-invalid-version.ckpt",
            "checkpoint-invalid-revived-seat.ckpt",
            "checkpoint-invalid-food.ckpt",
            "checkpoint-invalid-nested-resume.ckpt");

    private static CheckpointRecord fixture() throws IOException {
        return CheckpointRecord.read(DIRECTORY.resolve("checkpoint-v1.ckpt")).record();
    }

    @Test
    void readsTheCrossLanguageCheckpointFixture() throws IOException {
        CheckpointRecord.Stored stored = CheckpointRecord.read(DIRECTORY.resolve("checkpoint-v1.ckpt"));
        CheckpointRecord record = stored.record();

        assertEquals("fixture-checkpoint", record.checkpointId());
        assertEquals(0, record.epoch());
        assertEquals(new BigInteger("520"), record.matchTick());
        assertEquals(188.5, record.borderDiameterBlocks());
        assertEquals(Set.of(2, 5), record.deadSeats());
        assertEquals(8, record.seats().size());
        assertTrue(record.livingSeat(2).isEmpty());
        assertEquals(2, record.livingSeat(0).orElseThrow().living().orElseThrow().inventory().size());
        assertEquals(ControlProtocol.EliminationCause.DISCONNECT, record.eliminations().get(1).cause());
        assertTrue(record.extension().isEmpty());
        assertEquals(64, stored.digest().length());
    }

    @Test
    void keepsTheOpaqueExtensionBytes() throws IOException {
        CheckpointRecord record = CheckpointRecord.read(DIRECTORY.resolve("checkpoint-v1-extension.ckpt")).record();

        assertEquals(3, record.extension().orElseThrow().version());
        assertArrayEquals("faction-state".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                record.extension().orElseThrow().payload());
    }

    @Test
    void rejectsEveryInvalidCheckpointFixture() {
        for (String name : INVALID) {
            assertThrows(IOException.class, () -> CheckpointRecord.read(DIRECTORY.resolve(name)), name);
        }
    }

    @Test
    void roundTripsThroughAnAtomicWriteAndKeepsTheDigest() throws IOException {
        CheckpointRecord record = fixture();
        Path scratch = Files.createTempDirectory(Path.of("../../.work/tmp").toAbsolutePath().normalize(), "ckpt-");
        Path target = scratch.resolve("saved.json");
        try {
            CheckpointRecord.Stored written = record.write(target);
            CheckpointRecord.Stored read = CheckpointRecord.read(target);

            assertEquals(written.digest(), read.digest());
            assertEquals(written.byteLength(), read.byteLength());
            assertEquals(record.deadSeats(), read.record().deadSeats());
            assertEquals(record.matchTick(), read.record().matchTick());
            assertEquals(record.seats(), read.record().seats());
            assertFalse(Files.exists(scratch.resolve("saved.json.partial")));
        } finally {
            Files.deleteIfExists(target);
            Files.deleteIfExists(scratch);
        }
    }

    @Test
    void aTruncatedWriteIsExplicitlyIncomplete() throws IOException {
        byte[] complete = Files.readAllBytes(DIRECTORY.resolve("checkpoint-v1.ckpt"));
        byte[] body = CheckpointRecord.read(DIRECTORY.resolve("checkpoint-v1.ckpt")).record().encodeBody();
        byte[] truncated = java.util.Arrays.copyOf(complete, complete.length - 10);

        assertThrows(IOException.class, () -> CheckpointRecord.decode(body));
        assertThrows(IOException.class, () -> CheckpointRecord.decode(truncated));
    }

    @Test
    void resumeBindsOnlyLivingSeatsAndRestoresSavedStateWithoutAFreshReset() throws IOException {
        CheckpointRecord record = fixture();
        ResumeSession session = new ResumeSession(record, 1);
        ControlProtocol.Competitor living = record.prepare().roster().get(0);
        ControlProtocol.Competitor dead = record.prepare().roster().get(2);

        SeatAdmission.Decision livingDecision = session.admit(living.username(), living.offlineUuid());
        assertEquals(new SeatAdmission.Bind(0), livingDecision);
        assertEquals(ResumeSession.BindingPlan.RESTORE_SAVED_STATE, session.planFor(0));
        CheckpointRecord.LivingState restored = session.markRestored(0, living.offlineUuid());
        assertEquals(record.livingSeat(0).orElseThrow().living().orElseThrow(), restored);
        assertEquals(2, restored.inventory().size());

        assertEquals(new SeatAdmission.Spectate(), session.admit(dead.username(), dead.offlineUuid()));
        assertThrows(IllegalStateException.class, () -> session.planFor(2));
        assertThrows(IllegalStateException.class, () -> session.markRestored(2, dead.offlineUuid()));
        assertInstanceOf(SeatAdmission.Reject.class, session.admit(living.username().toLowerCase(), UUID.randomUUID()));
        assertFalse(session.allLivingSeatsRestored());
    }

    @Test
    void resumeRequiresTheNextRuntimeEpoch() throws IOException {
        CheckpointRecord record = fixture();

        assertThrows(IllegalArgumentException.class, () -> new ResumeSession(record, 0));
        assertThrows(IllegalArgumentException.class, () -> new ResumeSession(record, 2));
        assertEquals(1, new ResumeSession(record, 1).epoch());
    }

    @Test
    void resumedMatchKeepsTheTickAndNeverRevivesDeadSeats() throws IOException {
        CheckpointRecord record = fixture();
        MatchController.Settings settings = new MatchController.Settings(BigInteger.ZERO, BigInteger.valueOf(200),
                BigInteger.valueOf(9000), new MatchController.FixedBorder(190));
        List<Integer> alive = record.seats().stream().filter(CheckpointRecord.SeatState::alive)
                .map(CheckpointRecord.SeatState::seat).toList();

        MatchController match = MatchController.resumed(settings, 8, record.matchTick(), alive);

        assertEquals(MatchController.Phase.ACTIVE, match.phase());
        assertEquals(record.matchTick(), match.matchTick().orElseThrow());
        assertEquals(List.of(0, 1, 3, 4, 6, 7), match.aliveSeats());
        match.endServerTick(List.of(new MatchController.Elimination(2, MatchController.EliminationCause.DEATH)));
        assertEquals(List.of(0, 1, 3, 4, 6, 7), match.aliveSeats());
        assertThrows(IllegalArgumentException.class,
                () -> MatchController.resumed(settings, 8, BigInteger.valueOf(9000), alive));
    }
}
