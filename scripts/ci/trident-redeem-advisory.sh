#!/usr/bin/env bash
#
# scripts/ci/trident-redeem-advisory.sh — print the redeeming command for the
# branches being pushed. ADVISORY ONLY: always exits 0, never blocks.
#
# WHY THIS IS ITS OWN FILE. It reads git's pre-push ref lines on stdin, so it can
# be RUN in a test with a real ref line and its output checked — which is what the
# in-hook version could not offer. That version read
# `git rev-parse --abbrev-ref HEAD` and so named the CHECKED-OUT branch rather than
# the PUSHED one: `git push origin some-other-branch`, a multi-ref push, and a tag
# push all printed a redemption command for the wrong branch, and its only
# coverage was an assertion about the hook's text.
#
# INPUT is git's pre-push format, one line per ref:
#   <local_ref> <local_sha> <remote_ref> <remote_sha>
# Branch refs only. A tag is not a branch a review lane can re-enter, and a
# deletion (all-zero local sha) pushes no commits at all.
#
# The command text comes FROM THE GATE (`trident-verdict.ts --redeem-command`),
# never from a copy here. A second spelling would drift from the one CI prints,
# and a drifted redemption path is a gate that only rejects.

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || exit 0
GATE="$ROOT/scripts/ci/trident-verdict.ts"
ZERO='0000000000000000000000000000000000000000'

# A branch that predates the gate (a bisect, an old worktree) has no script, and
# bun may not be installed. Say nothing rather than invent a failure.
[ -f "$GATE" ] || exit 0
command -v bun >/dev/null 2>&1 || exit 0

branches=""
while read -r local_ref local_sha _remote_ref _remote_sha; do
  [ -n "${local_ref:-}" ] || continue
  [ -n "${local_sha:-}" ] || continue
  [ "$local_sha" = "$ZERO" ] && continue
  case "$local_ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  name="${local_ref#refs/heads/}"
  case " $branches " in
    *" $name "*) continue ;;
  esac
  branches="${branches:+$branches }$name"
done

[ -n "$branches" ] || exit 0

{
  echo ""
  echo "note: pushed. The MERGE is gated on a review verdict for the head commit."
  echo "      If a branch below has not been through a review lane, put it through one."
  echo "      Point the lane AT the branch — the instruction to adopt it is the payload:"
  echo ""
  for name in $branches; do
    cmd="$(bun "$GATE" --redeem-command --branch "$name" 2>/dev/null || true)"
    [ -n "$cmd" ] || continue
    echo "        $cmd"
  done
  echo ""
  echo "      A lane that answers by opening a NEW branch has not redeemed this one."
  echo "      The other route is to review it and record the verdict on the PR."
  echo "      docs/trident-verdict-gate.md"
} >&2 || true

exit 0
