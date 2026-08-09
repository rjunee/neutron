#!/usr/bin/env bash
#
# Publish an OTA update, but PROVE THE BUNDLE IS REAL FIRST (ISSUES #518).
#
# `eas update` bundles and publishes in one step, and it published a BROKEN export
# once already: a Metro/Watchman failure produced unusable output, the command
# still exited 0 with an update id and a permalink, and the OTA reached the
# owner's phone dead. Every signal said success. Nothing had looked at the bundle.
#
# So the two halves are separated here. Export first, verify what landed on disk,
# and only then publish that exact directory with `--skip-bundler` so the thing
# verified is the thing shipped — not a second bundling run that could differ.
#
# Usage:
#   scripts/eas-update.sh --branch preview --message "what changed"
#
# NEVER pass `--channel production`; this wrapper deliberately takes a BRANCH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
DIST_DIR="$APP_DIR/dist"

BRANCH=""
MESSAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$BRANCH" ] || { echo "eas-update: --branch is required" >&2; exit 2; }
[ -n "$MESSAGE" ] || { echo "eas-update: --message is required" >&2; exit 2; }

# A store channel must never be published from this path. The publish target is a
# BRANCH, and `production` is the one branch name that maps to the store build.
if [ "$BRANCH" = "production" ]; then
  echo "eas-update: refusing to publish to the production branch from this wrapper" >&2
  exit 2
fi

echo "eas-update: exporting (branch=$BRANCH)"
cd "$APP_DIR"
# A stale dist would let a FAILED export publish the PREVIOUS run's bundle, which
# is the same class of silent success this wrapper exists to prevent.
rm -rf "$DIST_DIR"
bunx expo export --platform all --output-dir "$DIST_DIR"

echo "eas-update: verifying the export before publishing"
bun run "$REPO_ROOT/scripts/ci/verify-expo-export.ts" "$DIST_DIR"

echo "eas-update: publishing the VERIFIED directory"
bunx eas update \
  --branch "$BRANCH" \
  --message "$MESSAGE" \
  --input-dir "$DIST_DIR" \
  --skip-bundler \
  --non-interactive
