#!/usr/bin/env bash
#
# scripts/ci/lint.sh — L5 layering gate: relative cross-workspace imports.
#
# CHECK 1 + CHECK 2 fail the build on a relative import that
# crosses a `@neutronai/*` workspace-package boundary (which should use the
# `@neutronai/<pkg>/...` specifier instead); CHECK 3 (F3) bans bare
# `void <promise>` fire-and-forget outside the fireAndForget wrapper.
# depcruise (G4) tracks resolved
# module edges, not specifier shape, so it can't see either class; a relative
# cross-package import also silently couples packages without ever touching
# their `package.json` `dependencies`.
#
# CHECK 1 — ESLint (eslint.config.mjs), two rules:
#   * `import/no-relative-packages` — covers STATIC import/export declarations
#     (with OR without a file extension — the config's `import/resolver:
#     typescript` setting resolves extensionless `.ts` specifiers so the rule
#     can see they cross a boundary), `require()`, and value-position dynamic
#     `await import()`.
#   * `no-restricted-syntax` — P2 `ProjectDb.raw()` restriction: production
#     code must use the typed get/all/runSync/run/exec/transaction API; the
#     migration runner (`migrations/runner.ts`) is the only allowed `raw()`
#     caller (tests exempt — see the config block for the full rationale).
#
#   WHY NOT JUST `eslint .`'S EXIT CODE: this config registers ONE rule. Some
#   source files (e.g. under `app/`, or files carrying directives for other
#   lint tooling) have pre-existing `eslint-disable` comments for rules THIS
#   config never loads (`react-hooks/exhaustive-deps`,
#   `@typescript-eslint/no-explicit-any`, etc). ESLint always reports those as
#   "Definition for rule '<x>' was not found" regardless of
#   `reportUnusedDisableDirectives`, which would make the raw exit code flaky
#   and couple this gate to unrelated lint debt. So this script parses the
#   JSON report and fails ONLY on `import/no-relative-packages` findings.
#
# CHECK 2 — TYPE-QUERY gate (scripts/ci/type-query-check.mjs).
#   `import/no-relative-packages` does NOT lint TypeScript type-position
#   `import('...').Foo` queries (a `TSImportType` node its moduleVisitor never
#   visits). type-query-check.mjs resolves every `import('<relative>')` against
#   the importing file and fails on any that cross a workspace-package root.
#
# EXIT: 0 = both checks clean, 1 = at least one violation (printed),
# 2 = usage/internal error (a tool failed to run).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT" || exit 2

# ── CHECK 1: static/require/value-import via ESLint ────────────────────
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

fail=0
if [ "${count:-0}" -gt 0 ]; then
  echo "LINT (cross-workspace imports + ProjectDb.raw() restriction): FAILED — ${count} found" >&2
  fail=1
else
  echo "LINT (cross-workspace static/require/value-import + ProjectDb.raw() restriction): 0 found ✅"
fi

# ── CHECK 2: type-position import() queries ────────────────────────────
if ! bun "$HERE/type-query-check.mjs"; then
  fail=1
fi

# ── CHECK 3: F3 bare `void <promise>` fire-and-forget ban ──────────────
# Every fire-and-forget promise must go through fireAndForget() so its
# rejection is logged, not silently swallowed. See void-promise-check.mjs.
if ! bun "$HERE/void-promise-check.mjs"; then
  fail=1
fi

# ── CHECK 4: O2 bare `console.*` ban ───────────────────────────────────
# Host/product code must log through `createLogger(...)` from @neutronai/logger,
# not a bare `console.*` (which re-forks the one-logger convention). The logger
# package, genuine CLI entrypoints, browser/leaf/core code, and tests are
# allow-listed. See console-ban-check.mjs.
if ! bun "$HERE/console-ban-check.mjs"; then
  fail=1
fi

exit "$fail"
