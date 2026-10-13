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

The plugin's first message is authenticated `hello`, with the `hunger_games_v1`
capability. The runner acknowledges that sequence, then the plugin sends
`ready` with the acknowledgment sequence as its correlation and the Paper,
Minecraft, protocol, plugin, and capability identities. The runner accepts no
commands until this handshake completes. The plugin sends a heartbeat every
second. `ControlReceiver` performs run, sequence, authentication, capability,
and handshake checks before returning an accepted message to the caller.
The runtime also requires the announced plugin name and version to match the
shipped `server/arena-plugin/src/main/resources/plugin.yml` descriptor before
it prepares the match.

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
  `settings`, and `roster`. P0 accepts `mode: "hunger_games"`. Its `settings`
  contain the resolved scenario `match` and `border` fields with their source
  names and no Java-side defaults. Civilization settings are unsupported until
  their schema and values are defined.
- Every roster entry is a fixed bot identity with `kind`, `seat`,
  `participant_id`, `username`, and `offline_uuid`. Seats are ordered,
  contiguous, and bounded to zero through five. Non-roster players are
  spectators and cannot claim a competitive seat.
- `public_clock` reports phase, authoritative countdown/match tick, and border
  diameter. `public_state` reports alive seat IDs. `elimination` reports the
  ordered seat and cause at one authoritative tick. `outcome` is the sole
  terminal event and is one of winner, draw, or abort, with survivors, reason,
  and authoritative tick where one exists. There is no separate `finish`
  message.
- `metrics` contains bounded public operational counters. `error` contains a
  closed code and a non-secret message.

Clock, alive-seat, elimination, outcome, and metrics messages are evaluator
events. They must not be copied unfiltered into a policy observation. A policy
gets only its own Mineflayer client's received observations and explicit team
messages; the control channel's public state does not authorize access to
hidden world data, entities, health, inventories, or seed.
