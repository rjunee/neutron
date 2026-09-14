## Issue 822 — independent commit-integrity hook installation

### What changed

The installer now creates a dedicated managed hook directory and points each worktree at it through worktree-local Git configuration (`scripts/install-git-hooks.sh:25`, `scripts/install-git-hooks.sh:38`, `scripts/install-git-hooks.sh:41`). It always links the versioned commit-integrity hook (`scripts/install-git-hooks.sh:53`). When no non-empty list is available, it configures that directory with only `pre-commit`, reports `PARTIALLY INSTALLED`, explicitly reports `pre-push` as not installed, and exits successfully (`scripts/install-git-hooks.sh:57`, `scripts/install-git-hooks.sh:58`, `scripts/install-git-hooks.sh:60`, `scripts/install-git-hooks.sh:62`, `scripts/install-git-hooks.sh:86`). When the list is available, it also links `pre-push` and reports both hooks active (`scripts/install-git-hooks.sh:92`, `scripts/install-git-hooks.sh:93`, `scripts/install-git-hooks.sh:96`).

The fixture now copies both real hooks (`scripts/ci/leak-gate-selftest.test.ts:516`, `scripts/ci/leak-gate-selftest.test.ts:517`, `scripts/ci/leak-gate-selftest.test.ts:837`, `scripts/ci/leak-gate-selftest.test.ts:838`). The no-list case asserts the partial report, a configured `core.hooksPath`, the presence of only `pre-commit`, and a successful real `git hook run pre-commit` (`scripts/ci/leak-gate-selftest.test.ts:970`, `scripts/ci/leak-gate-selftest.test.ts:975`, `scripts/ci/leak-gate-selftest.test.ts:979`, `scripts/ci/leak-gate-selftest.test.ts:983`, `scripts/ci/leak-gate-selftest.test.ts:985`). The list-present case asserts the full report, configured path, and both hook entries (`scripts/ci/leak-gate-selftest.test.ts:991`, `scripts/ci/leak-gate-selftest.test.ts:995`, `scripts/ci/leak-gate-selftest.test.ts:999`, `scripts/ci/leak-gate-selftest.test.ts:1003`).

### Decisions

The managed directory contains symbolic links, not copies, so a pulled hook correction remains live without rerunning the installer (`scripts/install-git-hooks.sh:8`, `scripts/install-git-hooks.sh:53`, `scripts/install-git-hooks.sh:93`). Its absolute path is stored in worktree-local configuration so installing one worktree cannot redirect another worktree to this checkout (`scripts/install-git-hooks.sh:38`, `scripts/install-git-hooks.sh:41`, `scripts/install-git-hooks.sh:58`).

`PARTIALLY INSTALLED` joins the installer's existing installed/not-installed output vocabulary. Its default process outcome is success because the requested commit-integrity installation completed; the detailed output names the unavailable pre-push gate (`scripts/install-git-hooks.sh:60`, `scripts/install-git-hooks.sh:62`, `scripts/install-git-hooks.sh:86`). The pre-push gate's fail-closed runtime outcome is unchanged: if its list disappears after installation, the existing test still requires `COULD NOT RUN`, `PUSH BLOCKED`, and a nonzero exit (`scripts/ci/leak-gate-selftest.test.ts:1010`, `scripts/ci/leak-gate-selftest.test.ts:1022`, `scripts/ci/leak-gate-selftest.test.ts:1025`).

The maintained invariant is that the configured managed directory contains `pre-commit` always and `pre-push` only when its pattern source was available at installation. The installer rebuilds that directory on every run before configuring it (`scripts/install-git-hooks.sh:48`, `scripts/install-git-hooks.sh:53`, `scripts/install-git-hooks.sh:57`, `scripts/install-git-hooks.sh:93`); the invariant does not require an uninstalled hook to execute.

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Always install `pre-commit` (`scripts/install-git-hooks.sh:53`) | Linked it as `pre-commit.disabled`; printed landing line 47 in the mutation worktree | No-list case failed at `scripts/ci/leak-gate-selftest.test.ts:983`, expected the active hook to exist | Focused installer tests: 2 pass, 0 fail |
| Install `pre-push` only with a non-empty list (`scripts/install-git-hooks.sh:57`) | Inverted `! -s` to `-s`; printed landing line 51 in the mutation worktree | Both cases failed: partial-state assertion at `scripts/ci/leak-gate-selftest.test.ts:975`, full-state assertion at `scripts/ci/leak-gate-selftest.test.ts:995` | Focused installer tests: 2 pass, 0 fail |

### Verification

`bun test scripts/ci/leak-gate-selftest.test.ts` passed 58 tests with 0 failures. `bash scripts/ci/lint.sh` passed all reported gates. `git diff --check` passed. The requested `bun run typecheck` command does not exist in `package.json:12`; the repository's direct root check, `bunx tsc --noEmit`, reached three unrelated existing errors outside this lane at `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`.

### Deliberately not changed

The commit-integrity hook itself was not weakened; its three refusal outcomes remain defined by `.githooks/pre-commit:4`, `.githooks/pre-commit:12`, and `.githooks/pre-commit:17`. The pre-push hook and leak gate were not changed; their existing fail-closed behavior remains tested at `scripts/ci/leak-gate-selftest.test.ts:1010`. `CONTRIBUTING.md:96` still describes only the pre-push side of installation, and `docs/SYSTEM-OVERVIEW.md:6869` describes the still-true pairing between that gate and its pattern source; both are outside this lane's allowed territory. No product decision or `SPEC.md` decision changed.
