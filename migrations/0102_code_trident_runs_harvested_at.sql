-- 0102_code_trident_runs_harvested_at.sql
--
-- RC2 ([BEHAVIOR]) — the durable OUTER-HARVEST marker.
--
-- The RC2 agent-nexus producer emits a `handoff` (+ argus `decision`) ONLY for a
-- run the OUTER loop genuinely HARVESTED (`orchestrator.applyResult` decoded a
-- typed `inner_result` and made a merge/verdict decision). Nothing in the final
-- ROW SHAPE could previously distinguish that from a run FORCE-TERMINATED
-- out-of-band (`buildTridentTerminator.terminate(id, 'failed'|'stopped')`, a
-- board X-cancel / `/code stop`), which flips a LIVE run terminal via
-- `terminalTransition` WITHOUT clearing an already-written `inner_result` /
-- `inner_verdict` (both written by the DETACHED inner workflow BEFORE the outer
-- harvest). Keying the producer on `inner_verdict`/`inner_result` therefore
-- fabricated events for cancelled builds.
--
-- `harvested_at` is written EXCLUSIVELY by the outer loop's `applyResult` (via
-- the snapshot `save`/`saveIfActive` the tick loop commits), and NEVER by the
-- inner workflow nor by `terminalTransition`. So `harvested_at IS NOT NULL` is
-- the authoritative, force-terminate-proof "the outer loop harvested" signal the
-- terminal observer (`isTridentHarvestTerminal`) keys on. ms-epoch of the
-- harvest, nullable (unset until — and unless — the outer loop harvests).
--
-- STRICT-table-safe: a single nullable ADD COLUMN (no literal default needed).
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE code_trident_runs
    ADD COLUMN harvested_at INTEGER;
