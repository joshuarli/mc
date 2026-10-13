#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exclude=$(git -C "$root" rev-parse --git-path info/exclude)
[ -f "$exclude" ] || {
    printf 'ci: repository-local Git exclude file is unavailable: %s\n' "$exclude" >&2
    exit 2
}
if ! grep -Fqx '.work/' "$exclude"; then
    printf '\n.work/\n' >> "$exclude"
fi
export CARGO_HOME="$root/.work/arena/cargo"
export RUSTUP_HOME="$root/.work/arena/rustup"
export TMPDIR="$root/.work/tmp"

ensure_directory() {
    path=$1
    [ ! -L "$path" ] || {
        printf 'ci: path must not be a symlink: %s\n' "$path" >&2
        exit 2
    }
    if [ ! -d "$path" ]; then
        mkdir "$path" || {
            printf 'ci: could not create directory: %s\n' "$path" >&2
            exit 2
        }
    fi
    [ -d "$path" ] && [ ! -L "$path" ] || {
        printf 'ci: path must be a real directory: %s\n' "$path" >&2
        exit 2
    }
}

ensure_directory "$root/.work"
ensure_directory "$root/.work/arena"
ensure_directory "$root/.work/tmp"
ensure_directory "$CARGO_HOME"
ensure_directory "$RUSTUP_HOME"

rust_toolchain=$(awk -F '"' '$1 ~ /^rust_toolchain = / { print $2; matches++ } END { if (matches != 1) exit 1 }' "$root/versions.lock.toml") || {
    printf '%s\n' 'ci: versions.lock.toml must contain one Azalea rust_toolchain' >&2
    exit 2
}
kache_version=$(awk -F '"' '
    /^\[ci\]$/ { active = 1; next }
    active && /^\[/ { active = 0 }
    active && /^kache_version = / { print $2; matches++ }
    END { if (matches != 1) exit 1 }
' "$root/versions.lock.toml") || {
    printf '%s\n' 'ci: versions.lock.toml must contain one ci.kache_version' >&2
    exit 2
}

rustup toolchain install "$rust_toolchain" --profile minimal --no-self-update
cargo "+$rust_toolchain" --config 'build.rustc-wrapper=""' install \
    --locked --version "$kache_version" kache --root "$CARGO_HOME"
printf '%s\n' "$CARGO_HOME/bin" >> "$GITHUB_PATH"
