# IMPLEMENTATION_PLAN — provenance spine Part 2: the in-repo docs encoding (docs-only PR)

Decision record (planning, 2026-08-31): Part 1 — the architecture document — is already
delivered and OUT of scope for this lane; this lane lands only the in-repo encoding. Scope is
EXACTLY three files (`docs/INVARIANTS.md`, `GLOSSARY.md`, `docs/SYSTEM-OVERVIEW.md`), surgical
PURE ADDITIONS, one atomic docs-only change. This is deliberately ONE task, not three: the
three edits are one contract landing as one PR, and splitting them invites a partial encoding.
The ledger write-site refusal for REQUEST_CHANGES-with-no-findings already exists in code
(`TridentEmptyFindingsRejectionError`, `trident/store.ts:58`, checked in the update path at
`:948`) and is cited as the one ENFORCED site; everything else is written as a TARGET contract
with its enforcement status stated honestly per line — the documents must never describe the
target as the present. Two token families are banned from the diff, the commit message and the
PR body: the word for a per-customer isolated instance (the CI leak gate rejects the literal
string itself — write "absolute host filesystem paths" where the machine's own directories are
meant) and any absolute host filesystem path. A docs-only diff is exempt from the
mutation-proof gate; keeping the diff docs-only keeps that exemption. Do not touch
`docs/AS_BUILT.md` (the outer loop owns it), anything under the workflows directory, or any
code file.

- [x] Part 1: architecture document written and delivered (outside this repo; not this lane's job).
- [x] Preflight: write-site refusal verified present on main (`trident/store.ts:58`, `:948`; pinned by `trident/store.test.ts`) so INVARIANTS §12 may cite it as the one enforced transition.
- [x] Preflight: every glossary anchor verified on main (`trident/store.ts:49` REVIEW_NOT_RUN; `trident/store.ts:523-527` last_advanced_at staleness-by-construction; `runtime/subagent/registry.ts:18` finished; `gateway/cores/integrations.ts:155` + `:412` connected; `trident/gh-authed.ts:50` mergeable; `trident/codex-build.sh:1165` CODEX_BUILD_BRANCH_UNBOUND; `trident/orchestrator.ts:2350` the 113 never-reviewed-runs comment).
- [x] T1 — land all three surgical additions as one docs-only change: `docs/INVARIANTS.md` gains §12 "The honesty contract" (invariants 118-123) + §13 "The action contract" (invariants 124-127) + one appended Coverage-summary bullet; `GLOSSARY.md` gains the "Names whose plain reading is false" section (8 entries, 2-3 lines each); `docs/SYSTEM-OVERVIEW.md` gains ONLY a ~27-line orientation preamble directly under its H1. Pure additions (0 deletions in `git diff --numstat` for all three), no mode changes, banned-token sweep clean over the diff and the commit message, commit message and per-edit-justified PR body exactly as given in the execution spec.
