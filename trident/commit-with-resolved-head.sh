#!/usr/bin/env bash
set -uo pipefail

expected_branch=${1-}
if [ -z "$expected_branch" ]; then
  echo "commit refused: expected branch was not supplied" >&2
  exit 64
fi
shift

probe_err=$(mktemp)
trap 'rm -f "$probe_err"' EXIT

head_oid=$(git rev-parse --verify HEAD 2>"$probe_err")
probe_exit=$?
if [ "$probe_exit" -ne 0 ]; then
  detail=$(tr '\n' ' ' <"$probe_err" | sed 's/[[:space:]]*$//')
  echo "commit refused: HEAD does not resolve for branch '$expected_branch' (git rev-parse --verify HEAD exited $probe_exit${detail:+: $detail})" >&2
  exit 65
fi

if [ -z "$head_oid" ]; then
  echo "commit refused: HEAD resolution returned no object for branch '$expected_branch'" >&2
  exit 66
fi

case "$head_oid" in
  *[!0-9a-fA-F]*|'')
    echo "commit refused: HEAD resolved unexpectedly for branch '$expected_branch': '$head_oid'" >&2
    exit 67
    ;;
esac

# `exec` REPLACES this shell, so the EXIT trap above never runs on the success path.
# Left as-is that leaked one temp file per guarded commit -- measured at 5 files for 5
# commits, against 0 for 5 unguarded ones. Clean up before handing the process over.
rm -f "$probe_err"
trap - EXIT
exec git commit "$@"
