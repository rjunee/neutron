import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { applyMigrations } from './runner.ts'
import { serializeSchema } from './schema-serialize.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(HERE, 'expected-schema.txt')

const db = new Database(':memory:')
applyMigrations(db)
const out = serializeSchema(db)
db.close()
writeFileSync(SNAPSHOT_PATH, out)
console.log(`wrote ${SNAPSHOT_PATH} (${out.length} bytes)`)
