# TypeScript runtime lifecycle

`runPreparedRun` owns one run's Paper process, loopback control session, Mineflayer clients, run lease, trace, and cleanup. The runner stores the match under `.work/arena/runs/<run-id>`.

## Start a run

The runner resolves the scenario and policy, acquires the run lease, and builds or reuses a pristine world template under `.work/arena/templates/`. It clones that stopped template into the run's `server/world` directory, stages Paper files, binds an ephemeral loopback control listener, and starts Paper.

The plugin connects to the listener with the per-run credential. After authentication, the runner checks the plugin identity and mode capability before sending `prepare`. It connects each configured competitor and spectator. The runner sends `start` after all owned clients connect, or after an external player joins when `waitForExternalPlayer` is enabled.

The Paper plugin owns match state and outcomes. The runner gives policy code only the observations produced by each competitor's Mineflayer client and permitted team messages.

## Stop a run

After the terminal outcome, the runner stops policy decisions, joins active skills, closes clients, stops and reaps Paper, closes the control connection, finalizes trace segments, reads stopped player statistics, and releases the run lease.

On failure or cancellation, cleanup preserves the primary error and reports cleanup errors separately. The runner retains partial evidence and does not invent a terminal match outcome.
