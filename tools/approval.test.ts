import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  ApprovalManager,
  type ApprovalNotifier,
  type ApprovalRow,
} from './approval.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-approval-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const recordingNotifier = (): ApprovalNotifier & { calls: ApprovalRow[] } => {
  const calls: ApprovalRow[] = []
  return {
    calls,
    notify: async (row) => {
      calls.push(row)
    },
  }
}

describe('ApprovalManager', () => {
  test('policy=auto short-circuits without persisting', async () => {
    const notifier = recordingNotifier()
    const mgr = new ApprovalManager(db, notifier)
    const decision = await mgr.requestApproval({
      project_slug: 't1',
      topic_id: 'topic-1',
      tool_name: 'echo',
      args: {},
      policy: 'auto',
    })
    expect(decision).toBe('approved')
    expect(notifier.calls.length).toBe(0)
    expect(mgr.listPending('t1').length).toBe(0)
  })

  test('prompt-user persists row + notifies + resolves on respond', async () => {
    const notifier = recordingNotifier()
    const mgr = new ApprovalManager(db, notifier)
    const promise = mgr.requestApproval({
      id: 'fixed-id',
      project_slug: 't1',
      topic_id: 'topic-1',
      tool_name: 'shell_exec',
      args: { cmd: 'ls' },
      policy: 'prompt-user',
    })

    // notifier is invoked async, so wait a microtick before asserting
    await new Promise((r) => setTimeout(r, 5))
    expect(notifier.calls.length).toBe(1)
    expect(notifier.calls[0]?.id).toBe('fixed-id')
    expect(notifier.calls[0]?.tool_name).toBe('shell_exec')

    const pending = mgr.listPending('t1')
    expect(pending.length).toBe(1)
    expect(pending[0]?.status).toBe('pending')

    await mgr.respondApproval('fixed-id', 'approved', 'user-123')
    const decision = await promise
    expect(decision).toBe('approved')

    const got = mgr.get('fixed-id')
    expect(got?.status).toBe('approved')
    expect(got?.decided_by).toBe('user-123')
    expect(mgr.listPending('t1').length).toBe(0)
  })

  test('respondApproval is idempotent (second decision no-ops)', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    const promise = mgr.requestApproval({
      id: 'id-2',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'shell_exec',
      args: {},
      policy: 'prompt-user',
    })
    await mgr.respondApproval('id-2', 'denied', 'user-x')
    expect(await promise).toBe('denied')
    // second call should not throw and should not flip the row
    await mgr.respondApproval('id-2', 'approved', 'user-y')
    const row = mgr.get('id-2')
    expect(row?.status).toBe('denied')
    expect(row?.decided_by).toBe('user-x')
  })

  test('expireStale moves stale pending rows to expired', async () => {
    let now = 1_000_000_000_000
    const mgr = new ApprovalManager(db, recordingNotifier(), {
      ttl_ms: 60_000,
      now: () => now,
    })
    const p1 = mgr.requestApproval({
      id: 'old',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'shell_exec',
      args: {},
      policy: 'prompt-user',
    })
    // Allow the synchronous-after-await INSERT inside requestApproval to land
    // before we sweep, but DON'T await p1 (it only resolves on decision).
    await new Promise((r) => setTimeout(r, 10))
    // advance the clock past TTL
    now += 120_000
    const expired = await mgr.expireStale()
    expect(expired).toBe(1)
    expect(await p1).toBe('expired')
    expect(mgr.get('old')?.status).toBe('expired')
  })

  test('notifier failures do not crash the request', async () => {
    const failingNotifier: ApprovalNotifier = {
      notify: async () => {
        throw new Error('telegram down')
      },
    }
    const mgr = new ApprovalManager(db, failingNotifier)
    const promise = mgr.requestApproval({
      id: 'id-x',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'echo',
      args: {},
      policy: 'prompt-user',
    })
    await mgr.respondApproval('id-x', 'approved', 'user')
    expect(await promise).toBe('approved')
  })

  test('findApproved returns only approved rows matching (slug, tool_name)', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    // approved + matching (the one we want) — approve two so ORDER BY decided_at is exercised
    const p1 = mgr.requestApproval({ id: 'ok-1', project_slug: 't1', topic_id: null, tool_name: 'ritual:x', args: { n: 1 }, policy: 'prompt-user' })
    const p2 = mgr.requestApproval({ id: 'ok-2', project_slug: 't1', topic_id: null, tool_name: 'ritual:x', args: { n: 2 }, policy: 'prompt-user' })
    // pending (excluded), denied (excluded), other-slug (excluded), other-tool (excluded)
    const pPending = mgr.requestApproval({ id: 'pending-1', project_slug: 't1', topic_id: null, tool_name: 'ritual:x', args: {}, policy: 'prompt-user' })
    const pDenied = mgr.requestApproval({ id: 'denied-1', project_slug: 't1', topic_id: null, tool_name: 'ritual:x', args: {}, policy: 'prompt-user' })
    const pSlug = mgr.requestApproval({ id: 'slug-1', project_slug: 't2', topic_id: null, tool_name: 'ritual:x', args: {}, policy: 'prompt-user' })
    const pTool = mgr.requestApproval({ id: 'tool-1', project_slug: 't1', topic_id: null, tool_name: 'ritual:y', args: {}, policy: 'prompt-user' })
    await new Promise((r) => setTimeout(r, 5))

    await mgr.respondApproval('ok-1', 'approved', 'owner')
    await mgr.respondApproval('ok-2', 'approved', 'owner')
    await mgr.respondApproval('denied-1', 'denied', 'owner')
    await mgr.respondApproval('slug-1', 'approved', 'owner')
    await mgr.respondApproval('tool-1', 'approved', 'owner')

    const rows = mgr.findApproved('t1', 'ritual:x')
    expect(rows.map((r) => r.id).sort()).toEqual(['ok-1', 'ok-2'])
    for (const r of rows) {
      expect(r.status).toBe('approved')
      expect(r.project_slug).toBe('t1')
      expect(r.tool_name).toBe('ritual:x')
    }

    // drain the promises we deliberately never decided so bun doesn't warn
    void p1
    void p2
    void pPending
    void pDenied
    void pSlug
    void pTool
  })
})
