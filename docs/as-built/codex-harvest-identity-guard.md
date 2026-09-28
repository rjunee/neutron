## 2026-09-28 — Keep Codex refresh harvesting within its stored account identity

The implicit disk-to-store refresh path compared refresh timestamps without
confirming account identity. A newer native bundle could consequently replace
the encrypted grant for another account, despite explicit adoption refusing that
identity change. The shared harvest writer now requires an existing account ID
matching the native bundle before persistence and records a sanitized refusal
otherwise (`trident/codex-credential.ts:1123`). This enforces the custody decision
dated 2026-09-27 in `SPEC.md`; it does not perform reconciliation or change account
selection or native-home admission.

Synthetic regression coverage exercises default, named and project grants with
foreign, duplicate and missing identities, alongside matching-account refreshes
(`trident/codex-credential.test.ts:566`). Refusals preserve the grant and native
bytes; successful refreshes preserve finite expiry and labels. The prior-seat
rotation fixture now refreshes its original account instead of accidentally
substituting the default account (`trident/codex-rotation.test.ts:1220`).

Validation against base `ae3dd784f0391fcab0b1121883f0bbe7e9512f1f`:

- Before the guard, the identity matrix had 15 refusal failures and three valid
  refresh passes. With the guard, the credential, rotation and operator-custody
  suites passed all 155 tests.
- Root and Trident `tsc --noEmit` checks passed.
- `bun test open/__tests__/project-build-e2e.test.ts` passed all 379 consuming
  tests in the required isolated process namespace (4,894 assertions).
- Semantic mutations were applied at module load without editing the candidate:
  replacing the identity condition with `false` produced 15 failures and three
  passes; replacing it with `true` produced three failures and 15 passes. The
  unchanged candidate then passed all 18 identity cases again.
- The local leak gate did not pass: it reported 451 denylist findings on an
  archive of the fetched base, and the same category counts plus one untracked
  Git worktree pointer finding on this working tree. No gate exception was added.

Full repository checks, exact-head CI, publication and deployment remain
unverified. No live credential or database operation is part of this change.
