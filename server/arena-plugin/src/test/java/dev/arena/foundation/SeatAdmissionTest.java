package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class SeatAdmissionTest {
    private static final List<ControlProtocol.Competitor> ROSTER = List.of(
            competitor(0, ControllerKind.BOT, "ArenaBot0"),
            competitor(1, ControllerKind.EXTERNAL, "Alex_Fixture"),
            competitor(2, ControllerKind.BOT, "ArenaBot2"));

    private static ControlProtocol.Competitor competitor(int seat, ControllerKind kind, String username) {
        return new ControlProtocol.Competitor(seat, kind, "seat-" + seat, username, ControlProtocol.offlineUuid(username));
    }

    private static SeatAdmission.Decision admit(boolean open, Map<Integer, UUID> bound, String name, UUID id) {
        return SeatAdmission.admit(ROSTER, open, bound, name, id);
    }

    @Test
    void exactIdentityBindsItsSeatForBotsAndExternalsAlike() {
        assertEquals(new SeatAdmission.Bind(0),
                admit(true, Map.of(), "ArenaBot0", ControlProtocol.offlineUuid("ArenaBot0")));
        assertEquals(new SeatAdmission.Bind(1),
                admit(true, Map.of(), "Alex_Fixture", ControlProtocol.offlineUuid("Alex_Fixture")));
    }

    @Test
    void wrongOrImpersonatedIdentityIsRejected() {
        assertInstanceOf(SeatAdmission.Reject.class,
                admit(true, Map.of(), "alex_fixture", ControlProtocol.offlineUuid("alex_fixture")));
        assertInstanceOf(SeatAdmission.Reject.class,
                admit(true, Map.of(), "Alex_Fixture", UUID.randomUUID()));
        assertInstanceOf(SeatAdmission.Reject.class,
                admit(true, Map.of(), "Someone", ControlProtocol.offlineUuid("Alex_Fixture")));
        assertInstanceOf(SeatAdmission.Reject.class,
                admit(true, Map.of(), "ArenaBot9", ControlProtocol.offlineUuid("ArenaBot9")));
    }

    @Test
    void duplicateIdentityIsRejectedWhileTheSeatIsHeld() {
        Map<Integer, UUID> bound = new HashMap<>();
        bound.put(1, UUID.randomUUID());

        assertInstanceOf(SeatAdmission.Reject.class,
                admit(true, bound, "Alex_Fixture", ControlProtocol.offlineUuid("Alex_Fixture")));
    }

    @Test
    void afterBindingClosesExactIdentitiesOnlySpectate() {
        assertEquals(new SeatAdmission.Spectate(),
                admit(false, Map.of(), "Alex_Fixture", ControlProtocol.offlineUuid("Alex_Fixture")));
        assertEquals(new SeatAdmission.Spectate(),
                admit(false, Map.of(), "ArenaBot0", ControlProtocol.offlineUuid("ArenaBot0")));
    }

    @Test
    void unrelatedNamesAndRunnerSpectatorsNeverTakeSeats() {
        assertEquals(new SeatAdmission.Spectate(),
                admit(true, Map.of(), "ArenaSpec0", ControlProtocol.offlineUuid("ArenaSpec0")));
        assertEquals(new SeatAdmission.Spectate(),
                admit(true, Map.of(), "Watcher", ControlProtocol.offlineUuid("Watcher")));
    }
}
