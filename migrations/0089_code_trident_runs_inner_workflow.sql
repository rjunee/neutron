-- 0089_code_trident_runs_inner_workflow.sql
--
-- Trident v2 (Phase 2 — hard cutover) — the inner Forge→Argus→fix loop is now
-- a single native CC Dynamic Workflow (`trident/inner-workflow.mjs`, run by the
-- `Workflow` tool), launched once per run by the durable OUTER loop
-- (`TridentTickLoop` + `code_trident_runs`, migration 0077). The OUTER loop, the
-- Ralph spec-drift docs, and merge-as-outer/human-gate (`trident/merge.ts`) are
-- UNCHANGED; only the substrate-per-phase inner dispatch is replaced.
--
-- A CC Dynamic Workflow is SESSION-BOUND: `resumeFromRunId` is same-session only
-- (proto-2, 2026-06-28), so a control-plane crash loses the in-flight workflow.
-- Crash-recovery therefore = relaunch a FRESH workflow that idempotently SKIPS
-- the phases a prior run already completed. That requires two things the v1
-- schema didn't carry, added here:
--
-- * `workflow_run_id` — the CC workflow run id of the last inner-loop dispatch.
--   Observability only (correlate a `code_trident_runs` row with its workflow
--   transcript); not load-bearing for resume.
--
-- * `inner_checkpoint` — C1 PER-PHASE CHECKPOINT. The workflow's own `agent()`
--   Bash steps write this column mid-run (`forge-done`, `argus-approved` /
--   `argus-request-changes`, `fix-round-N`) so a relaunched workflow reads it as
--   `resumeCheckpoint` and skips already-finished phases instead of rebuilding
--   from zero (and never opening a DUPLICATE PR — it reuses `pr`/`branch`).
--
-- * `inner_verdict` — the final synthesised Argus verdict of the inner loop
--   (`APPROVE` → merge; `REQUEST_CHANGES` → failed after maxRounds). Persisted on
--   the terminal transition for the audit trail + idempotent-resume decisions.
--   CHECK-constrained to the two real verdicts (NULL while in flight).
--
-- Each column is added in its OWN statement (STRICT-table-safe: SQLite forbids
-- multiple ADD COLUMNs per ALTER, and a STRICT table requires every added column
-- to be nullable OR carry a literal default — all three are nullable).
--
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE code_trident_runs
    ADD COLUMN workflow_run_id TEXT;

ALTER TABLE code_trident_runs
    ADD COLUMN inner_checkpoint TEXT;

ALTER TABLE code_trident_runs
    ADD COLUMN inner_verdict TEXT
        CHECK (inner_verdict IS NULL OR inner_verdict IN ('APPROVE', 'REQUEST_CHANGES'));
