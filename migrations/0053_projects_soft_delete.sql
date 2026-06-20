-- 0053_projects_soft_delete.sql
--
-- "Tweak later" agent-settings tools core (2026-06-03). The onboarding
-- final-handoff tells the user they can rename / delete / merge projects
-- later just by asking. Those tools live in `cores/free/agent-settings/`
-- and operate against the canonical per-project `projects` table
-- (migration 0038_projects_canonical.sql). To support soft-delete +
-- merge + Telegram-topic retitling, this migration adds three nullable
-- columns to `projects`:
--
--   * `deleted_at TEXT` — ISO-8601 UTC timestamp set when a project is
--     soft-deleted (delete_project) OR absorbed into another project
--     (merge_projects, on the `from` side). NULL means live. The
--     agent-settings `list_projects` tool filters `deleted_at IS NULL`
--     so soft-deleted rows disappear from the user-facing list while the
--     row + its history survive for audit / undo.
--
--   * `context_archived_at TEXT` — ISO-8601 UTC timestamp recording when
--     the project's context (its Telegram forum topic + any sidecar
--     context) was archived as part of a delete / merge. Distinct from
--     `deleted_at` so a future flow can soft-delete the row WITHOUT yet
--     having archived the topic (best-effort Telegram calls can lag the
--     DB write). The delete/merge tools return this value in their
--     `removed.context_archived_at` / merge result payloads.
--
--   * `topic_id TEXT` — the Telegram forum-topic thread id
--     (`message_thread_id`) bound to this project, stored as TEXT so it
--     survives >2^53 ids. NULL when the project has no bound Telegram
--     topic (e.g. demo-seeded projects, app-only projects). rename_project
--     / delete_project / merge_projects read this to call editForumTopic /
--     closeForumTopic. Today nothing populates it (see KNOWN LIMITATION
--     below); the column exists so the tools are forward-correct the
--     moment onboarding/project-creation starts writing the canonical row.
--
-- KNOWN LIMITATION (documented, intentional): onboarding does NOT
-- currently populate the canonical `projects` table at all. Project
-- shells created during the wow-moment land as `topics` rows
-- (onboarding/wow-moment/actions/03-project-shells.ts) keyed by a UUID
-- `project_id` with NO name column, NOT as `projects` rows. The
-- `projects` table is only populated on first PATCH /settings access
-- (gateway/projects/sqlite-store.ts auto-seed) or by the demo seeder.
-- The agent-settings tools are CORRECT against the canonical store
-- regardless — they operate on whatever is in `projects`. Closing the
-- onboarding→projects population gap is a separate sprint (it touches
-- onboarding/interview/* which this sprint is forbidden from editing).
--
-- Migration mechanics:
--   `projects` is a STRICT table (0038), and SQLite forbids adding a
--   column to a STRICT table only when a NOT-NULL-without-default is
--   requested. All three new columns are nullable with no default, so a
--   plain `ALTER TABLE ... ADD COLUMN` is legal AND atomic under the
--   runner's BEGIN/COMMIT wrap. We nonetheless use the STRICT-safe
--   table-rebuild dance (CREATE new, INSERT SELECT, DROP, RENAME) to
--   match the precedent set by 0043 and to keep the column ordering +
--   CHECK constraints explicit in one place (a sequence of ADD COLUMNs
--   leaves the canonical shape spread across 0038 + 0053).
--
--   STRICT typing preserved. PK `(id)` preserved. CHECK constraints on
--   privacy_mode / billing_mode preserved verbatim from 0038. The
--   project_members table + its FK + index are untouched (no rebuild
--   needed — the FK references projects(id) which the RENAME preserves).
--   Forward-only. Snapshot regen required.
--
-- Verification (post-migration, per-project DB):
--   SELECT COUNT(*) AS total,
--          SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live
--     FROM projects;
--   PRAGMA table_info(projects);  -- expect deleted_at / context_archived_at / topic_id present, nullable
--
--   FK handling: `project_members.project_id` carries
--   `FOREIGN KEY ... REFERENCES projects(id) ON DELETE CASCADE` (0038).
--   With foreign_keys=ON the `DROP TABLE projects` below would cascade
--   and wipe every member row. We disable foreign_keys in this leading
--   PRAGMA (the runner hoists it out of the transaction) so the
--   drop/rename is FK-inert; the member rows survive untouched and the
--   FK re-binds to the RENAMEd `projects` by name. The runner
--   re-asserts `PRAGMA foreign_keys = ON` after the migration commits,
--   so enforcement is not leaked onto subsequent migrations. Same
--   technique 0004's preamble documents.

PRAGMA foreign_keys = OFF;

CREATE TABLE projects_new (
    id                   TEXT PRIMARY KEY NOT NULL,
    name                 TEXT NOT NULL,
    description          TEXT,
    persona              TEXT,
    privacy_mode         TEXT NOT NULL DEFAULT 'private'
                             CHECK (privacy_mode IN ('private', 'workspace', 'public')),
    billing_mode         TEXT NOT NULL DEFAULT 'personal'
                             CHECK (billing_mode IN ('personal', 'group_per_seat', 'group_shared')),
    created_at           TEXT NOT NULL,                          -- ISO-8601 UTC
    updated_at           TEXT NOT NULL,                          -- ISO-8601 UTC
    deleted_at           TEXT,                                   -- ISO-8601 UTC; NULL = live
    context_archived_at  TEXT,                                   -- ISO-8601 UTC; NULL = not archived
    topic_id             TEXT                                    -- telegram forum-topic thread id; NULL = unbound
) STRICT;

INSERT INTO projects_new
    (id, name, description, persona, privacy_mode, billing_mode,
     created_at, updated_at, deleted_at, context_archived_at, topic_id)
SELECT
    id, name, description, persona, privacy_mode, billing_mode,
    created_at, updated_at, NULL, NULL, NULL
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
