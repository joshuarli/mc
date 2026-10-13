# TypeScript runtime lifecycle

`runPreparedRun` owns the Paper process, control listener, Mineflayer clients, run lease, trace, and cleanup. It uses a fresh run directory and clones the immutable prepared world template into `server/world` before starting the match server. Competitors are headless bots; scenario spectator capacity is filled by separate spectator clients. Paper binds game traffic to `127.0.0.1:25565`.

The runtime authenticates the plugin over a loopback control socket, validates its ready identity against the repository plugin descriptor, sends the compiled prepare command, waits for all clients, and then starts the match or passes control to an evaluator. The plugin owns player modes. After a terminal event, the runtime stops issuing policy decisions, joins active skills, stops and reaps Paper, finalizes the v2 trace, reads stopped player stats, and releases the run lease.

The CLI applies a 180 second cold-start deadline, a 60 second per-server readiness deadline, and a 600 second wall deadline. Deadlines fail with a structured runtime timeout. Cleanup preserves the initiating error and reports cleanup failure separately. An interrupted run retains its structured failure artifact and any completed trace checkpoints; the runtime does not invent a terminal outcome.

## Integration selectors

- `./arena test --suite integration --case lifecycle-smoke` runs one real short match, checks Paper reaping and both game/control socket release, then uses the GC CLI to archive the exact trace and stopped stats before removing the live run directory.
- `./arena test --suite integration --case lifecycle` repeats that lifecycle ten times sequentially and archives every two completed runs. This keeps the number of live run directories below the native helper's ten-run limit while preserving their evidence in the archive.
- `./arena test --suite integration --case faults` covers an occupied game port, a competing run-lease owner, a mismatched loaded plugin, an externally killed Paper process, and SIGINT cancellation through the CLI process. Interrupted cases check their failure artifact and actual partial trace and assert that no plugin outcome was recorded.

## Focused failure coverage

The live selectors and focused source tests cover distinct parts of runtime failure handling:

| Behavior | Evidence |
| --- | --- |
| Ten real start-stop cycles and resource cleanup | `tests/integration/lifecycle.ts`, selectors `lifecycle-smoke` and `lifecycle`; checks live control and bot sockets, process reaping, port reuse, archival, retained stats and trace, and removal of completed run directories. |
| Occupied game port does not stop its owner | `tests/integration/faults.ts`, selector `faults-port-conflict`; `runtime-process.test.ts`, test `owned server detects a Paper bind failure across output chunks as an owner conflict`. |
| A second runtime cannot take the run lease | `tests/integration/faults.ts`, selector `faults-second-owner`; `owned-files-native.test.ts`, tests `stages runtime files, creates private plugin directories, and locks a run exclusively` and `asserts that a held lease matches the owned run identity`. |
| Loaded plugin identity matches the shipped descriptor | `tests/integration/faults.ts`, selector `faults-plugin-identity`; `runtime-plugin-identity.test.ts`, tests `runtime rejects a ready message with a plugin identity different from the shipped descriptor` and `runtime plugin descriptor requires exactly one supported name and version`. |
| Server crash, controller disconnect, and truthful interrupted evidence | `tests/integration/faults.ts`, selector `faults-server-crash`; `runtime-session.test.ts`, test `control session reports an unexpected plugin disconnect`; `runtime-failure-artifact.test.ts`, test `runtime failure evidence records the primary error and cleanup result`. The live case requires a failure artifact and partial trace without a plugin outcome. |
| CLI Ctrl-C preserves cancellation and incomplete evidence | `tests/integration/faults.ts`, selector `faults-sigint`; `runtime-session.test.ts`, tests `canceling plugin acceptance releases the loopback listener` and `closing the listener cancels a connection waiting for its authenticated hello`. |
| Bad token, protocol version, frame, and acknowledgement correlation | `runtime-session.test.ts`, tests `control listener rejects a plugin with the wrong token and closes its socket`, `control listener rejects an unsupported protocol version and closes its socket`, `control listener rejects a malformed frame and closes its socket`, and `control session closes the connection on an uncorrelated acknowledgment`; `control-codec.test.ts`, tests `control frames use one big-endian length and reject mismatches` and `control schema rejects duplicate JSON keys before DTO validation`. |
| Owned filesystem path, lease, clone, and staging boundaries | `owned-files-native.test.ts`, tests `rejects traversal, symlink components, and reads beyond the bound`, `preserves non-UTF-8 path bytes where the host filesystem accepts them`, `releases a run lease when its owning process exits`, `a signalled clone removes its identity-owned staging directory before publication`, and `does not publish a replacement swapped into a staged temporary name`. |

There is no disk-full simulation or end-to-end Java control-queue saturation proof. The tests also do not claim that every partial Paper initialization failure has a separate live integration case.
