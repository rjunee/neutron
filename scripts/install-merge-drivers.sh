#!/usr/bin/env bash
#
# scripts/install-merge-drivers.sh — teach this clone how to merge `docs/AS_BUILT.md`.
#
#   bash scripts/install-merge-drivers.sh              # install
#   bash scripts/install-merge-drivers.sh --check      # exit 0 iff already installed
#   bash scripts/install-merge-drivers.sh --uninstall  # remove
#
# Idempotent, and safe to run from any working tree of the repo (including a linked worktree —
# both the config and the attributes file live in the COMMON git dir, so installing once serves
# every worktree, which is what the publisher's throwaway rebase worktree depends on).
#
# WHAT IT INSTALLS, AND WHY BOTH HALVES GO IN TOGETHER
# ---------------------------------------------------
#   1. `merge.as-built-log.driver` in the repo config — the command git runs.
#   2. `docs/AS_BUILT.md merge=as-built-log` in `$GIT_COMMON_DIR/info/attributes` — the binding
#      from the path to that command.
#
# Half (2) deliberately does NOT live in a tracked `.gitattributes`. MEASURED on git 2.50.1
# (Apple Git-155), a fresh repo with `log.txt merge=as-built-log` and two branches editing the same
# region:
#
#   - no `merge.as-built-log.*` config at all → NOT fatal. git falls back to the ordinary text
#     merge: exit 1, `CONFLICT (content)`, conflict markers.
#   - `merge.as-built-log.name` set with no `.driver` → THAT is the fatal one:
#         fatal: custom merge driver as-built-log lacks command line.   (exit 128)
#   - both `.name` and `.driver` set → exit 0, the driver's output.
#
# An earlier revision of this comment claimed exit 128 for the FIRST case as well. It does not
# happen, and the true behaviour is the better argument anyway: `docs/AS_BUILT.md merge=union` IS
# tracked, and it is the floor every clone gets. A committed `merge=as-built-log` line would
# OVERRIDE that union floor with a driver nobody has configured, so every clone that had not run
# this script would quietly go back to conflicting on the log — the exact regression
# `scripts/ci/check-governed-repo-attributes.ts` now gates.
#
# The third case is why the two config keys go in together or not at all: half-installed IS the
# exit-128 state, for `git merge` and for the `git apply --3way` the publisher uses. Keeping the
# binding untracked means the attribute and its driver arrive together; a clone that never runs
# this behaves exactly as it does today. Same rule `install-git-hooks.sh` applies to the leak gate
# and its denylist.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIVER_NAME="as-built-log"
LOG_PATH="docs/AS_BUILT.md"
ATTR_LINE="$LOG_PATH merge=$DRIVER_NAME"
DRIVER_SCRIPT="$ROOT/scripts/git/as-built-merge-driver.ts"

if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install-merge-drivers: $ROOT is not a git repository" >&2
  exit 2
fi

# The COMMON git dir, not the per-worktree one: a linked worktree has its own $GIT_DIR but reads
# attributes and config from the common one, so installing there serves every worktree at once.
COMMON="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
if [ -z "$COMMON" ]; then
  COMMON="$(git -C "$ROOT" rev-parse --git-common-dir)"
  case "$COMMON" in /*) ;; *) COMMON="$ROOT/$COMMON" ;; esac
fi
ATTRS="$COMMON/info/attributes"

# The scratch file is PER-PROCESS and the replacement is an atomic rename.
#
# Two build lanes sharing a checkout can run this at the same moment — which is the exact situation
# this whole change exists to serve, so a shared `$ATTRS.tmp` here would be its own concurrency bug:
# both would write the same scratch path and one could rename a half-written file over the
# attributes. `$$` makes the scratch private and `mv` within the directory is atomic, so a racing
# reader sees either the old file or the new one and never a partial one.
remove_attr_line() {
  [ -f "$ATTRS" ] || return 0
  local tmp="$ATTRS.tmp.$$"
  grep -v -x -F "$ATTR_LINE" "$ATTRS" > "$tmp" 2>/dev/null || : > "$tmp"
  mv "$tmp" "$ATTRS"
}

if [ "${1:-}" = "--uninstall" ]; then
  git -C "$ROOT" config --unset "merge.$DRIVER_NAME.driver" 2>/dev/null
  git -C "$ROOT" config --unset "merge.$DRIVER_NAME.name" 2>/dev/null
  remove_attr_line
  echo "merge drivers: uninstalled — $LOG_PATH merges with git's default again"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  configured="$(git -C "$ROOT" config --get "merge.$DRIVER_NAME.driver" 2>/dev/null)"
  if [ -z "$configured" ]; then
    echo "merge drivers: NOT installed — merge.$DRIVER_NAME.driver is unset" >&2
    exit 1
  fi
  if ! grep -q -x -F "$ATTR_LINE" "$ATTRS" 2>/dev/null; then
    echo "merge drivers: NOT installed — '$ATTR_LINE' missing from $ATTRS" >&2
    exit 1
  fi
  echo "merge drivers: installed"
  exit 0
fi

if [ ! -f "$DRIVER_SCRIPT" ]; then
  echo "install-merge-drivers: no driver at $DRIVER_SCRIPT" >&2
  exit 2
fi

BUN="$(command -v bun 2>/dev/null)"
if [ -z "$BUN" ]; then
  # Refuse rather than write a config whose command does not exist: git would abort the merge with
  # a fatal error, which is strictly worse than the conflict this driver exists to prevent.
  echo "install-merge-drivers: NOT INSTALLED — bun is not on PATH, and the driver runs under bun." >&2
  echo "                       Install bun, then re-run this script." >&2
  exit 2
fi

git -C "$ROOT" config "merge.$DRIVER_NAME.name" "entry-aware merge for the AS_BUILT log"
git -C "$ROOT" config "merge.$DRIVER_NAME.driver" "$BUN $DRIVER_SCRIPT %O %A %B %L %P"

mkdir -p "$(dirname "$ATTRS")"
remove_attr_line
printf '%s\n' "$ATTR_LINE" >> "$ATTRS"

echo "merge drivers: installed"
echo "       driver → $BUN $DRIVER_SCRIPT %O %A %B %L %P"
echo "       path   → $ATTR_LINE"
echo "                ($ATTRS)"
