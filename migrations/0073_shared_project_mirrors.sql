-- 0073_shared_project_mirrors.sql
--
-- 2026-06-14 — Connect FEATURES B2 (connect-spec §1.8 + §2.4). The one-way
-- host→collaborator memory mirror, IMPORT-ON-JOIN milestone.
--
-- When a collaborator joins a shared project, a SNAPSHOT of that shared
-- project's GBrain GRAPH layer (entities/relations/embeddings — NOT the raw
-- transcript) is imported one-directionally from the host into the joining
-- collaborator's OWN GBrain, scoped + tagged `source=<project>@<host>` and
-- carrying the §4 `author` attribution. The host's memory stays canonical; the
-- collaborator's copy is a scoped recall replica (NO write-back, NO bus, NO
-- quarantine — those stay ripped per §2.1).
--
-- This table is the collaborator-side ONE-TIME-import ledger: it records that a
-- given shared project (`project_id`) from a given source scope (`source` =
-- `<project>@<host>`) has already been mirrored, so the import-on-join path is
-- idempotent (a re-accept / reconnect does NOT re-import a second copy). The
-- mirrored graph rows themselves live in the per-instance GBrain (reached over
-- MCP), NOT in this SQLite DB — this table only tracks the import event +
-- attribution for audit and idempotency.
--
--   project_id   the shared project the snapshot came from (host-side id).
--   source       the scope tag stamped on every mirrored entry: <project>@<host>.
--   host         the host instance slug / home authority (display + audit).
--   author_id    the uniform §4 author id the join was attributed to
--                (the collaborator's local_slug, or NULL if unattributed).
--   page_count   number of graph pages (entities) imported in the snapshot.
--   edge_count   number of typed relations imported in the snapshot.
--   imported_at  ISO-8601 UTC timestamp of the one-time import.
--
-- Forward-only; STRICT table. Snapshot regen required.

CREATE TABLE shared_project_mirrors (
    project_id  TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    host        TEXT    NOT NULL,
    author_id   TEXT,
    page_count  INTEGER NOT NULL DEFAULT 0,
    edge_count  INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT    NOT NULL,
    PRIMARY KEY (project_id, source)
) STRICT;
