package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class LoginGuardTest {
    private static final UUID ALEX = ControlProtocol.offlineUuid("Alex_Fixture");

    @Test
    void deniesALoginWhoseUuidOrNameIsAlreadyOnline() {
        List<LoginGuard.OnlineIdentity> online = List.of(new LoginGuard.OnlineIdentity("Alex_Fixture", ALEX));

        assertEquals(Optional.of("this identity is already connected"),
                LoginGuard.denial(online, "Alex_Fixture", ALEX));
        assertEquals(Optional.of("this identity is already connected"),
                LoginGuard.denial(online, "ALEX_FIXTURE", UUID.randomUUID()));
        assertEquals(Optional.of("this identity is already connected"),
                LoginGuard.denial(online, "Other", ALEX));
    }

    @Test
    void admitsDistinctIdentitiesAndRejoinsAfterTheHolderLeaves() {
        List<LoginGuard.OnlineIdentity> online = List.of(new LoginGuard.OnlineIdentity("Alex_Fixture", ALEX));

        assertEquals(Optional.empty(), LoginGuard.denial(online, "Watcher", ControlProtocol.offlineUuid("Watcher")));
        assertEquals(Optional.empty(), LoginGuard.denial(List.of(), "Alex_Fixture", ALEX));
    }
}
