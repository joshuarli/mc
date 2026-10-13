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
chunk and the configured view-distance halo, fills the declared chests, and
sets the world spawn to seat zero. Only then it emits
`ARENA_MAP_READY|run_id=...|map_semantic_id=...|prepared_chunks=...`, followed
by the general `ARENA_READY` marker. The no-plan local stack smoke path keeps
its protocol fixture and does not report map readiness.

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

The plugin currently has no runtime prepare/start/abort payload contract or
participant-to-seat identity mapping. `MatchController` remains a pure match
timeline model until those inputs exist; join and combat log markers are not
authoritative seat or outcome events.
