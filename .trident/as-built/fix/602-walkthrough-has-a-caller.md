## Issue 602 — browser walkthrough caller finding

### Outcome

No production or CI wiring was added. The unchanged browser walkthrough is red in the build lane, so wiring it would knowingly add a failing job. This follows the filed issue's instruction to report the break rather than weaken the walkthrough or wire it in red.

### Evidence and root cause

The caller absence was checked with this repository-wide tracked-content search, excluding documentation and the walkthrough itself:

`git grep -nE 'onboarding_walkthrough\.py|run-pty-e2e\.sh' -- ':!docs/**' ':!tests/e2e-browser/onboarding_walkthrough.py'`

The `run-pty-e2e.sh` half was the positive control. It matched the runner's own usage at `scripts/run-pty-e2e.sh:24-25` and its test caller at `tests/integration/pty-e2e-registered.test.ts:32`; the `onboarding_walkthrough.py` half returned no match. Test discovery cannot supply the missing caller because its complete extension list is JavaScript and TypeScript test/spec files at `scripts/lib/discover-test-files.sh:25-34`, while the walkthrough is Python.

Running `python3 tests/e2e-browser/onboarding_walkthrough.py` unchanged returned exit 1. Execution imports the Python Playwright binding inside `run()` at `tests/e2e-browser/onboarding_walkthrough.py:243-245`, and that import raised `ModuleNotFoundError`. The configured health endpoint was also unreachable. Once the import prerequisite exists, unreachable-server handling is deliberately a non-pass exit 2 at `tests/e2e-browser/onboarding_walkthrough.py:246-256`.

### Execution-lane decision

The intended home is a separate real-browser lane, not the default PR suite. The walkthrough needs a live Open install at `tests/e2e-browser/onboarding_walkthrough.py:7-9`, allows 180 seconds for its first live response at `tests/e2e-browser/onboarding_walkthrough.py:65-69`, and reports some host-filesystem and live-response checks without gating them at `tests/e2e-browser/onboarding_walkthrough.py:650-660`. Those dependencies make the eight-way default hosted PR shard inappropriate. A scheduled, explicitly named lane on a prepared same-host installation would make missed execution visible without making every PR depend on a live model session. That lane was deliberately not added while its unchanged command cannot start here.

### Other walkthrough and e2e inventory

The complete tracked executable/test inventory was enumerated with `git ls-files | rg -i '(^|/)[^/]*(walkthrough|e2e)'`, then documentation and the runner/registry files were classified separately. It found the browser walkthrough and eleven filename-marked TypeScript e2e suites. All eleven TypeScript suites appeared in the independent output of `neutron_discover_test_files` from `scripts/lib/discover-test-files.sh:20-34`; therefore none has the same undiscoverable zero-caller shape. Four credential-gated suites additionally have explicit runner entries at `scripts/run-pty-e2e.sh:34-42`, and the registry test states that its purpose is to prevent a gated suite from lacking a runner at `tests/integration/pty-e2e-registered.test.ts:19-23`.

### Mutation table

No guard or test was added, so there is no guard mutation to perform. The requested bidirectional proof through a new caller cannot honestly be created before the unchanged walkthrough passes on its target host.

### Validation

`bun test scripts/git/as-built-heading-uniqueness.test.ts scripts/ci/as-built-write-guard.test.ts` passed 31 tests. `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configurations, and `bash scripts/ci/lint.sh` passed. The leak gate reported zero findings from the rules it could run, but its owner-identity scan was unavailable because this lane lacks the required external denylist; that result is incomplete rather than green.

### Deliberately not done

I did not install or mock Playwright, start a fixture server, opt into the soft skip, reduce assertions, or add a conditional/allowed-failure CI step. The soft skip returns success at `tests/e2e-browser/onboarding_walkthrough.py:250-252`, which would recreate the false-green condition this issue exists to remove. No product decision or `SPEC.md` decision changed.
