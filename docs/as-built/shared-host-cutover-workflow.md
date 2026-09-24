## 2026-09-24 — Admit shared-host checks once and finalize cutover evidence before publication

Operator validation could start competing full suites in separate worktrees,
while bookkeeping amendments invalidated CI on an otherwise completed head.
`AGENTS.md:46` now points to the shared-host workflow in `CONTRIBUTING.md:153`.
That workflow keeps independent side work off the cutover dependency chain,
prepares the narrative before validation and records the exact local receipt after
the checks finish, then freezes one publication head. It preserves
both required local checks and identity-bound proof reuse, and requires exact-head
CI and the existing served/unattended dispatch witness before claiming cutover.

`scripts/check-shared-host.sh:5` admits operator checks under a non-waiting lock
on the existing Git common directory inode, opened read-only (`:13`). Linked
worktrees resolve the same directory; no temporary lock pathname is created,
rotated or opened for truncation. Another admitted run exits 75 before typecheck
or test execution. Non-Git roots and lock errors refuse with exit 2. The holder
clears inherited test selectors and uses jobs=4, chunk-size=100 and runner-default
concurrency (`:31`), then calls the existing all-config typecheck and complete
partitioned suite (`:33`). Either
failure remains a failure and releases the lock. This local profile is not a
universal performance claim. Related work: #1196; this is the operator workflow
slice, not completion of that issue's production efficiency acceptance.

Validation: `bash -n scripts/check-shared-host.sh`, `git diff --check`, and
`bun test scripts/check-shared-host.test.ts`: **5 pass, 0 fail**. Tests invoke the
actual executable from two real, tiny Git worktrees with fixture gate commands.
They prove the directory lock is held during both checks, the competing worktree
is refused before any check action and admitted after release, inherited
shard/planner/fake-runtime settings are cleared, failures release admission, and
a non-Git root is refused before either gate. Semantic controls reject both
unconditional admission and unconditional refusal. The original implementation
was restored after those controls.
The local full-tree leak preflight reported findings and is not claimed green;
publication still requires the configured purity gate to pass.
The changed-path diagnostic (the five changed files plus LICENSE, copied to an
isolated directory) passed the configured leak gate with zero findings. Adding a
hosted-domain fixture made that same scan fail with one finding. This diagnostic
does not replace the complete tree or commit-message publication checks.

Full local typecheck/suite and exact-head CI remain required before publication
and merge; they were not run during this focused verification because another
change held the shared host's suite slot. The lock governs this operator entry
point within one repository; it does not intercept direct runner invocations,
Trident or other repositories, or defend against another writer replacing the
Git common directory. This change
does not modify the suite runner, CI, Trident production code or suite receipt
identity, does not establish a deployed benchmark, and does not close #1196.
