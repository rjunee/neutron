import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ClaudeMcpHandlerDrain } from './claude-mcp-handler-drain.ts'
import { ProjectAdmissionStore } from './project-admission-store.ts'
import type { ClaudeToolGeneration } from '@neutronai/runtime/adapters/claude-code/persistent/tool-handler-generation.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn() })
const identity: ClaudeToolGeneration = { sessionId: 'parent', childGeneration: 'birth', projectId: 'project', admissionGeneration: 0, adopted: false }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-handler-drain-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = ProjectDb.open(join(dir, 'db'))
  cleanups.push(() => db.close())
  for (const file of ['0158_project_admission_fences.sql', '0161_native_host_terminations.sql', '0165_claude_mcp_handler_drain.sql']) {
    await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  }
  await new ProjectAdmissionStore(db).register({ ownerHandle: 'owner', projectId: 'project' })
  return { db, ledger: new ClaudeMcpHandlerDrain(db, 'owner') }
}
const call = '00000000-0000-4000-8000-000000000001'

test('open executes once; exact close refuses; returned downstream work is not effect settlement', async () => {
  const { ledger } = await fixture()
  let count = 0
  expect(await ledger.dispatch(identity, call, 'work_board_start', () => true, async () => {
    count++; return { status: 'dispatched', run_id: 'downstream-run' }
  })).toEqual({ status: 'dispatched', run_id: 'downstream-run' })
  await expect(ledger.dispatch(identity, call, 'work_board_start', () => true, async () => count++)).rejects.toThrow('Duplicate')
  await expect(ledger.dispatch(identity, call, 'other', () => true, async () => count++)).rejects.toThrow('Conflicting')
  expect(ledger.proof(identity).status).toBe('unknown')
  await ledger.close(identity)
  expect(ledger.proof(identity)).toEqual({ status: 'mcp-handlers-drained', downstreamEffects: 'unknown' })
  await expect(ledger.dispatch(identity, call + '2', 'other', () => true, async () => count++)).rejects.toThrow('closed')
  expect(count).toBe(1)
  expect(ledger.proof({ ...identity, childGeneration: 'foreign' }).status).toBe('unknown')
})

test('accepted unsettled call survives reopen as unknown; closure waits for durable outcome', async () => {
  const { db, ledger } = await fixture()
  let release!: () => void; let entered!: () => void
  const start = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const running = ledger.dispatch(identity, call, 'args', () => true, async () => { entered(); await gate; return 'done' })
  await start; await ledger.close(identity)
  const reopened = ProjectDb.open(db.path); cleanups.push(() => reopened.close())
  expect(new ClaudeMcpHandlerDrain(reopened, 'owner').proof(identity).status).toBe('unknown')
  release(); await running
  expect(new ClaudeMcpHandlerDrain(reopened, 'owner').proof(identity).status).toBe('mcp-handlers-drained')
})

test('revocation and foreign admission generation refuse without invoking; legacy coverage stays unknown', async () => {
  const { ledger } = await fixture()
  let count = 0
  for (const [id, current] of [[identity, false], [{ ...identity, admissionGeneration: 1 }, true]] as const) {
    await expect(ledger.dispatch(id, call, 'args', () => current, async () => count++)).rejects.toThrow()
  }
  const adopted = { ...identity, childGeneration: 'legacy', adopted: true }
  await ledger.dispatch(adopted, call, 'args', () => true, async () => count++)
  await ledger.close(adopted)
  expect(ledger.proof(adopted).status).toBe('unknown')
  expect(count).toBe(1)
})

test('unserializable returned outcome leaves durable acceptance unknown, never replays', async () => {
  const { ledger } = await fixture()
  const cyclic: { value?: unknown } = {}; cyclic.value = cyclic
  await expect(ledger.dispatch(identity, call, 'args', () => true, async () => cyclic)).rejects.toThrow()
  await ledger.close(identity)
  expect(ledger.proof(identity).status).toBe('unknown')
})

test('same covered parent survives adoption; a stale admission generation cannot reopen', async () => {
  const { ledger, db } = await fixture()
  await ledger.dispatch(identity, call, 'first', () => true, async () => 'first')
  const adopted = { ...identity, adopted: true }
  const restarted = new ClaudeMcpHandlerDrain(db, 'owner')
  expect(await restarted.dispatch(adopted, call + '2', 'second', () => true, async () => 'second')).toBe('second')
  await db.run('UPDATE project_admission_fences SET generation = generation + 1', [])
  await expect(restarted.dispatch(adopted, call + '3', 'third', () => true, async () => 'wrong')).rejects.toThrow()
  await restarted.close(adopted)
  expect(restarted.proof(adopted).status).toBe('mcp-handlers-drained')
})

test('failed durable outcome and malformed evidence remain unknown', async () => {
  const { ledger, db } = await fixture()
  await db.exec(`CREATE TRIGGER fail_handler_outcome BEFORE UPDATE OF outcome ON claude_mcp_handler_calls
    BEGIN SELECT RAISE(ABORT, 'outcome persistence unavailable'); END`)
  let calls = 0
  await expect(ledger.dispatch(identity, call, 'args', () => true, async () => ++calls)).rejects.toThrow()
  expect(calls).toBe(1)
  await ledger.close(identity)
  expect(ledger.proof(identity).status).toBe('unknown')
  await db.exec('DROP TRIGGER fail_handler_outcome')
  await db.run("UPDATE claude_mcp_handler_calls SET outcome = 'not-evidence'", [])
  expect(ledger.proof(identity).status).toBe('unknown')
})

test('closing an unobserved identity cannot manufacture coverage or permit its first call', async () => {
  const { ledger } = await fixture()
  await ledger.close(identity)
  expect(ledger.proof(identity).status).toBe('unknown')
  await expect(ledger.dispatch(identity, call, 'args', () => true, async () => 'wrong')).rejects.toThrow('closed')
})
