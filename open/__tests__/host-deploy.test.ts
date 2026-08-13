/**
 * Owner-approved host deploy — the guards, each proven by a test that would
 * fail on today's (pre-branch) code because the surface did not exist at all.
 *
 * Every assertion here is on BEHAVIOUR, not on shape: whether the one
 * authenticated control-plane call HAPPENED, and what the owner was actually
 * shown. `dispatch.calls` is the ground truth for "did anything deploy" — a
 * suite that only checked return values would pass a version of this module
 * that deploys first and asks afterwards.
 *
 * MUTATION-TESTED (each guard removed in turn, each of these goes RED):
 *   - drop the approval and dispatch inside `request()`      → "deploys NOTHING"
 *   - drop the stale-sha re-resolve in the approve path      → "stale approval"
 *   - drop the `user_id !== owner_user_id` gate              → "no self-approval"
 *   - drop the `row.status !== 'pending'` gate               → "expired timeout"
 *   - drop the `prior_option_values.includes` eligibility    → "unrelated reply"
 *   - drop the `!cfg.configured` early return in `request()` → "unavailable"
 *   - drop `scrubHostDeploySecrets` on the dispatch detail   → "no credential"
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ApprovalManager, type ApprovalRow } from '@neutronai/tools/approval.ts'

import {
  createHostDeployService,
  renderHostDeployApprovalBody,
  resolveHostDeployConfig,
  sanitizeCommitSubject,
  scrubHostDeploySecrets,
  HOST_DEPLOY_APPROVAL_TOOL_NAME,
  HOST_DEPLOY_TOKEN_ENV,
  HOST_DEPLOY_URL_ENV,
  type HostDeployCommit,
  type HostDeployDispatchInput,
  type HostDeployDispatchResult,
  type HostDeployEmit,
  type HostDeployGit,
  type HostDeployService,
} from '../host-deploy.ts'

const OWNER = 'owner'
const AGENT = 'agent-7'
const PROJECT = 'owner'
const TOPIC = 'app:owner'

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TARGET_SHA = 'ff00112233445566778899aabbccddeeff001122'
const MOVED_SHA = '99887766554433221100ffeeddccbbaa99887766'

const URL = 'https://control.example.test/v1/deploy'
const TOKEN = 'hdp-secret-token-9f3a2b1c8d7e6f5a4b3c2d1e'

let tmp: string
let db: ProjectDb
let approvals: ApprovalManager
/** Injectable clock so the TTL-expiry ("timeout") path runs without sleeping. */
let nowMs: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-host-deploy-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
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
  { sha: 'ff00112233445566778899aabbccddeeff001122', subject: 'fix(deploy): name the sha in the refusal' },
  { sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd', subject: 'feat(usage): one screen for every account' },
  { sha: 'bb22cc33dd44ee55ff6677889900aabbccddeeff', subject: 'chore: bump the CLI doctor cadence' },
]

interface GitState {
  head: string
  refs: Record<string, string>
  commits: HostDeployCommit[]
  total?: number
  throwOn?: string
}

function fakeGit(state: GitState): HostDeployGit {
  return {
    revParse: async (ref) => {
      if (state.throwOn === ref) throw new Error(`git blew up on ${ref}`)
      if (ref === 'HEAD') return state.head
      return state.refs[ref] ?? null
    },
    commitsBetween: async (_from, _to, limit) => ({
      commits: state.commits.slice(0, limit),
      total: state.total ?? state.commits.length,
    }),
  }
}

interface Harness {
  service: HostDeployService
  emits: HostDeployEmit[]
  dispatchCalls: HostDeployDispatchInput[]
  logs: string[]
  /** The option values of the most recent emitted prompt (the tappable set). */
  options(): string[]
  approveValue(): string
  denyValue(): string
}

function harness(
  opts: {
    git?: HostDeployGit
    env?: Record<string, string | undefined>
    dispatch?: (i: HostDeployDispatchInput) => Promise<HostDeployDispatchResult>
    emitThrows?: boolean
    /** Mutable so a test can move the environment BETWEEN calls. */
    envRef?: { current: Record<string, string | undefined> }
  } = {},
): Harness {
  const emits: HostDeployEmit[] = []
  const dispatchCalls: HostDeployDispatchInput[] = []
  const logs: string[] = []
  const envRef = opts.envRef ?? {
    current: opts.env ?? { [HOST_DEPLOY_URL_ENV]: URL, [HOST_DEPLOY_TOKEN_ENV]: TOKEN },
  }
  const service = createHostDeployService({
    approvals,
    git: opts.git ?? fakeGit({ head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS }),
    resolveConfig: () => resolveHostDeployConfig(envRef.current),
    dispatch: async (i) => {
      dispatchCalls.push(i)
      if (opts.dispatch !== undefined) return opts.dispatch(i)
      return { ok: true, detail: 'queued as run 4821' }
    },
    project_slug: PROJECT,
    owner_user_id: OWNER,
    approval_topic_id: TOPIC,
    emit: async (p) => {
      if (opts.emitThrows === true) throw new Error('the socket was dead')
      emits.push(p)
    },
    log: (m) => logs.push(m),
  })
  const options = (): string[] =>
    (emits.length > 0 ? emits[emits.length - 1]!.options : []).map((o) => o.value)
  return {
    service,
    emits,
    dispatchCalls,
    logs,
    options,
    approveValue: () => options().find((v) => v.endsWith(':a')) ?? '',
    denyValue: () => options().find((v) => v.endsWith(':d')) ?? '',
  }
}

/** The exact turn shape the live-agent capture seam hands the service. */
function answer(h: Harness, user_text: string, user_id = OWNER) {
  return h.service.handleOwnerButtonAnswer({
    user_id,
    user_text,
    topic_id: TOPIC,
    prior_option_values: h.options(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('a request without an approval deploys NOTHING', () => {
  test('request() raises an approval and dispatches nothing', async () => {
    const h = harness()
    const result = await h.service.request({ ref: 'origin/main' })

    expect(result.status).toBe('pending_approval')
    // THE assertion: no call to the control plane happened.
    expect(h.dispatchCalls).toEqual([])
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0]!.body).toContain('Nothing is deployed unless you tap Approve')

    await settle()
    const pending = approvals.listPending(PROJECT)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.tool_name).toBe(HOST_DEPLOY_APPROVAL_TOOL_NAME)
    expect(pending[0]!.status).toBe('pending')
  })

  test('the tool result names the sha it would move to, and the commit count', async () => {
    const h = harness()
    const result = await h.service.request({})
    expect(result).toMatchObject({
      status: 'pending_approval',
      ref: 'origin/main',
      target_sha: TARGET_SHA,
      current_sha: HEAD_SHA,
      commit_count: 3,
    })
  })

  test('an already-deployed sha raises no approval at all', async () => {
    const h = harness({
      git: fakeGit({ head: HEAD_SHA, refs: { 'origin/main': HEAD_SHA }, commits: [] }),
    })
    const result = await h.service.request({})
    expect(result).toEqual({ status: 'up_to_date', ref: 'origin/main', target_sha: HEAD_SHA })
    expect(h.emits).toEqual([])
    await settle()
    expect(approvals.listPending(PROJECT)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the approval body carries the ACTUAL commit list', () => {
  test('every commit, the current pin and the target sha are in the body', async () => {
    const h = harness()
    await h.service.request({})
    const body = h.emits[0]!.body

    // The two pins, by short sha.
    expect(body).toContain(HEAD_SHA.slice(0, 8))
    expect(body).toContain(TARGET_SHA.slice(0, 8))
    expect(body).toContain('Now running:')
    expect(body).toContain('Would run:')
    // THE COMMIT LIST — content, not merely "a notification fired".
    expect(body).toContain('3 commits would land:')
    for (const c of COMMITS) {
      expect(body).toContain(c.sha.slice(0, 8))
      expect(body).toContain(c.subject)
    }
  })

  test('an over-cap range counts the remainder instead of silently truncating', () => {
    const body = renderHostDeployApprovalBody({
      ref: 'origin/main',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: COMMITS.slice(0, 2),
      total: 57,
    })
    expect(body).toContain('57 commits would land:')
    expect(body).toContain('… and 55 more commits')
  })

  test('a sideways/backward move says so rather than showing an empty list', () => {
    const body = renderHostDeployApprovalBody({
      ref: 'v1.2.3',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: [],
      total: 0,
    })
    expect(body).toContain('SIDEWAYS or BACKWARD')
    expect(body).toContain('(no new commits)')
  })

  test('a commit subject cannot hide itself with bidi / zero-width characters', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE + U+200B ZERO WIDTH SPACE, written as
    // escapes so this test file itself stays plain ASCII.
    const hostile = 'fix: harmless\u202Ednarg-etaerc\u200B tail'
    expect(sanitizeCommitSubject(hostile)).toBe('fix: harmlessdnarg-etaerc tail')
    const body = renderHostDeployApprovalBody({
      ref: 'origin/main',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: [{ sha: COMMITS[0]!.sha, subject: hostile }],
      total: 1,
    })
    expect(body).not.toContain('\u202E')
    expect(body).not.toContain('\u200B')
  })

  test('a commit subject cannot break out of the code fence', () => {
    const body = renderHostDeployApprovalBody({
      ref: 'origin/main',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: [{ sha: COMMITS[0]!.sha, subject: 'fix: ``` then **bold** injected' }],
      total: 1,
    })
    // The fence must be LONGER than the longest backtick run inside it.
    expect(body).toContain('````')
  })

  test('the request is REFUSED when the commit list cannot be built', async () => {
    const git = fakeGit({ head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS })
    const h = harness({
      git: {
        revParse: git.revParse,
        commitsBetween: async () => {
          throw new Error('shallow clone')
        },
      },
    })
    const result = await h.service.request({})
    expect(result.status).toBe('refused')
    expect(h.emits).toEqual([])
    await settle()
    expect(approvals.listPending(PROJECT)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the approval binds to a SPECIFIC sha', () => {
  test('a target that moved between ask and answer is refused as STALE, naming the new sha', async () => {
    const state: GitState = {
      head: HEAD_SHA,
      refs: { 'origin/main': TARGET_SHA },
      commits: COMMITS,
    }
    const h = harness({ git: fakeGit(state) })
    await h.service.request({})
    await settle()

    // Three more commits land upstream while the prompt sits in the chat.
    state.refs['origin/main'] = MOVED_SHA

    const out = await answer(h, h.approveValue())
    expect(out).not.toBeNull()
    // NOTHING deployed.
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('Stale approval')
    expect(out!.body).toContain('nothing was deployed')
    // It NAMES the new sha, and the one that was actually approved.
    expect(out!.body).toContain(MOVED_SHA.slice(0, 8))
    expect(out!.body).toContain(TARGET_SHA.slice(0, 8))

    // And the stale grant is dead — a second tap cannot replay it.
    const again = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toEqual([])
    expect(again!.body).toContain('already expired')
  })

  test('an unmoved target deploys EXACTLY the sha that was approved, once', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toHaveLength(1)
    expect(h.dispatchCalls[0]).toEqual({
      url: URL,
      token: TOKEN,
      ref: 'origin/main',
      sha: TARGET_SHA,
    })
    expect(out!.body).toContain('Deploy requested')
    expect(out!.body).toContain(TARGET_SHA.slice(0, 8))
    expect(out!.body).toContain('queued as run 4821')

    // Re-tapping a decided row never fires a second deploy.
    await answer(h, h.approveValue())
    expect(h.dispatchCalls).toHaveLength(1)
  })

  test('a ref that vanished from the checkout deploys nothing', async () => {
    const state: GitState = { head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS }
    const h = harness({ git: fakeGit(state) })
    await h.service.request({})
    await settle()
    delete state.refs['origin/main']

    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('no longer knows origin/main')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('approval is an EXPLICIT AFFIRMATIVE ACT by the owner', () => {
  test('an agent can never approve its own request', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    const out = await answer(h, h.approveValue(), AGENT)
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('Only the owner can approve a host deploy')
    // The row is untouched — the owner can still decide it.
    expect(approvals.listPending(PROJECT)).toHaveLength(1)
  })

  for (const reply of ['yes', 'sure, ship it', 'deploy it', '', 'approve']) {
    test(`an ordinary reply (${JSON.stringify(reply)}) is not an approval`, async () => {
      const h = harness()
      await h.service.request({})
      await settle()

      expect(await answer(h, reply)).toBeNull()
      expect(h.dispatchCalls).toEqual([])
      expect(approvals.listPending(PROJECT)).toHaveLength(1)
    })
  }

  test('a well-formed token that was never an offered button is not eligible', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const forged = h.approveValue()

    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: forged,
      topic_id: TOPIC,
      prior_option_values: ['rap:AAAAAAAAAAAAAAAAAAAAAA:a'],
    })
    expect(out).toBeNull()
    expect(h.dispatchCalls).toEqual([])
  })

  test('a TIMED-OUT approval is not an approval', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    // The TTL sweep is what a "timeout" is on this box — roll the clock past
    // APPROVAL_DEFAULT_TTL_MS and run the real sweep on the real manager.
    nowMs += 10 * 60_000
    expect(await approvals.expireStale()).toBe(1)

    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('already expired')
  })

  test('Deny records the decision and deploys nothing', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    const out = await answer(h, h.denyValue())
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('Deploy declined')
    const rows = approvals.findByToolName(PROJECT, HOST_DEPLOY_APPROVAL_TOOL_NAME)
    expect(rows[0]!.status).toBe('denied')
    expect(rows[0]!.decided_by).toBe(OWNER)
  })

  test("a ritual approval token is not this service's business", async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: 'rap:AAAAAAAAAAAAAAAAAAAAAA:a',
      topic_id: TOPIC,
      prior_option_values: ['rap:AAAAAAAAAAAAAAAAAAAAAA:a'],
    })
    expect(out).toBeNull()
    expect(h.dispatchCalls).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('no control plane configured → VISIBLE and DISABLED with a reason', () => {
  test('status() is answerable and names what would enable it', () => {
    const h = harness({ env: {} })
    const s = h.service.status()
    expect(s.enabled).toBe(false)
    expect(s.default_ref).toBe('origin/main')
    // Assert the REASON, not merely the flag.
    expect(s.reason).toContain('No host-deploy endpoint is configured on this instance')
    expect(s.reason).toContain(HOST_DEPLOY_URL_ENV)
    expect(s.reason).toContain(HOST_DEPLOY_TOKEN_ENV)
    expect(s.reason).toContain('A self-hosted box has no endpoint to call')
  })

  test('request() refuses with that same reason and mints no approval', async () => {
    const h = harness({ env: {} })
    const result = await h.service.request({})
    expect(result.status).toBe('unavailable')
    expect(result).toHaveProperty('reason')
    expect((result as { reason: string }).reason).toContain(HOST_DEPLOY_URL_ENV)
    expect(h.emits).toEqual([])
    expect(h.dispatchCalls).toEqual([])
    await settle()
    expect(approvals.listPending(PROJECT)).toEqual([])
  })

  test('a URL with no credential is disabled for THAT reason, not the missing-URL one', () => {
    const h = harness({ env: { [HOST_DEPLOY_URL_ENV]: URL } })
    const s = h.service.status()
    expect(s.enabled).toBe(false)
    expect(s.reason).toContain(`${HOST_DEPLOY_TOKEN_ENV} is empty`)
    expect(s.reason).not.toContain('No host-deploy endpoint is configured')
    // And the reason never leaks the endpoint it is talking about.
    expect(s.reason).not.toContain(URL)
  })

  test('a plaintext endpoint is refused — the credential rides that call', () => {
    const state = resolveHostDeployConfig({
      [HOST_DEPLOY_URL_ENV]: 'http://control.example.test/v1/deploy',
      [HOST_DEPLOY_TOKEN_ENV]: TOKEN,
    })
    expect(state.configured).toBe(false)
    expect((state as { reason: string }).reason).toContain('must be an https:// URL')
  })

  test('there is no fabricated default endpoint', () => {
    expect(resolveHostDeployConfig({}).configured).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the endpoint + credential are resolved at CALL time', () => {
  test('configuration that arrives AFTER composition is picked up', async () => {
    const envRef = { current: {} as Record<string, string | undefined> }
    const h = harness({ envRef })

    // Nothing configured at "composition" — the capability says so.
    expect(h.service.status().enabled).toBe(false)
    expect((await h.service.request({})).status).toBe('unavailable')

    // The operator sets it later, without a restart.
    envRef.current = { [HOST_DEPLOY_URL_ENV]: URL, [HOST_DEPLOY_TOKEN_ENV]: TOKEN }
    expect(h.service.status().enabled).toBe(true)
    expect((await h.service.request({})).status).toBe('pending_approval')
  })

  test('configuration removed between ask and approve deploys nothing, and says why', async () => {
    const envRef = {
      current: { [HOST_DEPLOY_URL_ENV]: URL, [HOST_DEPLOY_TOKEN_ENV]: TOKEN } as Record<
        string,
        string | undefined
      >,
    }
    const h = harness({ envRef })
    await h.service.request({})
    await settle()
    envRef.current = {}

    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('Approved, but nothing was deployed')
    expect(out!.body).toContain(HOST_DEPLOY_URL_ENV)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('no credential or endpoint appears in a prompt, a log line, or a chat message', () => {
  test('a control plane that echoes its own Authorization header cannot leak it', async () => {
    const h = harness({
      dispatch: async () => ({
        // The POSITIVE case: a real, useful error the owner must still see —
        // constructed so an absent scrub would show 'boom' AND the secrets, and
        // an over-eager scrub would lose 'boom'. Both directions can fail.
        ok: false,
        detail: `boom: upstream ${URL} rejected Bearer ${TOKEN}`,
      }),
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())

    // Positive: the owner is told what actually went wrong.
    expect(out!.body).toContain('boom')
    expect(out!.body).toContain('upstream')
    // Negative: neither secret survived into the chat message.
    expect(out!.body).not.toContain(TOKEN)
    expect(out!.body).not.toContain(URL)
    expect(out!.body).toContain('[redacted]')

    // Nor into any log line.
    const logs = h.logs.join('\n')
    expect(logs).toContain('host-deploy call refused')
    expect(logs).not.toContain(TOKEN)
    expect(logs).not.toContain(URL)
  })

  test('a thrown transport error is scrubbed the same way', async () => {
    const h = harness({
      dispatch: async () => {
        throw new Error(`connect ECONNREFUSED for ${URL} (bearer ${TOKEN})`)
      },
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())
    expect(out!.body).toContain('ECONNREFUSED')
    expect(out!.body).not.toContain(TOKEN)
    expect(out!.body).not.toContain(URL)
  })

  test('the approval prompt, its persisted args and its notifier line carry no secrets', async () => {
    const notified: ApprovalRow[] = []
    approvals = new ApprovalManager(db, { notify: async (row) => void notified.push(row) })
    const h = harness()
    await h.service.request({})
    await settle()

    expect(h.emits[0]!.body).not.toContain(TOKEN)
    expect(h.emits[0]!.body).not.toContain(URL)
    // Positive control: the prompt DOES carry the thing it is supposed to.
    expect(h.emits[0]!.body).toContain(TARGET_SHA.slice(0, 8))

    const row = approvals.listPending(PROJECT)[0]!
    expect(row.args_json).not.toContain(TOKEN)
    expect(row.args_json).not.toContain(URL)
    expect(row.args_json).toContain(TARGET_SHA)

    expect(notified).toHaveLength(1)
    expect(notified[0]!.args_json).not.toContain(TOKEN)

    const logs = h.logs.join('\n')
    expect(logs).toContain('host-deploy pending_approval')
    expect(logs).not.toContain(TOKEN)
    expect(logs).not.toContain(URL)
  })

  test('scrubHostDeploySecrets leaves short/empty values alone', () => {
    expect(scrubHostDeploySecrets('a b c', ['a', ''])).toBe('a b c')
    expect(scrubHostDeploySecrets('xx secretvalue yy secretvalue', ['secretvalue'])).toBe(
      'xx [redacted] yy [redacted]',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a refused contract gate is a NORMAL outcome', () => {
  test('the host saying no reads as one sentence, not a crash', async () => {
    const h = harness({
      dispatch: async () => ({ ok: false, detail: 'HTTP 409 — the deploy window is closed until 06:00' }),
    })
    await h.service.request({})
    await settle()

    const out = await answer(h, h.approveValue())
    expect(out).not.toBeNull()
    expect(out!.body).toContain('The host refused the deploy')
    expect(out!.body).toContain('the deploy window is closed until 06:00')
    expect(out!.body).toContain('Nothing was deployed')
    expect(out!.body).not.toContain('Error')
    expect(out!.body).not.toContain('stack')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('input + failure handling', () => {
  test('a hostile ref is refused before it reaches git', async () => {
    const seen: string[] = []
    const h = harness({
      git: {
        revParse: async (ref) => {
          seen.push(ref)
          return TARGET_SHA
        },
        commitsBetween: async () => ({ commits: COMMITS, total: 3 }),
      },
    })
    const result = await h.service.request({ ref: 'main; rm -rf ~' })
    expect(result.status).toBe('refused')
    expect(seen).toEqual([])
  })

  test('an unknown ref is refused and mints nothing', async () => {
    const h = harness()
    const result = await h.service.request({ ref: 'origin/does-not-exist' })
    expect(result.status).toBe('refused')
    expect((result as { reason: string }).reason).toContain('does not know the ref')
    await settle()
    expect(approvals.listPending(PROJECT)).toEqual([])
  })

  test('a failed prompt emission cancels the grant so the owner can just ask again', async () => {
    const h = harness({ emitThrows: true })
    const result = await h.service.request({})
    expect(result.status).toBe('refused')
    expect((result as { reason: string }).reason).toContain('ask again')
    await settle()
    // No orphan pending grant lingering until the TTL sweep.
    expect(approvals.listPending(PROJECT)).toEqual([])
  })
})
