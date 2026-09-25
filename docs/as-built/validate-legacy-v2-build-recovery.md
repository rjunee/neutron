## 2026-09-25 — Legacy v2 build briefs are reconciled against current inputs before recovery

Closes #1296. Refs #1196; this is a focused slice of the recovery criterion in
`docs/spec-items/trident-build-efficiency.md` ("Recovery reconciles before buying
more work"). That criterion stays open: moved heads, publication-proof failures
and the live acceptance evidence are outside this change.

The defect: during pending recovery `prepareProjectBuild`
(`open/wiring/project-build.ts`) read a stored `<role>.strategy-v2.brief` and
adopted its bytes and path unconditionally whenever the file existed. A pending
reservation is identified by its brief path and integrity alone, and neither the
task text nor the owner reflection is part of that identity (reflection is
re-read on every fire). A run whose task or reflection changed after its v2
reservation was written therefore presented an "unchanged" identity and recovered
a result produced for inputs that no longer hold.

Prepare now renders each role brief from the current inputs in every known shape
and compares the stored v2 bytes byte-exact. The v2 renderer differed from v3
only in the builder TEST EXECUTION sentence, and the v2 era had two builder
shapes: with the commit-wrapper paragraph, and without it (before #1238). Plan
and review briefs carry neither, so for them only the task text can differ. The
comparison is exact against these known renderings, never a fuzzy match. Each
decision is recorded as a `build-legacy-brief-reconciled` stage event carrying
the role, the decision and brief integrities, with no paths.

- **reused** — the stored brief equals a known rendering. Its bytes and path are
  adopted exactly as before, so recovery on unchanged inputs dispatches no new
  planner, builder or reviewer turn.
- **invalidated** — the fixed contract is found in the stored brief but the text
  before it (task) or after it (reflection) differs from the current input.
  Every role is classified first, no v3 brief is written for an invalidated
  role, and prepare then throws a refusal naming the cause. Nothing is
  dispatched, the reservation and the stale `build.result` stay untouched, and
  the launcher records the run as a terminal `inner-error`.
- **missing** / **unrecognized** — the v2 brief this run's latest reservation
  names is gone, or the stored brief matches no known shape although nothing
  identifies a changed input (for example, an install-path change inside the
  commit-wrapper line). The current v3 identity is presented; it cannot match
  the v2 reservation, so build-run returns its typed `unknown` ("Resume cannot
  validate the original pending worker request and context") with the
  reservation preserved. Missing evidence is never reused and never turned into
  a fresh run.

Re-execution is the cross-run retry, not a same-step redispatch. The attempt
journal is write-once per `(run_id, step_id)`, so the reserved step cannot be
re-issued with a different brief; the retried run dispatches its own
`plan:0`/`build:0`. When the retry keeps the same slug, the invalidated build
commit still sits on the local branch, and the existing wrong-base guard refuses
to build over it until it is salvaged (a create-only tag, then the branch is
released). That guard is unchanged and is not bypassed.

No gate, budget, round, retry or attempt-ledger logic changed. Build-run, the
attempt accounting and ledger, and the project build host are untouched.
`validateLegacyPendingRequest` still covers only the older unversioned
`<role>.brief` artifacts.

Tests (`open/__tests__/project-build-e2e.test.ts`) seed a v2-era run with v2
briefs only, a completed build whose acknowledgement was lost, and the pending
build reservation that names the v2 brief. They count dispatches through the
real host, launcher and board dispatch:

- unchanged inputs, in both v2 shapes, recover through the gateway to a merge
  with zero plan, build or fix dispatches and an unchanged `build.result`;
- a changed task and a changed reflection are each refused at prepare with zero
  dispatches and an untouched reservation, then re-executed by the retry with
  fresh `plan:0`/`build:0` for the new run, nothing under the prior run id, and
  only the re-executed build merged. In the reflection case the plan and review
  briefs are still `reused`, which shows the check compares inputs rather than
  whole files;
- a missing v2 build brief yields the typed `unknown` with zero dispatches, the
  reservation unchanged and no PR.

Mutation proofs, both directions: adopting any stored v2 brief (the original
defect) turns the changed-task and changed-reflection tests red while the
unchanged-input tests stay green. Dropping the pre-#1238 shape turns the
unchanged-input test for that shape red. Disabling the missing-evidence check
turns the missing-evidence test red.
