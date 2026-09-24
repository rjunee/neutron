## 2026-09-24 — Focus the committed allowlist self-test on its production validator

For #1196 and `docs/spec-items/trident-build-efficiency.md`, the committed
allowlist test previously ran every leak rule across the repository even though
it asserted only configuration validity. `scripts/ci/leak-gate-allowlist.sh:5`
now contains the existing candidate enumeration, allowlist loading, matching and
audit without changing their logic. The production gate sources and calls it at
`scripts/ci/leak-gate.sh:214`, then continues into every existing content,
structural and message rule. No gate option or environment bypass was added;
the full-tree CI purity invocation remains unchanged.

The same named test at `scripts/ci/leak-gate-selftest.test.ts:1513` now calls that
shared production preparation directly against the real tree and committed
allowlist. It requires successful execution, retaining the original four audit
diagnostic checks. All fixture gates copy the helper alongside the gate.

Measured with Bun 1.3.13 on base `1ba43691d`, the command
`bun test scripts/ci/leak-gate-selftest.test.ts -t 'COMMITTED allowlist'`
reported 30,611.05 ms before and 540.00 ms after, before dependency installation
in the same isolated worktree (56.7 times faster; 98.2% less test time).
With dependencies installed, the final consuming-suite run reported 904.00 ms.
These are local test timings, not a full-suite or deployed-cutover benchmark.

Validation:

- `bunx tsc --noEmit` and `bunx tsc --noEmit -p trident/tsconfig.json`: pass.
- `bun test scripts/ci/leak-gate-selftest.test.ts scripts/ci/leak-gate-explain.test.ts scripts/ci/leak-gate-nul-tripwire.test.ts scripts/ci/ci-workflow.test.ts`:
  160 pass, zero fail, 422 assertions, 54.25 seconds. An earlier run had one
  transient failure in the existing lowercase denylist test; its isolated rerun
  and this complete rerun passed without a code change.
- Malformed entries, directory globs, excessive breadth and stale paths are
  refused; the exact-path sibling remains green. A missing helper exits 2.
  `scripts/ci/leak-gate-selftest.test.ts:1535` seeds both an allowed finding and
  an unlisted finding: the production gate suppresses only the former, reports
  the latter and exits 1.
- Semantic mutations: replacing the audit rejection condition with `false`
  caused all five invalid-entry tests to fail on assertions; setting the breadth
  limit to zero caused the valid exact-path sibling to fail. Both mutations were
  restored before the passing consuming run. Neither was a parser failure.
- `bash -n scripts/ci/leak-gate.sh scripts/ci/leak-gate-allowlist.sh` and
  `git diff --check`: pass. A temporary tree preserving changed-file paths plus
  LICENSE passes the real gate with the local denylist.

The additional full-worktree gate run completed with exit 1 and 456 findings
outside the changed files, including worktree metadata and local denylist
matches. It is not claimed as green full-tree purity evidence. The focused audit
does not replace that production gate, its CI job, or required publication proof.
