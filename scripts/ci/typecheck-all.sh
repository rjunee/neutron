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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT" || exit 2

discover() {
  find . -name tsconfig.json -not -path '*/node_modules/*' \
    | sed 's|^\./||' \
    | LC_ALL=C sort
}

# `--list` IS A QUERY AND MUST NOT PROVISION, and it answers before anything else
# can print. The matrix is discovered from tsconfig.json files on disk, which does
# not depend on an installed tree; meanwhile `ci-workflow.test.ts` parses this
# output AS the matrix, so a line the provisioning or verification step writes to
# stdout is read as a tsconfig path. That is exactly what happened: the verifier's
# "OK — N packages…" and two "note —" lines were compared against the files on disk.
# `--list` prints the matrix (one tsconfig path per line) without running tsc.
# Used by the CI-config test to prove matrix completeness.
if [ "${1:-}" = "--list" ]; then
  discover
  exit 0
fi

# A linked worktree does not inherit gitignored dependencies. Provision its own
# bun tree before asking tsc anything. The verifier below refuses the known-
# broken shortcut: a root node_modules symlink gives workspace packages two
# physical identities.
if [ ! -d node_modules/.bun ]; then
  echo "typecheck-all: provisioning worktree dependencies with bun install --frozen-lockfile"
  if ! bun install --frozen-lockfile; then
    echo "typecheck-all: REFUSED — worktree dependency installation failed." >&2
    exit 3
  fi
fi
if ! bun "${SCRIPT_DIR}/verify-workspace-deps.ts" "$ROOT"; then
  echo "typecheck-all: REFUSED — worktree dependency verification failed." >&2
  exit 3
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
