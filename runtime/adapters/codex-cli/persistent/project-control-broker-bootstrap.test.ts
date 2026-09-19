import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectControlJournal } from './project-control-broker-journal.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'broker-bootstrap-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return { socketPath: join(dir, 'control.sock'), cwd: dir, codexHome: dir, threadId: 'bootstrap-thread' }
}

test('SIGKILL after schema creation rolls back bootstrap and permits a first owner', async () => {
  const binding = fixture()
  const modulePath = new URL('./project-control-broker-journal.ts', import.meta.url).pathname
  // Instrument the actual SQLite boundary in a separate process: no production
  // crash hooks and no graceful close/rollback can mask the interrupted write.
  const script = `import { Database } from 'bun:sqlite';
    import { writeSync } from 'node:fs';
    import { openProjectControlJournal } from ${JSON.stringify(modulePath)};
    const exec = Database.prototype.exec;
    Database.prototype.exec = function(sql, ...args) {
      const result = exec.call(this, sql, ...args);
      if (/CREATE TABLE.*broker/i.test(sql)) {
        writeSync(1, 'schema-created');
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    openProjectControlJournal(JSON.parse(process.argv[1]));
    throw new Error('crash boundary was not reached');`
  const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(binding)], { stdout: 'pipe', stderr: 'pipe' })
  cleanup.push(() => child.kill())
  await child.exited
  expect(await new Response(child.stdout).text()).toBe('schema-created')
  expect(child.signalCode).toBe('SIGKILL')
  const journal = openProjectControlJournal(binding)
  cleanup.push(() => journal.close())
  expect(journal.generation).toBe(1)
  expect(journal.epoch).toBe(0)
  expect(journal.reserve()).toBe(1)
  journal.assertOwned()
})

test('existing broker table with deleted ownership refuses bootstrap without repairing evidence', () => {
  const binding = fixture()
  const original = openProjectControlJournal(binding)
  original.close()
  const db = new Database(`${binding.socketPath}.sqlite`)
  cleanup.push(() => db.close())
  expect(db.query('SELECT * FROM broker WHERE id=1').get()).not.toBeNull()
  db.exec('DELETE FROM broker WHERE id=1')
  expect(() => openProjectControlJournal(binding)).toThrow('Broker journal identity missing')
  expect(db.query('SELECT * FROM broker WHERE id=1').get()).toBeNull()
})

test('an unfinished database cannot authorize removal of an unidentified socket', async () => {
  const binding = fixture()
  const db = new Database(`${binding.socketPath}.sqlite`, { create: true })
  db.close()
  chmodSync(`${binding.socketPath}.sqlite`, 0o600)
  const server = createServer()
  cleanup.push(() => server.close())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(binding.socketPath, resolve)
  })
  const before = statSync(binding.socketPath)
  expect(() => openProjectControlJournal(binding)).toThrow('Broker journal identity missing')
  expect(statSync(binding.socketPath).ino).toBe(before.ino)
})
