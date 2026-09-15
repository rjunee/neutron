import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { applyMigrations } from './runner.ts'
import { serializeSchema } from './schema-serialize.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(HERE, 'expected-schema.txt')

let db: Database

beforeEach(() => {
  // In-memory DB — the snapshot test never needs to survive past this assertion, and the
  // CI box doesn't need a writable tmpdir / a host `sqlite3` binary on PATH for it to run.
  db = new Database(':memory:')
})

// Mirrors the deliverables-manifest contract: applying every migration in `migrations/` to a
// fresh DB must produce a schema byte-identical to `migrations/expected-schema.txt`. Drift
// between code (the SQL files) and the snapshot is a build-break; refresh via
// `bun run migrations/regen-snapshot.ts` (in-process; zero host deps beyond Bun).
test('current migrations produce the expected schema (snapshot diff)', () => {
  applyMigrations(db)

  const observed = serializeSchema(db)
  db.close()

  const expected = readFileSync(SNAPSHOT_PATH, 'utf8')
  if (observed !== expected) {
    // Surface the first ~30 mismatched lines so a regression in CI is decipherable without
    // rerunning locally.
    const obs = observed.split('\n')
    const exp = expected.split('\n')
    const maxLen = Math.max(obs.length, exp.length)
    const diffLines: string[] = []
    for (let i = 0; i < maxLen && diffLines.length < 30; i++) {
      const a = obs[i] ?? '<EOF>'
      const e = exp[i] ?? '<EOF>'
      if (a !== e) diffLines.push(`L${i + 1}\n  observed: ${a}\n  expected: ${e}`)
    }
    throw new Error(
      `schema drift vs migrations/expected-schema.txt — refresh via\n` +
        `  bun run migrations/regen-snapshot.ts\n` +
        `\nfirst diffs:\n${diffLines.join('\n')}`,
    )
  }
  expect(observed).toBe(expected)
})

test('code_trident_runs accepts REVIEW_NOT_RUN and rejects unknown verdicts', () => {
  applyMigrations(db)
  const insert = (id: string, verdict: string): void => {
    db.run(
      `INSERT INTO code_trident_runs
         (id, slug, project_slug, repo_path, task, started_at, last_advanced_at, inner_verdict)
       VALUES (?, ?, 'p', '/repo', 'build', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z', ?)`,
      [id, id, verdict],
    )
  }

  expect(() => insert('review-not-run', 'REVIEW_NOT_RUN')).not.toThrow()
  expect(() => insert('bogus-verdict', 'BOGUS')).toThrow()
  expect(
    db.query<{ inner_verdict: string }, [string]>(
      'SELECT inner_verdict FROM code_trident_runs WHERE id = ?',
    ).get('review-not-run')?.inner_verdict,
  ).toBe('REVIEW_NOT_RUN')
})

test('projects accept the shared provider vocabulary and reject obsolete or unknown values', () => {
  applyMigrations(db)
  const insert = (id: string, provider: string): void => {
    db.run(
      `INSERT INTO projects (id, name, created_at, updated_at, model_provider)
       VALUES (?, 'Project', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', ?)`,
      [id, provider],
    )
  }

  for (const provider of ['anthropic', 'openai', 'openai-codex', 'pi']) {
    expect(() => insert(provider, provider)).not.toThrow()
  }
  expect(() => insert('obsolete', 'openai-codex-cli')).toThrow()
  expect(() => insert('unknown', 'unknown')).toThrow()
})

test('provider vocabulary migration translates the obsolete Codex spelling', () => {
  db.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, persona TEXT,
    privacy_mode TEXT NOT NULL DEFAULT 'private', billing_mode TEXT NOT NULL DEFAULT 'personal',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, context_archived_at TEXT,
    topic_id TEXT, agent_engagement_mode TEXT NOT NULL DEFAULT 'all_messages', emoji TEXT,
    last_activity_at TEXT, archived_at TEXT, model_provider TEXT
  ) STRICT`)
  db.run(
    `INSERT INTO projects (id, name, created_at, updated_at, model_provider)
     VALUES ('legacy', 'Legacy', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', 'openai-codex-cli')`,
  )

  db.exec(readFileSync(join(HERE, '0146_project_provider_vocabulary.sql'), 'utf8'))

  expect(db.query<{ model_provider: string }, []>('SELECT model_provider FROM projects').get()).toEqual({
    model_provider: 'openai-codex',
  })
})
