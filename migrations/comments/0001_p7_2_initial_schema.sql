-- 0001_p7_2_initial_schema.sql — per-project comments sidecar schema (P7.2 S1).
--
-- Per docs/plans/P7.2-inline-comments-sprint-brief.md § 3.2.
-- Source-of-truth event log (`doc_comment_events`, append-only) + the
-- materialised projection (`doc_comment_anchors`, fast read path).
--
-- This file lives under migrations/comments/ — the per-project migration
-- tree applied via `applyProjectScopedMigrations(db, dir)` against each
-- project's `<project>/.comments/comments.db` sidecar (see
-- migrations/runner.ts). The instance-wide migration tree at the parent
-- migrations/ dir is untouched.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a
-- re-run is a no-op.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS doc_comment_events (
    -- ULID — Crockford-base32, 26 chars, lexicographically sortable by
    -- creation time. Atomic primary key + free chronological order +
    -- collision-resistant across concurrent appends without coordination.
    event_id              TEXT PRIMARY KEY NOT NULL,

    -- Locked vocabulary per brief § 3.3:
    --   'comment_posted' | 'anchor_relocated' | 'anchor_drifted' |
    --   'anchor_dead' | 'escalate_to_chat' | 'agent_reply_skipped'.
    -- S2/S3 introduce new walker / watcher kinds; S4 will add
    -- 'comment_resolved' / 'comment_edited' / 'comment_redacted' / etc.
    -- Schema is forward-compatible — new kinds land as new rows without
    -- migration.
    event_kind            TEXT NOT NULL,

    -- POSIX relative path inside the project's docs/ root (e.g.
    -- 'notes/foo.md'). Mirror of DocStore's validateRelativePath shape.
    doc_path              TEXT NOT NULL,

    -- Thread identity: NULL on the thread root, otherwise the root's
    -- event_id. parent_event_id is the immediate parent for nested-
    -- reply UI; flat-reply renderers can ignore it and order by
    -- (created_at, event_id).
    thread_root_id        TEXT,
    parent_event_id       TEXT,

    -- Anchor model (per brief § 3.2). Static byte offsets at S1 time;
    -- the S2 re-anchor walker will append anchor_* events to update the
    -- materialised view, but the original anchor fields on the
    -- comment_posted row are kept immutable.
    anchor_start          INTEGER,                       -- byte offset into doc body
    anchor_end            INTEGER,                       -- exclusive byte offset
    anchor_text_excerpt   TEXT,                          -- highlighted substring (≤ 1 KB)
    anchor_ctx_before     TEXT,                          -- ~64 chars BEFORE anchor_start
    anchor_ctx_after      TEXT,                          -- ~64 chars AFTER anchor_end

    -- Optimistic-concurrency tag: doc mtime at the time this event was
    -- authored. The materialiser uses this in S2 to discard stale
    -- walker events. comment_posted rows store the client-supplied
    -- based_on_modified_at; walker rows store the new mtime.
    based_on_modified_at  INTEGER,

    -- Author identity (per brief § 2.4). 'system' covers walker /
    -- watcher events; 'user' / 'agent' covers human + agent commenters.
    author_kind           TEXT NOT NULL,
    author_id             TEXT NOT NULL,

    -- Comment body (plain-text per § 0.3 lock — markdown lands in S3).
    -- NULL for non-comment events (anchor_*, escalate_to_chat, etc.).
    body                  TEXT,

    -- Event-kind-specific extras (e.g. anchor_relocated stores
    -- { from_start, from_end, to_start, to_end, lev_distance };
    -- escalate_to_chat stores { chat_message_id, escalated_by_user_id,
    -- escalated_at }). JSON text; nullable for events with no extras.
    metadata_json         TEXT,

    -- ms-epoch.
    created_at            INTEGER NOT NULL,

    -- ON DELETE RESTRICT mirrors the append-only contract: an event is
    -- never deleted in normal operation; mass-delete is a project-level
    -- `rm -rf .comments/` operation, not a per-row API.
    FOREIGN KEY (thread_root_id)  REFERENCES doc_comment_events(event_id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_event_id) REFERENCES doc_comment_events(event_id) ON DELETE RESTRICT
);

-- Doc-path + created_at — list-by-path queries.
CREATE INDEX IF NOT EXISTS idx_events_doc_path_created_at
    ON doc_comment_events(doc_path, created_at);

-- Thread fan-out — getThread queries.
CREATE INDEX IF NOT EXISTS idx_events_thread_root_created_at
    ON doc_comment_events(thread_root_id, created_at);

-- Event-kind by path — anchor walker scans (S2) + agent watcher polls
-- (S3).
CREATE INDEX IF NOT EXISTS idx_events_kind_doc_path
    ON doc_comment_events(event_kind, doc_path);

CREATE TABLE IF NOT EXISTS doc_comment_anchors (
    -- 1:1 with the thread root's event_id.
    thread_root_id        TEXT PRIMARY KEY NOT NULL,

    doc_path              TEXT NOT NULL,

    -- Current (materialised) anchor position. NULL when status='dead'.
    current_start         INTEGER,
    current_end           INTEGER,

    -- 'live' | 'drifted' | 'dead'. S2 walker mutates via append-event;
    -- the materialiser folds those into this column.
    status                TEXT NOT NULL,

    -- Best-guess hint when status='drifted' (the walker's best fuzzy
    -- match position). NULL otherwise.
    drift_hint_start      INTEGER,
    drift_hint_end        INTEGER,

    -- Last event folded into this row + when the materialiser ran.
    last_rebuilt_from     TEXT NOT NULL,
    last_rebuilt_at       INTEGER NOT NULL,

    -- Denormalised reply count + last-reply mtime so list-by-path can
    -- render summary chips without a JOIN on the events table.
    reply_count           INTEGER NOT NULL DEFAULT 0,
    last_reply_at         INTEGER NOT NULL,

    FOREIGN KEY (thread_root_id) REFERENCES doc_comment_events(event_id) ON DELETE RESTRICT
);

-- Doc-path + status + start — list-by-path queries filter on status
-- (drop 'dead' by default) and sort by current_start for the side-pane.
CREATE INDEX IF NOT EXISTS idx_anchors_doc_path_status_start
    ON doc_comment_anchors(doc_path, status, current_start);
