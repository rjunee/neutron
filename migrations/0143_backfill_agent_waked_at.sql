-- 0143_backfill_agent_waked_at.sql
--
-- CLOSE THE BACKLOG THE WAKE PATH INHERITED. 0127 added `agent_waked_at` and
-- left every row that was already terminal NULL. Nothing read that NULL until
-- the terminal-decision sweep started driving a project decision turn for each
-- one — at which point "never waked" and "finished before the wake path existed"
-- were the same state, and that state means POST.
--
-- Measured on the repo of record before this ran: 152 rows qualify, the oldest
-- 2026-08-07 and the newest 2026-08-22, and ZERO of them from the last day. On
-- the first boot after that sweep ships they would each have produced an owner
-- decision turn about a build that finished weeks earlier.
--
-- So the two states are separated here rather than in the query: a row that was
-- already terminal when this migration ran predates the wake path and has
-- nothing to announce, and it says so durably. After this, `agent_waked_at IS
-- NULL` means exactly one thing — a run that went terminal WITH the wake path in
-- place and has not been announced yet — which is the only reading the sweep can
-- act on safely.
--
-- The stamp is the migration's own time, not the run's: it records when the
-- question was settled, not a delivery that never happened.
--
-- Forward-only; no down-migration (Neutron OSS contract).

UPDATE code_trident_runs
   SET agent_waked_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE agent_waked_at IS NULL
   AND phase IN ('done', 'failed', 'stopped');
