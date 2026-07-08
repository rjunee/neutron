#!/usr/bin/env bash
#
# scripts/ci/lint.sh — L5 layering gate: relative cross-workspace imports.
#
# Runs the root `eslint.config.mjs`, which today wires exactly one rule —
# `import/no-relative-packages` — over every `.ts`/`.tsx` file in the repo.
# The rule catches `../<other-workspace>/...` imports that reach across a
# `@neutronai/*` package boundary using a relative path instead of the
# package specifier. depcruise (G4) tracks resolved module edges, not
# specifier shape, so it can't see this; a relative cross-package import also
# silently couples packages without ever touching their `package.json`
# `dependencies`.
#
# WHY NOT JUST `eslint .`'S EXIT CODE: this config registers ONE rule. Some
# source files (e.g. under `app/`, or files migrated from other lint
# tooling) carry pre-existing `eslint-disable` comments for rules THIS config
# never loads (`react-hooks/exhaustive-deps`,
# `@typescript-eslint/no-explicit-any`, etc). ESLint always reports those as
# "Definition for rule '<x>' was not found" regardless of
# `reportUnusedDisableDirectives`, which would make the raw exit code flaky
# and couple this gate to unrelated lint debt. So this script parses the
# JSON report and fails ONLY on `import/no-relative-packages` findings —
# everything else is out of L5's scope and is not this gate's job.
#
# EXIT: 0 = no relative cross-workspace imports found, 1 = at least one
# found (printed), 2 = usage/internal error (eslint itself failed to run).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT" || exit 2

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT

bunx eslint . --format json > "$REPORT" 2>/dev/null
eslint_exit=$?

# eslint's own exit code is 0 (no messages), 1 (lint errors found — expected
# whenever the unrelated-rule noise above exists), or >1 (it crashed / a
# real usage error). Only >1 is fatal to this script.
if [ "$eslint_exit" -gt 1 ]; then
  echo "lint.sh: eslint failed to run (exit $eslint_exit)" >&2
  bunx eslint . --format json 1>&2 || true
  exit 2
fi

FILTER_SCRIPT="$HERE/lint-filter.mjs"
count="$(bun "$FILTER_SCRIPT" "$REPORT")"
status=$?
if [ "$status" -ne 0 ]; then
  echo "lint.sh: report filter failed" >&2
  exit 2
fi

if [ "${count:-0}" -gt 0 ]; then
  echo "LINT (relative cross-workspace imports): FAILED — ${count} found" >&2
  exit 1
fi

echo "LINT (relative cross-workspace imports): 0 found ✅"
