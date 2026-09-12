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

# ── CHECK 5: wall-clock timing-assertion ban (ISSUES #438) ─────────────
# A test that compares REAL elapsed time against a threshold measures the
# machine, so it reddens when the runner is loaded rather than when the code is
# wrong. The tree was swept once (4437e8c7); this stops the class regrowing.
# Bounds with no deterministic substitute carry a justified WALL-CLOCK-BOUND-OK
# marker. See wall-clock-bound-check.mjs.
if ! bun "$HERE/wall-clock-bound-check.mjs"; then
  fail=1
fi

# ── CHECK 6: the app manifest matches what installs (ISSUES #513) ──────
# In CI this catches an `app/package.json` entry the lockfile cannot satisfy —
# declared, unresolvable, and therefore absent after a clean install. Locally it
# catches the state that actually shipped the bug: a dependency added to the
# manifest without re-installing, so `eas build` computed the runtime fingerprint
# from a tree that did not contain its own new native module. Same check, two
# failure modes, one root cause — the manifest and the install tree disagreeing.
# The submit-time runner is `scripts/eas-build.sh`.
if ! bun "$HERE/eas-build-preflight.ts" "$HERE/../.."; then
  fail=1
fi

# ── CHECK 7: keyboard-taps gate (mobile: first tap eaten while keyboard open) ──
# Every scrollable under app/ must set keyboardShouldPersistTaps or argue an
# in-tag exemption; the check refuses to pass on an empty match set. See
# keyboard-taps-check.mjs and .trident/plans/trident/fix-the-mobile-first-tap-is-eaten-w.md.
if ! bun "$HERE/keyboard-taps-check.mjs"; then
  fail=1
fi

# ── CHECK 8: a base BRANCH NAME as a rev-range operand (ISSUES #546) ───
# `git diff main..<head>` in a shared build checkout diffs against whatever
# `refs/heads/main` holds, so every commit merged into the base since the last
# pull is presented as this branch's own work — measured at 149 files where the
# branch changed 30 (#546) and at ~100 files where it changed 20 (run 25b2327d).
#
# DEFENCE IN DEPTH, NOT THE GUARANTEE. What enforces the invariant is structural:
# one binding per boundary (`diffBase`, `diffBaseRef()`), plus an argv boundary that
# hands the wrappers whatever that binding resolved — a sha, `refs/remotes/origin/<base>`,
# or `refs/heads/<base>`, never a bare name (round nineteen; this line said "the legitimate
# bare name when no remote-tracking ref resolves" until then). `codex-wrapper-range-line.test.ts`
# runs both wrappers' shipped range lines to measure what they do with whatever they are
# handed, since argv comes from anyone.
#
# THAT BOUNDARY IS NOT UNIFORM, and this comment used to say it was — "no variable
# holding a base branch NAME exists in their scope at all". `codex-build.sh` reaches
# it (argv $2, default EMPTY, and empty skips the diff). `codex-review.sh` does NOT:
# it defaults `BASE_REF` to the literal `main` for standalone use, promoting it to
# `refs/remotes/origin/main` when that ref resolves — whether or not a local branch of that
# name exists, since a detached CI checkout carries only the remote-tracking ref — and to
# `refs/heads/main` otherwise, refusing an ambiguous or tag-only argument. ("for a proven local
# branch name" until round twenty-six: that precondition rejected the ordinary CI checkout.)
# The as-built for this branch records that default; a guard describing its own
# coverage must not contradict it, because a stale sentence HERE tells the next
# person a gap is covered when it is not.
#
# This check makes a regression LOUD; a pass means "none of the enumerated spellings
# is present", never "no bare-base range exists". diff-base-check.mjs lists what it
# cannot see, and why.
if ! bun "$HERE/diff-base-check.mjs"; then
  fail=1
fi

exit "$fail"
