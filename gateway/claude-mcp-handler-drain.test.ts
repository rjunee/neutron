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
  for (const file of ['0158_project_admission_fences.sql', '0161_native_host_terminations.sql', '0165_claude_mcp_handler_drain.sql', '0168_planner_authority_retirements.sql', '0169_native_conversation_quarantines.sql']) {
    await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  }
  await new ProjectAdmissionStore(db).register({ ownerHandle: 'owner', projectId: 'project' })
  return { db, ledger: new ClaudeMcpHandlerDrain(db, 'owner') }
}
const call = '00000000-0000-4000-8000-000000000001'

test('canonical General and literal general remain isolated through sink admission and closure', async () => {
  const { db, ledger } = await fixture()
  const { ReplSink, replToolBridgeRef } = await import('@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts')
  const { ReplSession } = await import('@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts')
  const sink = new ReplSink()
  Reflect.set(sink, 'tokenValue', 'isolated-canonical-scope-token')
  const previous = replToolBridgeRef.current
  cleanups.push(() => { replToolBridgeRef.current = previous; sink.unregister(identity.sessionId) })
  const seen: unknown[] = []
  replToolBridgeRef.current = { listToolSchemas: () => [], claudeHandlerAdmission: {
    dispatch: (id, invocation, binding, current, handler) => ledger.dispatch(id, invocation, binding, () => {
      const original = session.toolProjectId
      session.toolProjectId = original === null ? 'general' : null
      expect(current()).toBe(false)
      session.toolProjectId = original
      return current()
    }, handler),
  },
    dispatch: async input => { seen.push(input.project_id); return 'ok' } }
  const request = () => new Request('http://localhost/tool-call', { method: 'POST',
    headers: { 'X-Sink-Token': sink.credentialFor(session) },
    body: JSON.stringify({ tool_name: 'write', call_id: call, project_id: 'forged', args: {} }) })
  const handle = async () => (await Reflect.get(sink, 'handle').call(sink, request()) as Response).json() as Promise<{ ok: boolean; result?: unknown }>
  const session = new ReplSession('key', identity.childGeneration, identity.sessionId, 'channel', '/tmp')
  session.projectId = 'general'; session.toolBridgeActive = true; session.admissionGeneration = 0
  sink.register(identity.sessionId, session)
  for (const projectId of [null, 'general'] as const) {
    await new ProjectAdmissionStore(db).register({ ownerHandle: 'owner', projectId })
    session.bindToolProjectScope({ project_id: 'general', conversationProjectId: projectId })
    expect(await handle()).toEqual({ ok: true, result: 'ok' })
    await ledger.close({ ...identity, projectId })
    expect((await ledger.proof({ ...identity, projectId })).status).toBe('mcp-handlers-drained')
    expect((await handle()).ok).toBe(false)
  }
  expect(seen).toEqual([null, 'general'])
  for (const project_id of [undefined, 'general', 'default']) {
    session.bindToolProjectScope(project_id === undefined ? {} : { project_id })
    expect((await handle()).ok).toBe(false)
    await expect(ledger.dispatch({ ...identity, projectId: session.toolProjectId }, call, 'write', () => true,
      async () => seen.push('unexpected'))).rejects.toThrow('unknown')
  }
  expect(seen).toEqual([null, 'general'])
})

test('open executes once; exact close refuses; returned downstream work is not effect settlement', async () => {
  const { ledger } = await fixture()
  let count = 0
  expect(await ledger.dispatch(identity, call, 'work_board_start', () => true, async () => {
    count++; return { status: 'dispatched', run_id: 'downstream-run' }
  })).toEqual({ status: 'dispatched', run_id: 'downstream-run' })
  await expect(ledger.dispatch(identity, call, 'work_board_start', () => true, async () => count++)).rejects.toThrow('Duplicate')
  await expect(ledger.dispatch(identity, call, 'other', () => true, async () => count++)).rejects.toThrow('Conflicting')
  expect((await ledger.proof(identity)).status).toBe('unknown')
  await ledger.close(identity)
  expect(await ledger.proof(identity)).toEqual({ status: 'mcp-handlers-drained', downstreamEffects: 'unknown' })
  await expect(ledger.dispatch(identity, call + '2', 'other', () => true, async () => count++)).rejects.toThrow('closed')
  expect(count).toBe(1)
  expect((await ledger.proof({ ...identity, childGeneration: 'foreign' })).status).toBe('unknown')
})

test('accepted unsettled call survives reopen as unknown; closure waits for durable outcome', async () => {
  const { db, ledger } = await fixture()
  let release!: () => void; let entered!: () => void
  const start = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const running = ledger.dispatch(identity, call, 'args', () => true, async () => { entered(); await gate; return 'done' })
  await start; await ledger.close(identity)
  const reopened = ProjectDb.open(db.path); cleanups.push(() => reopened.close())
  expect((await new ClaudeMcpHandlerDrain(reopened, 'owner').proof(identity)).status).toBe('unknown')
  release(); await running
  expect((await new ClaudeMcpHandlerDrain(reopened, 'owner').proof(identity)).status).toBe('mcp-handlers-drained')
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
  expect((await ledger.proof(adopted)).status).toBe('unknown')
  expect(count).toBe(1)
})

test('unserializable returned outcome leaves durable acceptance unknown, never replays', async () => {
  const { ledger } = await fixture()
  const cyclic: { value?: unknown } = {}; cyclic.value = cyclic
  await expect(ledger.dispatch(identity, call, 'args', () => true, async () => cyclic)).rejects.toThrow()
  await ledger.close(identity)
  expect((await ledger.proof(identity)).status).toBe('unknown')
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
  expect((await restarted.proof(adopted)).status).toBe('mcp-handlers-drained')
})

test('failed durable outcome and malformed evidence remain unknown', async () => {
  const { ledger, db } = await fixture()
  await db.exec(`CREATE TRIGGER fail_handler_outcome BEFORE UPDATE OF outcome ON claude_mcp_handler_calls
    BEGIN SELECT RAISE(ABORT, 'outcome persistence unavailable'); END`)
  let calls = 0
  await expect(ledger.dispatch(identity, call, 'args', () => true, async () => ++calls)).rejects.toThrow()
  expect(calls).toBe(1)
  await ledger.close(identity)
  expect((await ledger.proof(identity)).status).toBe('unknown')
  await db.exec('DROP TRIGGER fail_handler_outcome')
  await db.run("UPDATE claude_mcp_handler_calls SET outcome = 'not-evidence'", [])
  expect((await ledger.proof(identity)).status).toBe('unknown')
})

test('closing an unobserved identity cannot manufacture coverage or permit its first call', async () => {
  const { ledger } = await fixture()
  await ledger.close(identity)
  expect((await ledger.proof(identity)).status).toBe('unknown')
  await expect(ledger.dispatch(identity, call, 'args', () => true, async () => 'wrong')).rejects.toThrow('closed')
})

for (const commit of [false, true]) {
  test(`proof waits for settlement ${commit ? 'commit and then accepts' : 'rollback and remains unknown'}`, async () => {
    const { ledger, db } = await fixture()
    let handlerEntered!: () => void; let releaseHandler!: () => void
    const entered = new Promise<void>(resolve => { handlerEntered = resolve })
    const handlerGate = new Promise<void>(resolve => { releaseHandler = resolve })
    const running = ledger.dispatch(identity, call, 'args', () => true, async () => {
      handlerEntered(); await handlerGate; return 'returned'
    }).then(() => 'returned', () => 'rejected')
    await entered
    await ledger.close(identity)
    let settlementEntered!: () => void; let releaseSettlement!: () => void
    const settling = new Promise<void>(resolve => { settlementEntered = resolve })
    const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve })
    const transaction = db.transaction.bind(db)
    let intercept = true
    db.transaction = <R>(fn: (tx: ProjectDb) => R | Promise<R>): Promise<R> => transaction(async tx => {
      const value = await fn(tx)
      if (intercept) {
        intercept = false
        settlementEntered(); await settlementGate
        if (!commit) throw new Error('simulated settlement rollback before COMMIT')
      }
      return value
    })
    releaseHandler(); await settling
    let proofResolved = false
    const proof = ledger.proof(identity).then(value => { proofResolved = true; return value })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(proofResolved).toBe(false)
    } finally { releaseSettlement() }
    expect(await running).toBe(commit ? 'returned' : 'rejected')
    expect((await proof).status).toBe(commit ? 'mcp-handlers-drained' : 'unknown')
    expect((await ledger.proof(identity)).status).toBe(commit ? 'mcp-handlers-drained' : 'unknown')
  })
}

test('nested transaction cannot attest its own uncommitted snapshot or disturb its caller', async () => {
  const { ledger, db } = await fixture()
  await ledger.dispatch(identity, call, 'args', () => true, async () => 'done')
  await ledger.close(identity)
  await db.transaction(async tx => {
    expect((await ledger.proof(identity)).status).toBe('unknown')
    expect(tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM claude_mcp_handler_calls', [])?.count).toBe(1)
  })
  expect((await ledger.proof(identity)).status).toBe('mcp-handlers-drained')
})
