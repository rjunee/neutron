/**
 * The STANDING DEPLOY WINDOW — a permission that removes the owner's per-sha tap
 * for a bounded stretch of time.
 *
 * This suite is written the way `host-deploy.test.ts` is, and for the same
 * reason: `dispatchCalls` is the ground truth for "did anything deploy". A test
 * that only checked return shapes would pass a version of this that opens a
 * window nobody granted, or one that never closes.
 *
 * MUTATION-TESTED (each guard removed in turn, each of these goes RED):
 *   - drop the `status !== 'approved'` check in `readLiveWindow`  → "a DENIED window"
 *   - drop the expiry comparison in `readLiveWindow`              → "a LAPSED window"
 *   - drop the ref match in `readLiveWindow`                      → "another ref"
 *   - drop the owner gate in `handleWindowAnswer`                 → "the agent cannot"
 *   - drop the `liveWindow` check in `request()`                  → "auto_approved"
 *   - drop the range check in `validateWindowHours`               → "outside the range"
 *   - drop the already-open refusal in `requestWindow`            → "cannot be ratcheted"
 *   - drop `revokeApproved`'s `status = 'approved'` predicate     → "revoking closes"
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ApprovalManager, type ApprovalRow } from '@neutronai/tools/approval.ts'

import {
  createHostDeployService,
  resolveHostDeployConfig,
  type HostDeployCommit,
  type HostDeployDispatchInput,
  type HostDeployEmit,
  type HostDeployGit,
  type HostDeployService,
  type HostDeployServiceOptions,
} from '../host-deploy.ts'
import {
  describeRemaining,
  HOST_DEPLOY_WINDOW_MAX_HOURS,
  HOST_DEPLOY_WINDOW_TOOL_NAME,
  HOST_DEPLOY_WINDOW_VALUE_RE,
  pickLiveWindow,
  readLiveWindow,
  renderWindowApprovalBody,
  validateWindowHours,
  windowExpiryMs,
} from '../host-deploy-window.ts'

const OWNER = 'owner'
const AGENT = 'agent-7'
const PROJECT = 'owner'
const TOPIC = 'app:owner'

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TARGET_SHA = 'ff00112233445566778899aabbccddeeff001122'
const MOVED_SHA = '99887766554433221100ffeeddccbbaa99887766'

const URL = 'https://control.example.test/v1/deploy'
const TOKEN = 'hdp-secret-token-9f3a2b1c8d7e6f5a4b3c2d1e'

const HOUR_MS = 60 * 60_000

let tmp: string
let db: ProjectDb
let approvals: ApprovalManager
let nowMs: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-host-deploy-window-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  nowMs = Date.now()
  approvals = new ApprovalManager(db, { notify: async () => undefined }, { now: () => nowMs })
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* some tests close under test */
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** Let the not-awaited `requestApproval` INSERT land before reading the row. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 15))

const COMMITS: HostDeployCommit[] = [
  { sha: TARGET_SHA, subject: 'fix(deploy): name the sha in the refusal' },
  { sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd', subject: 'feat(usage): one screen for every account' },
]

interface Harness {
  service: HostDeployService
  emits: HostDeployEmit[]
  dispatchCalls: HostDeployDispatchInput[]
  notices: Array<{ topic_id: string; body: string }>
  logs: string[]
  options(): string[]
  approveValue(): string
  denyValue(): string
}

function fakeGit(head: string, target: string): HostDeployGit {
  const revParse = async (ref: string): Promise<string | null> =>
    ref === 'HEAD' ? head : ref === 'origin/main' ? target : null
  return {
    revParse,
    resolveTarget: revParse,
    commitsBetween: async (_f, _t, limit) => ({
      commits: COMMITS.slice(0, limit),
      total: COMMITS.length,
    }),
  }
}

function harness(
  opts: {
    head?: string
    target?: string
    dispatch?: (i: HostDeployDispatchInput) => Promise<{ ok: boolean; detail: string }>
    values?: { url?: string; token?: string }
    /**
     * The per-sha guard a window may never skip. DEFAULTS TO A PASSING ONE here
     * so these tests exercise window behaviour; the fail-closed default (absent
     * seam) has its own suite below, because "no checker" must never deploy.
     */
    check?: HostDeployServiceOptions['check_preconditions']
    /** Omit the checker entirely — the production default on an unwired box. */
    noCheck?: boolean
  } = {},
): Harness {
  const emits: HostDeployEmit[] = []
  const dispatchCalls: HostDeployDispatchInput[] = []
  const notices: Array<{ topic_id: string; body: string }> = []
  const logs: string[] = []
  const service = createHostDeployService({
    approvals,
    git: fakeGit(opts.head ?? HEAD_SHA, opts.target ?? TARGET_SHA),
    resolveConfig: () => resolveHostDeployConfig(opts.values ?? { url: URL, token: TOKEN }),
    dispatch: async (i) => {
      dispatchCalls.push(i)
      if (opts.dispatch !== undefined) return await opts.dispatch(i)
      return { ok: true, detail: 'queued as run 4821' }
    },
    project_slug: PROJECT,
    owner_user_id: OWNER,
    approval_topic_id: TOPIC,
    emit: async (p) => {
      emits.push(p)
      return { prompt_id: `bp-${emits.length}` }
    },
    post_notice: async (topic_id, body) => {
      notices.push({ topic_id, body })
    },
    ...(opts.noCheck === true
      ? {}
      : {
          check_preconditions:
            opts.check ?? (async () => ({ ok: true, reason: 'no migration drift' })),
        }),
    log: (m) => logs.push(m),
    now: () => nowMs,
  })
  const options = (): string[] =>
    (emits.length > 0 ? emits[emits.length - 1]!.options : []).map((o) => o.value)
  return {
    service,
    emits,
    dispatchCalls,
    notices,
    logs,
    options,
    approveValue: () => options().find((v) => v.endsWith(':a')) ?? '',
    denyValue: () => options().find((v) => v.endsWith(':d')) ?? '',
  }
}

function answer(h: Harness, user_text: string, user_id = OWNER) {
  return h.service.handleOwnerButtonAnswer({
    user_id,
    user_text,
    topic_id: TOPIC,
    prior_option_values: h.options(),
  })
}

/** Open a window the way the owner does: ask, then tap. */
async function openWindow(h: Harness, hours = 4): Promise<void> {
  const res = await h.service.requestWindow({ hours, topic_id: TOPIC })
  expect(res.status).toBe('pending_approval')
  await settle()
  const out = await answer(h, h.approveValue())
  expect(out).not.toBeNull()
}

function windowRows(): ApprovalRow[] {
  return approvals.findByToolName(PROJECT, HOST_DEPLOY_WINDOW_TOOL_NAME)
}

// ─────────────────────────────────────────────────────────────────────────────
describe('asking for a window opens NOTHING', () => {
  test('requestWindow raises a prompt and deploys nothing', async () => {
    const h = harness()
    const res = await h.service.requestWindow({ hours: 4, topic_id: TOPIC })

    expect(res.status).toBe('pending_approval')
    // THE GUARD: asking is not granting, and granting is not deploying.
    expect(h.dispatchCalls).toEqual([])
    expect(h.service.windowStatus().open).toBe(false)
    expect(h.emits).toHaveLength(1)
    expect(h.options().every((v) => HOST_DEPLOY_WINDOW_VALUE_RE.test(v))).toBe(true)
  })

  test('the prompt says any FUTURE commit may deploy, and names the closing time', () => {
    const body = renderWindowApprovalBody({
      ref: 'origin/main',
      hours: 4,
      expires_at_ms: nowMs + 4 * HOUR_MS,
      now_ms: nowMs,
      approve_value: 'hdw:AAAAAAAAAAAAAAAAAAAAAA:a',
      deny_value: 'hdw:AAAAAAAAAAAAAAAAAAAAAA:d',
    })
    // The whole risk of the feature is an owner who reads "deploy window" as
    // "the commits I just looked at". The body must give up that ambiguity.
    expect(body).toContain('without a further tap from you')
    expect(body).toContain('including commits nobody has written yet')
    expect(body).toContain('restarts the instance')
    expect(body).toContain('origin/main')
    // And it must NOT pretend to be bound to a commit list, because it is not.
    expect(body).not.toContain('fix(deploy)')
  })

  test('a duration outside the range is REFUSED, never clamped, and mints no row', async () => {
    const h = harness()
    const over = await h.service.requestWindow({ hours: HOST_DEPLOY_WINDOW_MAX_HOURS + 1, topic_id: TOPIC })
    expect(over.status).toBe('refused')
    if (over.status === 'refused') expect(over.reason).toContain('outside the allowed')

    const zero = await h.service.requestWindow({ hours: 0, topic_id: TOPIC })
    expect(zero.status).toBe('refused')
    const fractional = await h.service.requestWindow({ hours: 1.5, topic_id: TOPIC })
    expect(fractional.status).toBe('refused')

    await settle()
    // A clamp would have left the owner approving a body that says one duration
    // while the row holds another. Nothing was minted at all.
    expect(windowRows()).toHaveLength(0)
    expect(h.emits).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('only the owner can open one', () => {
  test('the agent cannot open the window it asked for', async () => {
    const h = harness()
    await h.service.requestWindow({ hours: 4, topic_id: TOPIC })
    await settle()

    const out = await answer(h, h.approveValue(), AGENT)

    expect(out?.body).toContain('Only the owner')
    expect(h.service.windowStatus().open).toBe(false)
    expect(h.dispatchCalls).toEqual([])
  })

  test('an unrelated reply is not an answer, and a Deny opens nothing', async () => {
    const h = harness()
    await h.service.requestWindow({ hours: 4, topic_id: TOPIC })
    await settle()

    expect(await answer(h, 'yes go ahead')).toBeNull()
    expect(h.service.windowStatus().open).toBe(false)

    const denied = await answer(h, h.denyValue())
    expect(denied?.body).toContain('No deploy window opened')
    expect(h.service.windowStatus().open).toBe(false)
    expect(h.dispatchCalls).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('an open window deploys without asking', () => {
  test('the tap that opens it also sends the deploy that was already waiting', async () => {
    const h = harness()
    await h.service.requestWindow({ hours: 4, topic_id: TOPIC })
    await settle()

    const out = await answer(h, h.approveValue())

    expect(h.service.windowStatus().open).toBe(true)
    // He opened it BECAUSE work is queued; making him then ask for that very
    // deploy is the round trip this feature removes.
    expect(h.dispatchCalls).toHaveLength(1)
    expect(h.dispatchCalls[0]!.sha).toBe(TARGET_SHA)
    expect(out?.body).toContain('Deploy window open')
    expect(out?.body).toContain(TARGET_SHA.slice(0, 8))
  })

  test('a later request returns auto_approved, dispatches, and POSTS a notice', async () => {
    const h = harness()
    await openWindow(h)
    h.dispatchCalls.length = 0
    h.notices.length = 0

    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })

    expect(res.status).toBe('auto_approved')
    if (res.status === 'auto_approved') {
      expect(res.accepted).toBe(true)
      expect(res.target_sha).toBe(TARGET_SHA)
      expect(res.commit_count).toBe(COMMITS.length)
    }
    expect(h.dispatchCalls).toHaveLength(1)
    // A permission whose exercise is silent is one the owner cannot audit.
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.body).toContain('standing deploy window')
    expect(h.notices[0]!.body).toContain(TARGET_SHA.slice(0, 8))
  })

  test('an auto deploy still stops at up_to_date and never dispatches', async () => {
    const h = harness({ head: TARGET_SHA, target: TARGET_SHA })
    await openWindow(h)

    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })

    expect(res.status).toBe('up_to_date')
    // The window replaces the owner's TAP. It replaces none of the checks.
    expect(h.dispatchCalls).toEqual([])
  })

  test('a control-plane refusal under the window is reported, not swallowed', async () => {
    const h = harness({ dispatch: async () => ({ ok: false, detail: 'contract gate failed' }) })
    await openWindow(h)
    h.notices.length = 0

    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })

    expect(res.status).toBe('auto_approved')
    if (res.status === 'auto_approved') expect(res.accepted).toBe(false)
    expect(h.notices[0]!.body).toContain('did NOT go out')
    expect(h.notices[0]!.body).toContain('contract gate failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a window that is not live changes nothing', () => {
  test('a LAPSED window falls back to asking per sha', async () => {
    const h = harness()
    await openWindow(h, 1)
    expect(h.service.windowStatus().open).toBe(true)
    h.dispatchCalls.length = 0

    nowMs += 1 * HOUR_MS + 1_000

    expect(h.service.windowStatus().open).toBe(false)
    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    expect(res.status).toBe('pending_approval')
    expect(h.dispatchCalls).toEqual([])
  })

  test('a window can only ever be asked for on the DEFAULT ref', async () => {
    const h = harness()
    // A standing grant pointed at an arbitrary branch is a promise about code the
    // owner never reviews. Every other ref keeps its per-sha tap.
    const res = await h.service.requestWindow({ hours: 4, ref: 'origin/release', topic_id: TOPIC })

    expect(res.status).toBe('refused')
    if (res.status === 'refused') expect(res.reason).toContain('default ref')
    await settle()
    expect(windowRows()).toHaveLength(0)
    expect(h.emits).toHaveLength(0)
  })

  test('a window recorded against another ref authorises nothing on main', async () => {
    const h = harness()
    // Written straight to the row rather than through `requestWindow`, which now
    // refuses a non-default ref — the read path must ALSO be scoped, or a row
    // that got there any other way would authorise the trunk.
    // NOT awaited: `requestApproval` resolves only when the grant is decided.
    const pending = approvals.requestApproval({
      id: 'w-release',
      project_slug: PROJECT,
      topic_id: TOPIC,
      tool_name: HOST_DEPLOY_WINDOW_TOOL_NAME,
      args: { ref: 'origin/release', hours: 4, expires_at_ms: nowMs + 4 * HOUR_MS },
      policy: 'prompt-user',
    })
    void pending
    await settle()
    await approvals.respondApproval('w-release', 'approved', OWNER)

    expect(h.service.windowStatus('origin/main').open).toBe(false)
    const deploy = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    expect(deploy.status).toBe('pending_approval')
    expect(h.dispatchCalls).toEqual([])
  })

  test('a DENIED row is never read as a window', async () => {
    const h = harness()
    await h.service.requestWindow({ hours: 4, topic_id: TOPIC })
    await settle()
    await answer(h, h.denyValue())

    const rows = windowRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('denied')
    expect(readLiveWindow(rows[0]!, 'origin/main', nowMs)).toBeNull()
  })

  test('a row whose expiry is missing or unreadable is CLOSED, not open', () => {
    const base: ApprovalRow = {
      id: 'w1',
      project_slug: PROJECT,
      topic_id: TOPIC,
      tool_name: HOST_DEPLOY_WINDOW_TOOL_NAME,
      args_json: JSON.stringify({ ref: 'origin/main' }),
      status: 'approved',
      requested_at: nowMs / 1000,
      decided_at: nowMs / 1000,
      decided_by: OWNER,
    }
    // FAIL-CLOSED ON EVERY AXIS: absent, garbled, non-finite, and past.
    expect(readLiveWindow(base, 'origin/main', nowMs)).toBeNull()
    expect(readLiveWindow({ ...base, args_json: '{' }, 'origin/main', nowMs)).toBeNull()
    expect(
      readLiveWindow(
        { ...base, args_json: JSON.stringify({ ref: 'origin/main', expires_at_ms: 'soon' }) },
        'origin/main',
        nowMs,
      ),
    ).toBeNull()
    expect(
      readLiveWindow(
        { ...base, args_json: JSON.stringify({ ref: 'origin/main', expires_at_ms: nowMs - 1 }) },
        'origin/main',
        nowMs,
      ),
    ).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the window replaces the TAP, never the GUARD', () => {
  test('NO precondition checker wired → the window never deploys, and asks instead', async () => {
    // The production default on a box that wired nothing. A permissive default
    // here would silently produce the one outcome the constraint forbids, on
    // exactly the installs least equipped to notice.
    const h = harness({ noCheck: true })
    await h.service.requestWindow({ hours: 4, topic_id: TOPIC })
    await settle()
    await answer(h, h.approveValue())

    expect(h.service.windowStatus().open).toBe(true)
    expect(h.dispatchCalls).toEqual([])

    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    expect(res.status).toBe('pending_approval')
    expect(h.dispatchCalls).toEqual([])
    expect(h.notices.some((n) => n.body.includes('was NOT'))).toBe(true)
  })

  test('a FAILING precondition holds the deploy and falls back to asking', async () => {
    const h = harness({
      check: async () => ({ ok: false, reason: 'migration 0138 is claimed by two different names' }),
    })
    await openWindow(h)

    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })

    expect(res.status).toBe('pending_approval')
    expect(h.dispatchCalls).toEqual([])
    // Held, not silently skipped: the owner is told what stopped it and can
    // still read the commit list and decide for himself.
    expect(h.notices.at(-1)!.body).toContain('claimed by two different names')
    expect(h.notices.at(-1)!.body).toContain('Asking you per commit instead')
  })

  test('a THROWING precondition proves nothing, so it holds too', async () => {
    const h = harness({
      check: async () => {
        throw new Error('the ledger could not be read')
      },
    })
    await openWindow(h)

    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })

    // Treating a crashed guard as a pass is how a guard becomes decoration.
    expect(res.status).toBe('pending_approval')
    expect(h.dispatchCalls).toEqual([])
  })

  test('the checker is called with the TARGET sha, every time', async () => {
    const seen: Array<{ ref: string; sha: string }> = []
    const h = harness({
      check: async (i) => {
        seen.push(i)
        return { ok: true, reason: 'clean' }
      },
    })
    await openWindow(h)
    await h.service.request({ ref: 'origin/main', topic_id: TOPIC })

    // Per sha, every time — not once when the window opened.
    expect(seen).toHaveLength(2)
    expect(seen.every((s) => s.sha === TARGET_SHA && s.ref === 'origin/main')).toBe(true)
  })

  test('the owner tapping Approve on a single deploy is NOT gated by the checker', async () => {
    // The constraint binds the STANDING grant. His own tap is his own judgement,
    // and gating it would change a behaviour nobody asked to change.
    const h = harness({ noCheck: true })
    await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    await settle()

    const out = await answer(h, h.approveValue())

    expect(h.dispatchCalls).toHaveLength(1)
    expect(out?.body).toContain('Deploy requested')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('every auto-deploy is written onto the grant that authorised it', () => {
  test('the grant row accumulates one use per deploy, with sha and outcome', async () => {
    const h = harness()
    await openWindow(h)
    await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    await settle()

    const row = windowRows().find((r) => r.status === 'approved')
    const uses = JSON.parse(row!.args_json).uses as Array<Record<string, unknown>>
    // Two: the deploy the opening tap sent, and the explicit request after it.
    expect(uses).toHaveLength(2)
    expect(uses.every((u) => u['sha'] === TARGET_SHA && u['kind'] === 'accepted')).toBe(true)
    // "Which permission authorised this deploy" has an answer after the fact.
    expect(typeof uses[0]!['at_ms']).toBe('number')
  })

  test('a HELD deploy writes no use — nothing was authorised', async () => {
    const h = harness({ check: async () => ({ ok: false, reason: 'drift' }) })
    await openWindow(h)
    await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    await settle()

    const row = windowRows().find((r) => r.status === 'approved')
    expect(JSON.parse(row!.args_json).uses).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the permission is bounded and revocable', () => {
  test('an open window cannot be ratcheted longer by asking again', async () => {
    const h = harness()
    await openWindow(h, 2)

    const again = await h.service.requestWindow({ hours: HOST_DEPLOY_WINDOW_MAX_HOURS, topic_id: TOPIC })

    expect(again.status).toBe('refused')
    if (again.status === 'refused') expect(again.reason).toContain('already open')
    // One 1-hour grant re-asked every hour would be a permanent window built out
    // of bounded ones. Extension has to be a decision, so it has to be a close.
    expect(h.service.windowStatus().expires_at_ms).toBe(windowExpiryMs(nowMs, 2))
  })

  test('revoking closes it immediately and the next request asks again', async () => {
    const h = harness()
    await openWindow(h)
    h.dispatchCalls.length = 0

    const closed = await h.service.revokeWindow()

    expect(closed).toBe(1)
    expect(h.service.windowStatus().open).toBe(false)
    const res = await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    expect(res.status).toBe('pending_approval')
    expect(h.dispatchCalls).toEqual([])
  })

  test('revoking nothing reports nothing, and never touches a lapsed row', async () => {
    const h = harness()
    expect(await h.service.revokeWindow()).toBe(0)

    await openWindow(h, 1)
    nowMs += 1 * HOUR_MS + 1_000
    // A window that ended on its own clock was not taken back; relabelling it
    // would rewrite the record of a permission the owner never revoked.
    expect(await h.service.revokeWindow()).toBe(0)
    expect(windowRows()[0]!.status).toBe('approved')
  })

  test('a second revoke of the same window closes zero — the claim is atomic', async () => {
    const h = harness()
    await openWindow(h)

    expect(await h.service.revokeWindow()).toBe(1)
    expect(await h.service.revokeWindow()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the pure helpers', () => {
  test('validateWindowHours accepts the range and names it on refusal', () => {
    expect(validateWindowHours(1)).toEqual({ hours: 1 })
    expect(validateWindowHours(HOST_DEPLOY_WINDOW_MAX_HOURS)).toEqual({
      hours: HOST_DEPLOY_WINDOW_MAX_HOURS,
    })
    for (const bad of [0, -3, 73, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4', null, undefined]) {
      expect(validateWindowHours(bad)).toHaveProperty('reason')
    }
  })

  test('describeRemaining rounds DOWN so it can never overstate the permission', () => {
    expect(describeRemaining(nowMs + 3 * HOUR_MS + 59 * 60_000, nowMs)).toBe('3 hours')
    expect(describeRemaining(nowMs + 26 * HOUR_MS, nowMs)).toBe('1 day, 2 hours')
    expect(describeRemaining(nowMs + 45_000, nowMs)).toBe('0 minutes')
    expect(describeRemaining(nowMs - 1, nowMs)).toBe('now')
  })

  test('pickLiveWindow takes the LATEST expiry among live rows', () => {
    const row = (id: string, expires: number, status: ApprovalRow['status'] = 'approved'): ApprovalRow => ({
      id,
      project_slug: PROJECT,
      topic_id: TOPIC,
      tool_name: HOST_DEPLOY_WINDOW_TOOL_NAME,
      args_json: JSON.stringify({ ref: 'origin/main', hours: 1, expires_at_ms: expires }),
      status,
      requested_at: nowMs / 1000,
      decided_at: nowMs / 1000,
      decided_by: OWNER,
    })
    const picked = pickLiveWindow(
      [row('a', nowMs + HOUR_MS), row('b', nowMs + 5 * HOUR_MS), row('c', nowMs + 9 * HOUR_MS, 'expired')],
      'origin/main',
      nowMs,
    )
    expect(picked?.id).toBe('b')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the two token namespaces do not cross', () => {
  test('a window token never reaches the single-deploy path, and vice versa', async () => {
    const h = harness()
    // A single-deploy grant, then a window grant, both live.
    await h.service.request({ ref: 'origin/main', topic_id: TOPIC })
    await settle()
    const deploy_approve = h.approveValue()
    await h.service.requestWindow({ hours: 4, topic_id: TOPIC })
    await settle()
    const window_approve = h.approveValue()

    expect(deploy_approve.startsWith('hdp:')).toBe(true)
    expect(window_approve.startsWith('hdw:')).toBe(true)

    // Tapping the WINDOW token must open a window, not deploy the pinned sha.
    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: window_approve,
      topic_id: TOPIC,
      prior_option_values: [deploy_approve, window_approve],
    })
    expect(out?.body).toContain('Deploy window open')
    expect(h.service.windowStatus().open).toBe(true)
  })

  test('a MOVED ref still deploys under a window — that is the point of it', async () => {
    // The single-deploy grant dies when the ref moves (its whole design). A
    // window is deliberately NOT bound to a sha, so the same movement is fine.
    const h = harness({ target: MOVED_SHA })
    await openWindow(h)

    expect(h.dispatchCalls).toHaveLength(1)
    expect(h.dispatchCalls[0]!.sha).toBe(MOVED_SHA)
  })
})
