# TypeScript runtime lifecycle

`runPreparedRun` owns one run's Paper process, loopback control session, Mineflayer clients, run lease, trace, and cleanup. The runner stores the match under `.work/arena/runs/<run-id>`.

## Start a run

The runner resolves the scenario and policy, acquires the run lease, and builds or reuses a pristine world template under `.work/arena/templates/`. It clones that stopped template into the run's `server/world` directory, stages Paper files, binds an ephemeral loopback control listener, and starts Paper.

The plugin connects to the listener with the per-run credential. After authentication, the runner checks the plugin identity and mode capabilities before sending `prepare`. Schema 3 scenarios, and any run with an external seat, require `hunger_games_roster_v2`; they stage world plan schema 3 and send `prepare` with `roster_version: 2`. Schema 1 and 2 scenarios without an external seat keep the six-seat roster. The runner connects each bot competitor and each automated spectator, and `start` follows admission.

## Admission

The effective roster is resolved before staging and recorded in the prepare record and the stdout result. Each external seat carries a reserved username and its offline UUID. The runner owns no client for an external seat.

Before `start`, the runner waits until every reserved identity is present in the server's player list with its exact username and offline UUID. A different username, a case variant, or the right name with another UUID does not satisfy the wait. The wait is bounded by `externalJoinTimeoutMs` (default 120 s). On expiry the run fails with `external_join_timeout` before the countdown and goes through ordinary cleanup, as does cancellation during the wait. Without an external seat, `waitForExternalPlayer` keeps its spectator behavior: any username outside the runtime roster satisfies the wait, with no deadline unless `externalJoinTimeoutMs` is set.

The plugin owns the binding. It rejects wrong and duplicate identities, and treats a reserved identity that joins after the countdown, reconnects, or has been eliminated as a spectator.

## Event bounds

The runtime rejects an authoritative event whose seats fall outside the prepared roster with `seat_outside_roster`. The codec accepts seats 0 to 255.

The Paper plugin owns match state and outcomes. The runner gives policy code only the observations produced by each competitor's Mineflayer client and permitted team messages.

## Stop a run

After the terminal outcome, the runner stops policy decisions, joins active skills, closes clients, stops and reaps Paper, closes the control connection, finalizes trace segments, reads stopped player statistics, and releases the run lease.

On failure or cancellation, cleanup preserves the primary error and reports cleanup errors separately. The runner retains partial evidence and does not invent a terminal match outcome.
