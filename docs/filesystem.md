# Owned files

The runner stores run data beneath an absolute owned root. Paths crossing the
TypeScript/native boundary are `Buffer` values so POSIX path bytes are not
decoded or re-encoded as UTF-8. Relative paths use `/` separators and reject
absolute paths, empty components, `.` and `..`. The native helper opens the
root and walks every component with directory handles and `O_NOFOLLOW`. It
rejects symlink components, non-directory parents, and parents that are
group/world writable or owned by another non-root user.

The helper is a small C program because Node's filesystem API does not expose
the handle-relative operations needed for the component walk. Build it with
`make -C native/arena-fs build`; the binary is written to `.work/arena-fs/`.
The source supports Darwin arm64 and Linux x86_64. It adds no package or native
library dependency.

`createRunDirectory` creates missing ancestors with mode `0700`, creates the
requested run directory with mode `0700`, and syncs each changed directory.
It returns the created directory's device and inode. On failure, it removes
directories created by that call in reverse order when their type and identity
still match. Creating an immediate run directory under `.work/arena/runs`
serializes against other owned-run creators and removals, and the helper caps
that directory at 10 real run directories.

`stageWorldPlan` accepts at most 128 MiB. It creates a random, exclusive,
same-directory temporary file with mode `0600`, writes at most the caller's
limit, and syncs the open file. It publishes that same inode with an atomic
no-replace rename, then compares the destination to the still-open file handle
before reporting success. A failed or cancelled operation attempts to remove
only temporary or published entries whose type and device/inode match the
identity returned by the helper.

`stageOwnedFile` uses the same atomic no-overwrite protocol for runtime-owned
files such as `server.properties`, `eula.txt`, and plugin JARs. Its hard limit
is 256 MiB, with a smaller per-call limit available. `createOwnedDirectory`
creates private `0700` directories for runtime-owned content such as
`plugins/`; like `createRunDirectory`, it creates missing ancestors and
returns the leaf identity.

`acquireOwnedRunLease` keeps a native helper alive while it holds an exclusive
`flock` on the persistent `.arena-run.lock` file inside a run directory. A
second lease for that run fails while the first is held. Releasing the lease
closes its control pipe and waits for the helper to exit. The lock file stays
in place after release so concurrent processes never lock different inodes.
The optional signal cancels acquisition; use `release()` to end an acquired
lease. If the owning process exits, its closed control pipe releases the lock.

`listOwnedRuns` returns a read-only snapshot of valid immediate run directories
under `.work/arena/runs`, sorted by ASCII run ID. Each entry contains the
directory identity and modification time, plus modification times for the
terminal consecutive trace segment and `operational-failure-v1.json` when
present. The terminal trace sequence is included with its modification time.
It does not create the runs directory or acquire run leases.
`removeOwnedRun` removes only `.work/arena/runs/<run-id>` and requires the
matching active lease and directory identity from that owned root. The helper
checks the run identity before each detach, never follows nested symlinks, and
preflights a maximum of 1,000,000 entries, 64 directory levels, and 64 GiB of
logical leaf data. Nested symlinks are removed as links, leaving their targets
untouched. Cancellation or an I/O failure can leave a partially removed tree;
the error is returned to the caller.

`cloneOwnedTree` copies a stopped, pristine tree from one relative path under
the owned root to a fresh destination. It copies bytes into private files and
directories; it creates no hardlinks or symlinks. It rejects symlinks,
non-regular files, non-directories, and mount/device crossings, and checks
source file and directory metadata before and after copying. Callers provide
limits up to 100,000 regular files and 16 GiB total file data. The helper also
bounds its internal entry list and stored path data. The source and destination
cannot overlap.

The clone is assembled in a random, private sibling directory. Once every
copied file and directory is synced, Darwin publishes it with
`renameatx_np(RENAME_EXCL)` and Linux with `renameat2(RENAME_NOREPLACE)`; a
destination that already exists is never replaced. Cancellation before
publication removes identity-matched staging entries. If cancellation arrives
after publication, the helper attempts identity-matched cleanup. If the helper
or host is killed before cleanup completes, the destination may be absent,
present, or unknown to the caller; `OwnedFilesError.clonePublication` reports
that state when it can be established. A leftover staging directory after a
process or host crash is not reused as a completed clone.

`readOwnedFile` opens the leaf without following symlinks, requires a regular
file, and reads at most 16 MiB or the smaller caller limit. It checks the
opened handle while reading, so growth during the read cannot exceed the
limit. `readOwnedFileWithIdentity` also returns the device and inode from that
opened handle; `readOwnedFile` returns only the bytes. `removeCreatedFile` and
`removeCreatedDirectory` accept the identity
returned at creation and reject an entry whose type or device/inode differs.
Before unlinking, the helper atomically moves the leaf to a random sibling name,
checks that moved entry's identity, and restores it if the identity differs.
Directory removal is non-recursive.

`inspectOwnedResources` reads available bytes on the filesystem containing
`.work/arena` and totals logical leaf sizes beneath that directory. If the
arena directory is absent, its usage and run count are zero; available bytes
come from the nearest existing directory among the owned root, `.work`, and
`.work/arena`. `workBytes` includes run data and traces. `dependencyBytes`
excludes only the top-level `runs` and `traces` trees. Symlinks count by their
own link size and are never followed. `runCount` counts immediate real
directories in `runs`. The scan fails on special files, filesystem crossings,
more than 1,000,000 entries, nesting beyond 64 directories, or more than 64
GiB of logical leaf data. An optional `AbortSignal` cancels the inspection.

The owned root is a private, single-owner runtime namespace. Only its owning
runner may mutate it, and it must serialize operations that can change the same
artifact. The helper verifies a staged inode after publication and moves a
removal target to a random sibling before checking its identity. POSIX provides
no conditional rename or unlink-by-inode operation, so an arbitrary process
with the same user ID that concurrently mutates the root, including one that
discovers and replaces a random helper name, cannot be excluded by file
permissions. Do not share the owned root with another mutating process.

The runner wrapper starts the helper without a shell, streams plan bytes over
stdin, bounds helper output, and uses an `AbortSignal` for cancellation. It
retains native creation events and attempts identity-checked cleanup after an
operation fails or is cancelled. `OwnedFilesError` reports the operation,
category, errno, cleanup errno, whether a published file remains, the relative
path when known, any known identity, and clone publication state when relevant.
Each exported operation takes one named request object so the root, relative
path, size limit, and cancellation signal stay distinct at the call site.

## Raw command-line arguments

Node exposes `process.argv` as strings, which cannot represent arbitrary POSIX
argument bytes. The `launch-node` helper mode copies arguments after the CLI
entry point into the versioned `ARENA_RAW_ARGV_V1` channel before executing
Node. `consumeRawArgv()` captures and removes that environment variable on its
first call, validates the exact bytes against Node's argument vector, and
returns copies of the arguments as buffers, or `undefined` when no launcher
channel was provided. Call it at the CLI boundary before interpreting path
arguments. `encodeStringArguments()` explicitly converts already-decoded
strings for callers that guarantee UTF-8 input; it cannot recover bytes lost
by a direct Node launch. Use `rawArgumentText()` only for arguments that are
required to be valid UTF-8; it fails on invalid bytes.

The channel accepts at most 4,096 arguments, 48 KiB of combined argument bytes,
and 64 KiB of encoded channel data. The native launcher fails with an error if
any limit is exceeded. An invalid or mismatched channel is a protocol error;
it is never silently replaced with Node's lossy string representation.
