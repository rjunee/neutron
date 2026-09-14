import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { makeTridentRun } from '@neutronai/trident/testing/make-trident-run.ts'
import { buildBoardReconcileObserver } from '@neutronai/trident/board-reconcile.ts'
import { buildTerminalBuildWakeObserver } from '@neutronai/gateway/proactive/terminal-build-wake.ts'
import { WorkBoardStore } from './store.ts'
import { registerWorkBoardToolSurface, WORK_BOARD_REORDER_TOOL } from './agent-tool.ts'
import { buildWorkBoardChatAck } from './chat-ack.ts'

let tmp: string, db: ProjectDb, board: WorkBoardStore, registry: ToolRegistry
let messages: string[], changes: number
const context = { project_slug: 'owner', project_id: 'project', topic_id: null, call_id: 'sequence', speaker_user_id: null }
// Active projects are their own storage scope.
const scope = 'project'
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dependency-sequence-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  changes = 0
  board = new WorkBoardStore(db, { onChange: () => { changes++ } })
  registry = new ToolRegistry()
  messages = []
  registerWorkBoardToolSurface(registry, board, { chatAck: buildWorkBoardChatAck({
    resolve_chat_id: (project) => `chat-${project}`,
    post: (chat, text) => { expect(chat).toBe('chat-project'); messages.push(text) },
  }) })
})
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })
const invoke = (args: unknown) => registry.get(WORK_BOARD_REORDER_TOOL)!.handler(args, context) as Promise<{ ok: boolean; changed?: boolean; report?: string; error?: string }>
async function fixture() {
  const blocked = await board.create(scope, { title: 'Consumer', design_doc_ref: 'https://example.com/consumer' })
  const middle = await board.create(scope, { title: 'Other priority' })
  const dependency = await board.create(scope, { title: 'Storage migration', design_doc_ref: 'https://example.com/storage' })
  await board.attachRun(scope, blocked.id, 'run-1')
  await board.detachRun(scope, 'run-1', 'blocked')
  return { blocked, middle, dependency }
}

test('escalation → independent orchestrator decision → persisted precedence and named chat report', async () => {
  const { blocked, middle, dependency } = await fixture()
  const run = makeTridentRun({ id: 'run-1', project_slug: scope, chat_id: 'chat-project', phase: 'failed', harvested_at: 1,
    inner_result: JSON.stringify({ ok: true, verdict: 'REQUEST_CHANGES', blockKind: 'missing-dependency', escalation: {
      kind: 'missing-dependency', whatIsMissing: 'storage migration', triggers: ['missing-dependency'], evidence: 'schema missing', round: 1,
      board_item_id: middle.id, reorder: { before: blocked.id }, sort_order: 0,
    } }),
  })
  const before = board.list(scope)
  await buildBoardReconcileObserver(board, { resolveRepoWebUrl: async () => null })!(run)
  expect(board.list(scope).map((x) => x.id)).toEqual(before.map((x) => x.id))
  let calls = 0
  const observe = buildTerminalBuildWakeObserver({
    wakeCompleted: () => false,
    arbitrate: async () => ({ kind: 'decision', option_id: 'investigate', reasoning: 'Read the dependency spec.' }),
    claimWake: async () => true, boardItemIdForRun: async () => blocked.id, projectChatScope: () => scope,
    llm: { compose: async (spec) => {
      // This is the decision boundary: the fake orchestrator selects from board/spec
      // evidence, not from the run's hostile card id or requested position.
      expect(spec.prompt).toContain('`precedes` set to the blocked card id')
      expect(spec.prompt).toContain('independently identify')
      expect(spec.prompt).not.toContain(middle.id)
      const cards = board.list(scope)
      const selected = cards.find((c) => c.design_doc_ref === 'https://example.com/storage')!
      const result = await invoke({ id: selected.id, precedes: blocked.id })
      expect(result.ok).toBe(true)
      calls++
      return result.report!
    } },
    post: async (_run, reply) => { expect(reply).toContain('Sequencing decision:'); return true },
    logger: { error: (message) => { throw new Error(message) } },
  })
  await observe(run)
  expect(board.list(scope).map((x) => x.id)).toEqual([dependency.id, blocked.id, middle.id])
  expect(messages).toEqual(['Sequencing decision: moved "Storage migration" before "Consumer" on the Work Board. "Consumer" remains blocked; no build was dispatched.'])
  const after = board.list(scope), count = changes
  // A fresh wake claim simulates another escalation; storage, not wake dedup, owns idempotence.
  await observe({ ...run, id: 'run-2' })
  expect(calls).toBe(2)
  expect(board.list(scope)).toEqual(after)
  expect(changes).toBe(count)
  expect(messages[1]).toContain('already precedes "Consumer"')
  expect(board.get(scope, blocked.id)).toMatchObject({ status: 'blocked', completed_at: null, linked_run_id: 'run-1' })
})

test('already earlier but not adjacent is a no-op, including concurrent decisions', async () => {
  const { blocked, middle, dependency } = await fixture()
  await board.reorder(scope, dependency.id, { before: middle.id })
  await board.reorder(scope, blocked.id, { after: middle.id })
  const before = board.list(scope), count = changes
  const results = await Promise.all([invoke({ id: dependency.id, precedes: blocked.id }), invoke({ id: dependency.id, precedes: blocked.id })])
  expect(results.map((r) => r.changed)).toEqual([false, false])
  expect(board.list(scope)).toEqual(before)
  expect(changes).toBe(count)
  expect(messages).toHaveLength(1)
})

test('concurrent first decisions commit one move and one unchanged result', async () => {
  const { blocked, dependency } = await fixture()
  const results = await Promise.all([invoke({ id: dependency.id, precedes: blocked.id }), invoke({ id: dependency.id, precedes: blocked.id })])
  expect(results.map((r) => r.changed).sort()).toEqual([false, true])
  expect(board.get(scope, dependency.id)!.sort_order).toBeLessThan(board.get(scope, blocked.id)!.sort_order)
})

for (const invalid of ['before', 'after', 'self', 'missing-dependency', 'done-dependency', 'archived-dependency', 'missing-blocked', 'unblocked', 'cross-project', 'empty', 'number']) {
  test(`refuses ${invalid} without changing order or reporting success`, async () => {
    const { blocked, dependency } = await fixture()
    const args: Record<string, unknown> = { id: dependency.id, precedes: blocked.id }
    if (invalid === 'before' || invalid === 'after') args[invalid] = blocked.id
    if (invalid === 'self') args.id = blocked.id
    if (invalid === 'missing-dependency') args.id = 'missing'
    if (invalid === 'done-dependency') await board.complete(scope, dependency.id)
    if (invalid === 'archived-dependency') await board.update(scope, dependency.id, { status: 'archived' })
    if (invalid === 'missing-blocked') args.precedes = 'missing'
    if (invalid === 'unblocked') await board.update(scope, blocked.id, { status: 'upcoming' })
    if (invalid === 'cross-project') {
      const foreign = await board.create('elsewhere', { title: 'Foreign' })
      args.id = foreign.id
    }
    if (invalid === 'empty') args.precedes = ''
    if (invalid === 'number') args.precedes = 7
    const before = board.list(scope), count = changes
    const result = await invoke(args)
    expect(result.ok).toBe(false)
    expect(result.error).toBeString()
    expect(board.list(scope)).toEqual(before)
    expect(changes).toBe(count)
    expect(messages).toEqual([])
  })
}
