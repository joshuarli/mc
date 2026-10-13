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
path when known, and any known identity. Each exported operation takes one
named request object so the root, relative path, size limit, and cancellation
signal stay distinct at the call site.

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
