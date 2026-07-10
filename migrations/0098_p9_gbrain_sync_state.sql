-- 0098_p9_gbrain_sync_state.sql
--
-- P9 (world-class refactor, 2026-07) — GBrain sync observability.
--
-- The entity→GBrain sync hook (`gbrain-memory/GBrainSyncHook.ts`) fans every
-- committed entity page out to the GBrain page store + typed-edge graph. Its
-- health was, until now, INVISIBLE: the deferred-edge retry queue is RAM-only
-- (dropped on restart) and the once-only "gbrain binary missing" latch left no
-- durable trace, so an operator (or O5's diagnostics) could not answer the
-- daily-driver question "is my memory actually being written?".
--
-- This adds a single tiny observability row per GBrain scope (today one brain
-- per instance; project partitioning lands in M2.6, hence a `scope` key rather
-- than a fixed singleton). The row is a PURE side-observation written
-- best-effort from the sync hook — the fail-soft control flow of the hook is
-- byte-identical (once-only latch, remove-before-add ordering unchanged); a
-- failed write of this row can never perturb or abort a sync. It records:
--   * `status`          — 'ok' while sync is live, latched to 'unavailable' the
--                         first time a GBrain op fails with the binary-missing
--                         error (mirrors the hook's once-only in-RAM latch).
--   * `latch_reason` /  — the error message + ISO-8601 timestamp captured at the
--     `latched_at`        moment the unavailable latch tripped (null while 'ok').
--   * `last_success_at` — ISO-8601 UTC of the most recent successful page persist
--                         (the "memory IS being written" signal).
--   * `deferred_count`  — current depth of the RAM deferred-edge retry queue,
--                         surfaced so a growing backlog is observable.
--
-- Single-writer by construction: the sole writer is the injected
-- `gateway/realmode-composer/gbrain-sync-state-store.ts` sink (P4
-- table-ownership map updated accordingly). This unit adds visibility, not
-- behavior; the deferred-edge boot-drainable JOURNAL floated in the plan is
-- deliberately DEFERRED (it changes drop-on-restart behavior and risks the
-- fail-soft invariants — out of this S-unit's "observability only" scope).
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE gbrain_sync_state (
    scope           TEXT PRIMARY KEY NOT NULL,      -- GBrain scope key (project slug / source); one brain per instance today
    status          TEXT NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok', 'unavailable')),
    latch_reason    TEXT,                           -- error message captured when status latched to 'unavailable'; NULL while 'ok'
    latched_at      TEXT,                           -- ISO-8601 UTC when the unavailable latch tripped; NULL while 'ok'
    last_success_at TEXT,                           -- ISO-8601 UTC of the last successful GBrain page persist; NULL until first success
    deferred_count  INTEGER NOT NULL DEFAULT 0,     -- current depth of the RAM deferred-edge retry queue
    updated_at      TEXT NOT NULL                   -- ISO-8601 UTC of the last observability write
) STRICT;
