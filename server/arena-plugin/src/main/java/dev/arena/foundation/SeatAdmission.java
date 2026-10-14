package dev.arena.foundation;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

final class SeatAdmission {
    sealed interface Decision permits Bind, Spectate, Reject {}

    record Bind(int seat) implements Decision {}

    record Spectate() implements Decision {}

    record Reject(String reason) implements Decision {}

    private static final String RESERVED_BOT_PREFIX = "arenabot";

    private SeatAdmission() {}

    static Decision admit(
            List<ControlProtocol.Competitor> roster,
            boolean bindingOpen,
            Map<Integer, UUID> boundPlayersBySeat,
            String username,
            UUID playerId) {
        String folded = username.toLowerCase(Locale.ROOT);
        for (ControlProtocol.Competitor competitor : roster) {
            boolean sameName = competitor.username().equals(username);
            boolean sameId = competitor.offlineUuid().equals(playerId);
            if (sameName && sameId) {
                if (!bindingOpen) {
                    return new Spectate();
                }
                UUID holder = boundPlayersBySeat.get(competitor.seat());
                if (holder != null && !holder.equals(playerId)) {
                    return new Reject("competitor identity is already bound to another connection");
                }
                return new Bind(competitor.seat());
            }
            if (sameName || sameId || competitor.username().toLowerCase(Locale.ROOT).equals(folded)) {
                return new Reject("identity does not exactly match its reserved competitor seat");
            }
        }
        if (folded.startsWith(RESERVED_BOT_PREFIX)) {
            return new Reject("bot identities are reserved for configured competitor seats");
        }
        return new Spectate();
    }
}
