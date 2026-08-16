#!/usr/bin/env bash
#
# scripts/ci/as-built-closed-log-guard.sh — `docs/AS_BUILT.md` is CLOSED for new
# entries. This fails the PR that adds one.
#
# WHY A GATE AND NOT A DOCUMENT. The one-file-per-entry layout and its rationale have
# been in `docs/as-built/README.md` since 2026-07-28, and that README says in bold:
# "Do not append to ../AS_BUILT.md". The closed file then took a new entry on
# essentially every day for the next eighteen, right through 2026-08-15 — and on
# 2026-08-15T23:20Z three concurrent builds all failed at publish on that file and on
# nothing else. The rule was right, written down, and had no teeth: no prompt read the
# README and nothing checked it. A convention that is only prose is a convention that
# holds until the first agent that did not read it.
#
# THE INVARIANT: relative to the base, this change may not ADD a `## ` entry heading to
# `docs/AS_BUILT.md`. Everything else about the file is fair game — fixing a typo,
# updating its header, correcting a link. It is a closure rule, not a freeze: the
# conflict came from every build inserting an ENTRY at the same offset, so an entry is
# what is banned.
#
# WHERE THE ENTRY GOES INSTEAD: `docs/as-built/<YYYY-MM-DD>-<slug>.md`, one file per
# entry, which two concurrent builds can never both write. Read the whole log with
# `bun scripts/render-as-built.ts`.
#
# ENV (test seams / overrides):
#   AS_BUILT_GUARD_ROOT      repo root to operate on (default: this repo)
#   AS_BUILT_GUARD_BASE_REF  git ref to diff against (default: origin/main)
#
# EXIT: 0 = no entry added (or a skip case), 1 = an entry was added to the closed file,
#       2 = usage / the guard could not evaluate (never a silent pass).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AS_BUILT_GUARD_ROOT:-$(cd "$HERE/../.." && pwd)}"
BASE_REF="${AS_BUILT_GUARD_BASE_REF:-origin/main}"
CLOSED_REL="docs/AS_BUILT.md"
ENTRY_DIR_REL="docs/as-built"

cd "$ROOT" || { echo "as-built-closed-log-guard: cannot cd to $ROOT" >&2; exit 2; }

# The guard is meaningless if the replacement directory is not there — that would mean
# the layout moved and this gate is checking a rule that no longer has a destination.
# Loud, not silently green (the leak-gate lesson).
[ -d "$ROOT/$ENTRY_DIR_REL" ] || {
  echo "as-built-closed-log-guard: $ENTRY_DIR_REL is gone — the per-entry layout moved," >&2
  echo "so this guard is enforcing a rule with nowhere to send the entry. Treat as broken." >&2
  exit 2
}

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "as-built-closed-log-guard: base ref $BASE_REF is unreachable (fork/offline) — skipping."
  exit 0
fi

BASE_SHA="$(git rev-parse "$BASE_REF")"
HEAD_SHA="$(git rev-parse HEAD)"
if [ "$BASE_SHA" = "$HEAD_SHA" ]; then
  echo "as-built-closed-log-guard: HEAD is $BASE_REF — nothing to compare; skipping."
  exit 0
fi

# `...` so the comparison is against the MERGE BASE: a base branch that moved after this
# branch was cut must not make someone else's entry look like this change's entry.
ADDED="$(git diff --unified=0 "$BASE_SHA...$HEAD_SHA" -- "$CLOSED_REL" | grep -c '^+## ' || true)"

if [ "${ADDED:-0}" -gt 0 ]; then
  echo "as-built-closed-log-guard: FAILED — this change adds ${ADDED} entry heading(s) to $CLOSED_REL." >&2
  git diff --unified=0 "$BASE_SHA...$HEAD_SHA" -- "$CLOSED_REL" | grep '^+## ' >&2
  echo >&2
  echo "$CLOSED_REL is CLOSED for new entries (docs/as-built/README.md, 2026-07-28)." >&2
  echo "Every build inserts at the same offset in that file, so two builds finishing in" >&2
  echo "the same window conflict by construction — measured three times over on" >&2
  echo "2026-08-15." >&2
  echo >&2
  echo "Move the entry to its own file:  $ENTRY_DIR_REL/<YYYY-MM-DD>-<slug>.md" >&2
  echo "Read the whole log newest-first:  bun scripts/render-as-built.ts" >&2
  exit 1
fi

echo "as-built-closed-log-guard: OK — no entry added to $CLOSED_REL."
exit 0
