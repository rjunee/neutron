## 2026-09-19 — Recover project drivers from canonical host checkpoints

Issue #1178 repairs the recovery path covered by
`docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md:41`. The production
host persists and reloads `build-mode-state` stage events
(`trident/production-host-effects.ts:238`), but gateway recovery previously
required nullable legacy `inner_checkpoint` columns. A completed build with a
durable host checkpoint could therefore be rejected after a gateway restart.

Recovery now reads the latest canonical event through the host's existing
identity/state parser (`trident/build-mode-state.ts:12`). The admission guard
requires a bound branch and base plus a checkpoint head or pending provider
step (`trident/orchestrator.ts:2920`). Invalid latest events do not fall back to
older events or legacy columns. The existing reservation CAS and durable crash
budget still control the claim (`trident/orchestrator.ts:2942`).

Launch preparation also consumes canonical state
(`trident/launch-preparation.ts:47`); fixing only admission would have launched
the recovered driver as fresh. Canonical resumes retain their base pin and
delegate live-head measurement to the typed host. No legacy checkpoint columns
are synthesized. The existing pending arm returns the original phase and step
identity without re-dispatch (`trident/build-run.ts:255`). This preserves its
unknown outcome; it does not implement reconciliation of an already armed
provider step.

The composed restart tests now pass through the actual orchestrator and project
launcher (`open/__tests__/project-build-e2e.test.ts:979`). They use checkpoints
written by the production host with both legacy columns null: a completed build
reaches merge without rebuilding, a moved branch rebuilds, and an armed review
preserves its step identity with zero new worker dispatches. Focused recovery
tests retain the checkpoint-free abandoned reservation and recovery-budget
controls, reject malformed identity/head/pending evidence, and admit a pending
first step without claiming a built head (`trident/orchestrator.test.ts:450`).

`trident/project-driver-recovery-mutation.test.ts:18` runs the semantic recovery
tests against copied source. The unchanged control passes; forcing the admission
guard closed fails the valid canonical continuation case, and forcing it open
fails the checkpoint-free abandonment case. Both failures must name the expected
test, so a broken import or syntax error cannot count as a caught mutation.

Validation:

- `bun test open/__tests__/project-build-e2e.test.ts`: 89 passed.
- Orchestrator, liveness-death e2e, production-host effects, project-build host,
  crash recovery, gateway recovery wiring and composition liveness wiring:
  469 passed across seven files.
- Retry resume, cross-run retry checkpoint, project launcher, infrastructure retry
  and inner-loop consumers: 183 passed across five files.
- Focused project-driver gateway recovery: 16 passed; executable mutation proof:
  one passed, including both required mutant failures and its green control.
- `bunx tsc --noEmit` and `bunx tsc -p trident/tsconfig.json --noEmit`: passed.
- `bash scripts/ci/lint.sh`: passed.

The work-tracking skill kept acceptance in the existing spec item and this
evidence in one record. Validation used isolated temporary repositories and
databases; no deployment or live build restart was performed.
