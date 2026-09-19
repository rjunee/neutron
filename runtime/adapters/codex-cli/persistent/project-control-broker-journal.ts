import { Database } from 'bun:sqlite'
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'

type Binding = { socketPath: string; threadId: string; cwd: string; codexHome: string }
type Row = { binding: string; generation: number; epoch: number; pid: number | null; boot: string; start: string; unresolved: string | null; socketIdentity: string | null }
const socketIdentity = (path: string): string => { const info = lstatSync(path); return `${info.dev}:${info.ino}` }

function identity(pid: number): { boot: string; start: string } {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  if (!boot || !start || !/^\d+$/.test(start)) throw new Error('Broker process identity unknown')
  return { boot, start }
}

/** Only positive process death/replacement permits reclamation. Permission and
 * probe failures are refusals, never expiry-based leases. Linux process identity
 * includes the boot and start ticks so a reused PID cannot become the owner.
 */
function requireDead(row: Row): void {
  if (row.pid === null) return
  // Probe the boot separately: absent procfs is UNKNOWN, not owner death.
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!boot || !Number.isSafeInteger(row.pid) || row.pid <= 0) throw new Error('Broker owner identity unknown')
  if (boot !== row.boot) return
  try {
    const current = identity(row.pid)
    if (current.boot === row.boot && current.start === row.start) throw new Error('Broker generation owner is still live')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function openProjectControlJournal(options: Binding) {
  const path = `${options.socketPath}.sqlite`
  const binding = JSON.stringify([options.socketPath, options.threadId, options.cwd, options.codexHome])
  let existing = false
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Broker journal needs a private owned file')
    existing = true
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let socketExists = false
  try {
    const info = lstatSync(options.socketPath)
    if (!existing || !info.isSocket() || info.uid !== process.getuid?.()) throw new Error('Unowned broker socket refused')
    socketExists = true
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const db = new Database(path, { create: true })
  let released = false
  let claimedGeneration: number | undefined
  try {
    chmodSync(path, 0o600)
    const file = lstatSync(path)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS broker (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, pid INTEGER, boot TEXT NOT NULL, start TEXT NOT NULL, unresolved TEXT, socketIdentity TEXT)')
    const own = identity(process.pid)
    const read = () => db.query<Row, []>('SELECT * FROM broker WHERE id=1').get()
    const row = db.transaction(() => {
      const previous = read()
      if (existing && !previous) throw new Error('Broker journal identity missing')
      if (previous) {
        if (previous.binding !== binding) throw new Error('Broker journal binding mismatch')
        requireDead(previous)
        if (socketExists && previous.socketIdentity !== socketIdentity(options.socketPath)) throw new Error('Broker socket identity unknown')
      }
      const next: Row = { binding, generation: (previous?.generation ?? 0) + 1, epoch: previous ? previous.epoch + 1 : 0,
        pid: process.pid, ...own, unresolved: previous?.unresolved ?? null, socketIdentity: null }
      if (!Number.isSafeInteger(next.epoch) || !Number.isSafeInteger(next.generation)) throw new Error('Broker fencing counter exhausted')
      db.query('INSERT OR REPLACE INTO broker VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL)').run(binding, next.generation, next.epoch, next.pid, own.boot, own.start, next.unresolved)
      return next
    }).immediate()
    claimedGeneration = row.generation
    const assertOwned = (): void => {
      const currentFile = lstatSync(path)
      if (currentFile.ino !== file.ino || currentFile.dev !== file.dev || !currentFile.isFile()) throw new Error('Broker journal replaced')
      const current = read()
      if (released || !current || current.generation !== row.generation || current.pid !== process.pid
        || current.boot !== own.boot || current.start !== own.start || current.binding !== binding) throw new Error('Stale broker generation')
    }
    // Claim is committed before unlinking. A contender now observes our live
    // identity even if this process fails between recovery and socket binding.
    if (socketExists) unlinkSync(options.socketPath)
    return {
      generation: row.generation, epoch: row.epoch, unresolved: row.unresolved,
      assertOwned,
      bound(): void {
        db.transaction(() => { assertOwned(); db.query('UPDATE broker SET socketIdentity=? WHERE id=1').run(socketIdentity(options.socketPath)) }).immediate()
      },
      reserve(): number {
        return db.transaction(() => {
          assertOwned()
          if (!Number.isSafeInteger(row.epoch + 1)) throw new Error('Broker fencing counter exhausted')
          db.query('UPDATE broker SET epoch=? WHERE id=1').run(++row.epoch)
          return row.epoch
        }).immediate()
      },
      record(method: string): void {
        db.transaction(() => {
          assertOwned()
          db.query('UPDATE broker SET unresolved=COALESCE(unresolved, ?) WHERE id=1').run(method)
        }).immediate()
      },
      settle(): void {
        db.transaction(() => { assertOwned(); db.exec('UPDATE broker SET unresolved=NULL WHERE id=1') }).immediate()
      },
      close(): void {
        if (released) return
        try {
          db.query('UPDATE broker SET pid=NULL WHERE id=1 AND generation=? AND pid=? AND boot=? AND start=?').run(row.generation, process.pid, own.boot, own.start)
        } finally { released = true; db.close() }
      },
    }
  } catch (error) {
    if (claimedGeneration !== undefined) db.query('UPDATE broker SET pid=NULL WHERE id=1 AND generation=? AND pid=?').run(claimedGeneration, process.pid)
    db.close(); throw error
  }
}
