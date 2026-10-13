# Server rules

## Resolved world plans

The runner supplies one UTF-8 world-plan v1 file through
`-Darena.generation-plan=<path>`. The plugin reads the file with a 128 MiB
streaming byte limit, rejects a final-component symlink, and rejects malformed
UTF-8, trailing JSON, duplicate keys, unknown keys, missing keys, unknown
versions, and out-of-range values. The runner is responsible for confining the
parent path to its owned run directory and must reject oversized output before
starting Paper.

Arrays must already be canonical at the JSON boundary. Blocks are strictly
ordered by `(x, y, z)`, spawn seats are contiguous from zero, and loot
containers are strictly ordered by `(x, y, z)`. The plugin checks the map
semantic ID against the SHA-256 encoding of the dimensions, block placements,
spawns, and ordered inventories. Duplicate block coordinates, unsupported
materials, invalid spawn headroom, and unsupported chest placement fail before
world generation or setup.

In plan mode, Paper must load `ArenaFoundation` at startup and configure the
default `world` generator as `ArenaFoundation:plan`. The plugin reads the plan
before world generation and returns the same immutable generator instance for
that world. A configured plan without the matching generator request fails
before the server reports ready. The runner must create a fresh world for each
plan because Paper only calls the generator for chunks that have not already
been generated.

The resolved plan allows at most 1,000,000 blocks, six spawns, 100,000 loot
containers, and 27 one-item inventory entries per chest. Chunk preparation
includes the configured view-distance halo, limited to 32 chunks in each
direction and 8,192 total prepared chunks.

The chunk generator reads only the immutable plan and writes to the
`ChunkData` supplied to its callback. It does not query or mutate another
chunk. Vanilla terrain phases and populators are disabled so chunks outside the
declared map are empty. On the server thread, the plugin prepares every map
chunk and the configured view-distance halo, checks every generated block
against the plan, fills the declared chests, and checks each spawn's actual
support and headroom. It sets the world spawn to seat zero, then emits
`ARENA_MAP_READY|run_id=...|map_semantic_id=...|prepared_chunks=...`. The later
`ARENA_READY|protocol=775|port=...` log line is diagnostic; control readiness is
the authenticated protocol `ready` event. The no-plan local stack smoke path
keeps its protocol fixture only when the runner passes
`-Darena.test-fixture=true`; it does not report map readiness. Startup fails if
neither mode is selected or if both are configured.

Plan mode requires `-Darena.control-port=<1..65535>`,
`-Darena.run-id=<run_id>`, and `ARENA_CONTROL_TOKEN` containing at least 32
random bytes in canonical base64url form. The run ID must match the staged map
plan. The plugin connects once to `127.0.0.1`, sends authenticated control-v1
`hello`, waits for its correlated acknowledgment, and emits `ready` only after
map setup. It never reconnects. Socket I/O runs off the Paper thread; commands,
world mutation, elimination resolution, and outcomes run at server tick end.

`prepare` must carry the staged `map_semantic_id`, resolved Hunger Games
settings, and one to six ordered bot competitors. Each bot binds only when both
its offline UUID and username match. Noncompetitor joins are spectators.
`start` requires every configured bot to be online before the countdown begins;
competitive reconnects after countdown are spectators. Match configuration
controls respawn, block breaking and placing, natural mob spawning, random
block ticks, and the world-border schedule. When respawn is disabled, death
eliminates the seat and any respawned player remains a spectator. Disconnects
eliminate bound competitors during countdown or play. Events from a server tick
are resolved together in seat order, and `outcome` is the sole terminal event.

Each seat bind in `WAITING` clears the bot's inventory and ender chest, health,
hunger, effects, experience, and other transient player state. Bound bots remain
at their assigned position while waiting and during countdown; they may change
yaw and pitch. Inventory opens and changes, item drops and pickups, item use,
block interactions, and damage are blocked until release. Block breaking and
placing are enabled only in `GRACE` or `ACTIVE` when the resolved match settings
allow them. The explicit test-fixture mode does not apply these plan-mode player
guards.

## Match timeline

The match starts in `WAITING` without a match tick. Countdown ticks are
zero-based. Once countdown completes, match tick zero begins; grace occupies
ticks `0..grace_ticks-1`, and active play starts at `grace_ticks`. With a zero
countdown, release occurs immediately. A one-seat roster wins at release.

`authoritative_max_ticks` is the inclusive final match tick. Elimination events
observed during a server tick are resolved in stable seat order before checking
the tick limit. One remaining seat wins, and zero remaining seats draw on that
tick. If multiple seats remain at the inclusive limit, the result is a tick
limit draw. A death takes precedence over a disconnect for a seat eliminated
on the same tick.

An abort while waiting has no phase tick. An abort during countdown carries the
zero-based countdown tick; after release it carries the current match tick.
World-border interpolation uses match ticks and reaches its configured final
diameter at `shrink_end_tick`.

The runner may abort with `runtime_timeout` when the operational deadline expires.

The control protocol's versioned payload schema and cross-language fixtures are
the wire contract. `ARENA_DAMAGE_ATTEMPT` includes cancelled attacks, while
`ARENA_DAMAGE` reports only uncancelled attacks with positive final damage.
Join and combat log markers remain diagnostic; only typed seat events and
`outcome` determine match results.
