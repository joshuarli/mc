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

The resolved plan allows at most 1,000,000 blocks, six spawns, 100,000 loot
containers, and 27 one-item inventory entries per chest. Chunk preparation
includes the configured view-distance halo, limited to 32 chunks in each
direction and 8,192 total prepared chunks.

The chunk generator reads only the immutable plan and writes to the
`ChunkData` supplied to its callback. It does not query or mutate another
chunk. Vanilla terrain phases and populators are disabled so chunks outside the
declared map are empty. World blocks and chest inventories are applied during
server-thread setup before the match is allowed to become ready.

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
