# Loopback control protocol

Control-v1 carries commands and evaluator events between the Arena runner and
its owned Paper plugin. The plugin is the authority for match state and
outcomes. This channel does not expose a command executor or a full-world query
to policies.

## Framing and validation

The runner binds an ephemeral loopback TCP listener before starting Paper. The
plugin connects outbound once with the fresh per-run token passed in its
private startup configuration. The token is compared during `hello`; it must
not appear in logs, traces, errors, or public state. A missing or closed lease
aborts the server on its main thread. The connection is not resumed or
reconnected, and application commands are never retried.

Each frame is a four-byte unsigned big-endian body length followed by that many
UTF-8 JSON bytes. The body length must be from 1 through 1,048,576 bytes. JSON
nesting is limited to 32 containers. Decoders reject malformed UTF-8, invalid
JSON, duplicate object names (including names that decode from the same escape
sequence), unsafe integer JSON numbers, unknown fields, unsupported protocol
versions, and invalid payload invariants before a message can change match
state. Wire u64 values are canonical decimal strings: zero is `"0"`, positive
values have no leading zero, and the range is 0 through
`18446744073709551615`. TypeScript represents these values as `bigint`.

Every envelope has `protocol`, `run_id`, `sequence`, `type`, and `payload`;
`correlation` is optional except on `ready` and `ack`. Sequence and correlation
are positive u64 decimal strings. Each direction maintains its own strictly
increasing sequence. Gaps are permitted; repeats and lower values fail. A
response correlation equals the initiating message's sequence.

The plugin's first message is an authenticated `hello` that lists its supported
capabilities. The runner validates these names against the closed
`CONTROL_CAPABILITIES` set. That set includes mode, roster, checkpoint, damage,
tick-metric, and duel-mechanics capabilities. The plugin may announce all its
supported capabilities in any match mode. The runner acknowledges that sequence, then the plugin sends
`ready` with the acknowledgment sequence as its correlation and the Paper,
Minecraft, protocol, plugin, and capability identities. The runner accepts no
commands until this handshake completes. The plugin sends a heartbeat every
second. `ControlReceiver` performs run, sequence, authentication, capability,
and handshake checks before returning an accepted message to the caller.
The runtime also requires the announced plugin name and version to match the
shipped `server/arena-plugin/src/main/resources/plugin.yml` descriptor before
it prepares the match. The authenticated capability set must include the selected
mode's capability before either bootstrap readiness or match preparation succeeds;
this required capability is distinct from the codec's supported wire set. Unknown
capabilities and a ready capability set differing from hello remain rejected.

The plugin's inbound command queue holds at most 128 `prepare`, `start`, and
`abort` messages until the server thread drains them. A 129th undrained command
fails the session and closes the connection. The outbound message queue is
separately bounded at 256 messages; it also fails the session on overflow
rather than dropping messages.

## Message contract

`schemas/control.schema.json` is the wire shape authority. Java DTOs mirror the
same names and enum values, with cross-language positive and negative fixtures
under `fixtures/protocol/control-*.json`.

- `hello` is `{token, capabilities}`. `ready` is `{server:{name,version,
  minecraft_version,protocol_version}, plugin:{name,version}, capabilities}`.
  An `ack` has an empty payload. Both `ready` and `ack` carry the initiating
  sequence in `correlation`. The codec validates the sequence format, but the
  runtime session must track pending requests and reject acknowledgments whose
  correlation has no outstanding request before treating an `ack` as complete.
- `heartbeat` and `start` have empty payloads. `start` enters the prepared
  match lifecycle. `abort` carries one closed `reason` value: `operator`,
  `lease_lost`, `invalid_world`, `protocol_error`, or `runtime_timeout`.
- `build_progress` reports only its stage and bounded completed/total counts.
  `prepare` carries `map_semantic_id`, `scenario_semantic_id`, `seed`, `mode`,
  `settings`, and `roster`. Hunger Games settings contain the resolved scenario
  `match` and `border` fields. Civilization settings are defined below.
- Every roster entry has `kind`, `seat`, `participant_id`, `username`, and
  `offline_uuid`. A legacy roster holds one to six `bot` entries with seats
  ordered, contiguous, and bounded to zero through five. The generalized roster
  is defined below. Non-roster players are spectators and cannot claim a
  competitive seat.
- `public_clock` reports phase, authoritative countdown/match tick, and border
  diameter. `public_state` reports alive seat IDs. `elimination` reports the
  ordered seat and cause at one authoritative tick. `outcome` is the sole
  terminal event and is one of winner, draw, or abort, with survivors, reason,
  and authoritative tick where one exists. There is no separate `finish`
  message.
- `metrics` contains bounded public operational counters. `error` contains a
  closed code and a non-secret message.
- `mechanics_receipt` carries evaluator-only UHC duel observations. The runner
  accepts it only when the plugin advertises `duel_mechanics_v1`. Each payload
  has one match tick and at most six receipts per seat.
  - `lateral_movement` records once after the player moves at least one block
    sideways relative to its heading. The plugin does not stream positions.
  - `distance_maintained` records ten consecutive server ticks with opponent
    distance greater than four and at most 40 blocks.
  - `ranged_projectile_release` records an arrow launch by a competitor.
  - `shield_blocking_transition` records the blocking state Paper reports at
    server tick end.
  - `golden_apple_consume` distinguishes ordinary and enchanted golden apples.
  - Competitor contact uses the existing `damage` event. Its attacker seat and
    match tick identify the contact. Evaluators pair server events with client
    action records by seat and match tick. Policies do not receive these events.

The command acknowledgment marks processing on the plugin's server thread. It
precedes the authority effects caused by that command. While an `abort` awaits
its matching acknowledgment, nonterminal clocks, alive-seat states, faction capture/score states, and
eliminations from the running match may already be in flight and remain valid
in their plugin sequence order. An aborted or finished clock and every outcome
still require the outstanding acknowledgment first. `prepare` and `start`
retain the stricter rule that authority follows their acknowledgments. A wrong
or absent acknowledgment, invalid state progression, or authority after the
terminal outcome fails reconstruction. A natural terminal outcome racing a
queued abort has no special acceptance path.

Clock, alive-seat, elimination, outcome, and metrics messages are evaluator
events. They must not be copied unfiltered into a policy observation. A policy
gets only its own Mineflayer client's received observations and explicit team
messages; the control channel's public state does not authorize access to
hidden world data, entities, health, inventories, or seed.

## Generalized roster

The closed `hunger_games_roster_v2` capability gates the generalized roster.
The envelope `protocol` stays 1. A Hunger Games `prepare` selects it with the
required field `roster_version: 2`; the field is rejected on every other
variant, including civilization, and any value other than 2 is rejected. The
`mode` stays `hunger_games` and `settings` keep their shape.

The roster holds one to 256 entries with seats ordered, contiguous, and
bounded to zero through 255. Each entry's `kind` is `bot` or `external`. Every
`offline_uuid` must equal the Minecraft offline UUID derived from the entry's
`username` (MD5 of `OfflinePlayer:<username>` with version-3 and variant bits).
Usernames and UUIDs are unique ignoring case. An `external` username has 3
through 16 ASCII letters, digits, or underscores and cannot begin with
`ArenaBot` or `ArenaSpec` in any case, so spectator identities and runner bot
identities never collide with external seats. The plugin accepts a roster-version-2 `prepare` against a schema-3 natural
plan when the seats, kinds, and external usernames match that plan. It also
accepts that prepare against a schema-1 planned plan when `rules.kind` is
`uhc_duel` and the roster seats match the planned spawns. Any other
roster-version-2 prepare is rejected against a schema-1 plan. A legacy
`prepare` is accepted against a schema-1 or schema-2 plan.

`public_state`, `elimination`, and winner outcomes accept seats zero through
255, up to 256 per list. The codec cannot know the roster size, so the
runtime and plugin still require every reported seat to belong to the prepared
roster. Civilization events and settings keep seats zero through five.
`fixtures/protocol/control-prepare-roster-v2*.json` and the
`control-invalid-roster-*` fixtures define the interoperable shapes.

### Rule modes

A roster-version-2 `prepare` may carry `rules`; its absence is the classic
Hunger Games rule set, and `rules` is rejected without `roster_version`.
`{kind: "frontier_survival", version: 1, edit_radius_blocks: 16-512,
max_block_edits_per_seat: 1-100000}` requires block breaking and placing on
with mobs and random ticks off in `settings.match`. `{kind: "squads",
version: 1, squads: [{id, seats}]}` declares 2 to 64 uniquely named squads
whose ascending seats partition every roster seat, and requires the classic
block rules. `{kind: "uhc_duel", version: 1, kit: {armor, sword, arrows,
golden_apples, food, food_count, shield?}}` requires exactly two roster seats
and the classic match booleans, including `respawn: false`. `armor` and
`sword` are material tokens, `food` is a closed Minecraft item id, and
`shield` may be omitted, which means no shield. The codec rejects unknown
kit items, a per-seat kit field, a missing required kit field, and any other
roster size. The plugin gives that one kit to each admitted competitor and
sets natural regeneration off. Classic prepares without `rules` are unchanged.
The codec and the plugin both check these cross-field rules. Scenario schema
4 adds no control field. A planned uhc laboratory stays world-plan schema 1
and sends the same roster-version-2 `rules` object as a natural uhc duel, so
the plugin applies that one kit and turns natural regeneration off. A legacy
prepare still rejects `rules`. A schema-1 hunger scenario stays on the legacy
prepare.

## Tick metrics

The closed `tick_metrics_v1` capability announces authoritative tick service
time. Once per second after `prepare` the plugin sends `metrics` with
`server_tick_duration_micros` (the latest tick), `critical_queue_depth` (the
plugin's outbound queue depth), `dropped_optional_metrics` (a running count),
and `tick_durations_micros`, 1 to 20 integers ordered oldest first, taken from
Paper's `ServerTickEndEvent` tick duration. `tick_durations_micros` is optional
on the wire so older metrics stay valid, and the receiver rejects it from a
plugin that did not announce the capability. Metrics are optional traffic: when
the outbound queue is at least half full the plugin skips the message and
counts it in `dropped_optional_metrics`; it never blocks the tick thread and
never fails the session. Samples are recorded in a fixed 20-entry ring with no
per-tick allocation.

## Damage events

The closed `damage_events_v1` capability gates the evaluator-only `damage`
event. The runner opts in per match with `damage_events: true` on a
roster-version-2 `prepare`; without it the plugin emits none. The envelope
`protocol` stays 1.

`damage` is `{at, entries}` with a match tick and 1 to 2,048 entries. Each
entry is `{victim, attacker, cause, amount, attacker_is_competitor}`: the
victim seat, the attacking competitor's seat or `null` for environment and
non-competitor sources, the cause category (`melee`, `projectile`, `border`,
`fall`, `fire`, `starvation`, `other`), the summed final damage in half
hearts, and a flag that is true exactly when `attacker` is a seat. An
attacker seat is valid only for `melee`, `projectile`, or `other`.

The plugin sends at most one `damage` message per match tick, before that
tick's `elimination`, covering only living competitors in `grace` or
`active`. Entries are aggregated per victim, attacker, and cause and ordered
by victim, attacker, cause. A victim has at most 8 entries per tick; when it
has more, the first 7 stay individual and the rest fold into one
`attacker: null`, `cause: other` entry that keeps the total amount. That bounds
a 256-seat tick to 2,048 entries, about 190 KiB, under the frame limit. Like
eliminations the event is critical: the runner must not drop or coalesce it.
`damage` is evaluator data and must never be copied into a policy input.

## Checkpoint and resume

The closed `checkpoint_v1` capability gates three additions; the envelope
`protocol` stays 1.

- `checkpoint` (runner to plugin) is `{checkpoint_id, epoch}`. The plugin
  accepts it once, for a prepared generalized-roster Hunger Games match in
  `grace` or `active`, and only when `epoch` equals its runtime epoch;
  anything else is rejected with `invalid_state`. After the acknowledgment
  the plugin resolves the current tick's eliminations, then stops advancing
  the match: no clock, public-state, elimination, or outcome event is
  produced after the barrier tick. Heartbeats continue.
- `checkpoint_written` (plugin to runner) is `{checkpoint_id, epoch,
  match_tick, digest, byte_length}`. `digest` is the SHA-256 of the record
  body and `match_tick` is the barrier tick that the resumed match will run
  next. A failed write is reported as an `error` correlated to the
  `checkpoint` sequence and leaves no complete record. The runner then stops
  Paper; there is no live pause.
- A roster-version-2 `prepare` may carry `resume: {checkpoint_digest, epoch}`.
  It is valid only when the server was started with `-Darena.resume-checkpoint`
  naming a complete record, the digest matches that record, `epoch` is the
  record's epoch plus one, and the rest of the payload equals the saved
  prepare. A server started with a checkpoint accepts only a resume prepare.
  `start` then resumes the clock once every living seat has rejoined.

The checkpoint file is one canonical JSON body followed by a newline and the
trailer `#arena-checkpoint-complete v1 sha256=<hex> bytes=<n>`. It is written
to `<name>.partial`, forced to disk, and renamed atomically, so a missing,
truncated, or mismatched trailer is an explicitly incomplete record. The
strict reader rejects unknown fields, other schema versions, seats whose
identity or liveness disagrees with the roster and eliminations, and fewer
than two living seats. The body holds the schema, ids, epoch, world identity,
the original prepare (roster, rules, match and border settings), match tick,
border diameter, eliminations with cause and tick, every seat's identity and
liveness, saved position, health, hunger, saturation, selected slot and
inventory for living seats, and an opaque versioned `extension` slot for
faction or job state. Fixtures are under `fixtures/checkpoint/` and
`fixtures/protocol/control-*checkpoint*` and `control-*resume*`.

## Civilization control-v1

Control-v1 adds the closed `civilization_v1` capability and `prepare.mode = civilization` variant. Hunger Games frames retain their existing shapes. A handshake advertising only `hunger_games_v1` rejects `civilization_state`, `faction_winner`, and draws carrying faction scores. Authentication still precedes capability checks; readiness must repeat the authenticated capability set exactly.

Civilization preparation uses the existing numeric-string u64 envelope and roster, exactly six bot seats, fixed 192-block border, 2400 grace ticks, 18000 maximum ticks, no respawn, and enabled block breaking and placing. Its `civilization` settings contain factions ordered ember then tide (seats 0–2 and 3–5 with gatherer/crafter, builder, defender/scout roles), the canonical bread/wooden-tool kit, inclusive capture-zone bounds, and the `oak-outpost-v1` anchors. The four civilization protocol fixtures define the exact interoperable field shapes; unknown fields and variants are rejected.

`civilization_state` publishes an authoritative match tick, ordered living capture-zone occupants, nullable `owner_faction` and `challenger_faction`, canonical decimal-string `capture_progress_ticks`, and scores ordered ember then tide as `{faction_id,points}`. Outcomes use `kind = faction_winner`, `winner_faction_id`, `reason = elimination | tick_limit`, exact faction scores, survivors, and an authoritative match tick. Civilization draws add the same scores to the existing draw shape. Aborts retain the shared abort shape. The plugin emits the final civilization state before the terminal clock and outcome at the exact outcome tick.

Civilization capture-zone and blueprint block positions use nonnegative safe-integer X/Z map indices and signed safe-integer Y heights (−9007199254740991 through 9007199254740991). Negative world heights accepted by the map compiler remain valid in control preparation.
