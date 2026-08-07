#!/usr/bin/env bash
# run-pty-e2e.sh — the ONE way to run the real-PTY acceptance E2Es.
#
# WHY THIS FILE EXISTS. Three E2E suites are gated behind `NEUTRON_PTY_E2E=1`
# because they spawn a real `claude` under a real PTY and need working
# credentials, which CI does not have (the only CI secret is the leak-gate
# denylist). The gate is CORRECT. What was wrong is that the variable was set in
# ZERO places — not CI, not a script, not a documented command — so all three
# suites had never run anywhere, while reporting `0 pass, N skip, 0 fail`, which
# reads as a passing file in any summary that counts failures.
#
# One of them is the T7 acceptance for the shipped ritual templates. Its
# existence is what someone would cite to claim that criterion is covered. When it
# was finally run (2026-08-07, the first time in its life) two cases passed and the
# third could not pass at all: its reply poll was 60s while its own test budget was
# 180s, so the heaviest ritual timed out inside the harness and reported "produced
# nothing". With the ceiling raised it passes in ~103s.
#
# So: if a suite is too expensive or too credential-hungry for CI, it needs a
# documented runner and someone to run it. A gate with no runner is a deletion
# that still looks like coverage.
#
# Usage:
#   bash scripts/run-pty-e2e.sh              # all registered suites
#   bash scripts/run-pty-e2e.sh <substring>  # only suites whose path matches
#
# Requires: a real `claude` on PATH (or CLAUDE_BIN), with working credentials.
# Runtime: several minutes per suite — these drive real model turns.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# THE REGISTRY. Every `NEUTRON_PTY_E2E`-gated suite MUST be listed here;
# `tests/integration/pty-e2e-registered.test.ts` fails in CI otherwise, so a new
# gated suite cannot be added and then quietly never run.
PTY_E2E_SUITES=(
  "reminders/bundled-rituals.e2e.test.ts"
  "runtime/adapters/claude-code/persistent/__tests__/dev-channel-pty-bind.e2e.test.ts"
  "runtime/adapters/claude-code/persistent/__tests__/ritual-write-containment.e2e.test.ts"
)

FILTER="${1:-}"

if ! command -v claude >/dev/null 2>&1 && [ -z "${CLAUDE_BIN:-}" ]; then
  echo "run-pty-e2e: no \`claude\` on PATH and CLAUDE_BIN unset — these suites need a real binary." >&2
  exit 2
fi

ran=0
failed=0
for suite in "${PTY_E2E_SUITES[@]}"; do
  if [ -n "$FILTER" ] && [[ "$suite" != *"$FILTER"* ]]; then
    continue
  fi
  if [ ! -f "$suite" ]; then
    echo "run-pty-e2e: MISSING suite $suite (registry is stale)" >&2
    failed=$((failed + 1))
    continue
  fi
  echo "── running $suite"
  ran=$((ran + 1))
  # Do NOT let one suite's failure abort the rest: the point of a manual
  # acceptance run is a full picture, and `set -e` would hide the later suites.
  if ! NEUTRON_PTY_E2E=1 bun test "$suite"; then
    failed=$((failed + 1))
    echo "── FAILED $suite" >&2
  fi
done

if [ "$ran" -eq 0 ]; then
  echo "run-pty-e2e: no suite matched '${FILTER}'" >&2
  exit 2
fi

echo "run-pty-e2e: ran ${ran} suite(s), ${failed} failed"
[ "$failed" -eq 0 ]
