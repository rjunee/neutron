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
