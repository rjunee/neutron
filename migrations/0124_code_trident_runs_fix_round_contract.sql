-- 0124_code_trident_runs_fix_round_contract.sql
--
-- These columns are the machine-readable FIX-ROUND CONTRACT pinned at dispatch
-- (mandated by the Fable arbitration on #289 vs #318, run fec4d3aa):
-- reviewed_head is the 40-hex head the review verdict was about (publish refuses
-- a produced head that does not descend from it); bound_pr is the PR the round
-- must update; fenced_paths is a JSON array of repo-relative paths the round must
-- not touch. All are nullable for pre-existing rows and STRICT-table-safe.
-- Forward-only; no down-migration.

ALTER TABLE code_trident_runs ADD COLUMN reviewed_head TEXT;
ALTER TABLE code_trident_runs ADD COLUMN bound_pr INTEGER;
ALTER TABLE code_trident_runs ADD COLUMN fenced_paths TEXT;
