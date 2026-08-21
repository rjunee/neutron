# IMPLEMENTATION_PLAN — #313/main brief-part integrity arbitration (merge, PR #377)

Decision record (unchanged, 2026-08-17): both #313 and main (#321) independently built
brief-part integrity. The SURVIVOR is main's per-part receipt gate (`fnv_receipt()` +
`NEUTRON_CODEX_BUILD_BRIEF_PART_INTEGRITY`); #313's whole-brief
`NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY` check is DROPPED in parts mode (it remains the
receipt for the non-parts path only); #313's `NEUTRON_CODEX_BUILD_BRIEF_PARTS_FILE`
manifest survives as TRANSPORT ONLY, resolving into `$BRIEF_PARTS` BEFORE the receipt
gate so both transports face identical refusals.

Planner re-survey 2026-08-17 against the branch tip 903428b4 (merge of origin/main
477671d7): the arbitrated merge is LANDED and the corrupted-part refusal VERIFIED
(exit 3 `CODEX_BUILD_BRIEF_PART_CORRUPT` through inline AND manifest transports;
symmetry suite present). What the merge BROKE, measured by running the suite at the
tip: `trident/codex-build-arrival.test.ts` 0 pass / 2 fail — the workflow now THROWS
before dispatching forge:build ("forge:build is routed to the codex executor but the
launcher did not thread codexBuildScript … thread it from trident/inner-loop.ts
buildWorkflowArgs"), because main dropped the repoPath fallback for the wrapper path
(#355) AFTER the arrival harness was written; and even once threaded, assertion (d)
greps the whole-file `NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY` receipt that the
arbitration itself removed from parts mode. The exact two-edit repair was validated
at 903428b4: 2 pass / 0 fail, 60 expects, negative control included.

- [x] T1 (decision): arbitrate the two integrity implementations — main's per-part receipt gate survives alone; rationale recorded in the plan doc and the in-file ARBITRATION comment in `trident/codex-build.sh`.
- [x] T1–T4 (code): arbitrated merge landed on the branch (`trident/codex-build.sh` union-resolved: one verifier — per-part receipts; manifest resolves into `$BRIEF_PARTS` upstream of the gate; corrupted-part-through-manifest refuses exit 3 `CODEX_BUILD_BRIEF_PART_CORRUPT`; 7-case inline-vs-manifest refusal-symmetry suite in `trident/codex-build.test.ts`).
- [x] AS_BUILT arbitration entry ("2026-08-17 — Brief-part integrity arbitration (#313 vs main/#321)") — present on the branch.
- [x] REPAIR `trident/codex-build-arrival.test.ts` to the post-merge contract so the arrival proof runs again: thread `codexBuildScript` (the REAL `trident/codex-build.sh` path) into the harness args — without it forgeAgent fails closed BEFORE forge:build is ever dispatched, which is why no run command and no PARTS exist at all — and rework assertion (d) from the dropped whole-file receipt to the surviving per-part receipts (every child-reported part measures to the prompt's own `NEUTRON_CODEX_BUILD_BRIEF_PART_INTEGRITY` entry, and the seam's stdin is byte-for-byte the in-order assembly of those parts). Both tests green; short AS_BUILT addendum; no behavior change to `inner-workflow.mjs` or `codex-build.sh`.
