---
title: Accept full SHA-1 and SHA-256 run heads and checkpoints
group: trident
status: done
priority: P1
cutover: false
---

Issue #667. Full object names at the run-head and checkpoint boundaries accept exactly
40 or 64 hexadecimal digits. Existing normalization remains; abbreviations do not
qualify as reviewed heads. This does not promise general SHA-256 support in every
Git helper in the repository.

## Persisted-format decision

Keep `outer-published:<oid>:<remaining>:<round>[:deviated]` and widen its OID
field. Preserve field order, suffix semantics, and existing numeric bounds. The
producer writes the full head witnessed by Git, without truncation or a version
prefix (`trident/orchestrator.ts:5074`).

New readers accept old 40-digit checkpoints byte for byte. Old readers cannot
consume new 64-digit checkpoints correctly: the anchored old parser returns null,
not a truncated head. The old workflow then rebuilds with `no-recorded-head` for a
64-digit companion head, or `unknown-checkpoint` with a valid 40-digit companion
head (`trident/inner-workflow.mjs:4311`, `trident/inner-workflow.mjs:4373`, as on the
base of this change). Its round parser returns null; the old published-evidence
reader can classify the row as `none` (`trident/fire-evidence.ts:233`). This is a
silent loss of checkpoint meaning and can cost completed work, not a loud refusal.

Consequently a mixed-version rollout sharing SHA-256 checkpoints is **not
compatible**. Drain old readers before allowing new SHA-256 runs to write shared
state. Rolling back after those writes likewise requires draining those runs;
merely replacing the binary is not safe. This is an operational prerequisite,
not an automatic deployment interlock delivered by this change.

A version prefix was rejected because an already-running old binary sends unknown
names to the same fallback; no new marker can change its code. Keeping checkpoints
at 40 digits with a refusal would preserve that restriction but discard the requested
SHA-256 checkpoint capability. Widening is selected with the explicit rollout limit,
rather than claiming forward compatibility. No parallel format or feature flag.

## Acceptance

- [x] Both full widths pass; 7, 39, 41, 63 and 65 digits and non-hex fail.
      Verify: `trident/run-head-width.test.ts`, including real Git repositories in
      both formats and local/remote resume reads.
- [x] Existing resume, round and disposition scenarios run with both widths.
      Verify: `trident/inner-workflow-resume.test.ts`, `trident/checkpoint-round.test.ts`,
      `trident/run-disposition.test.ts`.
- [x] Publisher, launcher, workflow-argument and persisted-seed fixtures include
      both widths. Verify: `trident/orchestrator.test.ts`, `trident/inner-loop.test.ts`,
      `trident/store.test.ts`.
- [x] Each changed recognizer is mutation-checked to reject 64 digits when narrowed,
      and incorrectly accept abbreviations when broadened. The as-built records
      the resulting failures and restored passes.

## Existing outcomes and enforcement

No new outcome is added. Valid checkpoints retain `review` resume mode,
`built-never-reviewed` disposition, and `published` evidence when no tasks remain
(`trident/inner-workflow.mjs:4351`, `trident/run-disposition.ts:145`,
`trident/fire-evidence.ts:218`). Invalid heads retain the existing null/empty
refusals and `TridentIncompleteSeedError` (`trident/merge.ts:1410`,
`trident/store.ts:675`). The store checks seed pins at insertion, independent of
whether the failed workflow is still alive; parser domain tests run in CI.
