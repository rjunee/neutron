-- 0125_code_trident_runs_base_sha.sql
--
-- Every build branch was cut from the never-fetched local main of the shared
-- checkout — measured 16 commits behind origin/main on 2026-08-16 — so the
-- publish-time rebase repaired divergence that should never have accumulated.
-- These columns make cut-time staleness observable per run.
--
-- STRICT-table-safe nullable ADD COLUMNs. Forward-only; no down-migration.

ALTER TABLE code_trident_runs ADD COLUMN base_sha TEXT;
ALTER TABLE code_trident_runs ADD COLUMN base_behind INTEGER;
