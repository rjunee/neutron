import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
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
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

  test('respondApproval REPORTS the claim: true for the winner, false for everyone after', async () => {
    // Idempotency alone is not enough for a caller that DOES something on the
    // strength of a decision. `open/host-deploy.ts` dispatches a deploy, so it has
    // to be able to tell "I decided this" from "someone already had" — without
    // this boolean the race loser silently believed it had won and dispatched a
    // second time (Argus r1 BLOCKER).
    const mgr = new ApprovalManager(db, recordingNotifier())
    const promise = mgr.requestApproval({
      id: 'claim-1',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'shell_exec',
      args: {},
      policy: 'prompt-user',
    })
    expect(await mgr.respondApproval('claim-1', 'approved', 'owner')).toBe(true)
    expect(await promise).toBe('approved')
    // Same id again, either decision: the row is no longer claimable.
    expect(await mgr.respondApproval('claim-1', 'denied', 'owner')).toBe(false)
    expect(await mgr.respondApproval('claim-1', 'approved', 'owner')).toBe(false)
    // A row that never existed is not a claim either.
    expect(await mgr.respondApproval('never-existed', 'approved', 'owner')).toBe(false)
    // And an EXPIRED row cannot be claimed back into a decision.
    const expiring = mgr.requestApproval({
      id: 'claim-2',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'shell_exec',
      args: {},
      policy: 'prompt-user',
    })
    expect(await mgr.cancelPending('claim-2')).toBe(true)
    expect(await expiring).toBe('expired')
    expect(await mgr.respondApproval('claim-2', 'approved', 'owner')).toBe(false)
    expect(mgr.get('claim-2')?.status).toBe('expired')
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

  test('recordPromptLink merges prompt_id into args_json and keeps the rest', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    const p = mgr.requestApproval({
      id: 'link-1',
      project_slug: 't1',
      topic_id: 'app:owner',
      tool_name: 'host-deploy',
      args: { ref: 'origin/main', target_sha: 'abc', description: 'deploy the host' },
      policy: 'prompt-user',
    })
    await new Promise((r) => setTimeout(r, 5))

    await mgr.recordPromptLink('link-1', 'bp-42')

    const args = JSON.parse(mgr.get('link-1')!.args_json) as Record<string, unknown>
    // The link the expiry sweep reads — added, never at the cost of what was there.
    expect(args['prompt_id']).toBe('bp-42')
    expect(args['ref']).toBe('origin/main')
    expect(args['target_sha']).toBe('abc')
    expect(args['description']).toBe('deploy the host')
    void p
  })

  test('recordPromptLink on an unknown id is a no-op', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    await expect(mgr.recordPromptLink('nope', 'bp-1')).resolves.toBeUndefined()
    expect(mgr.get('nope')).toBeNull()
  })

  test('recordPromptLink replaces unparseable args with the link itself', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    await db.run(
      `INSERT INTO tool_approvals
         (id, project_slug, topic_id, tool_name, args_json, status, requested_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ['bad-1', 't1', 'app:owner', 'host-deploy', '{not json', Date.now() / 1000],
    )

    await mgr.recordPromptLink('bad-1', 'bp-7')

    expect(JSON.parse(mgr.get('bad-1')!.args_json)).toEqual({ prompt_id: 'bp-7' })
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

describe('revokeApproved', () => {
  test('only an APPROVED row can be revoked — a pending one is left alone', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    const p = mgr.requestApproval({
      id: 'w-pending',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'host-deploy-window',
      args: {},
      policy: 'prompt-user',
    })
    await new Promise((r) => setTimeout(r, 5))

    // THE PREDICATE. Without `status = 'approved'` this would silently expire a
    // grant the owner has not answered yet — revoking a permission that was
    // never given, and retiring the prompt he is still looking at.
    expect(await mgr.revokeApproved('w-pending')).toBe(false)
    expect(mgr.get('w-pending')?.status).toBe('pending')

    void p
  })

  test('revoking twice reports true then false — the claim is atomic', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    const p = mgr.requestApproval({
      id: 'w-live',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'host-deploy-window',
      args: {},
      policy: 'prompt-user',
    })
    await new Promise((r) => setTimeout(r, 5))
    await mgr.respondApproval('w-live', 'approved', 'owner')

    expect(await mgr.revokeApproved('w-live')).toBe(true)
    expect(mgr.get('w-live')?.status).toBe('expired')
    // Of two racing revocations exactly one may tell the owner it closed the
    // window; the loser must not claim it too.
    expect(await mgr.revokeApproved('w-live')).toBe(false)

    void p
  })

  test('a DENIED row is not revocable — the record of a refusal is not rewritten', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    const p = mgr.requestApproval({
      id: 'w-denied',
      project_slug: 't1',
      topic_id: null,
      tool_name: 'host-deploy-window',
      args: {},
      policy: 'prompt-user',
    })
    await new Promise((r) => setTimeout(r, 5))
    await mgr.respondApproval('w-denied', 'denied', 'owner')

    expect(await mgr.revokeApproved('w-denied')).toBe(false)
    expect(mgr.get('w-denied')?.status).toBe('denied')

    void p
  })

  test('an unknown id revokes nothing', async () => {
    const mgr = new ApprovalManager(db, recordingNotifier())
    expect(await mgr.revokeApproved('nope')).toBe(false)
  })
})

describe('daily approval reminders', () => {
  const day = 86_400_000
  let now: number
  let manager: ApprovalManager
  let sent: number[]
  const render = (_row: ApprovalRow, attempt: number) => async () => { sent.push(attempt) }
  async function seed(requested_at: string | number = 1000) {
    await db.run(`INSERT INTO tool_approvals
      (id, project_slug, tool_name, args_json, status, requested_at)
      VALUES ('daily', 'p', 'ritual:daily', '{"content_hash":"original"}', 'pending', ?)`, [requested_at])
  }
  beforeEach(() => {
    now = 1_000_000
    sent = []
    manager = new ApprovalManager(db, recordingNotifier(), { now: () => now })
  })
  test('daily boundary, concurrent sweeps, restart, three reminders then retained expiry', async () => {
    await seed()
    now += day - 1
    expect(await manager.reraisePending('daily', render)).toBe('skipped')
    now++
    expect(await Promise.all([manager.reraisePending('daily', render), manager.reraisePending('daily', render)]))
      .toEqual(['raised', 'skipped'])
    manager = new ApprovalManager(db, recordingNotifier(), { now: () => now })
    expect(await manager.reraisePending('daily', render)).toBe('skipped')
    for (let i = 0; i < 2; i++) {
      now += day
      expect(await manager.reraisePending('daily', render)).toBe('raised')
    }
    now += day
    expect(await manager.reraisePending('daily', render)).toBe('expired')
    expect(await manager.reraisePending('daily', render)).toBe('skipped')
    expect(sent).toEqual([1, 2, 3])
    expect(manager.get('daily')?.status).toBe('expired')
    expect(JSON.parse(manager.get('daily')!.args_json)).toMatchObject({
      content_hash: 'original', reraise_count: 3, expiry_reason: 'No answer after three daily reminders',
    })
  })
  test.each(['approved', 'denied'] as const)('answer before selected row is dispatched: %s', async (decision) => {
    await seed()
    const selected = manager.listPending('p')[0]!
    now += day
    await manager.respondApproval(selected.id, decision, 'owner')
    expect(await manager.reraisePending(selected.id, render)).toBe('skipped')
    expect(sent).toEqual([])
    expect(manager.get(selected.id)?.status).toBe(decision)
    expect(JSON.parse(manager.get(selected.id)!.args_json)).toEqual({ content_hash: 'original' })
  })
  test('answer queued during reservation wins before delivery starts', async () => {
    await seed()
    now += day
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const merge = manager.mergeArgs.bind(manager)
    manager.mergeArgs = async (id, patch) => {
      await merge(id, patch)
      entered()
      await gate
    }
    const sending = manager.reraisePending('daily', render)
    await started
    const answering = manager.respondApproval('daily', 'approved', 'owner')
    release()
    await answering
    expect(await sending).toBe('skipped')
    expect(sent).toEqual([])
  })
  test('answer during asynchronous delivery serializes behind send, then forbids later reminders', async () => {
    await seed()
    now += day
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const sending = manager.reraisePending('daily', () => async () => {
      entered()
      await gate
      expect(manager.get('daily')?.status).toBe('pending')
      sent.push(1)
    })
    await started
    const answering = manager.respondApproval('daily', 'denied', 'owner')
    await new Promise((r) => setTimeout(r, 5))
    expect(manager.get('daily')?.status).toBe('pending')
    release()
    await sending
    expect(await answering).toBe(true)
    now += day
    expect(await manager.reraisePending('daily', render)).toBe('skipped')
    expect(sent).toEqual([1])
  })
  test.each(['unreadable', -1, 1e20])('unknown or impossible request age expires: %s', async (stamp) => {
    await seed(stamp)
    expect(await manager.reraisePending('daily', render)).toBe('expired')
    expect(sent).toEqual([])
    expect(JSON.parse(manager.get('daily')!.args_json).expiry_reason).toContain('unreadable')
  })
  test.each([{ last_raised_at: null }, { reraise_count: -1 }, { reraise_count: '2' }])('unreadable history expires: %j', async (patch) => {
    await seed()
    await manager.mergeArgs('daily', patch)
    expect(await manager.reraisePending('daily', render)).toBe('expired')
    expect(sent).toEqual([])
  })
  test('missing request timestamp is not fresh', async () => {
    await seed()
    const get = manager.get.bind(manager)
    manager.get = (id) => ({ ...get(id)!, requested_at: undefined as unknown as number })
    expect(await manager.reraisePending('daily', render)).toBe('expired')
    expect(get('daily')?.status).toBe('expired')
    expect(sent).toEqual([])
  })
  test('cancellation during reservation prevents delivery', async () => {
    await seed()
    now += day
    const merge = manager.mergeArgs.bind(manager)
    manager.mergeArgs = async (id, patch) => { await merge(id, patch); await manager.cancelPending(id) }
    expect(await manager.reraisePending('daily', render)).toBe('skipped')
    expect(sent).toEqual([])
  })
  test('failed delivery consumes its durable attempt and does not block an answer', async () => {
    await seed()
    now += day
    await expect(manager.reraisePending('daily', () => async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(await manager.reraisePending('daily', render)).toBe('skipped')
    expect(JSON.parse(manager.get('daily')!.args_json).reraise_count).toBe(1)
    expect(await manager.respondApproval('daily', 'approved', 'owner')).toBe(true)
  })
})
