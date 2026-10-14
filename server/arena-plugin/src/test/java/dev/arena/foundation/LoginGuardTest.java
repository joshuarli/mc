package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class LoginGuardTest {
    private static final UUID ALEX = ControlProtocol.offlineUuid("Alex_Fixture");
    private static final Optional<String> DENIED = Optional.of("this identity is already connected");

    private static List<LoginGuard.OnlineIdentity> holder(boolean holdsLivingSeat) {
        return List.of(new LoginGuard.OnlineIdentity("Alex_Fixture", ALEX, holdsLivingSeat));
    }

    @Test
    void deniesALoginWhoseUuidOrNameIsHeldByALivingBoundCompetitor() {
        assertEquals(DENIED, LoginGuard.denial(holder(true), "Alex_Fixture", ALEX));
        assertEquals(DENIED, LoginGuard.denial(holder(true), "ALEX_FIXTURE", UUID.randomUUID()));
        assertEquals(DENIED, LoginGuard.denial(holder(true), "Other", ALEX));
    }

    @Test
    void lets_an_eliminated_or_spectating_holder_be_displaced() {
        assertEquals(Optional.empty(), LoginGuard.denial(holder(false), "Alex_Fixture", ALEX));
        assertEquals(Optional.empty(), LoginGuard.denial(holder(false), "ALEX_FIXTURE", UUID.randomUUID()));
    }

    @Test
    void admitsDistinctIdentitiesAndRejoinsAfterTheHolderLeaves() {
        assertEquals(Optional.empty(),
                LoginGuard.denial(holder(true), "Watcher", ControlProtocol.offlineUuid("Watcher")));
        assertEquals(Optional.empty(), LoginGuard.denial(List.of(), "Alex_Fixture", ALEX));
    }
}
