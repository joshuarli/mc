# TypeScript runtime lifecycle

`runPreparedRun` owns the Paper process, control listener, Mineflayer clients, run lease, trace, and cleanup. It uses a fresh run directory and clones the immutable prepared world template into `server/world` before starting the match server. Competitors are headless bots; scenario spectator capacity is filled by separate spectator clients. Paper binds game traffic to `127.0.0.1:25565`.

The runtime authenticates the plugin over a loopback control socket, validates its ready identity against the repository plugin descriptor, sends the compiled prepare command, waits for all clients, and then starts the match or passes control to an evaluator. The plugin owns player modes. After a terminal event, the runtime stops issuing policy decisions, joins active skills, stops and reaps Paper, finalizes the v2 trace, reads stopped player stats, and releases the run lease.

The CLI applies a 180 second cold-start deadline, a 60 second per-server readiness deadline, and a 600 second wall deadline. Deadlines fail with a structured runtime timeout. Cleanup preserves the initiating error and reports cleanup failure separately. An interrupted run retains its structured failure artifact and any completed trace checkpoints; the runtime does not invent a terminal outcome.

## Integration selectors

- `./arena test --suite integration --case lifecycle-smoke` runs one real short match, checks Paper reaping and both game/control socket release, then uses the GC CLI to archive the exact trace and stopped stats before removing the live run directory.
- `./arena test --suite integration --case lifecycle` repeats that lifecycle ten times sequentially and archives every two completed runs. This keeps the number of live run directories below the native helper's ten-run limit while preserving their evidence in the archive.
- `./arena test --suite integration --case faults` covers an occupied game port, a competing run-lease owner, a mismatched loaded plugin, an externally killed Paper process, and SIGINT cancellation through the CLI process. Interrupted cases check their failure artifact and actual partial trace and assert that no plugin outcome was recorded.

## Focused failure coverage

The live integration cases are supplemented by narrow boundary tests:

- `runtime-session.test.ts` covers wrong-token authentication, unsupported protocol versions, malformed frames, unexpected plugin disconnect, acknowledgement correlation, and listener cancellation.
- `control-codec.test.ts` covers length mismatch, oversized bodies, noncanonical and overflowing values, unknown fields, and duplicate JSON keys.
- `runtime-process.test.ts` covers Paper bind-error classification, child exit, and graceful shutdown.
- `owned-files-native.test.ts` covers traversal and symlink rejection, bounded reads and clones, non-UTF-8 path bytes, lease release on owner exit, and atomic staging and clone publication.

These tests do not claim a disk-full simulation or an end-to-end Java control-queue saturation proof.
