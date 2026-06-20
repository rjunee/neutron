-- 0001_drawers_notes_kg.sql — Notes Core S1 per-project sidecar schema.
--
-- Per docs/plans/notes-core-tier1-brief.md § 4.2.
-- Schema is RE-IMPLEMENTED from the proven drawer/KG mental model
-- (drawers / wings / rooms / notes / KG nodes / KG edges). Zero imports
-- from Nova; no migration from any external memory DB. Empty
-- per-project sidecar on first init.
--
-- Lives under cores/free/notes/migrations/ — the Core's own migration
-- tree, applied via `applyProjectScopedMigrations(db, dir)` against
-- each project's `<OWNER_HOME>/Projects/<project_id>/notes/notes.db`
-- sidecar.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a
-- re-run is a no-op.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
PRAGMA busy_timeout = 100;

CREATE TABLE IF NOT EXISTS drawers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'inbox',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS wings (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,
  drawer_id    TEXT NOT NULL REFERENCES drawers(id),
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  UNIQUE(drawer_id, name)
);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  drawer_id    TEXT NOT NULL REFERENCES drawers(id),
  room_id      TEXT REFERENCES rooms(id),
  content      TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  source_kind  TEXT,
  source_ref   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_drawer_updated ON notes(drawer_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_updated_desc ON notes(updated_at DESC) WHERE deleted_at IS NULL;

-- FTS5 virtual table over note content. Tokenizer is `unicode61` with
-- diacritic-stripping for common-case English + Romanized text.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  id UNINDEXED,
  content,
  content='notes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers keep FTS5 in sync with the notes table. Soft-deleted rows
-- stay in FTS5 until `cleanupFts()` (a future S2 vacuum step) — search
-- filters by joining notes.deleted_at IS NULL so they never leak.
CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, id, content) VALUES ('delete', old.rowid, old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, id, content) VALUES ('delete', old.rowid, old.id, old.content);
  INSERT INTO notes_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS kg_nodes (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'note',
  note_id      TEXT REFERENCES notes(id),
  label        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_nodes_note_id ON kg_nodes(note_id) WHERE note_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kg_edges (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES kg_nodes(id),
  target_id    TEXT NOT NULL REFERENCES kg_nodes(id),
  kind         TEXT NOT NULL DEFAULT 'user_tunnel',
  weight       REAL NOT NULL DEFAULT 1.0,
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS notes_meta (
  -- Single-row table — the schema version + the project_id this DB
  -- was opened against. Defence-in-depth: if a sidecar gets copied
  -- between projects, the resolver fails loud on `project_id`
  -- mismatch.
  schema_version  INTEGER NOT NULL,
  project_id      TEXT NOT NULL,
  initialised_at  INTEGER NOT NULL
);
