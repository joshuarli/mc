package dev.arena.foundation;

enum ControllerKind {
    BOT("bot"),
    EXTERNAL("external");

    private final String wireName;

    ControllerKind(String wireName) {
        this.wireName = wireName;
    }

    String wireName() {
        return wireName;
    }

    static ControllerKind fromWire(String value) {
        for (ControllerKind kind : values()) {
            if (kind.wireName.equals(value)) {
                return kind;
            }
        }
        throw new IllegalArgumentException("roster controller kind must be bot or external");
    }
}
