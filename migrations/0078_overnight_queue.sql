-- 0078_overnight_queue.sql
--
-- Autonomous Overnight-Work engine — the durable queue substrate.
--
-- This is the Neutron-Open (SQLite-native) translation of Vajra's
-- `gateway/overnight-queue.json` + per-window budget counters. Where Vajra
-- kept the queue as a JSON file on disk and reconciled it from each
-- project's STATUS.md `## Autonomous Overnight Work` bullets, Neutron
-- persists each work item as a row here (runtime truth) and renders the
-- agent-maintained STATUS.md block from it (`status-md-sync.ts`).
--
-- DESIGN CORRECTION (Ryan-locked 2026-06-19): each queued item runs as a
-- TRIDENT RUN — the dispatcher creates a `code_trident_runs` row (migration
-- 0077) per item and the Trident tick drives it Forge→Argus→merge. The link
-- is `trident_run_id` / `trident_slug` below. The morning brief reports the
-- REAL terminal result of that run; it never invents results.
--
-- The queue is CHAT-DRIVEN: the agent maintains the STATUS.md block, never
-- the user. This table is the runtime source of truth; STATUS.md is the
-- agent's rendering of it.
--
-- Column rationale:
--
-- * `id` — the owk-id (`owk-YYYYMMDD-NNN`, Vajra format), human-facing PK
--   rendered back into the STATUS.md bullet's `[owk:]` tag.
--
-- * `project_slug` — the project folder under `Projects/<slug>/` the item
--   belongs to; its STATUS.md is the bullet's home.
--
-- * `agent_role` — `forge` (build work → Trident run) or `atlas`
--   (research/analysis/draft → Trident run with a single-task, non-Ralph
--   shape). Defaults to forge. Both run AS Trident runs per the correction;
--   `agent_role` only seeds the run's `ralph`/prompt shape.
--
-- * `priority` — P1 > P2 > P3 dispatch ordering. Defaults to P3.
--
-- * `description` — the bullet text (the task the run builds).
--
-- * `status` — queued | in-flight | completed | failed. Mirrors the
--   `[owk-status:]` tag. in-flight == a Trident run is driving it.
--
-- * `context_relpath` — the REQUIRED `[context:<path>]` hard gate, resolved
--   relative to the project repo root. A queued item with no resolvable
--   context file is REJECTED at dispatch (double-enforced: scan + dispatch),
--   never spawned. Nullable in the schema only so a freshly-parsed bare
--   bullet can be stored before the gate runs.
--
-- * `result` — the REAL terminal result string (`PR#42`, `merged <branch>`,
--   or `failed: <reason>`), written by the advance tick from the completed
--   Trident run. The morning brief reads ONLY this.
--
-- * `trident_run_id` / `trident_slug` — the `code_trident_runs` row driving
--   this item (NULL until dispatch). `/trident status <slug>` works against
--   overnight items unmodified through this link.
--
-- * `spawn_attempts` — soft-fail counter; 3 strikes → status='failed'.
--
-- * `ralph` — 0/1; whether the item's Trident run uses Ralph spec-driven
--   build mode (set by the dispatcher when the context is a SPEC).
--
-- * `created_at` / `started_at` / `finished_at` — ISO-8601 UTC lifecycle
--   stamps (sortable TEXT, matches `code_trident_runs` + `tasks`).
--
-- * `window_date_local` — the local YYYY-MM-DD of the overnight window the
--   item was dispatched in (budget attribution).
--
-- `overnight_budget` holds one row per window date with the per-window
-- dispatch counter. In-flight concurrency is computed from the queue
-- (COUNT status='in-flight') rather than a stored counter, so it can never
-- drift from reality across a restart.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE overnight_queue (
    id                  TEXT PRIMARY KEY NOT NULL,           -- owk-YYYYMMDD-NNN
    project_slug        TEXT NOT NULL,
    agent_role          TEXT NOT NULL DEFAULT 'forge'
                            CHECK (agent_role IN ('forge', 'atlas')),
    priority            TEXT NOT NULL DEFAULT 'P3'
                            CHECK (priority IN ('P1', 'P2', 'P3')),
    description         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'in-flight', 'completed', 'failed')),
    context_relpath     TEXT,
    result              TEXT,
    trident_run_id      TEXT,
    trident_slug        TEXT,
    spawn_attempts      INTEGER NOT NULL DEFAULT 0,
    ralph               INTEGER NOT NULL DEFAULT 0
                            CHECK (ralph IN (0, 1)),
    created_at          TEXT NOT NULL,                       -- ISO-8601 UTC
    started_at          TEXT,
    finished_at         TEXT,
    window_date_local   TEXT
) STRICT;

-- Scan/dispatch read paths: dispatch picks the highest-priority queued rows
-- per project; advance sweeps in-flight rows.
CREATE INDEX idx_overnight_queue_status
    ON overnight_queue (status);

CREATE INDEX idx_overnight_queue_project
    ON overnight_queue (project_slug, status);

CREATE TABLE overnight_budget (
    window_date_local   TEXT PRIMARY KEY NOT NULL,           -- local YYYY-MM-DD
    started_this_window INTEGER NOT NULL DEFAULT 0
) STRICT;
