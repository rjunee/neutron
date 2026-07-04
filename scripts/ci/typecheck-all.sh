#!/usr/bin/env bash
#
# G5 — typecheck completeness.
#
# Runs `tsc -p` for EVERY tsconfig.json in the repo (the root deploy-gate config
# PLUS every leaf/package config). The old CI gate ran only the root
# `tsc --noEmit`, whose include list never reached `trident/`, `app/`,
# `work-board/`, `project-credentials/`, `jwt-validator/`, `landing/chat-react/`,
# and every test file under them — so real type errors shipped invisibly.
#
# Discovery is dynamic (a plain `find`), so a NEW package that owns a
# tsconfig.json is typechecked automatically — it can never silently escape the
# gate. `scripts/ci/ci-workflow.test.ts` cross-checks this list against an
# independent enumeration so the discovery can't be quietly narrowed.
#
# Note: `tsconfig.base.json` is `extends`-only (no `include`) and is NOT named
# `tsconfig.json`, so `find -name tsconfig.json` correctly skips it.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

discover() {
  find . -name tsconfig.json -not -path '*/node_modules/*' \
    | sed 's|^\./||' \
    | LC_ALL=C sort
}

# `--list` prints the matrix (one tsconfig path per line) without running tsc.
# Used by the CI-config test to prove matrix completeness.
if [ "${1:-}" = "--list" ]; then
  discover
  exit 0
fi

fail=0
count=0
while IFS= read -r cfg; do
  [ -n "$cfg" ] || continue
  count=$((count + 1))
  printf '::group::tsc -p %s\n' "$cfg"
  if bunx tsc -p "$cfg" --noEmit; then
    echo "pass  $cfg"
  else
    echo "FAIL  $cfg"
    fail=1
  fi
  printf '::endgroup::\n'
done < <(discover)

echo "typecheck matrix: ${count} tsconfig(s) checked"
if [ "$fail" -ne 0 ]; then
  echo "TYPECHECK MATRIX: FAILED"
  exit 1
fi
echo "TYPECHECK MATRIX: ALL PASS"
