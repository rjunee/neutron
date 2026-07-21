import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  ApprovalManager,
  type ApprovalNotifier,
  type ApprovalRow,
} from '@neutronai/tools/approval.ts'
import { createRitualRegistry, validateRitualFire, type RitualDef } from './rituals.ts'
import {
  computeRitualContentHash,
  createRitualApprovalCheck,
  requestRitualApproval,
  ritualApprovalToolName,
  ritualCadenceString,
  ritualEgressApprovalToolName,
  type RitualContentHashInput,
} from './ritual-approval.ts'

// ── db harness — mirrors tools/approval.test.ts:16-36 ────────────────────────
let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-approval-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // some tests close the db under test; ignore a double-close here
  }
  rmSync(tmp, { recursive: true, force: true })
})

const recordingNotifier = (): ApprovalNotifier & { calls: ApprovalRow[] } => {
  const calls: ApprovalRow[] = []
  return { calls, notify: async (row) => void calls.push(row) }
}

/** Let the synchronous-after-await INSERT + fireAndForget notify land. */
const settle = () => new Promise((r) => setTimeout(r, 10))

function def(overrides: Partial<RitualDef> = {}): RitualDef {
  return {
    id: 'morning-brief',
    description: 'read STATUS.md + calendar and summarise the day',
    scope: 'project',
    tool_surface: ['Read', 'Glob', 'Grep'],
    egress: 'none',
    silent: false,
    ...overrides,
  }
}

/** Approve every pending grant for the slug (the explicit affirmative act). */
async function approveAllPending(
  mgr: ApprovalManager,
  project_slug: string,
  by = 'owner-1',
): Promise<void> {
  for (const row of mgr.listPending(project_slug)) {
    await mgr.respondApproval(row.id, 'approved', by)
  }
}

// ── 1. Hash: determinism + per-field sensitivity + order-insensitive surface ──

describe('computeRitualContentHash', () => {
  const base: RitualContentHashInput = {
    prompt: 'do the thing',
    tool_surface: ['Read', 'Glob'],
    scope: 'project',
    cadence: 'spec:0 9 * * *',
    model_tier: 'best',
    timeout_ms: 2_700_000,
  }

  test('deterministic — same input twice yields the same hex', () => {
    expect(computeRitualContentHash(base)).toBe(computeRitualContentHash(base))
    expect(computeRitualContentHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('EACH of the six inputs flips the hash', () => {
    const h = computeRitualContentHash(base)
    expect(computeRitualContentHash({ ...base, prompt: 'do the thin' })).not.toBe(h)
    expect(computeRitualContentHash({ ...base, tool_surface: ['Read', 'Glob', 'Grep'] })).not.toBe(h)
    expect(computeRitualContentHash({ ...base, scope: 'instance' })).not.toBe(h)
    expect(computeRitualContentHash({ ...base, cadence: 'spec:0 8 * * *' })).not.toBe(h)
    expect(computeRitualContentHash({ ...base, model_tier: 'fast' })).not.toBe(h)
    expect(computeRitualContentHash({ ...base, timeout_ms: 2_700_001 })).not.toBe(h)
  })

  test('tool_surface ORDER does not flip the hash', () => {
    expect(computeRitualContentHash({ ...base, tool_surface: ['Glob', 'Read'] })).toBe(
      computeRitualContentHash(base),
    )
  })
})

// ── 2. ritualCadenceString ───────────────────────────────────────────────────

describe('ritualCadenceString', () => {
  test('spec row → spec:<cron>; coarse row → legacy:<coarse>; both-null → once', () => {
    expect(ritualCadenceString({ recurrence: null, recurrence_spec: '0 9 * * *' })).toBe(
      'spec:0 9 * * *',
    )
    expect(ritualCadenceString({ recurrence: 'weekly', recurrence_spec: null })).toBe('legacy:weekly')
    expect(ritualCadenceString({ recurrence: null, recurrence_spec: null })).toBe('once')
  })
})

// ── 3. requestRitualApproval — egress:'none' single grant + durable record ────

describe('requestRitualApproval (egress:none)', () => {
  test('one notify call, args round-trip, pends until respond, durable record set', async () => {
    const notifier = recordingNotifier()
    const mgr = new ApprovalManager(db, notifier)
    const d = def()
    const res = requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: 'topic-1',
      def: d,
      prompt: 'do the thing',
      cadence: 'spec:0 9 * * *',
    })
    await settle()

    // EXACTLY ONE call, under ritual:<id>
    expect(notifier.calls.length).toBe(1)
    const row = notifier.calls[0]!
    expect(row.tool_name).toBe(ritualApprovalToolName(d.id))

    // args_json round-trips ritual_id + content_hash
    const args = JSON.parse(row.args_json) as { ritual_id: string; content_hash: string }
    expect(args.ritual_id).toBe(d.id)
    expect(args.content_hash).toBe(res.content_hash)

    // promise pends until the explicit affirmative act
    let settled = false
    void res.content.then(() => (settled = true))
    await settle()
    expect(settled).toBe(false)

    await mgr.respondApproval(row.id, 'approved', 'owner-1')
    expect(await res.content).toBe('approved')

    // the durable (ritual_id, content_hash, approved_by, approved_at) record
    const reread = mgr.get(row.id)!
    expect(reread.status).toBe('approved')
    expect(reread.decided_by).toBe('owner-1')
    expect(reread.decided_at).not.toBeNull()
  })
})

// ── 4. requestRitualApproval — egress:'web' mints a SECOND bound grant ────────

describe('requestRitualApproval (egress:web)', () => {
  test('two notify calls (ritual: + ritual-egress:) sharing one content_hash', async () => {
    const notifier = recordingNotifier()
    const mgr = new ApprovalManager(db, notifier)
    const d = def({
      id: 'kaizen',
      tool_surface: ['Read', 'WebSearch'],
      egress: 'web',
    })
    const res = requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: d,
      prompt: 'research the topic',
      cadence: 'spec:0 9 * * *',
    })
    await settle()

    expect(notifier.calls.length).toBe(2)
    const byTool = new Map(notifier.calls.map((c) => [c.tool_name, c]))
    const content = byTool.get(ritualApprovalToolName(d.id))!
    const egress = byTool.get(ritualEgressApprovalToolName(d.id))!
    expect(content).toBeDefined()
    expect(egress).toBeDefined()

    const contentHash = (JSON.parse(content.args_json) as { content_hash: string }).content_hash
    const egressHash = (JSON.parse(egress.args_json) as { content_hash: string }).content_hash
    expect(contentHash).toBe(res.content_hash)
    expect(egressHash).toBe(res.content_hash)
    expect(res.egress).toBeDefined()
  })
})

// ── 5-11. seam-bound checker over the real registry + validateRitualFire ─────

describe('createRitualApprovalCheck ⨯ validateRitualFire', () => {
  const CADENCE = 'spec:0 9 * * *'

  /** Write a ritual prompt file and return the registry + its bytes. */
  function seedRegistry(id: string, promptBytes: string) {
    const reg = createRitualRegistry({ rituals_dir: tmp })
    writeFileSync(join(tmp, `${id}.md`), promptBytes, 'utf8')
    return reg
  }

  // 5. end-to-end bind (artifact-on-disk prompt → grant → ok:true)
  test('grant minted from the live prompt → validateRitualFire ok:true', async () => {
    const PROMPT = 'MORNING BRIEF: read STATUS.md and summarise\n'
    const reg = seedRegistry('morning-brief', PROMPT)
    const d = def()
    reg.register(d)
    const mgr = new ApprovalManager(db, recordingNotifier())

    requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: d,
      prompt: PROMPT,
      cadence: CADENCE,
    })
    await settle()
    await approveAllPending(mgr, 't1')

    const checker = createRitualApprovalCheck({ manager: mgr, project_slug: 't1', cadence: CADENCE })
    const verdict = await validateRitualFire(reg, checker, 'morning-brief', () => {})
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.prompt).toBe(PROMPT)
  })

  // 6. RE-VERIFY EVERY FIRE — rewrite the prompt bytes after approval → skip
  test('rewriting the prompt file after approval drops the grant (ok:false unapproved)', async () => {
    const reg = seedRegistry('morning-brief', 'ORIGINAL PROMPT\n')
    const d = def()
    reg.register(d)
    const mgr = new ApprovalManager(db, recordingNotifier())

    requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: d,
      prompt: 'ORIGINAL PROMPT\n',
      cadence: CADENCE,
    })
    await settle()
    await approveAllPending(mgr, 't1')

    // an editor (or an injected agent) rewrites the ported prompt file
    writeFileSync(join(tmp, 'morning-brief.md'), 'TAMPERED PROMPT\n', 'utf8')

    const checker = createRitualApprovalCheck({ manager: mgr, project_slug: 't1', cadence: CADENCE })
    const verdict = await validateRitualFire(reg, checker, 'morning-brief', () => {})
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('unapproved')
  })

  // 7. cadence change drops approval — reminders_update is atomic cancel+create
  //    and mints a NEW id (cores/free/reminders/src/mcp-tools-extra.ts:64), so an
  //    update ALSO drops approval; here we prove the cadence arm directly.
  test('a cadence change invalidates the grant', async () => {
    const PROMPT = 'BRIEF\n'
    const reg = seedRegistry('morning-brief', PROMPT)
    const d = def()
    reg.register(d)
    const mgr = new ApprovalManager(db, recordingNotifier())

    requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: d,
      prompt: PROMPT,
      cadence: 'spec:0 9 * * *',
    })
    await settle()
    await approveAllPending(mgr, 't1')

    const checker = createRitualApprovalCheck({
      manager: mgr,
      project_slug: 't1',
      cadence: 'spec:0 8 * * *', // re-cadenced after approval
    })
    expect(checker.isApproved(d, PROMPT)).toBe(false)
  })

  // 8. egress is a separately-approved capability class
  test('web def: content grant alone is not enough; egress grant unlocks it; none never needs it', async () => {
    const PROMPT = 'RESEARCH\n'
    const reg = seedRegistry('kaizen', PROMPT)
    const d = def({ id: 'kaizen', tool_surface: ['Read', 'WebSearch'], egress: 'web' })
    reg.register(d)
    const mgr = new ApprovalManager(db, recordingNotifier())

    requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: d,
      prompt: PROMPT,
      cadence: CADENCE,
    })
    await settle()

    const checker = createRitualApprovalCheck({ manager: mgr, project_slug: 't1', cadence: CADENCE })

    // approve ONLY the content grant
    const contentRow = mgr
      .listPending('t1')
      .find((r) => r.tool_name === ritualApprovalToolName(d.id))!
    await mgr.respondApproval(contentRow.id, 'approved', 'owner-1')
    expect(checker.isApproved(d, PROMPT)).toBe(false)

    // now approve the egress grant too
    const egressRow = mgr
      .listPending('t1')
      .find((r) => r.tool_name === ritualEgressApprovalToolName(d.id))!
    await mgr.respondApproval(egressRow.id, 'approved', 'owner-1')
    expect(checker.isApproved(d, PROMPT)).toBe(true)

    // an egress:'none' def never requires the egress row
    const readOnly = def({ id: 'evening-wrap' })
    reg.register(readOnly)
    writeFileSync(join(tmp, 'evening-wrap.md'), PROMPT, 'utf8')
    requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: readOnly,
      prompt: PROMPT,
      cadence: CADENCE,
    })
    await settle()
    const roRow = mgr
      .listPending('t1')
      .find((r) => r.tool_name === ritualApprovalToolName(readOnly.id))!
    await mgr.respondApproval(roRow.id, 'approved', 'owner-1')
    expect(checker.isApproved(readOnly, PROMPT)).toBe(true)
  })

  // 9. denied / pending / malformed rows never match
  test('denied → false; pending → false; malformed args_json row → ignored (false, no throw)', async () => {
    const PROMPT = 'BRIEF\n'
    const d = def()
    const checker = createRitualApprovalCheck({ manager: new ApprovalManager(db, recordingNotifier()), project_slug: 't1', cadence: CADENCE })

    // denied
    const mgrDenied = new ApprovalManager(db, recordingNotifier())
    requestRitualApproval(mgrDenied, { project_slug: 't1', topic_id: null, def: d, prompt: PROMPT, cadence: CADENCE })
    await settle()
    const denyRow = mgrDenied.listPending('t1')[0]!
    await mgrDenied.respondApproval(denyRow.id, 'denied', 'owner-1')
    expect(checker.isApproved(d, PROMPT)).toBe(false)

    // pending (a fresh request, never decided)
    requestRitualApproval(mgrDenied, { project_slug: 't2', topic_id: null, def: d, prompt: PROMPT, cadence: CADENCE })
    await settle()
    const pendingChecker = createRitualApprovalCheck({ manager: mgrDenied, project_slug: 't2', cadence: CADENCE })
    expect(pendingChecker.isApproved(d, PROMPT)).toBe(false)

    // malformed approved row — insert directly, must be ignored, never throw
    await db.run(
      `INSERT INTO tool_approvals (id, project_slug, topic_id, tool_name, args_json, status, requested_at, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
      ['bad-1', 't3', null, ritualApprovalToolName(d.id), '{not valid json', Date.now() / 1000, Date.now() / 1000, 'owner-1'],
    )
    const malformedChecker = createRitualApprovalCheck({ manager: mgrDenied, project_slug: 't3', cadence: CADENCE })
    expect(() => malformedChecker.isApproved(d, PROMPT)).not.toThrow()
    expect(malformedChecker.isApproved(d, PROMPT)).toBe(false)
  })

  // 10. fail closed — a manager that throws (closed db) → validateRitualFire skip
  test('a throwing approval store fails CLOSED through validateRitualFire', async () => {
    const PROMPT = 'BRIEF\n'
    const reg = seedRegistry('morning-brief', PROMPT)
    const d = def()
    reg.register(d)
    const mgr = new ApprovalManager(db, recordingNotifier())
    const checker = createRitualApprovalCheck({ manager: mgr, project_slug: 't1', cadence: CADENCE })

    db.close() // now findApproved's prepare/all throws

    const verdict = await validateRitualFire(reg, checker, 'morning-brief', () => {})
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('unapproved')
  })

  // 11. no auto-approve — the request is policy 'prompt-user', decision pends
  test('the content decision does not resolve before the explicit respond', async () => {
    const d = def()
    const mgr = new ApprovalManager(db, recordingNotifier())
    const res = requestRitualApproval(mgr, {
      project_slug: 't1',
      topic_id: null,
      def: d,
      prompt: 'BRIEF\n',
      cadence: CADENCE,
    })
    let resolved = false
    void res.content.then(() => (resolved = true))
    await settle()
    expect(resolved).toBe(false)

    const row = mgr.listPending('t1')[0]!
    await mgr.respondApproval(row.id, 'approved', 'owner-1')
    expect(await res.content).toBe('approved')
  })
})
