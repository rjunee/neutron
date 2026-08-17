# IMPLEMENTATION_PLAN — #313/main brief-part integrity arbitration (merge, PR #313)

Decision record (planning, 2026-08-17, validated end-to-end in a scratch merge):
Both #313 (`trident/the-codex-build-bridge-loses-the-br` @ 01100526) and main (#321) independently
built brief-part integrity. The SURVIVOR is main's per-part receipt gate (`fnv_receipt()` +
`NEUTRON_CODEX_BUILD_BRIEF_PART_INTEGRITY`): it is what the production launcher actually emits in
parts mode (`trident/inner-workflow.mjs:1574` sends `BRIEF_PARTS` + `BRIEF_PART_INTEGRITY`, and
`BRIEF_INTEGRITY` only on the non-parts fallback — pinned by `trident/inner-workflow-assembly.test.ts:239-257`),
and it names the corrupt part instead of reporting a whole-file mismatch. #313's whole-brief
`NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY` check is DROPPED in parts mode; it remains the receipt for the
non-parts (pre-written brief) path only. #313's `NEUTRON_CODEX_BUILD_BRIEF_PARTS_FILE` manifest
survives as TRANSPORT ONLY: it resolves into `$BRIEF_PARTS` BEFORE the receipt gate, so both
transports face identical refusals. Validation: merge of 01100526 with origin/main @ 9228f57a,
`bash -n` clean, `trident/codex-build.test.ts` 86 pass / 0 fail (was 76/77 — the corrupted-part-
through-manifest case now refuses with exit 3 `CODEX_BUILD_BRIEF_PART_CORRUPT`), plus a new
7-case inline-vs-manifest symmetry suite, and `trident/inner-workflow-assembly.test.ts` 55/55.

- [x] T1 (decision): arbitrate the two integrity implementations — main's per-part receipts survive alone; rationale recorded above and in the in-file ARBITRATION comment carried by the merge resolution.
- [x] T1–T4 (code): land the arbitrated merge of origin/main into `trident/the-codex-build-bridge-loses-the-br` as ONE merge commit and push it to that branch (no force): union-resolve the two `trident/codex-build.sh` hunks with the ARBITRATION comment (one verifier: per-part receipts; manifest resolves into `$BRIEF_PARTS` upstream of the gate), reword the branch's `a corrupted part behind a valid receipt is refused through the FILE path` test to the surviving implementation (still exit 3, marker `CODEX_BUILD_BRIEF_PART_CORRUPT`, test unmodified in intent), and add the `inline and manifest transports agree on every refusal` symmetry suite (7 refusal cases through BOTH transports). Acceptance: `bash -n` clean, zero conflict markers, `bun test trident/codex-build.test.ts` 86 pass / 0 fail, `bun test trident/inner-workflow-assembly.test.ts` 55 pass, remote branch tip still 01100526 at push time.
- [x] Follow-up: append a `docs/AS_BUILT.md` entry recording the arbitration (which verifier survived, why the other was dropped, and that transport symmetry is now pinned by test) — separate small commit after the merge lands.
