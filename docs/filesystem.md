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
still match.

`stageWorldPlan` accepts at most 128 MiB. It creates a random, exclusive,
same-directory temporary file with mode `0600`, writes at most the caller's
limit, syncs the file, then publishes it with `linkat`, which fails if the
destination already exists. It removes the temporary name and syncs the parent
directory before reporting success. A failed or cancelled operation attempts
to remove only temporary or published entries whose device and inode match
the identity returned by the helper.

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
limit. `removeCreatedFile` and `removeCreatedDirectory` accept the identity
returned at creation and reject an entry whose type or device/inode differs.
Directory removal is non-recursive.

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
