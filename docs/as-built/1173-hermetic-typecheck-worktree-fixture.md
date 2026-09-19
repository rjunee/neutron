## 2026-09-19 — isolate the fresh-worktree typecheck fixture from ambient modules

Issue #1173 records a false G063 failure in the real-worktree regression. The same
`scripts/ci/typecheck-worktree.test.ts` revision at `bb6065b4` and the fetched
`origin/main` at `a1be24e0` passed from a top-level temporary worktree, but failed
its fresh-worktree case when the invoking checkout exposed the reported
`node_modules/@types/@types` ancestor entry. A direct compiler invocation against
that topology produced TS2688 for the implicit `@types` library. This was a fixture
failure, not evidence that `typecheck-all.sh` failed to provision a real checkout.

The fixture had two ambient dependencies. It created all of its repositories below
the invoking checkout, allowing TypeScript's ancestor lookup to enter that checkout's
dependency tree. It also replaced the copied TypeScript manifest with a package that
had a binary but no `main`; Bun 1.3.13 hoisted that package into the fixture root, so
the workspace dependency verifier could resolve `typescript` only by escaping to the
invoking checkout. The scratch root now lives in the operating system temporary
directory, and the vendored compiler retains a resolvable JavaScript entry point
(`scripts/ci/typecheck-worktree.test.ts:34-44`).

The fixture app now declares that it consumes no ambient type packages. A deliberately
invalid local type root reproduces the former TS2688 direction without relying on any
developer or runner dependency tree (`scripts/ci/typecheck-worktree.test.ts:51-60`).
This changes test construction only: the production dependency verifier and dynamic
typecheck matrix are untouched.

### Bidirectional mutations

| Mutation | Result |
|---|---|
| Remove `types: []` from the generated fixture config | Fresh-worktree case failed with matrix exit 1 after dependency verification passed |
| Replace the fixture's numeric value with a string | Fresh-worktree case failed with matrix exit 1, proving the compiler still rejects source errors |
| Restore both lines | 3/3 real-worktree cases passed |

### Validation

- `bun test scripts/ci/typecheck-worktree.test.ts scripts/ci/verify-workspace-deps.test.ts`: 17 pass, 0 fail.
- `bun test open/__tests__/project-build-e2e.test.ts`: 89 pass, 0 fail (818 assertions).
- `bunx tsc -p tsconfig.json --noEmit`: passed.
- `bunx tsc -p trident/tsconfig.json --noEmit`: passed.
- `bunx tsc -p app/tsconfig.json --noEmit`: passed.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed, including `app/tsconfig.json`.
- `bash scripts/ci/lint.sh`: passed all gates after the reproduction-only dependency directory was removed. The first lint attempt was not a source result: its recursive walkers encountered the intentionally created self-link used to reproduce TS2688.
- `bash scripts/ci/leak-gate.sh --tree .`: not green. Its all-files scan reported the linked worktree's `.git` pointer plus 453 PII-denylist hits across the tree, so this local invocation is not a clean leak certification.

No production provisioning rule, dependency refusal, feature flag, product decision,
or publication surface changed.
