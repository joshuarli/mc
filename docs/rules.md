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

The resolved plan allows at most 1,000,000 blocks, six spawns (256 for a
schema-3 natural plan), 100,000 loot containers, and 27 one-item inventory
entries per chest. Chunk preparation
includes the configured view-distance halo, limited to 32 chunks in each
direction and 8,192 total prepared chunks.

For a schema-3 natural plan the plugin resolves each seat with a bounded,
deterministic candidate search instead of requiring the declared column to
be safe. Candidates are the declared column, then Chebyshev rings of radius
1 through 8 ordered by x then z, at most 128 per seat. A candidate needs a
safe full-block support, two clear blocks, no lava, fire, magma, cactus,
campfire, berry bush, powder snow, or cobweb within one block, a safe
adjacent escape column, and two blocks of separation from already chosen
seats. The first passing candidate wins; if none passes, preparation fails
and lists the per-reason rejection counts. The world seed is never
rerolled. The recipe string and the chosen spawn and chest positions feed a
world identity hash that the plugin logs as `ARENA_NATURAL_WORLD`. Cache
chests in a schema-3 plan additionally reject hazards within one block.
Schema-1 and schema-2 plans keep the declared-column checks.

Frontier survival (rule mode `frontier_survival` v1) lets competitors break
and place blocks only within the edit radius of the border center, never on a
loot chest, and only up to the per-seat edit budget; denied edits are
cancelled. The plugin creates no resources for the mode, and random ticks stay
off. Squads (rule mode `squads` v1) keep the classic rules; chat from a
competitor is delivered only to its own squad's competitors and to
non-competitors. Last-survivor outcomes are unchanged.

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

`prepare` must carry the staged `map_semantic_id`, settings for one supported
mode, and ordered competitors. A legacy Hunger Games `prepare` accepts one to
six bot seats; a Hunger Games `prepare` with `roster_version` 2 accepts one to
256 seats, each a bot or an external client with a reserved username.
Civilization requires exactly six bot seats. A roster-version-2 `prepare` is
valid only against a schema-3 world plan whose roster has the same seats,
controller kinds, and external usernames. Each competitor binds only when both
its offline UUID and username match. Exact roster identities bind only while the match waits. A join whose
username matches a reserved identity ignoring case, whose UUID matches a
reserved UUID, whose identity is already held, or that uses an unreserved
`ArenaBot` name is kicked; every other noncompetitor join is a spectator.
An exact identity that joins after countdown, or after elimination, is a
spectator and never re-enters competition, and a living competitor cannot
leave survival mode before its elimination. Noncompetitor joins are spectators, and
spectators never occupy a competitor seat.
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
block interactions, all damage to a bound bot, and damage caused by a bound bot
are blocked during `WAITING` and `COUNTDOWN`.

During `GRACE`, direct competitor attacks and projectiles shot by a competitor
cannot damage another bound competitor. Environmental damage remains enabled,
and competitors may still damage noncompetitors. Competitor PvP is enabled in
`ACTIVE` only. Block breaking and placing are enabled only in `GRACE` or
`ACTIVE` when the resolved match settings allow them. The explicit test-fixture
mode does not apply these plan-mode player guards.

## Match timeline

The match starts in `WAITING` without a match tick. Countdown ticks are
zero-based. Once countdown completes, match tick zero begins; grace occupies
ticks `0..grace_ticks-1`, and active play starts at `grace_ticks`. With a zero
countdown, release occurs immediately. In Hunger Games, a one-seat roster wins
at release.

`authoritative_max_ticks` is the inclusive final match tick. Elimination events
observed during a server tick are resolved in stable seat order before checking
the tick limit. In Hunger Games, one remaining seat wins and zero remaining
seats draw on that tick. If multiple seats remain at the inclusive limit, the
result is a tick limit draw. A death takes precedence over a disconnect for a
seat eliminated on the same tick.

An abort while waiting has no phase tick. An abort during countdown carries the
zero-based countdown tick; after release it carries the current match tick.
For natural worlds the plugin sets the border center to the floor, per axis,
of the mean declared spawn column, an integer block coordinate.

World-border interpolation uses match ticks and reaches its configured final
diameter at `shrink_end_tick`.

The runner may abort with `runtime_timeout` when the operational deadline expires.

## Civilization

Civilization `prepare` carries six bot seats: Ember seats 0–2 and Tide seats
3–5, each with a gatherer/crafter, builder, and defender/scout role. The mode
uses a fixed 192-block border, a 2,400-tick grace period, no respawn, enabled
survival block breaking and placing, and an inclusive 18,000-tick limit. The
compiled starting kit gives every seat four bread, a wooden axe, pickaxe, and
sword. Food is finite; the kit does not imply a renewable food economy.

The resolved scenario supplies the neutral capture zone and both oak-outpost
anchors. At the end of each match tick, the plugin derives occupants from the
currently bound, living bot players inside the inclusive zone bounds. After
grace, a sole present faction advances capture by one uncontested tick. A
contest pauses progress, and a challenger leaving resets its unfinished
progress. A new challenger starts from zero; capture completes at 200
increments. Ownership remains unchanged until completion, and the owner scores
one point at each end-of-tick boundary, including the completion tick, even if
the owner has no surviving seats. The plugin advertises `civilization_v1` and
publishes the actual occupants, owner, challenger, progress, and both scores as
`civilization_state`.

Each outpost is a survival-placed 3×3 oak-plank platform with two opposing
three-block corner pillars rising above opposite platform corners, for 15
required blocks. Four oak logs craft 16
planks through ordinary recipe and inventory mechanics; the extra plank is not
placed as part of the blueprint. The server checks the actual world blocks at
the declared anchor. It does not grant materials or place structure blocks.

If one faction is eliminated, the other faction wins regardless of score. A
same-tick wipe draws. If both factions still have survivors at tick 18,000,
their scores decide the winner; equal scores draw. Civilization outcomes carry
both faction scores and the authoritative match tick. The match controller
leaves these decisions to the civilization rules after resolving the same-tick
elimination batch.

The control protocol's versioned payload schema and cross-language fixtures are
the wire contract. `ARENA_DAMAGE_ATTEMPT` includes cancelled attacks, while
`ARENA_DAMAGE` reports only uncancelled attacks with positive final damage.
Join and combat log markers remain diagnostic; only typed seat events and
`outcome` determine match results.

For private six-seat acceptance runs, `-Darena.civilization-evaluator=true`
enables `ARENA_CIV_MATERIAL_V1` log markers. The initial checkpoint is sampled
at match tick zero after the starting kit is applied. Later checkpoints are
emitted at match-tick end when the sampled material state changes, and once
after any successful death-cargo marker even if the state is unchanged. They
count oak logs and planks in each bound player's inventory, cursor, and open
crafting input matrix; the crafting result preview and an open container's top
inventory are excluded. They also count dropped item entities and each
declared loot-container inventory, and list the surviving coordinates of the
map's original oak logs and actual placed oak-plank coordinates. A death-cargo
marker records the dying player's inventory and the death event's actual drops,
so it does not depend on dropped items remaining in the world long enough to be
sampled. These markers are log-only and are not sent to control clients or
policy observers.

Each match tick reads six player inventories, the currently loaded item
entities, the map's declared original-log positions and loot containers, and
only oak-plank block positions touched by place or break events, reconciled
against the resulting world state. It does not scan the map. The recorder
allows at most 256 markers of 16 KiB each; exceeding either limit fails the
evaluator run without truncating evidence.

For the current 192×192 acceptance map, the bounded source and storage scope is
the 16 planned natural-log positions and two declared loot chests. The
evaluator requires every chunk intersecting the map bounds to already be
loaded; it fails on a missing chunk and does not load or generate chunks. Its
material accounting covers the six seats, those declared chests, actual Item
entities in loaded world chunks, the original log positions, and placed oak
planks. It supports the scenario's oak-log-to-four-oak-planks conversion. It
does not claim conservation for unloaded chunks, undeclared storage, or other
conversions; those must fail the acceptance conservation check rather than
receive fabricated material credit.
