#!/usr/bin/env bash
#
# scripts/install-merge-drivers.sh — teach this clone how to merge `docs/AS_BUILT.md`.
#
#   bash scripts/install-merge-drivers.sh              # install
#   bash scripts/install-merge-drivers.sh --check      # exit 0 iff installed AND usable
#   bash scripts/install-merge-drivers.sh --uninstall  # remove
#
# Idempotent, and safe to run from any working tree of the repo (including a linked worktree — the
# config lives in the COMMON git dir, so installing once serves every worktree, which is what the
# publisher's throwaway rebase worktree depends on).
#
# WHAT IT INSTALLS: exactly one config key, `merge.as-built-log.driver` — the command git runs.
#
# WHAT IT DELIBERATELY DOES NOT INSTALL: the attribute binding the path to that driver. That lives
# in the TRACKED `.gitattributes`, because git treats an attribute naming an unconfigured driver as
# a FALLBACK, not an error. Measured on git 2.50.1, fresh repo, attribute present, no config:
#
#     git merge  → CONFLICT (content) ... Automatic merge failed        exit 1
#     git apply --3way --index                                          exit 0
#
# So a clone that never runs this script behaves exactly as it does today; a clone that has run it
# gets the clean entry-aware merge. Tracking the attribute is also the only way GitHub's own
# server-side merge and an outside contributor see any rule at all — neither can run this script.
#
# WHY `.name` IS NEVER WRITTEN — THIS IS A SAFETY PROPERTY, NOT A STYLE CHOICE.
# There is exactly one config state that git treats as fatal:
#
#     merge.as-built-log.name set, merge.as-built-log.driver unset
#     → fatal: custom merge driver as-built-log lacks command line.     exit 128
#
# An earlier cut of this script wrote `.name` first and `.driver` second, with no `set -e` and no
# check on either write, so an interrupted or failed install left precisely that state — and then
# every merge and every `git apply --3way` of the log died at exit 128 while the script printed
# "installed" and exited 0. Writing ONLY `.driver` makes that state unreachable by construction
# rather than guarded against: `.name` is a human-readable label git never requires (measured —
# `.driver` alone merges at exit 0). `--uninstall` still clears a `.name` left by an older install,
# and clears it BEFORE `.driver` so the removal never transits the fatal state either.

set -euo pipefail

DRIVER_NAME="as-built-log"
LOG_PATH="docs/AS_BUILT.md"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! git -C "$HERE" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install-merge-drivers: $HERE is not a git repository" >&2
  exit 2
fi

# The COMMON git dir, not the per-worktree one: a linked worktree has its own $GIT_DIR but reads
# config from the common one, so installing there serves every worktree at once.
COMMON="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$COMMON" ]; then
  COMMON="$(git -C "$HERE" rev-parse --git-common-dir)"
  case "$COMMON" in /*) ;; *) COMMON="$HERE/$COMMON" ;; esac
fi

# THE SCRIPT PATH IS RELATIVE, AND THAT IS THE WHOLE FIX.
#
# The config we write is COMMON to every worktree, so an ABSOLUTE path into whichever worktree
# happened to run the install is a time bomb: trident installs from a throwaway linked worktree,
# that worktree is removed at the end of the build, and every other worktree is then pointed at a
# script that no longer exists. Observed in this repo — the config read
# `.../.worktrees/concurrent-plan-conflict/scripts/git/as-built-merge-driver.ts`, and a later rebase
# in a different tree failed with `Module not found` and fell back to a conflict.
#
# Anchoring to the MAIN worktree instead only moves the problem: its PATH is stable but its
# CONTENT is not, and a main worktree parked on a commit that predates the driver makes every
# install fail. That is not hypothetical — it is what this repo was in when the relative form was
# adopted.
#
# MEASURED: git runs a merge driver with cwd set to the TOP OF THE WORKING TREE THE MERGE IS
# HAPPENING IN, linked worktrees included (probed on git 2.50.1 with a driver that printed `pwd`;
# a merge in the main worktree reported the main worktree, a merge in a linked one reported the
# linked one). So a relative path resolves, per merge, against the tree being merged — each
# worktree runs ITS OWN copy at ITS OWN checked-out version, no worktree depends on any other, and
# removing the installing worktree breaks nothing. A worktree that does not have the file simply
# fails to launch the driver, which git turns into an ordinary conflict — the safe direction.
DRIVER_SCRIPT_REL="scripts/git/as-built-merge-driver.ts"
# The copy in THIS tree, used only for the existence checks below. Never written to the config.
DRIVER_SCRIPT_LOCAL="$HERE/$DRIVER_SCRIPT_REL"

# LEGACY CLEANUP. An earlier cut of this script wrote the binding into `$COMMON/info/attributes`
# instead of tracking it. That file OVERRIDES the tracked `.gitattributes`, so a clone that ran the
# old installer would keep honouring its stale copy and never see a change to the tracked line.
# Removing it is safe in both directions: with the line gone the tracked attribute applies, and the
# tracked attribute names the same driver.
ATTRS="$COMMON/info/attributes"
drop_legacy_attr_line() {
  [ -f "$ATTRS" ] || return 0
  local tmp="$ATTRS.tmp.$$"
  # `$$` keeps the scratch private — two build lanes sharing a checkout can run this at the same
  # moment, which is the exact situation this change exists to serve. `mv` within the directory is
  # atomic, so a racing reader sees the old file or the new one and never a partial one.
  grep -v -x -F "$LOG_PATH merge=$DRIVER_NAME" "$ATTRS" > "$tmp" 2>/dev/null || : > "$tmp"
  mv "$tmp" "$ATTRS"
}

if [ "${1:-}" = "--uninstall" ]; then
  # `.name` first: the reverse order would transit the fatal name-without-driver state.
  git -C "$HERE" config --unset "merge.$DRIVER_NAME.name" 2>/dev/null || true
  git -C "$HERE" config --unset "merge.$DRIVER_NAME.driver" 2>/dev/null || true
  drop_legacy_attr_line
  echo "merge drivers: uninstalled — $LOG_PATH falls back to git's ordinary conflict markers"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  configured="$(git -C "$HERE" config --get "merge.$DRIVER_NAME.driver" 2>/dev/null || true)"
  if [ -z "$configured" ]; then
    echo "merge drivers: NOT installed — merge.$DRIVER_NAME.driver is unset" >&2
    exit 1
  fi
  # A NONEMPTY VALUE IS NOT A WORKING ONE. The config is shared by every worktree while the script
  # is per-worktree, so the key can be set in a tree that does not have the file — which is the
  # state that produced `Module not found` mid-rebase here. Check the file, not just the string,
  # and check it in THIS tree, because this tree is where a merge run here would look.
  if [ ! -f "$DRIVER_SCRIPT_LOCAL" ]; then
    echo "merge drivers: NOT usable here — configured, but no driver script at $DRIVER_SCRIPT_LOCAL" >&2
    exit 1
  fi
  echo "merge drivers: installed"
  exit 0
fi

if [ ! -f "$DRIVER_SCRIPT_LOCAL" ]; then
  echo "install-merge-drivers: no driver at $DRIVER_SCRIPT_LOCAL" >&2
  exit 2
fi

BUN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN" ]; then
  # Refuse rather than write a config whose command does not exist: a driver that fails to launch
  # turns every merge of this file into a conflict, which is worse than the tracked attribute's
  # own fallback (an ordinary conflict) only in that it is noisier — but it is also silent about
  # WHY, so it is better to say so here.
  echo "install-merge-drivers: NOT INSTALLED — bun is not on PATH, and the driver runs under bun." >&2
  echo "                       Install bun, then re-run this script." >&2
  exit 2
fi

# QUOTED, BECAUSE GIT RUNS THIS VALUE THROUGH A SHELL.
# `merge.<driver>.driver` is expanded by /bin/sh, so an unquoted path containing a space — a
# checkout under "Application Support", a macOS volume with a space, a user directory with one —
# word-splits and the driver dies on every merge. `%O %A %B` are substituted by git BEFORE the
# shell sees the string, so they are quoted here too: git substitutes the temp-file paths it chose,
# and those live under $TMPDIR, which is itself a path this repo does not control.
# `$BUN` is absolute (a machine-stable location, unlike a worktree); the SCRIPT is relative, and
# resolves against the working tree git runs the merge in.
printf -v DRIVER_CMD '%q %q "%%O" "%%A" "%%B" "%%L" "%%P"' "$BUN" "$DRIVER_SCRIPT_REL"

git -C "$HERE" config "merge.$DRIVER_NAME.driver" "$DRIVER_CMD"

# CONVERGE A CLONE THE OLD INSTALLER TOUCHED. Not writing `.name` keeps a FRESH clone out of the
# fatal state, but it does nothing for one that already has the key from a previous install — and
# that clone is one `--unset merge.as-built-log.driver` away from `lacks command line` (exit 128).
# Clearing it AFTER `.driver` is written means the pair is never momentarily name-without-driver.
git -C "$HERE" config --unset "merge.$DRIVER_NAME.name" 2>/dev/null || true

drop_legacy_attr_line

echo "merge drivers: installed"
echo "       driver → $DRIVER_CMD"
echo "       path   → $LOG_PATH merge=$DRIVER_NAME (tracked, in .gitattributes)"
