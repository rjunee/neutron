import { mock, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'

const [mode, root] = process.argv.slice(2)
if (!mode || !root) throw new Error('mode and root required')
const runnerPath = process.env['OWNER_PUBLICATION_RUNNER'] ?? resolve(import.meta.dir, '../../../../migrations/runner.ts')
const runner = await import(runnerPath)
mock.module('@neutronai/migrations/runner.ts', () => runner)
const { NexusStore } = await import('../../nexus-store.ts')
const home = join(root, 'Projects/race-project/.nexus')
fs.mkdirSync(home, { recursive: true })
const markerPath = join(home, '.migrate-owner')
const foreign = '/nonexistent-other-checkout/migrations\n'
const originalWrite = fs.writeFileSync
const originalOpen = fs.openSync
const originalClose = fs.closeSync
const originalRead = fs.readFileSync
let injected = false
let visibleDuringWrite: string | null = null
let contender: { exit: number; error: string | null } | null = null
if (mode === 'malformed') originalWrite(markerPath, ' \n')
if (mode === 'foreign') originalWrite(markerPath, foreign)
if (mode === 'dangling') fs.symlinkSync('missing-owner', markerPath)
const linkSpy = mode === 'failed-link' ? spyOn(fs, 'linkSync').mockImplementation(() => {
  throw Object.assign(new Error('injected unsupported hard link'), { code: 'EOPNOTSUPP' })
}) : null

// Pause at the real open-before-write window, without timing or sleeps. The
// contender reads exactly the path a simultaneous Nexus first writer reads.
const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
  const [path, data, options] = args
  if (injected || typeof path !== 'string' || !path.includes('.migrate-owner')) {
    return originalWrite(...args)
  }
  injected = true
  if (mode === 'foreign-winner') originalWrite(markerPath, foreign)
  if (mode === 'malformed-winner') originalWrite(markerPath, ' \n')
  const fd = originalOpen(path, 'wx')
  try {
    visibleDuringWrite = fs.existsSync(markerPath) ? originalRead(markerPath, 'utf8') : null
    if (mode === 'failed-write') throw Object.assign(new Error('injected write failure'), { code: 'EIO' })
    if (mode === 'publish') {
      const child = Bun.spawnSync([process.execPath, import.meta.path, 'contender', root], {
        stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
      })
      contender = { exit: child.exitCode, error: child.exitCode === 0 ? JSON.parse(child.stdout.toString()).error : child.stderr.toString() }
    }
    originalWrite(fd, data, options)
  } finally {
    originalClose(fd)
  }
})
const store = new NexusStore({ owner_home: root })
let error: string | null = null
try {
  await store.appendEvent('race-project', { actor_kind: 'forge', actor_id: mode, kind: 'observation', body: mode === 'contender' ? 'contender owner' : 'published owner', refs: null })
} catch (err) {
  error = String(err)
} finally {
  store.closeAll()
  writeSpy.mockRestore()
  linkSpy?.mockRestore()
}
const db = new Database(join(home, 'nexus.db'), { readonly: true })
const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
const events = tables.includes('agent_nexus_events') ? db.query('SELECT body FROM agent_nexus_events').all() : []
const ledger = tables.includes('_migrations') ? db.query('SELECT name FROM _migrations').all() : []
db.close()
console.log(JSON.stringify({ error, injected, visibleDuringWrite, contender, events, ledger, tables,
  marker: fs.existsSync(markerPath) ? originalRead(markerPath, 'utf8') : null,
  dangling: mode === 'dangling' ? fs.readlinkSync(markerPath) : null,
  staging: fs.readdirSync(home).filter(name => name.startsWith('.migrate-owner-')),
}))
