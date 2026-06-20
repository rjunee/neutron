-- 0038_projects_canonical.sql
--
-- ISSUES #9 — promote the per-instance `projects` concept from an opaque
-- string label (used by `tasks.project_id`, `sessions.project_id`,
-- `reminders.topic_id`, etc.) to a canonical SQLite row backing the
-- P5.2 project-settings surface.
--
-- Background. The P5.2 sprint shipped `GET` + `PATCH`
-- `/api/app/projects/<id>/settings` against an in-memory
-- `InMemoryProjectSettingsStore` (gateway/http/app-projects-surface.ts).
-- Atlas filed ISSUES.md #9 because PATCH mutations on `privacy_mode`
-- do not survive a gateway restart. This migration lands the
-- substrate so the surface can move to a SqliteProjectSettingsStore in
-- the same sprint without changing the HTTP wire shape.
--
-- Schema decisions (matching the P5.2 brief § 4.5 + § 4.12 wire shape
-- the existing surface + tests already use):
--
-- * `id TEXT PRIMARY KEY` — the slug-ish identifier already in flight
--   on `tasks.project_id` / `sessions.project_id` / etc. Empty string
--   is forbidden here (the "no project" sentinel for `tasks` is
--   `''`, but the projects table only enumerates actual projects).
--
-- * `name TEXT NOT NULL` — display label (e.g. "Neutron"). Not unique
--   — two distinct projects with the same human label can coexist.
--
-- * `description TEXT` — short one-liner shown on the project card +
--   inside the settings drawer. Nullable; empty string is also fine.
--
-- * `persona TEXT` — human-readable persona label surfaced in the
--   settings drawer (e.g. "Forge — pragmatic build agent"). Free-form
--   string at P5.2; a future P5.7 sprint that grows a real personas
--   table can promote this to an FK without changing the wire shape.
--   Nullable.
--
-- * `privacy_mode TEXT NOT NULL DEFAULT 'private'` — matches the
--   tri-state enum locked in the P5.2 brief § 4.12 (`private |
--   workspace | public`). The existing in-memory store + all P5.2
--   surface tests already encode this exact set; the SQLite CHECK
--   constraint mirrors it so PATCH writes cannot smuggle an
--   out-of-band value past the gateway.
--
--   (Atlas's ISSUES.md #9 sketch used `('private', 'shared')` as a
--   placeholder. The P5.2 brief is the binding spec and locks the
--   tri-state — see the PR description's "deviation from ISSUES.md
--   sketch" note.)
--
-- * `billing_mode TEXT NOT NULL DEFAULT 'personal'` — matches the
--   tri-state locked in the P5.2 brief § 4.5 (`personal |
--   group_per_seat | group_shared`). Read-only at P5.2 (the PATCH
--   whitelist does NOT include this field). Same brief-vs-sketch
--   reasoning as `privacy_mode`.
--
-- * `created_at` / `updated_at` are TEXT ISO-8601 strings — matches
--   the rest of the P6 substrate (`tasks`, `task_reminder_links`,
--   `device_push_tokens`). Stamped by the store on every write.
--
-- * `project_members` — separate composite-PK table for the per-user
--   membership list rendered in the settings drawer. ON DELETE
--   CASCADE from the projects row keeps the membership clean when a
--   future project-delete flow lands (project-delete is OUT OF SCOPE
--   for this sprint per the PR description; nothing writes to this
--   table yet via HTTP).
--
-- Indexes:
--   - `id` PK gives O(1) lookup; no extra index needed for the
--     settings drawer's single-project read.
--   - `idx_project_members_user` so a future "list projects for
--     user X" query can resolve members without scanning. Bound now
--     even though the GET /api/app/projects list endpoint currently
--     enumerates all rows — the list endpoint will switch to
--     "owner-scoped OR member-of" once a future P5.x sprint adds
--     user-scoped filtering.
--
-- Forward-only. No data backfill — the existing
-- `tasks.project_id` / `sessions.project_id` columns continue to
-- treat project_id as an opaque string label. The projects table
-- starts empty and is populated on first PATCH /settings (the store
-- upserts a default row on first access) OR by a follow-up
-- onboarding/signup sprint that explicitly populates it. Either path
-- is fine; the brief notes "starts empty until populated."

CREATE TABLE projects (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    persona         TEXT,
    privacy_mode    TEXT NOT NULL DEFAULT 'private'
                        CHECK (privacy_mode IN ('private', 'workspace', 'public')),
    billing_mode    TEXT NOT NULL DEFAULT 'personal'
                        CHECK (billing_mode IN ('personal', 'group_per_seat', 'group_shared')),
    created_at      TEXT NOT NULL,                              -- ISO-8601 UTC
    updated_at      TEXT NOT NULL                               -- ISO-8601 UTC
) STRICT;

CREATE TABLE project_members (
    project_id      TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner', 'member')),
    joined_at       TEXT NOT NULL,                              -- ISO-8601 UTC
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_project_members_user
    ON project_members (user_id);
