-- 0099_code_subagent_registry.sql
--
-- Subagent-registry persistence (world-class-refactor plan §P7, decision D-6:
-- "persist minimal + boot reap").
--
-- `runtime/subagent/registry.ts` has, since S3, promised in its header that
-- "S4 wires it to a SQLite-backed table so the lifecycle watchdog can survive a
-- gateway restart and reap orphaned children." That table never landed: the
-- registry was in-process only, so a gateway restart silently ORPHANED every
-- dispatched sub-agent — the awaiting caller hung forever with no signal and the
-- record simply vanished from `live()`. This migration lands that table.
--
-- One row == one dispatched sub-agent (the generic `runtime/subagent/` registry
-- record — distinct from `code_trident_runs.subagent_*`, which persists the
-- Trident loop's OWN in-flight sub-agent on the run row). The row mirrors the
-- in-memory `SubagentRecord` field-for-field so the store is a faithful
-- projection: `SubagentRegistry` upserts a row on every `create`/`update` and
-- deletes it on prune (`runtime/subagent/store.ts`).
--
-- BOOT REAP (the behaviour this unlocks — `runtime/subagent/boot-sweep.ts`):
-- on startup, every row still `pending`|`running` was left in-flight by a PRIOR
-- process that has since died. The boot sweep CLAIMS each — an atomic guarded
-- `live → crashed` UPDATE (`WHERE status IN (pending,running)`) — and then FIRES
-- THE REPORT SINK (the same report-back surface a clean completion uses) for the
-- claimed row. The DURABLE `crashed` row is the surfacing that never vanishes
-- (persisted + queryable); the report is a best-effort notification on top of it,
-- exactly as the live agent-aware watchdog treats its own notify. The atomic
-- claim is the concurrency + idempotency point: of any number of overlapping
-- sweeps or repeated boots, EXACTLY ONE wins each row's transition, so an orphan
-- is reported once, never twice, and never after it is terminal. The partial live
-- index below keeps a boot's "load every in-flight row" scan flat-cost. It does
-- NOT re-hydrate the record as live — the spec is "surface, don't resume."
--
-- DELIBERATELY NOT PERSISTED — the orphan-detection dedup sets:
--   The Trident orchestrator's per-process `fired`/`redispatched` sets
--   (`trident/orchestrator.ts`) are volatile CLOSURE state by design: losing
--   them on restart IS the orphan-detection mechanism (a persisted
--   `subagent_run_id` whose id is not in this-process `fired` is treated as an
--   orphan and re-fired idempotently). This table persists the REGISTRY
--   (dispatched-agent records) ONLY. It has NO column that records "already
--   fired / redispatched / reported", so nothing here can restore or replay a
--   dedup set — a restart still re-detects orphans the intended way.
--
-- Column rationale (mirrors `SubagentRecord` in `registry.ts`):
--
-- * `run_id` — opaque PK (the dispatch run id; a ULID/UUID minted by the
--   spawner). The single identity for the record across processes.
--
-- * `instance_key` — owning instance (registry scoping + spawn caps). Mirrors
--   the redundant-but-defensive scoping column used by `code_trident_runs`.
--
-- * `agent_kind` — the dispatched agent's kind. Closed enum matching
--   `AgentKind` (`forge`/`atlas`/`sentinel`/`argus`/`core`).
--
-- * `status` — lifecycle cursor. `pending`/`running` are LIVE; `finished`/
--   `crashed`/`cancelled` are terminal. The boot sweep loads only the two live
--   states (partial index below); a cleanly-terminated dispatch persists its
--   terminal status so the sweep skips it (no false crash-surface).
--
-- * `spawn_depth` — the Hermes MAX_DEPTH cap counter.
--
-- * `parent_run_id` / `parent_session_id` / `child_session_id` — the dispatch
--   lineage + substrate session ids (nullable; child set once the REPL spawns).
--
-- * `pid` / `pid_starttime` — the OS process identity the watchdog's
--   `process_dead` probe keys off (nullable for in-process `core` agents).
--
-- * `started_at` / `ended_at` / `last_event_at` / `cleanup_after` — epoch-ms
--   INTEGER timestamps (the in-memory record uses `Date.now()` ms, NOT ISO
--   strings — persisted verbatim as INTEGER so the projection round-trips
--   exactly). `last_event_at` is bumped on every registry patch; `cleanup_after`
--   gates the lifecycle prune; `ended_at` set on terminal.
--
-- * `delivery_target` / `delegation_claims` — small structured blobs stored as
--   JSON TEXT (the report-back routing target + the signed-delegation claims).
--
-- * `spawn_key` — the logical de-dup key for the double-spawn guard
--   (`liveByKey`). Persisted so the guard's semantics survive a restart, but it
--   is NOT an orphan-detection dedup set — it identifies a logical task, and a
--   terminal row with the key does not match the live-only guard.
--
-- * `failure_reason` — why a record reached a terminal-failed state
--   (`process_dead`/`stuck`), set by the watchdog / boot sweep. Undefined for
--   clean finishes.
--
-- * `boot_id` — the PER-PROCESS-BOOT OWNERSHIP TOKEN (NOT a SubagentRecord field
--   — a store-internal column). Minted ONCE per process at startup (same id
--   shape as `run_id`) and stamped on every row THIS process creates. It is the
--   predicate that makes the boot reap CORRECT: the sweep reaps only rows whose
--   `boot_id` differs from the current process's (rows a PRIOR boot left behind),
--   and NEVER a row the current boot owns and is legitimately still running. It
--   is set once at INSERT and immutable thereafter (never rewritten on the
--   ON CONFLICT update, never by `markCrashed`). Without it, a second composer
--   build / a repeat boot in the SAME process would sweep its OWN live dispatches
--   to `crashed`. It is emphatically NOT a fired/redispatched dedup marker: it
--   records WHICH process generation owns a row, not whether an orphan was
--   already reported — a restart (new `boot_id`) still re-detects prior orphans.
--   SCOPE: `boot_id` reaping is correct for SEQUENTIAL process generations (the
--   real deployment model — Managed runs one process per tenant via systemd,
--   Open runs a single gateway). Two CONCURRENTLY-live gateway processes sharing
--   ONE project DB is out of scope (not a supported deployment).
--
-- Indexes match the two read paths:
--   * the boot sweep's "load every live (in-flight) row" → a partial index on
--     `status` restricted to the live set keeps that scan dense as terminal
--     rows accumulate.
--   * owner-scoped enumeration (`byOwner`) → an index on `instance_key`.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS code_subagent_registry (
    run_id              TEXT PRIMARY KEY NOT NULL,
    instance_key        TEXT NOT NULL,
    agent_kind          TEXT NOT NULL
                            CHECK (agent_kind IN (
                                'forge', 'atlas', 'sentinel', 'argus', 'core'
                            )),
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'running', 'finished', 'crashed', 'cancelled'
                            )),
    spawn_depth         INTEGER NOT NULL DEFAULT 0,
    parent_run_id       TEXT,
    parent_session_id   TEXT,
    child_session_id    TEXT,
    pid                 INTEGER,
    pid_starttime       INTEGER,
    started_at          INTEGER NOT NULL,               -- epoch ms
    ended_at            INTEGER,                         -- epoch ms
    last_event_at       INTEGER NOT NULL,               -- epoch ms
    cleanup_after       INTEGER,                         -- epoch ms
    delivery_target     TEXT,                            -- JSON {channel, binding_id}
    delegation_claims   TEXT,                            -- JSON {instance, depth, scope, jti}
    spawn_key           TEXT,
    failure_reason      TEXT
                            CHECK (failure_reason IS NULL OR failure_reason IN (
                                'process_dead', 'stuck'
                            )),
    -- Per-process-boot ownership token (see header). NOT NULL: every row is
    -- stamped with the creating process's boot id so the reap can tell prior-boot
    -- orphans from current-boot live rows.
    boot_id             TEXT NOT NULL
) STRICT;

-- The boot sweep scans only LIVE (in-flight) rows; a partial index keeps that
-- query flat-cost as finished/crashed/cancelled rows pile up. The reap's extra
-- `boot_id <> ?` filter needs no index of its own — an inequality over the
-- already-tiny live set (in-flight dispatches only) is negligible, and the full
-- record columns force a table lookup regardless, so a boot_id index could not
-- cover the read.
CREATE INDEX IF NOT EXISTS idx_code_subagent_registry_live
    ON code_subagent_registry (status)
    WHERE status IN ('pending', 'running');

-- Owner-scoped enumeration (spawn caps + observability).
CREATE INDEX IF NOT EXISTS idx_code_subagent_registry_owner
    ON code_subagent_registry (instance_key);
