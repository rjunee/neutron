## 2026-09-19 — Keep CI fixture diagnostics local and observable

The cross-workspace lint fixture invoked `bunx` by name. A full-suite run on the
host failed before ESLint ran because that executable was absent from the child
process PATH. The fixture now invokes the installed local ESLint CLI with the
current Bun executable. It still tests both directions: a cross-workspace
relative import must be rejected and a local relative import must be accepted.

The fresh-worktree typecheck fixture previously asserted only its exit code,
hiding the subprocess output when provisioning or typechecking failed. The
assertion now carries that output on failure without changing its pass criteria.
The web production-bundle test was not changed: the observed Bun file-read
errors did not reproduce or establish a code defect.

On an isolated checkout of base `ae21fe5d`, all six assertions across the three
affected files passed before the changes, both with default concurrency and
with `--max-concurrency=1`. Afterward, the same six passed; the lint fixture
also passed with a PATH that contains Bun but excludes `bunx`. These checks
do not prove the full live suite green or classify its unreproduced bundle and
typecheck failures as pre-existing under G063.
