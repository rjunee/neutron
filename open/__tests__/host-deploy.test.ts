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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { uuidToToken } from '@neutronai/reminders/index.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ApprovalManager, type ApprovalRow } from '@neutronai/tools/approval.ts'

import {
  createHostDeployService,
  renderHostDeployApprovalBody,
  resolveHostDeployConfig,
  sanitizeCommitSubject,
  scrubHostDeploySecrets,
  HOST_DEPLOY_APPROVAL_TOOL_NAME,
  HOST_DEPLOY_APPROVAL_TTL_MS,
  HOST_DEPLOY_MIN_SECRET_CHARS,
  HOST_DEPLOY_TOKEN_SERVICE,
  HOST_DEPLOY_URL_SERVICE,
  HOST_DEPLOY_VALUE_RE,
  type HostDeployCommit,
  type HostDeployDispatchInput,
  type HostDeployDispatchResult,
  type HostDeployEmit,
  type HostDeployGit,
  type HostDeployRequestResult,
  type HostDeployService,
  isDispatchTimeout,
} from '../host-deploy.ts'
import { createHostDeployRemoteGit } from '../host-deploy-runtime.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const OWNER = 'owner'
const AGENT = 'agent-7'
const PROJECT = 'owner'
const TOPIC = 'app:owner'

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TARGET_SHA = 'ff00112233445566778899aabbccddeeff001122'
const MOVED_SHA = '99887766554433221100ffeeddccbbaa99887766'

const URL = 'https://control.example.test/v1/deploy'
const TOKEN = 'hdp-secret-token-9f3a2b1c8d7e6f5a4b3c2d1e'

/** Fixed option values for tests that call `renderHostDeployApprovalBody` directly. */
const APPROVE_VALUE = 'hdp:AAAAAAAAAAAAAAAAAAAAAA:a'
const DENY_VALUE = 'hdp:AAAAAAAAAAAAAAAAAAAAAA:d'

let tmp: string
let db: ProjectDb
let approvals: ApprovalManager
/** Injectable clock so the TTL-expiry ("timeout") path runs without sleeping. */
let nowMs: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-host-deploy-'))
  db = openMigratedDbAt(join(tmp, 'project.db'))
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
  /** Commits in the REVERSE range (`target..current`) — a rollback's content. */
  reverseCommits?: HostDeployCommit[]
  /**
   * When set, EVERY `revParse` awaits it first. The concurrency tests park two
   * taps inside this await, which is the exact window the TOCTOU lived in.
   */
  gate?: Promise<void> | null
}

function fakeGit(state: GitState): HostDeployGit {
  const revParse = async (ref: string): Promise<string | null> => {
      if (state.gate != null) await state.gate
      if (state.throwOn === ref) throw new Error(`git blew up on ${ref}`)
      if (ref === 'HEAD') return state.head
      return state.refs[ref] ?? null
  }
  return {
    revParse,
    resolveTarget: revParse,
    commitsBetween: async (from, _to, limit) => {
      // Direction matters: `current..target` is what would LAND, `target..current`
      // is what a rollback would REMOVE. A stub that answered both the same way
      // could not tell the rollback rendering apart from the forward one.
      const reverse = from !== state.head
      const list = reverse ? (state.reverseCommits ?? []) : state.commits
      return {
        commits: list.slice(0, limit),
        total: reverse ? list.length : (state.total ?? state.commits.length),
      }
    },
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
    values?: { url?: string; token?: string }
    dispatch?: (i: HostDeployDispatchInput) => Promise<HostDeployDispatchResult>
    emitThrows?: boolean
    /** Mutable so a test can move the stored values BETWEEN calls. */
    valuesRef?: { current: { url?: string; token?: string } }
    /** Share the suite's logical clock so the grant-age gate is testable. */
    now?: () => number
  } = {},
): Harness {
  const emits: HostDeployEmit[] = []
  const dispatchCalls: HostDeployDispatchInput[] = []
  const logs: string[] = []
  const valuesRef = opts.valuesRef ?? {
    current: opts.values ?? { url: URL, token: TOKEN },
  }
  const service = createHostDeployService({
    approvals,
    git: opts.git ?? fakeGit({ head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS }),
    resolveConfig: () => resolveHostDeployConfig(valuesRef.current),
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
    now: opts.now ?? (() => nowMs),
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
  test('a remote ahead of the host pin is never reported as up to date', async () => {
    // THE #245 REGRESSION, now split across the boundary. Resolving a remote ref
    // is the CONTROL PLANE's job — it is the only side that may write the
    // `FETCH_HEAD` a fetch produces — so the half that proves a real fetch beats a
    // stale local mirror lives with the git, in Managed's `deploy-preview` suite.
    //
    // What remains OURS, and is asserted here, is that a control plane reporting a
    // target ahead of the pin is never flattened into `up_to_date` on the way
    // through this service.
    const g = createHostDeployRemoteGit({
      resolveConfig: () => ({
        configured: true,
        endpoint: { url: 'https://control.example.com/v1/deploy', token: 'tok' },
      }),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const json =
          typeof body['from'] === 'string'
            ? { commits: [{ sha: TARGET_SHA, subject: 'fix: remote release' }], total: 1 }
            : { target_sha: TARGET_SHA, current_sha: HEAD_SHA, commits: [], total: 0 }
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const h = harness({ git: g })
    const result = await h.service.request({ ref: 'origin/main' })

    expect(TARGET_SHA).not.toBe(HEAD_SHA)
    expect(result.status).not.toBe('up_to_date')
    expect(result).toMatchObject({
      status: 'pending_approval',
      target_sha: TARGET_SHA,
      current_sha: HEAD_SHA,
    })
    expect(h.emits[0]!.body).toContain('fix: remote release')
  })

  test('the target consults its remote-aware resolver and the current pin does not', async () => {
    const calls: string[] = []
    const git = fakeGit({ head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS })
    const h = harness({
      git: {
        resolveTarget: async (ref) => {
          calls.push(`remote:${ref}`)
          return git.resolveTarget(ref)
        },
        revParse: async (ref) => {
          calls.push(`local:${ref}`)
          return git.revParse(ref)
        },
        commitsBetween: git.commitsBetween,
      },
    })

    expect((await h.service.request({ ref: 'origin/main' })).status).toBe('pending_approval')
    expect(calls).toEqual(['remote:origin/main', 'local:HEAD'])
  })

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
describe('the button is raised WHERE the deploy was asked for', () => {
  // 2026-08-15: the owner asked for a host deploy from `app:owner:neutron-open`,
  // was told an Approve button was waiting, and there was none — the prompt had
  // been posted to General, the ONE topic the service captured at composition
  // time. `TOPIC` here is that install fallback; the requesting topic is the
  // destination now.
  const PROJECT_TOPIC = 'app:owner:neutron-open'

  test('a request from a project topic raises its prompt on THAT topic', async () => {
    const h = harness()
    const result = await h.service.request({ ref: 'origin/main', topic_id: PROJECT_TOPIC })
    await settle()

    // TWO INDEPENDENT SEAMS, asserted separately on purpose: the grant row and
    // the tappable prompt are written by different calls, and re-hard-coding
    // EITHER one back to the owner topic has to turn this test red on its own.
    const pending = approvals.listPending(PROJECT)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.topic_id).toBe(PROJECT_TOPIC)

    expect(h.emits).toHaveLength(1)
    expect(h.emits[0]!.topic_id).toBe(PROJECT_TOPIC)

    // …and neither is the fallback.
    expect(pending[0]!.topic_id).not.toBe(TOPIC)
    expect(h.emits[0]!.topic_id).not.toBe(TOPIC)

    // The result NAMES the destination, so the agent can never say "a button is
    // waiting" without saying where. No note: it landed where it was asked for.
    expect(result).toMatchObject({
      status: 'pending_approval',
      approval_topic_id: PROJECT_TOPIC,
    })
    expect((result as { note?: string }).note).toBeUndefined()
  })

  test('no calling topic → the install fallback, and the result SAYS so', async () => {
    for (const input of [{ ref: 'origin/main' }, { ref: 'origin/main', topic_id: null }]) {
      const h = harness()
      const result = await h.service.request(input)
      await settle()

      const pending = approvals.listPending(PROJECT)
      expect(pending[pending.length - 1]!.topic_id).toBe(TOPIC)
      expect(h.emits[0]!.topic_id).toBe(TOPIC)

      // A cron/system caller has no conversation to post into, so the prompt
      // goes to the owner's General topic — which is only acceptable because
      // the result says which topic that is.
      const note = (result as { note?: string }).note ?? ''
      expect(result).toMatchObject({ status: 'pending_approval', approval_topic_id: TOPIC })
      expect(note).toContain(TOPIC)
      expect(note.length).toBeGreaterThan(0)
    }
  })

  test('an empty-string topic is not a topic — it falls back', async () => {
    const h = harness()
    const result = await h.service.request({ topic_id: '' })
    await settle()
    expect(h.emits[0]!.topic_id).toBe(TOPIC)
    expect(approvals.listPending(PROJECT)[0]!.topic_id).toBe(TOPIC)
    expect(result).toMatchObject({ approval_topic_id: TOPIC })
  })

  test('the tap resolves on the topic that carries the prompt — no second mechanism', async () => {
    // The capture seam windows on the tap's OWN topic, so raising the prompt on
    // the requesting topic is enough for Approve to work there.
    const h = harness()
    await h.service.request({ topic_id: PROJECT_TOPIC })
    await settle()
    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: h.approveValue(),
      topic_id: PROJECT_TOPIC,
      prior_option_values: h.options(),
    })
    expect(out).not.toBeNull()
    expect(h.dispatchCalls).toHaveLength(1)
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

  test('the typed fallback in the body is the SAME string the buttons carry — no drift', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    const emit = h.emits[0]!
    expect(emit.body).toContain(emit.options[0]!.value)
    expect(emit.body).toContain(emit.options[1]!.value)
    expect(emit.body).not.toContain('Typing anything else will NOT approve this deploy')
  })

  test('the approve string printed in the body actually approves, end to end', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    const emit = h.emits[0]!
    const m = emit.body.match(/hdp:[A-Za-z0-9_-]{22}:a/)
    expect(m).not.toBeNull()

    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: m![0],
      topic_id: emit.topic_id,
      prior_option_values: emit.options.map((o) => o.value),
    })
    expect(h.dispatchCalls).toHaveLength(1)
    expect(out!.body).toContain('Deploy requested')
  })

  test('the typed fallback appears after the binding sentence, and the fence still holds', async () => {
    const h = harness()
    await h.service.request({})
    const body = h.emits[0]!.body

    const boundIdx = body.indexOf('This approval is bound to')
    const fallbackIdx = body.indexOf('type one of these exact lines instead')
    expect(boundIdx).toBeGreaterThan(-1)
    expect(fallbackIdx).toBeGreaterThan(boundIdx)

    // The commit list still renders inside a fence.
    expect(body).toContain('```')
  })

  test('an over-cap range counts the remainder instead of silently truncating', () => {
    const body = renderHostDeployApprovalBody({
      ref: 'origin/main',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: COMMITS.slice(0, 2),
      total: 57,
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
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
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
    })
    expect(body).toContain('SIDEWAYS or BACKWARD')
    expect(body).toContain('(no new commits)')
  })

  test('a ROLLBACK itemizes the commits it would take away, not an empty block', async () => {
    // Argus r1 minor: `current..target` is empty for a rollback, so the owner was
    // shown a warning above a blank fence and asked to approve the removal of N
    // commits sight-unseen. The content of a rollback IS the reverse range.
    const h = harness({
      git: fakeGit({
        head: HEAD_SHA,
        refs: { 'v1.2.3': TARGET_SHA },
        commits: [],
        reverseCommits: COMMITS,
      }),
    })
    const result = await h.service.request({ ref: 'v1.2.3' })
    expect(result.status).toBe('pending_approval')

    const body = h.emits[0]!.body
    expect(body).toContain('SIDEWAYS or BACKWARD')
    expect(body).toContain('3 commits the host is running now would be ROLLED BACK:')
    // CONTENT, not merely a count — every subject the owner is giving up.
    for (const c of COMMITS) {
      expect(body).toContain(c.sha.slice(0, 8))
      expect(body).toContain(c.subject)
    }
  })

  test('a forward deploy does NOT grow a rollback section', () => {
    // The negative control for the test above: the section is conditional, so its
    // presence up there is a real answer about direction.
    const body = renderHostDeployApprovalBody({
      ref: 'origin/main',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: COMMITS,
      total: 3,
      removed: COMMITS,
      removed_total: 3,
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
    })
    expect(body).toContain('3 commits would land:')
    expect(body).not.toContain('ROLLED BACK')
  })

  test('two shas with no commits either way say exactly that', () => {
    const body = renderHostDeployApprovalBody({
      ref: 'v1.2.3',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: [],
      total: 0,
      removed: [],
      removed_total: 0,
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
    })
    expect(body).toContain('Nothing would be rolled back either')
  })

  test('a commit subject cannot hide itself behind a carriage return', () => {
    // CR is the classic line-overwrite payload: a renderer that honours it shows
    // only the text after the CR, so `ok\rDEPLOYING NOTHING AT ALL` reads as a
    // reassurance while a real commit lands. The sanitizer used to pass it
    // through untouched (Argus r1 minor).
    const hostile = 'ok\rDEPLOYING NOTHING AT ALL, totally safe'
    const cleaned = sanitizeCommitSubject(hostile)
    expect(cleaned).not.toContain('\r')
    // POSITIVE half: the text is not deleted, only the control character — the
    // owner still sees BOTH halves and can tell something odd was attempted.
    expect(cleaned).toBe('okDEPLOYING NOTHING AT ALL, totally safe')

    // …and a newline cannot forge an extra line inside the fenced list.
    expect(sanitizeCommitSubject('ok\nff00112233  fix: not a real commit')).toBe(
      'okff00112233  fix: not a real commit',
    )
    // TAB is kept: it hides nothing and is legitimate in a subject.
    expect(sanitizeCommitSubject('fix:\tspacing')).toBe('fix:\tspacing')

    const body = renderHostDeployApprovalBody({
      ref: 'origin/main',
      current_sha: HEAD_SHA,
      target_sha: TARGET_SHA,
      commits: [{ sha: COMMITS[0]!.sha, subject: hostile }],
      total: 1,
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
    })
    expect(body).not.toContain('\r')
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
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
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
      approve_value: APPROVE_VALUE,
      deny_value: DENY_VALUE,
    })
    // The fence must be LONGER than the longest backtick run inside it.
    expect(body).toContain('````')
  })

  test('the request is REFUSED when the commit list cannot be built', async () => {
    const git = fakeGit({ head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS })
    const h = harness({
      git: {
        revParse: git.revParse,
        resolveTarget: git.resolveTarget,
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
    const oldApprove = h.approveValue()

    // Three more commits land upstream while the prompt sits in the chat.
    state.refs['origin/main'] = MOVED_SHA

    const out = await answer(h, oldApprove)
    expect(out).not.toBeNull()
    // NOTHING deployed.
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('Stale approval')
    expect(out!.body).toContain('nothing was deployed')
    // It NAMES the new sha, and the one that was actually approved.
    expect(out!.body).toContain(MOVED_SHA.slice(0, 8))
    expect(out!.body).toContain(TARGET_SHA.slice(0, 8))

    // …and it is not a dead end: a REPLACEMENT approval, bound to the NEW sha,
    // is raised on the topic the owner just tapped in.
    await settle()
    expect(h.emits).toHaveLength(2)
    expect(h.emits[1]!.topic_id).toBe(TOPIC)
    expect(h.emits[1]!.body).toContain(MOVED_SHA.slice(0, 8))

    // And the stale grant is dead — a second tap on the OLD button cannot replay
    // it, and points at the waiting prompt rather than raising a third one.
    const again = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: oldApprove,
      topic_id: TOPIC,
      prior_option_values: [oldApprove, ...h.options()],
    })
    expect(h.dispatchCalls).toEqual([])
    expect(again!.body).toContain('already waiting')
    expect(h.emits).toHaveLength(2)
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

  test('an EVICTED token gets a sentence and a fresh prompt, not silence', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const evicted = h.approveValue()
    const row_id = approvals.findByToolName(PROJECT, HOST_DEPLOY_APPROVAL_TOOL_NAME)[0]!.id

    // Four further prompts on the topic have pushed this one out of the answer
    // window: the value is real, the grant is pending, but membership fails.
    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: evicted,
      topic_id: TOPIC,
      prior_option_values: ['rap:AAAAAAAAAAAAAAAAAAAAAA:a'],
    })
    await settle()
    // Not null, and nothing deployed.
    expect(out).not.toBeNull()
    expect(out!.body).toContain('answer window')
    expect(h.dispatchCalls).toEqual([])
    // The unanswerable grant is retired and a replacement raised where he typed.
    expect(approvals.get(row_id)!.status).not.toBe('pending')
    expect(h.emits).toHaveLength(2)
    expect(h.emits[1]!.topic_id).toBe(TOPIC)
  })

  test('a forged hdp token that maps to no row gets a sentence, not a re-raise', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const forged = `hdp:${uuidToToken(crypto.randomUUID())}:a`

    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: forged,
      topic_id: TOPIC,
      prior_option_values: [],
    })
    await settle()
    expect(out!.body).toContain('no longer valid')
    expect(h.dispatchCalls).toEqual([])
    // A token that was never a grant raises nothing.
    expect(h.emits).toHaveLength(1)
  })

  test('an evicted tap when a fresh grant already waits points at it instead of raising a third', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const first = h.approveValue()
    await h.service.request({})
    await settle()
    expect(h.emits).toHaveLength(2)

    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: first,
      topic_id: TOPIC,
      prior_option_values: [],
    })
    await settle()
    expect(out!.body).toContain('already waiting')
    expect(h.emits).toHaveLength(2)
    expect(h.dispatchCalls).toEqual([])
  })

  test('an evicted tap on an already-approved row says the deploy went out', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const approve = h.approveValue()

    await answer(h, approve)
    expect(h.dispatchCalls).toHaveLength(1)

    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approve,
      topic_id: TOPIC,
      prior_option_values: [],
    })
    await settle()
    expect(out!.body).toContain('already approved')
    expect(out!.body).toContain('already went out')
    expect(h.dispatchCalls).toHaveLength(1)
  })

  test('a second evicted tap on the same token re-raises exactly once', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const evicted = h.approveValue()

    const tap = () =>
      h.service.handleOwnerButtonAnswer({
        user_id: OWNER,
        user_text: evicted,
        topic_id: TOPIC,
        prior_option_values: [],
      })

    const first = await tap()
    await settle()
    expect(first!.body).toContain('answer window')
    expect(h.emits).toHaveLength(2)

    // `cancelPending` is the claim: the second tap finds the row already
    // retired, so it raises nothing and reads the settled status instead.
    const second = await tap()
    await settle()
    expect(second!.body).toContain('nothing was deployed')
    expect(second!.body).toContain('already waiting')
    expect(h.emits).toHaveLength(2)
    expect(h.dispatchCalls).toEqual([])
  })

  test('an evicted Deny token also gets the sentence and deploys/declines nothing', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    const out = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: h.denyValue(),
      topic_id: TOPIC,
      prior_option_values: [],
    })
    await settle()
    expect(out).not.toBeNull()
    expect(out!.body).toContain('nothing was deployed')
    // Decision-neutral: an evicted tap decided nothing, in either direction.
    expect(out!.body).not.toContain('declined')
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
    expect(out!.body).toContain('expired')
    // Not silence, and not a dead end either: the swept grant answers with a
    // sentence AND a fresh prompt the owner can actually tap.
    expect(out!.body).toContain('fresh approval')
    await settle()
    expect(h.emits).toHaveLength(2)
    expect(h.dispatchCalls).toEqual([])
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
    const h = harness({ values: {} })
    const s = h.service.status()
    expect(s.enabled).toBe(false)
    expect(s.default_ref).toBe('origin/main')
    // Assert the REASON, not merely the flag.
    expect(s.reason).toContain('No host-deploy endpoint is configured on this instance')
    expect(s.reason).toContain(HOST_DEPLOY_URL_SERVICE)
    expect(s.reason).toContain(HOST_DEPLOY_TOKEN_SERVICE)
    expect(s.reason).toContain('A self-hosted box has no endpoint to call')
  })

  test('request() refuses with that same reason and mints no approval', async () => {
    const h = harness({ values: {} })
    const result = await h.service.request({})
    expect(result.status).toBe('unavailable')
    expect(result).toHaveProperty('reason')
    expect((result as { reason: string }).reason).toContain(HOST_DEPLOY_URL_SERVICE)
    expect(h.emits).toEqual([])
    expect(h.dispatchCalls).toEqual([])
    await settle()
    expect(approvals.listPending(PROJECT)).toEqual([])
  })

  test('a URL with no credential is disabled for THAT reason, not the missing-URL one', () => {
    const h = harness({ values: { url: URL } })
    const s = h.service.status()
    expect(s.enabled).toBe(false)
    expect(s.reason).toContain(`${HOST_DEPLOY_TOKEN_SERVICE} is missing`)
    expect(s.reason).not.toContain('No host-deploy endpoint is configured')
    // And the reason never leaks the endpoint it is talking about.
    expect(s.reason).not.toContain(URL)
  })

  test('a plaintext endpoint is refused — the credential rides that call', () => {
    const state = resolveHostDeployConfig({
      url: 'http://control.example.test/v1/deploy',
      token: TOKEN,
    })
    expect(state.configured).toBe(false)
    expect((state as { reason: string }).reason).toContain('must be an https:// URL')
  })

  test('there is no fabricated default endpoint', () => {
    expect(resolveHostDeployConfig({}).configured).toBe(false)
  })

  test('legacy environment values do not enable the capability', () => {
    process.env['NEUTRON_HOST_DEPLOY_URL'] = URL
    process.env['NEUTRON_HOST_DEPLOY_TOKEN'] = TOKEN
    try {
      expect(resolveHostDeployConfig({}).configured).toBe(false)
    } finally {
      delete process.env['NEUTRON_HOST_DEPLOY_URL']
      delete process.env['NEUTRON_HOST_DEPLOY_TOKEN']
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the endpoint + credential are resolved at CALL time', () => {
  test('configuration that arrives AFTER composition is picked up', async () => {
    const valuesRef = { current: {} as { url?: string; token?: string } }
    const h = harness({ valuesRef })

    // Nothing configured at "composition" — the capability says so.
    expect(h.service.status().enabled).toBe(false)
    expect((await h.service.request({})).status).toBe('unavailable')

    // The operator sets it later, without a restart.
    valuesRef.current = { url: URL, token: TOKEN }
    expect(h.service.status().enabled).toBe(true)
    expect((await h.service.request({})).status).toBe('pending_approval')
  })

  test('configuration removed between ask and approve deploys nothing, and says why', async () => {
    const valuesRef = {
      current: { url: URL, token: TOKEN } as { url?: string; token?: string },
    }
    const h = harness({ valuesRef })
    await h.service.request({})
    await settle()
    valuesRef.current = {}

    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('Approved, but nothing was deployed')
    expect(out!.body).toContain(HOST_DEPLOY_URL_SERVICE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the credential is hidden while the non-secret endpoint remains useful', () => {
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
    // Negative: the secret is gone; positive: the ordinary URL remains useful.
    expect(out!.body).not.toContain(TOKEN)
    expect(out!.body).toContain(URL)
    expect(out!.body).toContain('[redacted]')

    // Nor into any log line.
    const logs = h.logs.join('\n')
    expect(logs).toContain('host-deploy call refused')
    expect(logs).not.toContain(TOKEN)
    expect(logs).toContain(URL)
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
    expect(out!.body).toContain(URL)
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
    // At/above the floor, EVERY occurrence goes.
    const long = 'x'.repeat(HOST_DEPLOY_MIN_SECRET_CHARS)
    expect(scrubHostDeploySecrets(`aa ${long} bb ${long}`, [long])).toBe('aa [redacted] bb [redacted]')
    // One character below it, nothing is touched — which is precisely why
    // `resolveHostDeployConfig` must refuse a credential that short.
    const short = 'x'.repeat(HOST_DEPLOY_MIN_SECRET_CHARS - 1)
    expect(scrubHostDeploySecrets(`aa ${short} bb`, [short])).toBe(`aa ${short} bb`)
  })

  test('a credential too short to scrub is REFUSED as configuration, not printed', async () => {
    // Argus r1 major: the scrubber skipped values under its floor while the config
    // accepted any non-empty token, so a five-character deploy token
    // was live AND unredactable — 'Bearer hunt2' went straight into the owner's
    // chat and the log.
    const tiny = 'hunt2'
    const state = resolveHostDeployConfig({
      url: URL,
      token: tiny,
    })
    expect(state.configured).toBe(false)
    expect((state as { reason: string }).reason).toContain(
      `shorter than ${HOST_DEPLOY_MIN_SECRET_CHARS} characters`,
    )
    // The reason never quotes the value it is complaining about.
    expect((state as { reason: string }).reason).not.toContain(tiny)

    // End to end: nothing dispatches, and the token appears in no chat message
    // and no log line.
    const h = harness({
      values: { url: URL, token: tiny },
      dispatch: async () => ({ ok: false, detail: `rejected Bearer ${tiny}` }),
    })
    const result = await h.service.request({})
    expect(result.status).toBe('unavailable')
    expect(h.dispatchCalls).toEqual([])
    expect(h.emits).toEqual([])
    expect(h.logs.join('\n')).not.toContain(tiny)
    expect(JSON.stringify(result)).not.toContain(tiny)

    // POSITIVE CONTROL on the same input, one character longer: the boundary is a
    // real boundary, not a resolver that refuses everything.
    const ok = 'h'.repeat(HOST_DEPLOY_MIN_SECRET_CHARS)
    expect(
      resolveHostDeployConfig({ url: URL, token: ok }).configured,
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('two taps in the same window cannot deploy twice, or deploy after a Deny', () => {
  /**
   * The TOCTOU Argus r1 called a BLOCKER, with a repro: `handleOwnerButtonAnswer`
   * read the pending row, then AWAITED `git.revParse`, then dispatched
   * unconditionally. Two taps that interleave inside that await both saw
   * `status:'pending'` and both dispatched, because `respondApproval` reported
   * nothing about whether it had actually claimed the row.
   *
   * Both tests park calls inside that exact await via `state.gate`.
   */
  test('two simultaneous Approves dispatch EXACTLY once', async () => {
    const state: GitState = { head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS }
    const h = harness({ git: fakeGit(state) })
    await h.service.request({})
    await settle()

    let release!: () => void
    state.gate = new Promise<void>((r) => {
      release = () => r()
    })

    const first = answer(h, h.approveValue())
    const second = answer(h, h.approveValue())
    release()
    const [a, b] = await Promise.all([first, second])

    // THE assertion: one deploy, not two.
    expect(h.dispatchCalls).toHaveLength(1)
    expect(h.dispatchCalls[0]!.sha).toBe(TARGET_SHA)

    // Exactly one racer is told it deployed; the other is told, plainly, that it
    // did not — never silence, and never a second "Deploy requested".
    const bodies = [a!.body, b!.body]
    expect(bodies.filter((t) => t.includes('Deploy requested'))).toHaveLength(1)
    expect(bodies.filter((t) => t.includes('nothing was deployed a second time'))).toHaveLength(1)

    const rows = approvals.findByToolName(PROJECT, HOST_DEPLOY_APPROVAL_TOOL_NAME)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('approved')
  })

  test('a Deny that arrives AFTER the deploy went out does not claim the host stayed put', async () => {
    // The other half of the same gate. Nothing here is a safety failure — the
    // deploy already happened — but "Deploy declined. The host stays where it is"
    // in answer to a tap that declined nothing is a flat lie in the owner's
    // transcript, and the transcript is the only record he has.
    const h = harness()
    await h.service.request({})
    await settle()

    const approved = await answer(h, h.approveValue())
    expect(approved!.body).toContain('Deploy requested')
    expect(h.dispatchCalls).toHaveLength(1)

    const late = await answer(h, h.denyValue())
    expect(late!.body).not.toContain('Deploy declined')
    expect(late!.body).not.toContain('The host stays where it is')
    expect(late!.body).toContain('already approved')
    // …and it must not tell him nothing was deployed, because something was.
    expect(late!.body).not.toContain('nothing was deployed')
    expect(late!.body).toContain('the deploy already went out')
    // And the late tap neither deployed again nor rewrote the record.
    expect(h.dispatchCalls).toHaveLength(1)
    expect(approvals.findByToolName(PROJECT, HOST_DEPLOY_APPROVAL_TOOL_NAME)[0]!.status).toBe(
      'approved',
    )
  })

  test('an Approve parked behind a concurrent Deny deploys NOTHING', async () => {
    const state: GitState = { head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS }
    const h = harness({ git: fakeGit(state) })
    await h.service.request({})
    await settle()

    let release!: () => void
    state.gate = new Promise<void>((r) => {
      release = () => r()
    })

    // The Approve starts first and parks in the sha re-check…
    const approving = answer(h, h.approveValue())
    // …and while it is parked the owner taps Deny, which settles the row. (Deny
    // never re-resolves the sha, so it does not touch the gate.)
    state.gate = null
    const denied = await answer(h, h.denyValue())
    expect(denied!.body).toContain('Deploy declined')

    release()
    const approved = await approving

    // The parked Approve must NOT act on a row the Deny already claimed.
    expect(h.dispatchCalls).toEqual([])
    expect(approved!.body).toContain('nothing was deployed')
    const rows = approvals.findByToolName(PROJECT, HOST_DEPLOY_APPROVAL_TOOL_NAME)
    expect(rows[0]!.status).toBe('denied')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a grant has a lifetime of its own', () => {
  test('an approval older than the TTL is refused even though nothing swept it', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    // NOTHING calls `ApprovalManager.expireStale()` on this box — that was the
    // point of the Argus r1 minor. Roll only the clock; run no sweep. The row is
    // still literally `pending` in the table when the tap arrives.
    nowMs += HOST_DEPLOY_APPROVAL_TTL_MS + 1_000
    expect(approvals.listPending(PROJECT)).toHaveLength(1)
    const oldApprove = h.approveValue()

    const out = await answer(h, oldApprove)
    expect(h.dispatchCalls).toEqual([])
    expect(out!.body).toContain('has expired')
    // A SENTENCE AND A FRESH GRANT, not silence and not "ask again" — the owner
    // was told to tap something that had already died; making him re-ask is how a
    // 5-minute window becomes unwinnable.
    expect(out!.body).toContain('fresh approval')
    await settle()
    expect(h.emits).toHaveLength(2)
    expect(h.emits[1]!.topic_id).toBe(TOPIC)
    const fresh = h.emits[1]!.options.map((o) => o.value)
    for (const v of fresh) expect(HOST_DEPLOY_VALUE_RE.test(v)).toBe(true)
    expect(fresh).not.toContain(oldApprove)
    // The old grant is dead and EXACTLY ONE grant is waiting — the new one. A
    // re-raise never approves: nothing was dispatched.
    expect(approvals.listPending(PROJECT)).toHaveLength(1)
    const rows = approvals.findByToolName(PROJECT, HOST_DEPLOY_APPROVAL_TOOL_NAME)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.status).sort()).toEqual(['expired', 'pending'])
    expect(h.dispatchCalls).toEqual([])
  })

  test('the fresh grant from an expired tap deploys on its own tap, and only then', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    nowMs += HOST_DEPLOY_APPROVAL_TTL_MS + 1_000
    // Tapping the DEAD button re-raises. It does not deploy — that is the whole
    // difference between a re-raise and an auto-approve.
    await answer(h, h.approveValue())
    await settle()
    expect(h.dispatchCalls).toEqual([])

    // The owner taps the button he was just handed. NOW it deploys.
    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toHaveLength(1)
    expect(h.dispatchCalls[0]!.sha).toBe(TARGET_SHA)
    expect(out!.body).toContain('Deploy requested')
  })

  test('a repeat tap on the dead button points at the waiting prompt instead of raising a second one', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const oldApprove = h.approveValue()

    nowMs += HOST_DEPLOY_APPROVAL_TTL_MS + 1_000
    await answer(h, oldApprove)
    await settle()
    expect(h.emits).toHaveLength(2)

    // The dead button is still on screen; tapping it again must not mint a
    // prompt per tap.
    const again = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: oldApprove,
      topic_id: TOPIC,
      prior_option_values: [oldApprove, ...h.options()],
    })
    await settle()
    expect(again!.body).toContain('already waiting')
    expect(h.emits).toHaveLength(2)
    expect(approvals.listPending(PROJECT)).toHaveLength(1)
    expect(h.dispatchCalls).toEqual([])
  })

  test('a racing second tap on a TTL-dead grant re-raises exactly once', async () => {
    const h = harness()
    await h.service.request({})
    await settle()
    const oldApprove = h.approveValue()

    nowMs += HOST_DEPLOY_APPROVAL_TTL_MS + 1_000
    await answer(h, oldApprove)
    await settle()
    // The second tap on the SAME dead token finds the row already retired by the
    // first — `cancelPending` is the claim — so it raises nothing.
    const second = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: oldApprove,
      topic_id: TOPIC,
      prior_option_values: [oldApprove, ...h.options()],
    })
    await settle()
    expect(h.emits).toHaveLength(2)
    expect(second!.body).toContain('nothing was deployed')
    expect(h.dispatchCalls).toEqual([])
  })

  test('an expired tap when the host has caught up says nothing is left to deploy', async () => {
    const state: GitState = { head: HEAD_SHA, refs: { 'origin/main': TARGET_SHA }, commits: COMMITS }
    const h = harness({ git: fakeGit(state) })
    await h.service.request({})
    await settle()

    nowMs += HOST_DEPLOY_APPROVAL_TTL_MS + 1_000
    // Someone else deployed it in the meantime. There is nothing to re-raise, and
    // a prompt that asks the owner to approve a no-op is worse than a sentence.
    state.head = TARGET_SHA
    state.refs['origin/main'] = TARGET_SHA

    const out = await answer(h, h.approveValue())
    await settle()
    expect(out!.body).toContain('nothing is left to deploy')
    expect(h.emits).toHaveLength(1)
    expect(h.dispatchCalls).toEqual([])
  })

  test('an approval INSIDE the window still deploys — the gate is a boundary, not a wall', async () => {
    const h = harness()
    await h.service.request({})
    await settle()

    nowMs += HOST_DEPLOY_APPROVAL_TTL_MS - 1_000
    const out = await answer(h, h.approveValue())
    expect(h.dispatchCalls).toHaveLength(1)
    expect(out!.body).toContain('Deploy requested')
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
        revParse: async () => TARGET_SHA,
        resolveTarget: async (ref) => {
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

  test('a ref that is really a git OPTION never reaches git as argv', async () => {
    // Argus r1 nit: the charset guard admitted a leading `-`, so an agent-chosen
    // "ref" of `--parseopt` / `--local-env-vars` / `-h` was handed to
    // `git rev-parse` as an option and contained only incidentally, by the shape
    // check on stdout. Refuse it structurally instead.
    const seen: string[] = []
    const h = harness({
      git: {
        revParse: async () => TARGET_SHA,
        resolveTarget: async (ref) => {
          seen.push(ref)
          return TARGET_SHA
        },
        commitsBetween: async () => ({ commits: COMMITS, total: 3 }),
      },
    })
    for (const hostile of ['--parseopt', '--local-env-vars', '-h', '-']) {
      const result = await h.service.request({ ref: hostile })
      expect(result.status).toBe('refused')
      expect((result as { reason: string }).reason).toContain('not a usable git ref')
    }
    expect(seen).toEqual([])

    // POSITIVE control through the SAME stub: an ordinary ref with a `-` in the
    // middle still reaches git, so the refusals above are about the LEADING dash
    // and not about the character existing at all.
    expect((await h.service.request({ ref: 'release-2026-08' })).status).not.toBe('refused')
    expect(seen).toContain('release-2026-08')
  })

  test('an unknown ref is refused and mints nothing', async () => {
    const h = harness()
    const result = await h.service.request({ ref: 'origin/does-not-exist' })
    expect(result.status).toBe('refused')
    expect((result as { reason: string }).reason).toContain('does not know the ref')
    await settle()
    expect(approvals.listPending(PROJECT)).toEqual([])
  })

  test('a failing remote is refused in both assertions, never reported as up to date', async () => {
    const results: HostDeployRequestResult[] = []
    for (const staleLocalTarget of [HEAD_SHA, TARGET_SHA]) {
      const git = fakeGit({ head: HEAD_SHA, refs: { 'origin/main': staleLocalTarget }, commits: [] })
      git.resolveTarget = async () => {
        throw new Error('remote unreachable before timeout')
      }
      results.push(await harness({ git }).service.request({ ref: 'origin/main' }))
    }
    expect(results.map((result) => result.status)).toEqual(['refused', 'refused'])
    expect(results.every((result) => result.status !== 'up_to_date')).toBe(true)
    for (const result of results) {
      expect((result as { reason: string }).reason).toContain('remote unreachable before timeout')
    }
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

// ─────────────────────────────────────────────────────────────────────────────
/**
 * A TIMEOUT IS THE ABSENCE OF A REPORT, NOT A REPORT OF FAILURE.
 *
 * The client waited 30s for an operation that takes minutes, so the timer
 * expired on every real deploy — and the message it produced told the owner
 * "Nothing was deployed; ask again to retry". On 2026-08-15 he was shown exactly
 * that at 00:34 for a deploy that completed 55 seconds later. Re-approving would
 * have restarted his instance a second time.
 */
describe('a dispatch TIMEOUT never claims nothing happened', () => {
  const timeoutErr = (): Error => {
    // What `AbortSignal.timeout()` actually rejects with.
    const e = new Error('The operation timed out.')
    e.name = 'TimeoutError'
    return e
  }

  test('it does NOT say nothing was deployed', async () => {
    const h = harness({
      dispatch: async () => {
        throw timeoutErr()
      },
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())
    expect(out).not.toBeNull()
    expect(out!.body).not.toContain('Nothing was deployed')
  })

  test('it does NOT invite a blind retry of an instance-restarting action', async () => {
    const h = harness({
      dispatch: async () => {
        throw timeoutErr()
      },
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())
    expect(out!.body).not.toContain('ask again to retry')
  })

  test('it says the deploy may still be running, and points at the status check', async () => {
    const h = harness({
      dispatch: async () => {
        throw timeoutErr()
      },
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())
    expect(out!.body).toContain('may still be running')
    expect(out!.body.toLowerCase()).toContain('status')
  })

  test('a NON-timeout dispatch failure still reports failure — the distinction is the point', async () => {
    // Connection refused really does mean nothing happened. Collapsing the two
    // cases in either direction loses information the owner needs.
    const h = harness({
      dispatch: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:7780')
      },
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())
    expect(out!.body).toContain('Nothing was deployed')
    expect(out!.body).toContain('ask again to retry')
  })

  test('a refused gate is still a refusal, not a timeout', async () => {
    // The HTTP-refusal path must be untouched by this change.
    const h = harness({
      dispatch: async () => ({ ok: false, detail: 'HTTP 500 — contract gate FAILED' }),
    })
    await h.service.request({})
    await settle()
    const out = await answer(h, h.approveValue())
    expect(out!.body).toContain('The host refused the deploy')
    expect(out!.body).not.toContain('may still be running')
  })
})

describe('isDispatchTimeout', () => {
  test('recognises the TimeoutError AbortSignal.timeout rejects with', () => {
    const e = new Error('The operation timed out.')
    e.name = 'TimeoutError'
    expect(isDispatchTimeout(e)).toBe(true)
  })

  test('matches on NAME, not on the human-facing message', () => {
    // A `.includes("timed out")` check would pass every test written against one
    // runtime and silently stop recognising a timeout on another.
    const impostor = new Error('The operation timed out.')
    impostor.name = 'Error'
    expect(isDispatchTimeout(impostor)).toBe(false)
  })

  test('an explicit AbortError is NOT a timeout — it is a cancellation', () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    expect(isDispatchTimeout(e)).toBe(false)
  })

  test('ordinary transport errors and junk are not timeouts', () => {
    expect(isDispatchTimeout(new Error('ECONNREFUSED'))).toBe(false)
    expect(isDispatchTimeout(null)).toBe(false)
    expect(isDispatchTimeout('TimeoutError')).toBe(false)
  })
})
