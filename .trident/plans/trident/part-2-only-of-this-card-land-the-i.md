# IMPLEMENTATION_PLAN — provenance spine Part 2: the in-repo docs encoding (docs-only PR)

Decision record (planning, 2026-08-31): Part 1 — the architecture document — is already
delivered and OUT of scope for this lane; this lane lands only the in-repo encoding. Scope is
EXACTLY three DOCUMENT files (`docs/INVARIANTS.md`, `GLOSSARY.md`, `docs/SYSTEM-OVERVIEW.md`),
surgical PURE ADDITIONS, one atomic docs-only change — plus this plan file itself, which every
trident lane commits under `.trident/plans/` by standing repo convention. This is deliberately ONE task, not three: the
three edits are one contract landing as one PR, and splitting them invites a partial encoding.
The ledger write-site refusal for REQUEST_CHANGES-with-no-findings already exists in code
(`TridentEmptyFindingsRejectionError`, `trident/store.ts:58`, checked in the update path at
`:1005-1026`) and is cited as the one PARTLY enforced site — it binds in-process writers only,
and `checkpoint.sh` bypasses it out-of-band by construction, which the text says plainly.
Everything else is written as a TARGET contract with its enforcement status stated honestly
per line — the documents must never describe the
target as the present. Two token families are banned from the diff, the commit message and the
PR body: the word for a per-customer isolated instance (the CI leak gate rejects the literal
string itself — write "absolute host filesystem paths" where the machine's own directories are
meant) and any absolute host filesystem path. A docs-only diff is exempt from the
mutation-proof gate; keeping the diff docs-only keeps that exemption. Do not touch
`docs/AS_BUILT.md` (the outer loop owns it), anything under the workflows directory, or any
code file.

- [x] Part 1: architecture document written and delivered (outside this repo; not this lane's job).
- [x] Preflight: write-site refusal verified present at the branch's real base 5d3550de (`trident/store.ts:58`, guard `:1005-1026`; bypass comment `:1019-1021`; pinned by `trident/store.test.ts:1054`) so INVARIANTS §12 may cite it as the one partly-enforced transition.
- [x] Preflight (RE-DONE at 5d3550de after round 1 found the first pass pinned against a stale local main): every anchor re-verified against the merge-base — `trident/store.ts:49` REVIEW_NOT_RUN/REQUEST_CHANGES; `trident/store.ts:999` the unconditional last_advanced_at push and `:562-567` the staleness rationale; `runtime/subagent/registry.ts:18` finished; `gateway/cores/integrations.ts:155` + `:412` connected; `trident/inner-workflow.mjs:4707-4712` (probe) + `:4061-4065` (consumer) mergeable; `trident/inner-workflow.mjs:6495-6499` the clean-APPROVE empty-findings write; the eight `CODEX_BUILD_BRANCH_UNBOUND` sites in `trident/codex-build.sh` (`:1165`, `:1183`, `:1187`, `:1205`, `:1213`, `:1220`, `:1226`, `:1232`); `trident/orchestrator.ts:912-924` recordedTerminalVerdict and `:2538` the 113 never-reviewed-runs comment; `trident/checkpoint.sh:182` the out-of-band verdict write.
- [x] T1 — land all three surgical additions as one docs-only change: `docs/INVARIANTS.md` gains §12 "The honesty contract" (invariants 118-123) + §13 "The action contract" (invariants 124-127) + one appended Coverage-summary bullet; `GLOSSARY.md` gains the "Names whose plain reading is false" section (8 entries, 2-3 lines each); `docs/SYSTEM-OVERVIEW.md` gains ONLY a ~27-line orientation preamble directly under its H1. Pure additions (0 deletions in `git diff --numstat` for all three), no mode changes, banned-token sweep clean over the diff and the commit message, commit message and per-edit-justified PR body exactly as given in the execution spec.
- [x] T2 (round 2, after Argus) — anchor-correction and honesty pass over the same three documents, no new scope: #122 no longer claims a narrow waist the code does not have and no longer says the guard records REVIEW_NOT_RUN (it throws and writes nothing; the substitution is `recordedTerminalVerdict` a layer up); #120 repinned from a docstring usage example to the real consumer; #126 made conditional on UNKNOWN-based refusals and repinned across all eight emission sites; the empty-findings glossary entry corrected (a clean APPROVE persists an empty list, so the false reading applies only alongside REQUEST_CHANGES); `last_advanced_at` restated as every-store-write, and a long round performs none; anchors added to #119/#121/#124/#125/#127; the GLOSSARY scoping note amended to admit this one live-names section; the SYSTEM-OVERVIEW preamble no longer cites an in-repo document that does not exist and drops an unsourced read-count.
