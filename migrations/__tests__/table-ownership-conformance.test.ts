/**
 * P4 (world-class refactor, 2026-07) — table-ownership conformance.
 *
 * Enforces migrations/table-ownership.json: for every table in the map, the
 * set of non-test source files containing a WRITE statement against that
 * table must EXACTLY equal the committed `writers` allowlist — both
 * directions, so a new stray writer fails loudly AND a stale allowlist entry
 * (writer deleted/moved) fails loudly. Keyed off migrations/expected-schema.txt:
 * every mapped table must exist in the committed schema, so the map cannot
 * drift to phantom tables.
 *
 * Scan mechanics:
 *   - Pure fs walk from the repo root (git-independent; catches untracked
 *     files too). Pruned: node_modules, .git, dot-dirs (worktree clones under
 *     .claude/worktrees must not leak in), plus test trees (any `__tests__`
 *     segment, any top-level `tests/` segment, `*.test.ts`) — fixtures and
 *     suites legitimately write tables they don't own.
 *   - Migration SQL lives in *.sql (not scanned — .ts only) and the runner
 *     carries no per-table DML, so schema evolution stays exempt by
 *     construction.
 *   - Write statements = INSERT [OR IGNORE|REPLACE|...] INTO t / UPDATE t SET
 *     / DELETE FROM t / REPLACE INTO t, case-insensitive, whitespace across
 *     newlines (multi-line template literals match).
 *
 * Guardrail (L-phase source-text trap): the walk asserts a sane minimum file
 * count so a broken root resolution fails the suite instead of passing on an
 * empty scan.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MAP_PATH = fileURLToPath(new URL('../table-ownership.json', import.meta.url))
const SCHEMA_PATH = fileURLToPath(new URL('../expected-schema.txt', import.meta.url))

interface OwnershipEntry {
  owner: string
  writers: string[]
  notes?: string[]
}

interface OwnershipMap {
  tables: Record<string, OwnershipEntry>
}

const ownership = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as OwnershipMap

/** Directories never descended into (by basename). */
const PRUNE_DIRS = new Set(['node_modules', '__tests__'])

function isPruned(name: string): boolean {
  // Dot-dirs cover .git, .claude (worktree clones), .expo, etc.
  return name.startsWith('.') || PRUNE_DIRS.has(name)
}

/** Walk the repo for candidate .ts source files (non-test). */
function collectSourceFiles(root: string): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (isPruned(entry.name)) continue
        // Top-level tests/ (integration suites + fixtures) is test tree.
        if (dir === root && entry.name === 'tests') continue
        stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.test.ts')) continue
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * The table identifier as SQLite accepts it in DML (Codex round-3): bare,
 * double-quoted, backtick-quoted, or bracket-quoted — each optionally
 * schema-qualified (`main.projects`, `main."projects"`, ...). Bare form gets a
 * trailing \b so `projects_x` never matches; quoted forms end at the closing
 * quote. Single-quoted 'projects' is a string literal, not an identifier —
 * deliberately unmatched.
 */
function tableToken(table: string): string {
  return String.raw`(?:[\w"\x60\[\]]+\s*\.\s*)?(?:${table}\b|"${table}"|\x60${table}\x60|\[${table}\])`
}

/** SQL write statements against `table`, tolerant of multi-line literals. */
function writePatterns(table: string): RegExp[] {
  const t = tableToken(table)
  return [
    new RegExp(String.raw`\binsert\s+(?:or\s+\w+\s+)?into\s+${t}`, 'i'),
    new RegExp(String.raw`\bupdate\s+${t}\s+set\b`, 'i'),
    new RegExp(String.raw`\bdelete\s+from\s+${t}`, 'i'),
    new RegExp(String.raw`\breplace\s+into\s+${t}`, 'i'),
  ]
}

function toRepoRel(abs: string): string {
  return relative(REPO_ROOT, abs).split(sep).join('/')
}

const sourceFiles = collectSourceFiles(REPO_ROOT)

describe('table-ownership conformance (migrations/table-ownership.json)', () => {
  test('walk sanity — the scan actually saw the repo', () => {
    // ~2k source .ts files at time of writing; a broken root or an
    // over-aggressive prune must fail loudly, never pass on a near-empty scan.
    expect(sourceFiles.length).toBeGreaterThan(500)
  })

  test('matcher — quoted / schema-qualified identifier forms are caught (Codex r3)', () => {
    const pats = writePatterns('projects')
    const hits = [
      'UPDATE projects SET x = 1',
      'UPDATE "projects" SET x = 1',
      'UPDATE `projects` SET x = 1',
      'UPDATE [projects] SET x = 1',
      'UPDATE main.projects SET x = 1',
      'UPDATE main."projects" SET x = 1',
      'INSERT INTO "projects" (id) VALUES (?)',
      'INSERT OR IGNORE INTO `projects` (id) VALUES (?)',
      'DELETE FROM [projects]',
      'REPLACE INTO main.projects (id) VALUES (?)',
      'insert\n  into\n  projects (id)',
    ]
    for (const sql of hits) {
      expect(pats.some((re) => re.test(sql)), `must match: ${sql}`).toBe(true)
    }
    const misses = [
      'UPDATE projects_archive SET x = 1', // different table (bare \b)
      "SELECT * FROM projects WHERE id = ?", // read, not write
      "UPDATE 'projects' SET x = 1", // string literal, not an identifier
      'update the projects list in the UI', // prose (no SQL shape)
    ]
    for (const sql of misses) {
      expect(pats.some((re) => re.test(sql)), `must NOT match: ${sql}`).toBe(false)
    }
  })

  test('every mapped table exists in expected-schema.txt', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8')
    const declared = new Set(
      [...schema.matchAll(/^\[table\]\s+(\S+)/gm)].map((m) => m[1] as string),
    )
    for (const table of Object.keys(ownership.tables)) {
      expect(declared.has(table), `table '${table}' is in the ownership map but not in expected-schema.txt`).toBe(true)
    }
  })

  test('map shape — every entry has an owner inside its writers list', () => {
    for (const [table, entry] of Object.entries(ownership.tables)) {
      expect(entry.writers.length, `table '${table}' has an empty writers list`).toBeGreaterThan(0)
      expect(
        entry.writers.includes(entry.owner),
        `table '${table}': owner '${entry.owner}' must itself appear in writers`,
      ).toBe(true)
      const sorted = [...entry.writers].sort()
      expect(entry.writers, `table '${table}': writers must be sorted + unique`).toEqual([...new Set(sorted)])
    }
  })

  for (const [table, entry] of Object.entries(ownership.tables)) {
    test(`'${table}' writers = committed allowlist (both directions)`, () => {
      const patterns = writePatterns(table)
      const found = new Set<string>()
      for (const file of sourceFiles) {
        const text = readFileSync(file, 'utf8')
        if (patterns.some((re) => re.test(text))) found.add(toRepoRel(file))
      }
      const allow = new Set(entry.writers)

      const strays = [...found].filter((f) => !allow.has(f)).sort()
      const stale = [...allow].filter((f) => !found.has(f)).sort()

      expect(
        strays,
        `NEW writer(s) of '${table}' outside the committed ownership map. ` +
          `Route the write through the owning store ('${entry.owner}') — move the ` +
          `SQL verbatim into a store method — or, if the file is a deliberate ` +
          `owner, add it to migrations/table-ownership.json with a note.`,
      ).toEqual([])
      expect(
        stale,
        `STALE allowlist entry for '${table}': listed file no longer writes the ` +
          `table (deleted/moved/refactored). Update migrations/table-ownership.json.`,
      ).toEqual([])
    })
  }
})
