## 2026-09-24 — Suite identity records first-party workspace links instead of hashing their trees

### Measured failure

PR #1269 failed twice (runs b151870b and 2213c68e) with `build-driver-settled
{"kind":"unknown","detail":"Suite inputs changed during host observation"}`
after a green host full suite (1668 files, 0 fail) with no other writer in the
suite window. No `build-suite-receipt` event in production had ever carried an
`identity`, so no host suite receipt had ever been saved for reuse.

### Root cause

`trident/project-suite-receipt.ts` compares `projectSuiteIdentity` before and
after `source.observe`. Its installed-tree component,
`projectInstalledTreeIdentity` (`open/wiring/project-build-dependencies.ts:110`),
followed every in-root `node_modules` link and walked the target. In this
repository that includes every `node_modules/@neutronai/*` workspace link, so
the walk hashed `%T@`/`%C@` of about 50 first-party SOURCE directories. Suite
tests create and delete temporary files inside those directories (for example
`migrations/__tests__/migrate-owner-mutation.test.ts:40` writes into
`import.meta.dir`), which moves directory mtime/ctime while git stays clean and
no input changes. Every full suite therefore flipped the identity.

### What changed

`projectInstalledTreeIdentity` now walks and hashes only installed-dependency
trees: the root `node_modules`, any in-root link target inside a
`node_modules` tree (`open/wiring/project-build-dependencies.ts:156`), and a
plain-directory `node_modules` nested under a linked first-party package. A
link whose target is a first-party path (workspace package, `file:` directory,
`.bin` entry pointing at a source file) is recorded as link path -> resolved
target (`:160`, hashed at `:178`) and is never stat'ed or walked. Git HEAD plus
a clean `git status`, both already part of `projectSuiteIdentity`, prove those
sources. The find argv, printf format, 5 s deadline, output validation and
external-target refusal are unchanged. `projectSuiteIdentity`,
`preparationKey`, `resolutionKey` and `RECEIPT_VERSION` are untouched; a
receipt persisted under the old measurement simply fails to match once and the
suite re-runs.

What still refuses or changes the identity: a third-party byte change under
`node_modules` or the Bun store (including a same-mtime rewrite), an added or
removed package, a retargeted workspace link, a change inside a
`node_modules` nested under a linked workspace, a link target outside the root,
a nested `node_modules` that is a link or file, a first-party target that git
ignores (one batched `git check-ignore` at `:175`; exit 1 is the only accepted
result, because an ignored source is covered by neither HEAD nor status), a
dirty tree, a HEAD mismatch and any unmeasurable state.

### Receipt consumer: unknown-before

`trident/project-suite-receipt.ts:54` makes the decision explicit:
`stable = identity !== null && after === identity`. Known-before with a changed
or unmeasurable after still settles `unknown` with the same detail (`:63`), and
the receipt is saved only when `stable` (`:67`). Unknown-before (null) is kept
as a one-shot observation: `decode()` refuses any prior receipt for a null
identity (`:26`) and the fresh one is never saved, so the caller consumes it
once as an unproven, non-reusable result and the next observation re-runs the
suite. This is the contract `trident/project-build-host.test.ts` already
asserts for an unknown identity. It is not turned into `unknown` because one
over-deadline walk would then veto every green suite without adding proof.

### Tests and mutation control

- `open/__tests__/project-suite-identity.test.ts:162`: in a fixture with a
  declared workspace and `node_modules/@scope/pkg -> ../../pkg`, both the
  installed and suite identity stay EQUAL after creating/deleting a temp file
  in `pkg/` and moving `pkg/`'s mtime into the future. `:174`: they DIFFER
  after a same-mtime third-party byte change, an added package, a removed
  package, a retargeted link, and a nested `pkg2/node_modules` addition and
  byte change. `:215`: a first-party edit leaves the installed identity equal
  while the suite identity goes null (dirty); external, git-ignored and
  non-directory nested `node_modules` targets refuse.
- `open/__tests__/project-suite-receipt.test.ts` drives
  `createProjectSuiteReceipts` through the real `projectSuiteIdentity` and a
  migrated `TridentRunStore`: a green observe that scratches `pkg/` returns the
  receipt, SAVES it with an identity, and a second observe reuses it without
  running the source; mutating `node_modules` during observe returns
  `unknown` and saves nothing; a null-before identity returns the fresh
  receipt, saves nothing and re-runs next time.
- `open/__tests__/project-build-e2e.test.ts:1738` gains a `workspace-scratch`
  variant expecting reuse (one suite). Its Bun isolated-linker fixture does not
  link the `app` workspace from the root `node_modules`, so this variant is a
  composed regression check, not the discriminating test.
- Mutation: replacing `firstParty.push([group[position]!, actual])` with
  `pending.push(actual)` (restoring the walk into first-party targets) turned
  the stability test and the first-party test RED (2 fail, 8 pass), and the
  receipt "scratches a workspace directory" test RED; restored, all green.
- Live-tree control: on this repository's worktree, the installed identity was
  equal before and after creating/deleting a temp file in `trident/` and
  moving `migrations/`'s mtime (measured in about 1.1 s).

### Verification

`bun test open/__tests__/project-suite-identity.test.ts
open/__tests__/project-suite-receipt.test.ts trident/project-build-host.test.ts`
(56 pass), `bun test open/__tests__/project-build-e2e.test.ts`,
`tsc -p tsconfig.json`, `tsc -p trident/tsconfig.json`,
`scripts/ci/typecheck-all.sh`, `scripts/ci/lint.sh`,
`scripts/ci/leak-gate.sh --tree .` and `git diff --check`.
