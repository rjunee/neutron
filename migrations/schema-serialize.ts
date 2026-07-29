import type { Database } from 'bun:sqlite'

interface SchemaRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

/**
 * Serialize a SQLite database's user schema into a deterministic text snapshot.
 *
 * Reads `sqlite_master` directly (no host `sqlite3` CLI needed) so the snapshot test runs on
 * any clean Bun environment. Output ordering is `(type, name)`-stable; `sqlite_*` system
 * objects are excluded but FTS5 shadow tables (e.g. `messages_fts_data`) are kept because
 * they are part of the user-visible schema contract.
 *
 * Format (one record per object, blank line between records, trailing blank line):
 *
 *     [type] name
 *     <sql, or "(auto-created, no DDL)" when sqlite_master.sql IS NULL>
 *
 * NULL `sql` happens for auto-indexes that SQLite synthesises for `UNIQUE` constraints; the
 * snapshot still records the (type, name, tbl_name) triple so a regression that adds or
 * removes one of them is caught.
 */
export function serializeSchema(db: Database): string {
  const rows = db
    .query<SchemaRow, []>(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all()

  const parts: string[] = []
  for (const r of rows) {
    parts.push(`[${r.type}] ${r.name} (tbl=${r.tbl_name})`)
    parts.push(r.sql ?? '(auto-created, no DDL)')
    parts.push('')
  }
  return parts.join('\n')
}
