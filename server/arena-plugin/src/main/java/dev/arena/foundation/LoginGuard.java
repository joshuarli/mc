package dev.arena.foundation;

import java.util.Collection;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;

final class LoginGuard {
    record OnlineIdentity(String username, UUID id) {}

    private LoginGuard() {}

    static Optional<String> denial(Collection<OnlineIdentity> online, String username, UUID id) {
        String folded = username.toLowerCase(Locale.ROOT);
        for (OnlineIdentity existing : online) {
            if (existing.id().equals(id) || existing.username().toLowerCase(Locale.ROOT).equals(folded)) {
                return Optional.of("this identity is already connected");
            }
        }
        return Optional.empty();
    }
}
