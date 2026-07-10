-- 0001_rc1_initial_schema.sql — per-project agent-nexus sidecar schema (RC1).
--
-- Per docs/plans/2026-07-02-world-class-refactor-plan.md § RC1.
-- Append-only cross-agent decision/observation log (`agent_nexus_events`).
-- NOT a bus: there is exactly one write surface (`NexusStore.appendEvent`)
-- and, until RC3, no reader wiring at all.
--
-- This file lives under migrations/nexus/ — a per-project migration tree
-- applied via `applyProjectScopedMigrations(db, dir)` against each
-- project's `<project>/.nexus/nexus.db` sidecar (see migrations/runner.ts).
-- The instance-wide migration tree at the parent migrations/ dir is
-- untouched, mirroring migrations/comments/ exactly (parallel namespace
-- starting at 0001, per the P7.2 § 3.4 precedent).
--
-- Why a sidecar (same rationale the comments sidecar locked):
--   - Project delete is `rm -rf <project>/` — the nexus log goes with it,
--     no foreign-key cleanup pass.
--   - Cross-agent event writes are bursty + project-scoped; isolating them
--     from the cross-cutting `project.db` means a busy overnight trident
--     run never contends on the busy-retry mutex with reminder ticks.
--   - Matches the Tier 1 Core sidecar convention.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a
-- re-run is a no-op.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS agent_nexus_events (
    -- ULID — Crockford-base32, 26 chars, lexicographically sortable by
    -- creation time. Atomic primary key + free chronological order +
    -- collision-resistant across concurrent appends without coordination.
    id          TEXT PRIMARY KEY NOT NULL,

    -- WHO wrote the event. Locked taxonomy per RC1 — RC2 emitters and the
    -- RC3 per-turn reader key off these values, so the vocabulary is
    -- enforced at the schema level (unlike the comments sidecar's open
    -- event_kind, this one is load-bearing across units):
    --   'chat'         — the interactive chat agent
    --   'reflection'   — the onTurnComplete reflection writer
    --   'scribe'       — the background scribe
    --   'forge'        — trident build workers
    --   'argus'        — trident review workers
    --   'orchestrator' — the outer trident/dispatch loop
    --   'user'         — a human-authored entry
    actor_kind  TEXT NOT NULL CHECK (actor_kind IN
                  ('chat', 'reflection', 'scribe', 'forge', 'argus',
                   'orchestrator', 'user')),

    -- Instance-of-actor identity (e.g. a trident run slug, a session id,
    -- an owner user id). Free-form; the pair (actor_kind, actor_id) is the
    -- full provenance.
    actor_id    TEXT NOT NULL,

    -- WHAT the event is. Locked taxonomy per RC1:
    --   'decision'     — a choice was made (e.g. an Argus verdict)
    --   'observation'  — a fact noticed, no commitment implied
    --   'learning'     — a durable correction/insight (e.g. owner feedback
    --                    captured by reflection)
    --   'handoff'      — work passed across an agent boundary (e.g.
    --                    trident inner→outer harvest)
    kind        TEXT NOT NULL CHECK (kind IN
                  ('decision', 'observation', 'learning', 'handoff')),

    -- Human-readable event text. Pointers-lean by contract (RC3): long
    -- content links out via refs_json, it is not inlined here. Size cap
    -- enforced at the write surface.
    body        TEXT NOT NULL,

    -- JSON array of typed references, `[{ "kind": ..., "ref": ...,
    -- "note"?: ... }]` — see NexusRef in gateway/nexus/nexus-store.ts for
    -- the locked ref-kind vocabulary. NULL when the event carries no refs.
    -- Validated + serialized by the single write surface; readers parse
    -- via parseNexusRefs (malformed JSON degrades to []).
    refs_json   TEXT,

    -- ms-epoch, server clock.
    created_at  INTEGER NOT NULL
);

-- readRecent filters by kind + since and pages newest-first by id (ULIDs
-- sort chronologically, so id order == creation order).
CREATE INDEX IF NOT EXISTS idx_agent_nexus_events_kind_id
    ON agent_nexus_events (kind, id);

CREATE INDEX IF NOT EXISTS idx_agent_nexus_events_created_at
    ON agent_nexus_events (created_at, id);
