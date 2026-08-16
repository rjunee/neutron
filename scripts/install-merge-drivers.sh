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
# WHAT IT INSTALLS, AND WHICH HALF-STATE IS IMPOSSIBLE — WHICH IS NOT THE SAME AS "NEITHER"
# -----------------------------------------------------------------------------------------
# Stated exactly, because "both halves or neither" is the sentence a reader will trust and it is
# one word too strong. There are two half-states and they are NOT symmetric:
#
#   • ATTRIBUTE WITHOUT DRIVER is the bad half, and it has TWO forms that do NOT behave the same —
#     an earlier version of this paragraph called both of them fatal, which is true of only one.
#     Measured on git 2.50.1, attribute present in $GIT_COMMON_DIR/info/attributes:
#       - with `merge.<name>.name` set and no `.driver`: `fatal: custom merge driver as-built-log
#         lacks command line`, exit 128 — the merge cannot be run at all. THIS is the fatal one.
#       - with NO `merge.<name>.*` config whatsoever: git silently falls back to its built-in text
#         merge, exit 1 with ordinary conflict markers. Not fatal; just this path conflicting the
#         way it did before the driver was written.
#     Both are IMPOSSIBLE here: the attribute is written only after the driver config landed, and is
#     removed again by the verification at the end if the driver is not readable back.
#   • DRIVER WITHOUT ATTRIBUTE is INERT — the config names a command nothing points at, so the path
#     merges exactly as it did before — and it IS reachable: if `mkdir -p` or the append to the
#     attributes file fails, the script exits 3 loudly and leaves the config behind. That is the
#     deliberate choice, not an oversight, and re-running is enough to finish the job.
#
# So the guarantee is "never the fatal half, always loudly", not "never a half".
#   1. `merge.as-built-log.driver` in the repo config — the command git runs.
#   2. `docs/AS_BUILT.md merge=as-built-log` in `$GIT_COMMON_DIR/info/attributes` — the binding
#      from the path to that command.
#
# Half (2) deliberately does NOT live in a tracked `.gitattributes`, and the reason is the measured
# one rather than the dramatic one. A fresh clone carries no `merge.as-built-log.*` config at all,
# and in that state git does NOT fail — it silently falls back to its built-in text merge, exit 1
# with ordinary conflict markers. So committing the attribute would not brick a clone; it would
# quietly REPLACE the `merge=union` this path gets from the tracked `.gitattributes` today with a
# conflict on every concurrent append, for every outside contributor and for CI, until each of them
# ran this script — the exact regression `scripts/ci/check-governed-repo-attributes.ts` gates. That
# is worth avoiding on its own. The genuinely fatal state needs a `merge.<name>.name` with no
# `.driver` — a half-installed clone — for `git merge` and for the `git apply --3way` the publisher
# uses, and a committed attribute is what would put every such clone one bad config write away from
# it. Keeping the attribute untracked means it and its driver never arrive attribute-first; a clone
# that never runs this behaves exactly as it does today. Same rule `install-git-hooks.sh` applies to
# the leak gate and its denylist.
#
# MEASURED on git 2.50.1 (Apple Git-155), a fresh repo with `log.txt merge=as-built-log` and two
# branches editing the same region:
#
#   - no `merge.as-built-log.*` config at all → NOT fatal. git falls back to the ordinary text
#     merge: exit 1, `CONFLICT (content)`, conflict markers.
#   - `merge.as-built-log.name` set with no `.driver` → THAT is the fatal one:
#         fatal: custom merge driver as-built-log lacks command line.   (exit 128)
#   - both `.name` and `.driver` set → exit 0, the driver's output.
#
# "NEVER THE FATAL HALF" IS ENFORCED, NOT MERELY INTENDED. This script has no `errexit` (and
# cannot safely acquire one — `git config --unset` exits 5 on an already-absent key and `grep -v`
# exits 1 on an empty result, both of which are normal here). So every step below that can leave
# the fatal half behind is checked BY HAND, and the ordering is load-bearing:
#
#   .driver → .name → attribute → verify both → remove the attribute again if either is missing
#
# because driver-without-attribute is inert while a clone that BELIEVES it is installed is not.
# Measured on git 2.50.1, the two bad halves differ and only one of them is now reachable:
#
#   • `merge.<name>.name` written with no `.driver` — git refuses outright, exit 128:
#         fatal: custom merge driver as-built-log lacks command line.
#     UNREACHABLE BY ORDERING. `.driver` is written first and nothing else happens if it fails, and
#     a lone `.driver` with no `.name` merges perfectly (measured: driver ran, exit 0 — `.name` is
#     only the description `git config --get-regexp merge.` prints). The earlier version wrote
#     `.name` first and unset it by hand when `.driver` failed — a cleanup performed by a THIRD
#     write, which the held `config.lock` that caused the failure would have blocked too. Ordering
#     removes the state; a rollback only apologises for it.
#   • the attribute written with no config at all — git falls back to its built-in merge SILENTLY
#     (exit 1 with ordinary markers, NOT the 128 above), so the clone reports "installed" and goes
#     on conflicting exactly as before. Reachable with a
#     stale `$GIT_COMMON_DIR/config.lock`: the unchecked version appended the attribute after both
#     config writes had failed and still printed "merge drivers: installed" on exit 0 — the exact
#     state the paragraph above calls impossible. `--check` and the lock-contention case are both
#     covered in `scripts/git/as-built-merge-realgit.test.ts`.
#
# `--check` VERIFIES WHAT IS INSTALLED, NOT MERELY THAT SOMETHING IS.
# ------------------------------------------------------------------
# It used to ask two yes/no questions — is `merge.<name>.driver` non-empty, and is the attribute
# line present — and answer "installed" to any command whatsoever. A clone that ran an EARLIER
# version of this script therefore reported success while still holding that version's command,
# so none of the hardening below (`env -u` on the credentials, `--config=/dev/null`,
# `--env-file=/dev/null`) ever reached it. Measured on git 2.50.1 before this was fixed: install,
# then `git config merge.as-built-log.driver "bun <driver> %O %A %B %L %P"` — the predecessor
# command, attribute untouched — and `--check` printed "merge drivers: installed" and exited 0.
# That is the same false-pass class this driver exists to close, one layer out: a check that
# cannot tell the hardened driver from its predecessor is what keeps every already-installed
# clone on the vulnerable one.
#
# So the configured command is now compared against the one THIS script would write, and a
# difference is reported as STALE with both strings printed and the one-line remedy. The comparison
# is a REBUILD rather than a substring hunt for the individual hardening flags, for two reasons: a
# hunt has to be extended by hand every time a flag is added — precisely the maintenance the old
# check failed at — and re-running the installer is idempotent and cheap, so a false "stale" costs
# one command while a false "installed" costs the whole property. Both halves are derived by
# `driver_command`, so there is one definition of the command and the check cannot drift from what
# the install writes.
#
# WHAT THE REBUILD DELIBERATELY DOES NOT COMPARE, AND WHY THE FIRST CUT WAS WRONG TO. Comparing the
# whole string byte for byte was the obvious reading of "verify WHAT is installed" and it was too
# strong by exactly two words — the absolute path of bun, and the absolute path of the driver. Both
# are properties of the shell that ran the install rather than of the command's hardening, and
# neither is stable across the ways this script is legitimately invoked:
#
#   - the driver path, because the config lives in the COMMON git dir and is therefore shared by
#     every linked worktree, while the expected string was built from whichever checkout was
#     asking. MEASURED on git 2.50.1: install from the main checkout, `git worktree add`, `--check`
#     from the new worktree → STALE, the two commands differing in nothing but the checkout. The
#     header's promise three paragraphs up — "installing once serves every worktree" — was quietly
#     false for the check.
#   - the bun path, because it is resolved from PATH, and a git hook, a CI step and a login shell
#     do not agree on PATH order.
#
# Worse than the false verdict was its remedy: the message says re-run the installer, and doing
# that from a throwaway worktree wrote THAT worktree's driver path into the shared config, where it
# dangled the moment the worktree was removed — turning a spurious warning into the silent
# entry-losing merge this whole change exists to prevent.
#
# So the two paths are read back out of the installed command, fed to the same `driver_command`,
# and the rebuild has to reproduce the configured string byte for byte. Every hardening token stays
# exact; the two free words are then checked for what they must BE — the driver is a
# `scripts/git/as-built-merge-driver.ts` that exists, the bun is executable — which also catches
# the dangling-worktree command that parses perfectly and cannot run.
#
# WHY THIS DOES NOT NEED `.name` IN THE COMPARISON: `.name` is cosmetic (see the ordering note
# above — a lone `.driver` is a working driver), it is deliberately non-fatal on install, and
# demanding it here would report a correctly-hardened clone as stale.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIVER_NAME="as-built-log"
LOG_PATH="docs/AS_BUILT.md"
ATTR_LINE="$LOG_PATH merge=$DRIVER_NAME"
DRIVER_RELPATH="scripts/git/as-built-merge-driver.ts"

if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install-merge-drivers: $ROOT is not a git repository" >&2
  exit 2
fi

# The COMMON git dir, not the per-worktree one: a linked worktree has its own $GIT_DIR but reads
# attributes and config from the common one, so installing there serves every worktree at once.
#
# `--path-format=absolute` arrived in git 2.31, hence the fallback — AND THE FALLBACK'S ANSWER IS
# CHECKED. In a linked worktree the common dir is recorded in `<main>/.git/worktrees/<name>/commondir`
# as `../..`, relative to THAT file's directory rather than to the working tree. Measured on git
# 2.50.1 the `-C` form already answers absolutely, so the fallback never runs here; on the old git it
# exists for, resolving `../..` against $ROOT would land two levels above the worktree — a real
# directory, outside the repository, where an attributes file is silently inert. So the resolved
# directory has to prove it is a git dir. If it cannot, this refuses: a clone that merges the way it
# always did beats one that believes it is installed and is not.
COMMON="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
if [ -z "$COMMON" ]; then
  COMMON="$(git -C "$ROOT" rev-parse --git-common-dir)"
  case "$COMMON" in /*) ;; *) COMMON="$ROOT/$COMMON" ;; esac
  if [ ! -f "$COMMON/HEAD" ]; then
    echo "install-merge-drivers: NOT INSTALLED — could not locate the common git dir." >&2
    echo "                       'rev-parse --git-common-dir' gave '$COMMON', which is not one." >&2
    exit 2
  fi
fi
ATTRS="$COMMON/info/attributes"

# THE DRIVER PATH IS RESOLVED FROM THE MAIN WORKTREE, NOT FROM THIS SCRIPT'S OWN LOCATION.
#
# The config this path is written into is SHARED by every worktree of the clone (it lives in the
# common git dir — see above), but `${BASH_SOURCE[0]}` names whichever checkout invoked the script.
# Deriving the driver from the invoker therefore writes a PER-WORKTREE path into a SHARED setting,
# and both directions of that are bugs this file has already shipped:
#
#   • installing from the publisher's throwaway rebase worktree wrote that worktree's path into the
#     shared config, and `git worktree remove` then left the whole clone pointing at a driver that
#     no longer exists — every later merge of this path silently losing one side's entries.
#   • `--check` run from any linked worktree rebuilt the expected command with the ASKING
#     worktree's path and reported a correctly-installed clone STALE. Measured on git 2.50.1:
#     install from the main checkout, `git worktree add`, `--check` from there → exit 1, the two
#     commands differing in nothing but which checkout hosts the driver. Worse, the remedy it
#     printed ("re-run the installer") would have written the throwaway path in, which is the first
#     bullet.
#
# The main worktree is the one that outlives every linked one, so its copy is the stable choice and
# every worktree agrees on it. The fallback matters for the one shape where there is no such copy —
# a linked worktree of a BARE clone, whose "main worktree" is the bare dir and carries no checkout
# at all — and there the invoking checkout's copy is the only one there is.
MAIN_TREE="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
if [ -n "$MAIN_TREE" ] && [ -f "$MAIN_TREE/$DRIVER_RELPATH" ]; then
  DRIVER_SCRIPT="$MAIN_TREE/$DRIVER_RELPATH"
else
  DRIVER_SCRIPT="$ROOT/$DRIVER_RELPATH"
fi

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

# Single-quote one word for the `/bin/sh -c` git runs the driver command under.
#
# The wrapping used to be a bare `'$BUN'`, which is correct for every path without a single quote
# in it and produces an unparseable command for any path with one — and `$ROOT` comes from wherever
# the clone happens to live, so it is not this script's to promise. The `'\''` dance is the
# standard escape and this costs three lines. For a quote-free path the output is byte-identical to
# the old spelling, so nothing already installed is disturbed by it.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# The exact inverse of `sq`, for reading a path back OUT of an installed command. Non-zero if the
# word is not a single-quoted one, which is itself a difference worth reporting rather than
# guessing past. Deliberately NOT `eval`: the string comes from the repo config, and the whole
# point of this file is that a command found lying around is not a command to execute.
unsq() {
  local w="$1"
  case "$w" in "'"*"'") ;; *) return 1 ;; esac
  w="${w#\'}"
  w="${w%\'}"
  printf '%s' "$w" | sed "s/'\\\\''/'/g"
}

# THE ONE DEFINITION IN THIS SCRIPT of the command git runs, derived identically for the install
# and for `--check`. Two spellings within this file would let the check pass a clone the installer
# would have written differently, which is the bug `--check` was just fixed for.
#
# THERE IS EXACTLY ONE OTHER DERIVATION IN THE REPOSITORY, AND IT IS DELIBERATE RATHER THAN DRIFT:
# `asBuiltDriverCommand` in `trident/orchestrator.ts`. The publisher cannot reach this function,
# because reaching it would mean executing a `scripts/install-merge-drivers.sh` found in a checkout
# it does not control — the credential-exposing bug this whole change is named for. So it builds
# the same string in TypeScript instead. The two are pinned in agreement by a test rather than by
# this comment (`scripts/git/as-built-merge-realgit.test.ts`, "the two derivations of the driver
# command agree"), because a comment asserting they match is the thing that goes stale first.
#
# `--config=/dev/null` IS NOT OPTIONAL. git runs a merge driver with its cwd at the top of the
# working tree being merged, and bun reads `bunfig.toml` from its cwd — so without this flag a
# `bunfig.toml` carrying `preload = ["./anything.ts"]` executes that file inside the driver process
# on every merge of this path, inheriting whatever credentials the invoking shell holds. Reproduced
# on bun 1.3.9; `--config=/dev/null` is an empty TOML file, and the driver needs no config of its
# own (it reads three files and writes one).
#
# `--env-file=/dev/null` COVERS WHAT `--config` DOES NOT. bun auto-loads a `.env` from that same
# cwd — the merged repository — independently of `bunfig.toml`. Measured on bun 1.3.9: with only
# `--config=/dev/null`, a `.env` in the cwd still reached `process.env`; with this flag it did not.
#
# …AND THE TOKEN IS NOT IN THE PROCESS AT ALL. `env -u` drops the owner's `GH_TOKEN` and the
# `GIT_CONFIG_*` credential-helper triple that reads it, so there is nothing for a future injection
# to find. Two independent controls: one over what can get in, one over what is there to take.
driver_command() {
  local bun="$1"
  local driver="$2"
  local env_bin=env
  [ -x /usr/bin/env ] && env_bin=/usr/bin/env
  printf '%s -u GH_TOKEN -u GITHUB_TOKEN -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 %s --config=/dev/null --env-file=/dev/null %s %%O %%A %%B %%L %%P' \
    "$env_bin" "$(sq "$bun")" "$(sq "$driver")"
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
  # WHAT is installed, not merely THAT something is — see the header. Without this a clone still
  # holding a previous version's command answers "installed" and never takes the hardening.
  #
  # Exactly TWO words of the command are absolute paths that legitimately differ between the shell
  # that installed and the shell now asking, and comparing them for equality is what made the first
  # cut of this check report correct clones as stale:
  #
  #   • WHICH BUN. Resolved from PATH at install time, and a hook, a CI step and a login shell do
  #     not share a PATH order. Two same-version bun binaries at different paths are not a stale
  #     install, and reinstalling would only rewrite the path the next shell disagrees with.
  #   • WHICH CHECKOUT hosts the driver. The config is shared by every worktree, so a linked
  #     worktree asking about a command the main checkout wrote is the ORDINARY case.
  #
  # So both are read back out of the installed command and fed to the same `driver_command` that
  # writes it, and the rebuild must reproduce the configured string BYTE FOR BYTE. Every token that
  # carries the hardening is still exact — a missing `-u GITHUB_TOKEN`, a dropped `--env-file`, a
  # different argument order or a mangled quote all fail to rebuild — while the two free words are
  # judged on what they have to BE rather than on which one they happen to be. One definition of
  # the command still, and the check cannot drift from what the install writes.
  slots="$(driver_command '@@bun@@' '@@driver@@')"
  head="${slots%%\'@@bun@@\'*}"
  rest="${slots#*\'@@bun@@\'}"
  mid="${rest%%\'@@driver@@\'*}"
  tail="${rest#*\'@@driver@@\'}"

  stale() {
    echo "merge drivers: STALE — this clone holds a DIFFERENT driver command from the one this" >&2
    echo "                       script installs, so it is running an older driver." >&2
    [ -n "${1:-}" ] && echo "                       ($1)" >&2
    echo "     installed → $configured" >&2
    echo "     expected  → $(driver_command "${BUN_FOR_MSG:-<bun>}" "$DRIVER_SCRIPT")" >&2
    echo "     Re-run 'bash scripts/install-merge-drivers.sh' to update it (idempotent)." >&2
    exit 1
  }
  BUN_FOR_MSG="$(command -v bun 2>/dev/null)"

  body="$configured"
  case "$body" in "$head"*) body="${body#"$head"}" ;; *) stale "the command's leading environment scrub does not match" ;; esac
  case "$body" in *"$tail") body="${body%"$tail"}" ;; *) stale "the command's trailing merge placeholders do not match" ;; esac
  case "$body" in *"$mid"*) ;; *) stale "the bun hardening flags are not between the two paths" ;; esac
  bun_word="${body%%"$mid"*}"
  driver_word="${body#*"$mid"}"

  bun_path="$(unsq "$bun_word")" || stale "the bun path is not a single-quoted word"
  driver_path="$(unsq "$driver_word")" || stale "the driver path is not a single-quoted word"
  [ "$configured" = "$(driver_command "$bun_path" "$driver_path")" ] || stale "it does not rebuild to itself"

  # The two free words still have to be the things they claim to be. A command that parses
  # perfectly and names a driver deleted with the worktree that installed it is the exact
  # false-pass this check exists to close — git would run it, `/bin/sh` would fail to find the
  # file, and the merge would fall back to leaving one side's entries out.
  case "$driver_path" in
    "/$DRIVER_RELPATH" | */"$DRIVER_RELPATH") ;;
    *) stale "it names $driver_path, which is not a $DRIVER_RELPATH" ;;
  esac
  [ -f "$driver_path" ] || stale "the driver it names is not there — $driver_path"
  [ -x "$bun_path" ] || stale "the bun it names is not executable — $bun_path"

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

# Derived by `driver_command` above, which `--check` uses too — see its docblock for what each of
# `env -u`, `--config=/dev/null` and `--env-file=/dev/null` closes, and the reproductions.
DRIVER_COMMAND="$(driver_command "$BUN" "$DRIVER_SCRIPT")"

# THE LOAD-BEARING HALF FIRST — see the header. A lone `.driver` works; a lone `.name` is fatal.
if ! git -C "$ROOT" config "merge.$DRIVER_NAME.driver" "$DRIVER_COMMAND"; then
  fail_unwritable "merge.$DRIVER_NAME.driver"
fi
# Cosmetic, and deliberately not fatal: its absence changes nothing about how the merge runs.
git -C "$ROOT" config "merge.$DRIVER_NAME.name" "entry-aware merge for the AS_BUILT log" || :

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
echo "       driver → $DRIVER_COMMAND"
echo "       path   → $ATTR_LINE"
echo "                ($ATTRS)"
