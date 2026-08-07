#!/usr/bin/env bash
#
# The ONLY sanctioned way to submit an EAS build from this repo (ISSUES #513).
#
# WHY A WRAPPER AND NOT A DOCUMENTED STEP. The preflight it runs was written after a
# build was submitted from a tree whose `node_modules` lagged `app/package.json`, and
# was therefore stamped with the runtime fingerprint of a tree that did not contain
# its own new native module. A check that has to be REMEMBERED before a command you
# type by hand is not a check — the same reasoning that makes a gate with no runner a
# deletion that looks like coverage. So the check and the command are one command.
#
# What it does, in order:
#
#   1. Refuses to proceed if any declared app dependency is not installed. That is
#      the root cause: the local fingerprint measures what is INSTALLED, while EAS's
#      builder installs from the lockfile, so the two describe different trees.
#   2. Prints the fingerprint this submit WILL stamp, beside the runtime version of
#      the most recent build on the same platform. A native-dependency change that
#      leaves the fingerprint identical is the signature of the #513 bug, so the two
#      values are shown together rather than left to be looked up separately.
#   3. Hands off to `eas build` with every argument it was given.
#
# It does NOT decide for you whether a changed or unchanged fingerprint is correct —
# only one of those is knowable from the diff, and guessing would replace a visible
# question with an invisible assumption.
#
# Usage:  bash scripts/eas-build.sh --platform android --profile preview --non-interactive
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "── EAS build preflight ─────────────────────────────────────────────────"
bun "scripts/ci/eas-build-preflight.ts" "$REPO_ROOT"

# Platform for the fingerprint comparison. Read from the args rather than assumed;
# absent, the comparison is skipped rather than reported against the wrong platform.
PLATFORM=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--platform" ] || [ "$prev" = "-p" ]; then PLATFORM="$arg"; fi
  prev="$arg"
done

if [ -n "$PLATFORM" ] && [ "$PLATFORM" != "all" ]; then
  echo
  echo "── Runtime fingerprint ($PLATFORM) ─────────────────────────────────────"
  LOCAL_FP="$(cd app && bunx expo-updates fingerprint:generate --platform "$PLATFORM" 2>/dev/null \
    | bun -e 'const d=await Bun.stdin.json(); process.stdout.write(String(d.hash ?? "unknown"))' || echo unknown)"
  LAST_FP="$(cd app && bunx eas-cli@latest build:list --platform "$PLATFORM" --limit 1 --json --non-interactive 2>/dev/null \
    | bun -e 'const d=await Bun.stdin.json(); process.stdout.write(String(d?.[0]?.runtimeVersion ?? "none"))' || echo none)"
  echo "  this submit will stamp : $LOCAL_FP"
  echo "  most recent build has  : $LAST_FP"
  if [ "$LOCAL_FP" = "$LAST_FP" ]; then
    echo "  → UNCHANGED. Correct for a JS-only change (an OTA can carry it instead)."
    echo "    If this change added or removed a NATIVE dependency, STOP: an unchanged"
    echo "    fingerprint then means the wrong tree was measured (ISSUES #513)."
  else
    echo "  → CHANGED. Existing installs will NOT receive updates published against"
    echo "    this runtime until they install the resulting build."
  fi
fi

echo
echo "── eas build ───────────────────────────────────────────────────────────"
cd app
exec bunx eas-cli@latest build "$@"
