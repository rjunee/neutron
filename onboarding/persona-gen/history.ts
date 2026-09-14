/** Observed preimages, stored before replacement. A baseline's original date is unknown. */
import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openSidecar } from '@neutronai/persistence/sidecar.ts'

export interface PersonaVersion {
  version: number
  filename: string
  observed_at: number
  content: string | null
}

function readCurrent(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try { return readFileSync(fd, 'utf8') } finally { closeSync(fd) }
}

function withHistory<T>(path: string, action: (db: ReturnType<typeof openSidecar>) => T): T {
  mkdirSync(dirname(path), { recursive: true })
  const db = openSidecar(join(dirname(path), '.persona-history.sqlite'))
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS persona_versions (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      content TEXT
    )`)
    return action(db)
  } finally { db.close() }
}

/** First observation imports legacy nonempty, empty, or missing state as its first observed version. */
export function personaHistory(path: string): PersonaVersion[] {
  return withHistory(path, db => {
    const content = readCurrent(path)
    db.transaction(() => {
      const prior = db.query<PersonaVersion, [string]>(
        'SELECT * FROM persona_versions WHERE filename = ? ORDER BY version DESC LIMIT 1',
      ).get(basename(path))
      if (!prior || prior.content !== content) {
        db.query('INSERT INTO persona_versions(filename, observed_at, content) VALUES (?, ?, ?)')
          .run(basename(path), Date.now(), content)
      }
    })()
    return db.query<PersonaVersion, [string]>(
      'SELECT * FROM persona_versions WHERE filename = ? ORDER BY version',
    ).all(basename(path))
  })
}

/** Synchronous critical section shared by regeneration and the HTTP editor. */
export function writePersonaVersion(path: string, content: string): void {
  personaHistory(path)
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
    personaHistory(path)
  } finally {
    try { unlinkSync(tmp) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

export function deletePersonaVersion(path: string): void {
  personaHistory(path)
  unlinkSync(path)
}
