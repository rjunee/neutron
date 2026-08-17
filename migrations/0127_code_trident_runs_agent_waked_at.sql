-- 0125_code_trident_runs_agent_waked_at.sql
--
-- THE DURABLE AT-MOST-ONCE AGENT-WAKE MARKER — a terminal run must wake the
-- bound agent exactly once. The marker must be durable because redelivery (the
-- out-of-band `buildTridentTerminator` chokepoint), a retry, or a gateway restart
-- re-running terminal observers must not fan out duplicate agent turns, and every
-- gateway boot resets in-memory state. Millisecond epoch of the wake claim,
-- nullable (unset until — and unless — the wake observer claims it).
--
-- Written by exactly ONE writer, `TridentRunStore.claimAgentWake` (an atomic
-- claim UPDATE) — never by `update`/`save`/`saveIfActive` — the same single-writer
-- discipline as `inner_result`, `harvested_at`, and `crash_recoveries`.
--
-- STRICT-table-safe: a single nullable ADD COLUMN (no literal default needed).
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE code_trident_runs
    ADD COLUMN agent_waked_at INTEGER;
