-- 0008_reverse_promotions_pk_scope.sql
--
-- Sprint 9 (P1 S6) — Codex r3 IMPORTANT fix-up: scope reverse_promotions
-- by source workspace instance.
--
-- 0007 keyed reverse_promotions on `source_workspace_topic_id` alone, but
-- topic_id is workspace-DB-scoped, not globally unique. Two latent
-- failure modes followed:
--   (a) False-positive resume — a recipient receiving a reverse-promote
--       from workspace B with a topic_id that collides with a prior
--       reverse-promote from workspace A would match A's row, return
--       resume_mode=true, SKIP B's INSERT, and reuse A's
--       recipient_project_id, silently losing B's project on the
--       recipient side.
--   (b) PK violation on a fresh call when topic_id collides between
--       two unrelated workspaces.
--
-- UUIDv4 makes the collision space ~2^128 in practice, but
-- `source_workspace_instance_slug` is in the schema exactly to scope this
-- — promote it into the primary key.
--
-- SQLite cannot widen a PRIMARY KEY in place; rebuild the table via the
-- standard table-rebuild dance. The runner wraps the body in
-- BEGIN/COMMIT so this is atomic.
--
-- Forward-only. Idempotent against fresh databases (CREATE...IF NOT
-- EXISTS in 0007 + this rebuild produces the new shape on first run).
-- Safe against existing rows: every row has a non-null
-- source_workspace_instance_slug (NOT NULL since 0007), so the
-- INSERT...SELECT carries them across without nulls.

CREATE TABLE reverse_promotions_new (
    -- Slug of the source workspace instance the topic came from. Leading column
    -- of the composite PK so `WHERE source_workspace_instance_slug = ?`
    -- is index-served on its own.
    source_workspace_instance_slug TEXT NOT NULL,
    -- The WORKSPACE-side topic id that this recipient topic was
    -- migrated from. Lookup key on retry, scoped by the slug above so
    -- two unrelated workspaces with colliding topic_ids do not stomp
    -- each other on the recipient side.
    source_workspace_topic_id TEXT NOT NULL,
    -- The recipient's local topic id minted by step 1. Reused on retry.
    recipient_topic_id TEXT NOT NULL,
    -- The recipient's local project_id minted by step 1. Reused on
    -- retry so a second call does NOT generate a fresh project id.
    recipient_project_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (source_workspace_instance_slug, source_workspace_topic_id)
);

INSERT INTO reverse_promotions_new (
    source_workspace_instance_slug,
    source_workspace_topic_id,
    recipient_topic_id,
    recipient_project_id,
    created_at
)
SELECT
    source_workspace_instance_slug,
    source_workspace_topic_id,
    recipient_topic_id,
    recipient_project_id,
    created_at
FROM reverse_promotions;

DROP TABLE reverse_promotions;

ALTER TABLE reverse_promotions_new RENAME TO reverse_promotions;

-- Recreate the recipient_project_id index that 0007 declared. The
-- index attached to the old table is dropped along with it.
CREATE INDEX IF NOT EXISTS idx_reverse_promotions_recipient_project
    ON reverse_promotions(recipient_project_id);
