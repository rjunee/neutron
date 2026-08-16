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
# Half (2) deliberately does NOT live in a tracked `.gitattributes`. git treats an attribute naming
# a driver that is not configured as FATAL, not as a fallback:
#
#     fatal: custom merge driver as-built-log lacks command line.   (exit 128)
#
# — for `git merge` and for the `git apply --3way` the publisher uses. Committing the attribute
# would therefore break every fresh clone, every outside contributor and CI on any merge touching
# this file, until each of them ran this script. Keeping it untracked means the attribute and its
# driver arrive together or not at all; a clone that never runs this behaves exactly as it does
# today. Same rule `install-git-hooks.sh` applies to the leak gate and its denylist.
#
# "TOGETHER OR NOT AT ALL" IS ENFORCED, NOT MERELY INTENDED. This script has no `errexit` (and
# cannot safely acquire one — `git config --unset` exits 5 on an already-absent key and `grep -v`
# exits 1 on an empty result, both of which are normal here). So every step below that can leave
# the fatal half behind is checked BY HAND, and the ordering is load-bearing:
#
#   config first → attribute second → verify both → remove the attribute again if either is missing
#
# because driver-without-attribute is inert while a clone that BELIEVES it is installed is not.
# Measured on git 2.50.1, the two bad halves differ and both were reachable:
#
#   • `merge.<name>.name` written with no `.driver` — git refuses outright, exit 128:
#         fatal: custom merge driver as-built-log lacks command line.
#     Reachable whenever the first config write lands and the second does not, which is why the
#     second's failure path unsets the first.
#   • the attribute written with no config at all — git falls back to its built-in merge SILENTLY,
#     so the clone reports "installed" and goes on conflicting exactly as before. Reachable with a
#     stale `$GIT_COMMON_DIR/config.lock`: the unchecked version appended the attribute after both
#     config writes had failed and still printed "merge drivers: installed" on exit 0 — the exact
#     state the paragraph above calls impossible.

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

# THE DRIVER HALF FIRST, AND NOTHING ELSE HAPPENS IF IT DOES NOT LAND.
fail_unwritable() {
  echo "install-merge-drivers: NOT INSTALLED — could not write $1 into the repo config." >&2
  echo "                       The attribute was NOT written, so this clone merges $LOG_PATH" >&2
  echo "                       exactly as it did before. A stale $COMMON/config.lock left by an" >&2
  echo "                       interrupted git is the usual cause; remove it and re-run." >&2
  exit 3
}

if ! git -C "$ROOT" config "merge.$DRIVER_NAME.name" "entry-aware merge for the AS_BUILT log"; then
  fail_unwritable "merge.$DRIVER_NAME.name"
fi
if ! git -C "$ROOT" config "merge.$DRIVER_NAME.driver" "$BUN $DRIVER_SCRIPT %O %A %B %L %P"; then
  # Leave no lone `.name` behind; if the config is locked this cannot land either, hence the `|| :`.
  git -C "$ROOT" config --unset "merge.$DRIVER_NAME.name" 2>/dev/null || :
  fail_unwritable "merge.$DRIVER_NAME.driver"
fi

if ! mkdir -p "$(dirname "$ATTRS")"; then
  echo "install-merge-drivers: NOT INSTALLED — could not create $(dirname "$ATTRS")" >&2
  exit 3
fi
remove_attr_line
if ! printf '%s\n' "$ATTR_LINE" >> "$ATTRS"; then
  echo "install-merge-drivers: NOT INSTALLED — could not write $ATTRS" >&2
  echo "                       The driver config is harmless on its own and is left in place." >&2
  exit 3
fi

# VERIFY BOTH HALVES, whatever route the failure took. If the driver is missing the attribute goes
# straight back out: a clone with an attribute and no driver cannot merge this path at all, which is
# strictly worse than the conflict this script exists to remove.
if [ -z "$(git -C "$ROOT" config --get "merge.$DRIVER_NAME.driver" 2>/dev/null)" ] ||
   ! grep -q -x -F "$ATTR_LINE" "$ATTRS" 2>/dev/null; then
  remove_attr_line
  echo "install-merge-drivers: NOT INSTALLED — the two halves did not both land, so neither is kept." >&2
  echo "                       $LOG_PATH merges exactly as it did before." >&2
  exit 3
fi

echo "merge drivers: installed"
echo "       driver → $BUN $DRIVER_SCRIPT %O %A %B %L %P"
echo "       path   → $ATTR_LINE"
echo "                ($ATTRS)"
