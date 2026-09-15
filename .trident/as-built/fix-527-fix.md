## 2026-09-15 — Denylisted identities stay out of merge messages

### What changed

Every project build dispatch now writes a neutral repository-local Git identity before an agent can commit, for both new and existing workspaces (`trident/build-workspace.ts:62-120`). The initial commit uses that maintained configuration and only overrides signing (`trident/build-workspace.ts:122-133`). A configuration write failure throws instead of inheriting a machine identity (`trident/build-workspace.ts:103-116`).

The purity job now derives its scan base from fetched repository history rather than event payload fields. A branch head uses its merge base with `origin/main`; a just-landed mainline head uses its parent, keeping the squash commit in the range (`.github/workflows/ci.yml:278-299`). The derived value is the sole CI input to the gate (`.github/workflows/ci.yml:302-322`).

An explicitly supplied all-zero base in CI or any other unresolvable supplied base now refuses the message scan (`scripts/ci/leak-gate.sh:659-679`). An invalid supplied head also refuses instead of silently changing to `HEAD` (`scripts/ci/leak-gate.sh:680-687`). The existing CI failure outcome remains exit 2 (`scripts/ci/leak-gate.sh:728-743`).

### Decisions

Repository-local configuration is the maintained source because Git worktrees share repository configuration, and the dispatch resolver runs before merge-mode and workflow setup (`trident/board-dispatch.ts:893-926`). Reapplying the values on every dispatch continuously repairs an older workspace and does not depend on the author process noticing a leak (`trident/build-workspace.ts:90-120`).

Identity-configuration failure joins the dispatch function's existing `backend_error` vocabulary. The resolver throws (`trident/build-workspace.ts:111-116`), and the dispatch chokepoint converts any preparation exception to `backend_error` by default (`trident/board-dispatch.ts:893-940`). The message-range refusal joins the gate's documented configuration/internal-error exit 2 vocabulary (`scripts/ci/leak-gate.sh:117-123`) and therefore fails CI by default (`scripts/ci/leak-gate.sh:734-743`).

The all-zero marker remains a supported local first-push signal because local resolution can use the repository's mainline ref, but the same value is fatal in CI (`scripts/ci/leak-gate.sh:663-679`). This preserves the pre-push behavior while removing CI's event-dependent substitution.

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Neutral repository email (`trident/build-workspace.ts:65`) | Changed it to `inherited@example.invalid`; printed mutated line 65 | `fresh project` failed at `trident/build-workspace.test.ts:78` | 1 pass, 0 fail |
| Invalid supplied base refuses (`scripts/ci/leak-gate.sh:669`) | Substituted `main`; printed mutated line 669 | `explicitly supplied unresolvable base` failed at `scripts/ci/leak-gate-selftest.test.ts:1293` and the mutant reported a silent result | 1 pass, 0 fail |
| CI consumes the history-derived base (`.github/workflows/ci.yml:316`) | Restored the event-dependent expression; printed mutated line 316 | `derived from history` failed at `scripts/ci/ci-workflow.test.ts:270` | 1 pass, 0 fail |

### Verification

The complete focused command `bun test trident/build-workspace.test.ts scripts/ci/ci-workflow.test.ts scripts/ci/leak-gate-selftest.test.ts` passed 146 tests with 407 assertions. After the final mainline-parent refinement, `bun test scripts/ci/ci-workflow.test.ts trident/build-workspace.test.ts` passed 87 tests with 206 assertions. `bash scripts/ci/lint.sh` passed every reported gate.

The repository's 51-config typecheck matrix passed `trident/tsconfig.json`. It failed only in untouched files: `app/tsconfig.json` could not find its implicit type library; `gateway/transcription/__tests__/whisper-install.test.ts:186`, `onboarding/history-import/__tests__/zip-writer.ts:10`, and `logger/__tests__/fire-and-forget.test.ts:301` reported existing type errors.

### Deliberately not changed

Existing merged history was not rewritten. The changed-file set was enumerated with `git diff --name-only origin/main` and contains only the workflow, gate, their focused tests, the build-workspace resolver and test, and this as-built record. The historical diagnosis in the spec item remains because it accurately describes the replaced behavior (`docs/spec-items/merge-message-pii-and-a-deterministic-leak-window.md:17-23`). `SPEC.md` was not changed because this implementation does not alter a product decision. The full test suite was not run, as required by the lane brief.
