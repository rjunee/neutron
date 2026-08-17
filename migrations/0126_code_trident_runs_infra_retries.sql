-- 0126_code_trident_runs_infra_retries.sql
--
-- THE DURABLE INFRASTRUCTURE AUTO-RETRY BUDGET — an infrastructure failure
-- must retry itself instead of waiting for a human to say "try again".
--
-- Owner instruction, 2026-08-14: "if there's an infrastructure failure like
-- that we need to automatically retry not wait for me to say something".
-- Measured incident run `76bb4eca`: forge:build was routed to the Codex executor
-- and no build happened (`codexStatus=deferred`); sibling run `9bb31a2e`
-- succeeded on the same route minutes later. The code was never judged — the
-- executor/transport simply did not answer.
--
-- SEPARATE from `round`/`ralph_round`: infrastructure did not spend an agent fix
-- round. SEPARATE from `crash_recoveries`: that budget counts dead LAUNCHERS;
-- this one counts executors/transports that did not answer. Written by exactly
-- ONE writer, `TridentRunStore.beginInfraRetry` (the atomic retry claim), never
-- by `update`/`save`/`saveIfActive`.
--
-- DURABLE on purpose: an in-memory counter is reset by a gateway restart, so it
-- cannot bound a retry loop across restarts. STRICT-table-safe: a single nullable
-- ADD COLUMN (no literal default); readers coalesce NULL -> 0 for legacy rows.
-- Forward-only; no down-migration (Neutron OSS contract).
--
-- Ordinal 125 is deliberately skipped: repaired live databases already carry
-- 0124's fix-round contract under version 125 (#350). Reusing it makes boot
-- refuse the name mismatch before this ALTER can run; 126 is the next free
-- durable ordinal on this base.

ALTER TABLE code_trident_runs
    ADD COLUMN infra_retries INTEGER;
