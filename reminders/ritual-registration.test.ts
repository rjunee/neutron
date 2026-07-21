/**
 * Plan task 8 — the agent-callable ritual REGISTRATION service + the in-chat
 * approval gate. The security lives in the GATE, so these tests are adversarial:
 * the headline is T8 — an unrelated owner reply can NEVER flip the approval row.
 *
 * REAL `ApprovalManager` + `ReminderStore` over a migrated temp `project.db`
 * (bundled-rituals.test.ts precedent); the injected `emit` persists to a REAL
 * `ButtonStore` so a resolve() can simulate the freeform-attach the app-ws path
 * would do on a tapped/typed reply.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  buildButtonPrompt,
  VALUE_BYTE_CAP,
  type ButtonOption,
} from '@neutronai/channels/button-primitive.ts'
import { ApprovalManager, type ApprovalNotifier } from '@neutronai/tools/approval.ts'

import { ReminderStore } from './store.ts'
import { createRitualRegistry, validateRitualFire, RITUAL_MODEL_TIER, RITUAL_TIMEOUT_MS } from './rituals.ts'
import {
  computeRitualContentHash,
  createRitualApprovalCheck,
  ritualApprovalToolName,
  ritualEgressApprovalToolName,
} from './ritual-approval.ts'
import {
  createRitualRegistrationService,
  loadPersistedRitualDefs,
  RITUAL_APPROVAL_VALUE_RE,
  RITUAL_PROPOSAL_MAX_PROMPT_BYTES,
  renderRitualApprovalBody,
  tokenToUuid,
  uuidToToken,
  type RitualProposalInput,
  type RitualRegistrationService,
} from './ritual-registration.ts'

const SLUG = 'owner-1'
const OWNER = 'owner-user-1'
const TOPIC = 'app:owner-user-1'

let tmp: string
let db: ProjectDb
let rituals_dir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-reg-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  rituals_dir = join(tmp, 'rituals')
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* some tests close under test */
  }
  rmSync(tmp, { recursive: true, force: true })
})

const noopNotifier: ApprovalNotifier = { notify: async (): Promise<void> => undefined }
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 15))

interface EmittedPrompt {
  body: string
  options: ButtonOption[]
  idempotency_key: string
  metadata: Record<string, unknown>
  prompt_id: string
}

interface Harness {
  registry: ReturnType<typeof createRitualRegistry>
  approvals: ApprovalManager
  store: ReminderStore
  buttonStore: ButtonStore
  service: RitualRegistrationService
  emitted: EmittedPrompt[]
  respondSpy: ReturnType<typeof spyOn>
  createSpy: ReturnType<typeof spyOn>
}

function makeHarness(): Harness {
  const registry = createRitualRegistry({ rituals_dir })
  const approvals = new ApprovalManager(db, noopNotifier)
  const store = new ReminderStore(db)
  const buttonStore = new ButtonStore({ db })
  const emitted: EmittedPrompt[] = []
  const respondSpy = spyOn(approvals, 'respondApproval')
  const createSpy = spyOn(store, 'create')
  const service = createRitualRegistrationService({
    registry,
    rituals_dir,
    approvals,
    store,
    project_slug: SLUG,
    owner_user_id: OWNER,
    approval_topic_id: TOPIC,
    emit: async (p) => {
      const prompt = buildButtonPrompt({
        body: p.body,
        options: p.options.map((o) => ({ label: o.label, body: o.body, value: o.value })),
        allow_freeform: true,
        idempotency_key: p.idempotency_key,
        metadata: p.metadata,
      })
      const res = await buttonStore.emit(prompt, { topic_id: TOPIC })
      emitted.push({
        body: p.body,
        options: p.options,
        idempotency_key: p.idempotency_key,
        metadata: p.metadata,
        prompt_id: res.prompt_id,
      })
    },
  })
  return { registry, approvals, store, buttonStore, service, emitted, respondSpy, createSpy }
}

function proposal(over: Partial<RitualProposalInput> = {}): RitualProposalInput {
  return {
    id: 'daily-digest',
    description: 'read STATUS.md + calendar and summarise the day',
    scope: 'instance',
    tool_surface: ['Read', 'Glob', 'Grep'],
    egress: 'none',
    silent: false,
    prompt: 'Read ~/STATUS.md and https://example.com/feed then summarise.',
    schedule: { fire_at: 1_900_000_000, recurrence_spec: '0 9 * * *' },
    ...over,
  }
}

function countReminderRows(): number {
  const row = db
    .prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM reminders`)
    .get()
  return row?.n ?? 0
}

// ── 1. propose happy path ─────────────────────────────────────────────────────

describe('propose — happy path', () => {
  test('writes files, registers, mints ONE pending grant, emits code-rendered prompt, creates NO reminder row', async () => {
    const h = makeHarness()
    const res = await h.service.propose(proposal())
    await settle()

    expect(res.status).toBe('pending_approval')
    expect(res.ritual_id).toBe('daily-digest')
    expect(res.requires_egress_approval).toBe(false)

    // files on disk
    expect(existsSync(join(rituals_dir, 'daily-digest.md'))).toBe(true)
    expect(existsSync(join(rituals_dir, 'daily-digest.def.json'))).toBe(true)

    // registered
    expect(h.registry.get('daily-digest')).toBeDefined()

    // ONE pending tool_approvals row under ritual:<id>, content_hash matches
    const pending = h.approvals.listPending(SLUG)
    expect(pending).toHaveLength(1)
    const row = pending[0]!
    expect(row.tool_name).toBe(ritualApprovalToolName('daily-digest'))
    const args = JSON.parse(row.args_json) as { content_hash: string }
    const expectedHash = computeRitualContentHash({
      prompt: 'Read ~/STATUS.md and https://example.com/feed then summarise.',
      tool_surface: ['Read', 'Glob', 'Grep'],
      scope: 'instance',
      cadence: 'spec:0 9 * * *',
      model_tier: RITUAL_MODEL_TIER,
      timeout_ms: RITUAL_TIMEOUT_MS,
    })
    expect(args.content_hash).toBe(expectedHash)

    // emit called once, 2 options, values match the token regex + within cap
    expect(h.emitted).toHaveLength(1)
    const opts = h.emitted[0]!.options
    expect(opts).toHaveLength(2)
    for (const o of opts) {
      expect(RITUAL_APPROVAL_VALUE_RE.test(o.value)).toBe(true)
      expect(Buffer.byteLength(o.value, 'utf8')).toBeLessThanOrEqual(VALUE_BYTE_CAP)
    }
    expect(h.emitted[0]!.idempotency_key).toBe(`ritual-approval:${tokenToUuid(res.proposal_id)}`)
    expect(h.emitted[0]!.metadata).toEqual({ kind: 'ritual-approval', ritual_id: 'daily-digest' })

    // body: capability language (not bare tool names) + itemized refs + fenced prompt + footer
    const body = h.emitted[0]!.body
    expect(body).toContain('Read any file in your Neutron home')
    expect(body).toContain('Runs UNATTENDED')
    expect(body).toContain('~/STATUS.md')
    expect(body).toContain('https://example.com/feed')
    expect(body).toContain('Read ~/STATUS.md and https://example.com/feed then summarise.')
    expect(body).toContain('Typing anything else will NOT approve or deny')

    // NO reminder row; store.create never called during propose
    expect(countReminderRows()).toBe(0)
    expect(h.createSpy).toHaveBeenCalledTimes(0)
  })
})

// ── 2. T8 — an unrelated owner reply never approves ──────────────────────────

describe('T8 — unrelated owner reply never approves', () => {
  test('null on unrelated reply; a freeform attach never touches the tool_approvals row; fire stays unapproved', async () => {
    const h = makeHarness()
    await h.service.propose(proposal())
    await settle()

    const priorOptions = h.emitted[0]!.options.map((o) => o.value)
    const contentPromptId = h.emitted[0]!.prompt_id
    const grant = h.approvals.listPending(SLUG)[0]!

    // (a) an unrelated owner reply is not eligible → null, no state change.
    const r1 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: 'what is the weather like',
      topic_id: TOPIC,
      prior_option_values: priorOptions,
    })
    expect(r1).toBeNull()

    // (b) simulate the app-ws freeform attach on the emitted prompt row (an
    // unrelated typed message resolves the ButtonStore row as __freeform__ — but
    // that is the CHAT row, never the tool_approvals row).
    await h.buttonStore.resolve({
      choice: {
        prompt_id: contentPromptId,
        choice_value: '__freeform__',
        freeform_text: 'what is the weather like',
        chosen_at: Date.now(),
        speaker_user_id: OWNER,
        channel_kind: 'app_socket',
      },
    })

    // the tool_approvals row is STILL pending; respondApproval was NEVER called
    expect(h.approvals.get(grant.id)!.status).toBe('pending')
    expect(h.respondSpy).toHaveBeenCalledTimes(0)

    // isApproved is false; a fire attempt SKIPS as 'unapproved'
    const checker = createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 9 * * *' })
    const def = h.registry.get('daily-digest')!
    const liveBytes = readFileSync(join(rituals_dir, 'daily-digest.md'), 'utf8')
    expect(await checker.isApproved(def, liveBytes)).toBe(false)
    const verdict = await validateRitualFire(h.registry, checker, 'daily-digest', () => {})
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('unapproved')

    // no reminder row ever created
    expect(countReminderRows()).toBe(0)
    expect(h.createSpy).toHaveBeenCalledTimes(0)
  })

  test('a paraphrase / bare "yes" / silence is never eligible', async () => {
    const h = makeHarness()
    await h.service.propose(proposal())
    await settle()
    const priorOptions = h.emitted[0]!.options.map((o) => o.value)
    for (const text of ['yes', 'approve it', 'sounds good', '', 'rap:notatoken:a']) {
      const r = await h.service.handleOwnerButtonAnswer({
        user_id: OWNER,
        user_text: text,
        topic_id: TOPIC,
        prior_option_values: priorOptions,
      })
      expect(r).toBeNull()
    }
    expect(h.respondSpy).toHaveBeenCalledTimes(0)
  })

  test('an exact token NOT in the persisted option set is never eligible', async () => {
    const h = makeHarness()
    await h.service.propose(proposal())
    await settle()
    // a well-formed but UNKNOWN token (correct shape, not the persisted one)
    const forged = `rap:${uuidToToken('00000000-0000-4000-8000-000000000000')}:a`
    const r = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: forged,
      topic_id: TOPIC,
      prior_option_values: [forged], // even if it were somehow in the set...
    })
    // ...it resolves no live row → unknown/stale, never an approval
    expect(r).not.toBeNull()
    expect(r!.body.toLowerCase()).toContain('unknown')
    expect(h.respondSpy).toHaveBeenCalledTimes(0)
  })
})

// ── 3. No self-approval ───────────────────────────────────────────────────────

describe('no self-approval', () => {
  test('a non-owner speaker with the exact approve token is refused; row stays pending', async () => {
    const h = makeHarness()
    await h.service.propose(proposal())
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    const grant = h.approvals.listPending(SLUG)[0]!
    const r = await h.service.handleOwnerButtonAnswer({
      user_id: 'guest-1',
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: [approveValue],
    })
    expect(r!.body).toContain('Only the owner')
    expect(h.approvals.get(grant.id)!.status).toBe('pending')
    expect(h.respondSpy).toHaveBeenCalledTimes(0)
    expect(countReminderRows()).toBe(0)
  })
})

// ── 4. Affirmative act — approve schedules on approve ─────────────────────────

describe('affirmative act — approve', () => {
  test('owner + exact approve token → approved + scheduled with ritual_id; second tap does not double-schedule', async () => {
    const h = makeHarness()
    await h.service.propose(proposal())
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    const priorOptions = h.emitted[0]!.options.map((o) => o.value)
    const grant = h.approvals.listPending(SLUG)[0]!

    const r = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: priorOptions,
    })
    expect(r!.body.toLowerCase()).toContain('approved')
    expect(h.respondSpy).toHaveBeenCalledTimes(1)

    // row decided by the owner
    const decided = h.approvals.get(grant.id)!
    expect(decided.status).toBe('approved')
    expect(decided.decided_by).toBe(OWNER)

    // isApproved true over LIVE bytes
    const checker = createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 9 * * *' })
    const def = h.registry.get('daily-digest')!
    const liveBytes = readFileSync(join(rituals_dir, 'daily-digest.md'), 'utf8')
    expect(checker.isApproved(def, liveBytes)).toBe(true)

    // reminder row exists with ritual_id + the approved cadence
    const rrow = db
      .prepare<{ ritual_id: string | null; recurrence_spec: string | null; message: string }, []>(
        `SELECT ritual_id, recurrence_spec, message FROM reminders WHERE status='pending'`,
      )
      .get()
    expect(rrow!.ritual_id).toBe('daily-digest')
    expect(rrow!.recurrence_spec).toBe('0 9 * * *')
    expect(rrow!.message).toBe('ritual:daily-digest')
    expect(countReminderRows()).toBe(1)

    // second identical tap → already-approved, STILL exactly one reminder row
    const r2 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: priorOptions,
    })
    expect(r2!.body.toLowerCase()).toContain('already')
    expect(countReminderRows()).toBe(1)
  })

  test('a one-shot proposal schedules a non-recurring row', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'one-shot', schedule: { fire_at: 1_900_000_500 } }))
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: h.emitted[0]!.options.map((o) => o.value),
    })
    const rrow = db
      .prepare<{ ritual_id: string | null; recurrence: string | null; recurrence_spec: string | null }, []>(
        `SELECT ritual_id, recurrence, recurrence_spec FROM reminders WHERE status='pending'`,
      )
      .get()
    expect(rrow!.ritual_id).toBe('one-shot')
    expect(rrow!.recurrence).toBeNull()
    expect(rrow!.recurrence_spec).toBeNull()
  })
})

// ── 5. Deny ───────────────────────────────────────────────────────────────────

describe('deny', () => {
  test('owner + exact deny token → denied, no reminder row, def stays registered, isApproved false', async () => {
    const h = makeHarness()
    await h.service.propose(proposal())
    await settle()
    const denyValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':d'))!.value
    const grant = h.approvals.listPending(SLUG)[0]!
    const r = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: denyValue,
      topic_id: TOPIC,
      prior_option_values: h.emitted[0]!.options.map((o) => o.value),
    })
    expect(r!.body.toLowerCase()).toContain('denied')
    expect(h.approvals.get(grant.id)!.status).toBe('denied')
    expect(countReminderRows()).toBe(0)
    expect(h.registry.get('daily-digest')).toBeDefined()
    const checker = createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 9 * * *' })
    expect(checker.isApproved(h.registry.get('daily-digest')!, readFileSync(join(rituals_dir, 'daily-digest.md'), 'utf8'))).toBe(false)
  })
})

// ── 6. Egress two-grant ───────────────────────────────────────────────────────

describe('egress:web — two separate grants', () => {
  test('content-approve alone is not enough; egress-approve then schedules', async () => {
    const h = makeHarness()
    await h.service.propose(
      proposal({
        id: 'web-scan',
        tool_surface: ['Read', 'WebSearch'],
        egress: 'web',
        prompt: 'Search the web for AI news and summarise.',
      }),
    )
    await settle()

    // TWO pending rows + emit called twice
    expect(h.approvals.listPending(SLUG)).toHaveLength(2)
    expect(h.emitted).toHaveLength(2)

    // content grant is emit[0]; egress grant is emit[1]
    const contentApprove = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    const egressApprove = h.emitted[1]!.options.find((o) => o.value.endsWith(':a'))!.value

    // content-approve alone → not scheduled
    const r1 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: contentApprove,
      topic_id: TOPIC,
      prior_option_values: h.emitted[0]!.options.map((o) => o.value),
    })
    expect(r1!.body.toLowerCase()).toContain('egress')
    expect(h.store.hasScheduledRitualRow('web-scan')).toBe(false)
    expect(countReminderRows()).toBe(0)

    // egress-approve → now fully approved → scheduled
    const r2 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: egressApprove,
      topic_id: TOPIC,
      prior_option_values: h.emitted[1]!.options.map((o) => o.value),
    })
    expect(r2!.body.toLowerCase()).toContain('scheduled')
    expect(h.store.hasScheduledRitualRow('web-scan')).toBe(true)
    expect(countReminderRows()).toBe(1)

    // isApproved requires BOTH the content and egress grants
    const checker = createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 9 * * *' })
    const def = h.registry.get('web-scan')!
    expect(checker.isApproved(def, readFileSync(join(rituals_dir, 'web-scan.md'), 'utf8'))).toBe(true)
  })
})

// ── 7. Sanitization + NFC + fence hardening ──────────────────────────────────

describe('sanitization', () => {
  test('over-cap prompt is REFUSED (never truncated) — no files, no rows, error names the cap', async () => {
    const h = makeHarness()
    const big = 'x'.repeat(RITUAL_PROPOSAL_MAX_PROMPT_BYTES + 1)
    await expect(h.service.propose(proposal({ id: 'too-big', prompt: big }))).rejects.toThrow(
      /RITUAL_PROPOSAL_MAX_PROMPT_BYTES|REFUSED|never truncated/,
    )
    expect(existsSync(join(rituals_dir, 'too-big.md'))).toBe(false)
    expect(h.registry.get('too-big')).toBeUndefined()
    expect(countReminderRows()).toBe(0)
  })

  test('bidi-override and zero-width characters are rejected', async () => {
    const h = makeHarness()
    await expect(
      h.service.propose(proposal({ id: 'bidi', prompt: 'read ‮evil‬ file' })),
    ).rejects.toThrow(/control character|bidi|zero-width/i)
    await expect(
      h.service.propose(proposal({ id: 'zw', prompt: 'read​ the file' })),
    ).rejects.toThrow(/control character|bidi|zero-width/i)
    expect(existsSync(join(rituals_dir, 'bidi.md'))).toBe(false)
    expect(existsSync(join(rituals_dir, 'zw.md'))).toBe(false)
  })

  test('NFC — a decomposed é produces the same file bytes + hash as the composed form', async () => {
    const h1 = makeHarness()
    await h1.service.propose(proposal({ id: 'nfc-decomposed', prompt: 'café note' }))
    const decomposedBytes = readFileSync(join(rituals_dir, 'nfc-decomposed.md'), 'utf8')
    // the on-disk bytes are the composed (NFC) form
    expect(decomposedBytes).toBe('café note')
    const decHash = JSON.parse(h1.approvals.listPending(SLUG)[0]!.args_json).content_hash

    const h2 = makeHarness()
    await h2.service.propose(proposal({ id: 'nfc-composed', prompt: 'café note' }))
    const compHash = JSON.parse(
      h2.approvals.listPending(SLUG).find((r) => r.tool_name === ritualApprovalToolName('nfc-composed'))!.args_json,
    ).content_hash
    expect(decHash).toBe(compHash)
  })

  test('fence hardening — a prompt containing a ``` run renders inside a longer fence', async () => {
    const def = { id: 'fence', description: 'x', scope: 'instance' as const, tool_surface: ['Read'], egress: 'none' as const, silent: false }
    const prompt = 'here is code:\n```\nrm -rf\n```\ndone'
    const body = renderRitualApprovalBody({
      def,
      prompt,
      cadence: 'once',
      schedule: { fire_at: 1 },
    })
    // the longest internal backtick run is 3, so the wrapping fence must be >= 4
    expect(body).toContain('````')
    // the prompt content survives verbatim inside
    expect(body).toContain('rm -rf')
  })
})

// ── 8. Never-clobber ──────────────────────────────────────────────────────────

describe('never-clobber', () => {
  test('a registered id is refused; an id whose .md exists is refused; nothing overwritten', async () => {
    const h = makeHarness()
    // register one first
    await h.service.propose(proposal({ id: 'first' }))
    await expect(h.service.propose(proposal({ id: 'first' }))).rejects.toThrow(/already registered|duplicate/i)

    // pre-existing .md on disk (owner-edited / imported) → refuse, unchanged
    const mdPath = join(rituals_dir, 'preexisting.md')
    writeFileSync(mdPath, 'OWNER CONTENT', 'utf8')
    const beforeStat = statSync(mdPath)
    await expect(h.service.propose(proposal({ id: 'preexisting' }))).rejects.toThrow(
      /already has files on disk|refusing to overwrite/i,
    )
    expect(readFileSync(mdPath, 'utf8')).toBe('OWNER CONTENT')
    expect(statSync(mdPath).size).toBe(beforeStat.size)
    expect(h.registry.get('preexisting')).toBeUndefined()
  })
})

// ── 9. Cadence / surface widening drops approval ─────────────────────────────

describe('cadence / surface widening', () => {
  test('a checker built with a DIFFERENT cadence sees the grant as unapproved', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'cad', schedule: { fire_at: 1, recurrence_spec: '0 9 * * *' } }))
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: h.emitted[0]!.options.map((o) => o.value),
    })
    const def = h.registry.get('cad')!
    const bytes = readFileSync(join(rituals_dir, 'cad.md'), 'utf8')
    expect(createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 9 * * *' }).isApproved(def, bytes)).toBe(true)
    expect(createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 10 * * *' }).isApproved(def, bytes)).toBe(false)
  })

  test('editing the prompt file after approval drops the grant', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'edit', schedule: { fire_at: 1, recurrence_spec: '0 9 * * *' } }))
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: h.emitted[0]!.options.map((o) => o.value),
    })
    const def = h.registry.get('edit')!
    const checker = createRitualApprovalCheck({ manager: h.approvals, project_slug: SLUG, cadence: 'spec:0 9 * * *' })
    expect(checker.isApproved(def, readFileSync(join(rituals_dir, 'edit.md'), 'utf8'))).toBe(true)
    writeFileSync(join(rituals_dir, 'edit.md'), 'DIFFERENT PROMPT BYTES', 'utf8')
    expect(checker.isApproved(def, readFileSync(join(rituals_dir, 'edit.md'), 'utf8'))).toBe(false)
  })
})

// ── 10. loadPersistedRitualDefs ──────────────────────────────────────────────

describe('loadPersistedRitualDefs', () => {
  test('re-registers a persisted def; skips corrupt + duplicate without throwing', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'persisted' }))

    // a fresh registry re-registers the def.json def
    const registry2 = createRitualRegistry({ rituals_dir })
    const skips: string[] = []
    const r = loadPersistedRitualDefs({ registry: registry2, rituals_dir, log: (m) => skips.push(m) })
    expect(r.registered).toContain('persisted')
    expect(registry2.get('persisted')).toBeDefined()

    // corrupt JSON + duplicate are skipped, never fatal
    writeFileSync(join(rituals_dir, 'corrupt.def.json'), '{ not json', 'utf8')
    const registry3 = createRitualRegistry({ rituals_dir })
    // pre-register 'persisted' so its def.json becomes a duplicate on load
    registry3.register(h.registry.get('persisted')!)
    const r3 = loadPersistedRitualDefs({ registry: registry3, rituals_dir, log: (m) => skips.push(m) })
    expect(r3.skipped).toContain('corrupt.def.json')
    // 'persisted' is a duplicate → skipped, but never throws
    expect(r3.skipped.some((f) => f.startsWith('persisted'))).toBe(true)
  })
})

// ── Argus r1 BLOCKER — web content token capturable across two prompts ─────────

describe('Argus r1 BLOCKER — web ritual content token is capturable', () => {
  test('the CONTENT approve token is absent from the LATEST prompt alone but present in the recent-union → resolves', async () => {
    const h = makeHarness()
    await h.service.propose(
      proposal({
        id: 'web-blocker',
        tool_surface: ['Read', 'WebSearch'],
        egress: 'web',
        prompt: 'Search the web and summarise.',
      }),
    )
    await settle()
    expect(h.emitted).toHaveLength(2) // content prompt, then egress prompt

    const contentApprove = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    const before = Date.now() + 5_000
    const nowTs = Date.now()

    // (a) THE BUG SHAPE — keying capture off the single latest prompt (egress)
    // misses the content token, so a web ritual could never be content-approved.
    const latest = await h.buttonStore.latestPromptByTopic({ topic_id: TOPIC, before, now: nowTs })
    expect(latest).not.toBeNull()
    expect(latest!.options.map((o) => o.value)).not.toContain(contentApprove)

    // (b) THE FIX — the recent-union DOES include the content token.
    const recent = await h.buttonStore.recentPromptOptionsByTopic({
      topic_id: TOPIC,
      before,
      now: nowTs,
      limit: 4,
    })
    expect(recent).toContain(contentApprove)

    // (c) end-to-end — with the recent-union as prior_option_values, the content
    // grant resolves (content approved; egress still pending, so not yet scheduled).
    const r = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: contentApprove,
      topic_id: TOPIC,
      prior_option_values: recent,
    })
    expect(r).not.toBeNull()
    expect(r!.body.toLowerCase()).toContain('egress')
    expect(h.respondSpy).toHaveBeenCalledTimes(1)
    expect(countReminderRows()).toBe(0)
  })
})

// ── Argus r1 BLOCKER — approved-but-unscheduled ritual heals on re-tap ─────────

describe('Argus r1 BLOCKER — reconciliation of a stranded approval', () => {
  test('a transient store failure after respondApproval strands the ritual; re-tapping Approve schedules it', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'heal', schedule: { fire_at: 1_900_000_500 } }))
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    const priorOptions = h.emitted[0]!.options.map((o) => o.value)
    const grant = h.approvals.listPending(SLUG)[0]!

    // First tap — store.create throws ONCE: the decision IS recorded, but no
    // reminder row is written (the exact post-respondApproval stranding).
    h.createSpy.mockImplementationOnce(() => {
      throw new Error('disk full (transient)')
    })
    const r1 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: priorOptions,
    })
    expect(r1!.body.toLowerCase()).toContain('again') // "tap Approve again"
    expect(h.approvals.get(grant.id)!.status).toBe('approved') // decision durably recorded
    expect(countReminderRows()).toBe(0) // stranded — no reminder row
    expect(h.respondSpy).toHaveBeenCalledTimes(1)

    // Re-tap — the row is no longer pending, so the reconciliation branch RE-DRIVES
    // scheduling (respondApproval is NOT called again) and the ritual heals.
    const r2 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: priorOptions,
    })
    expect(r2!.body.toLowerCase()).toContain('scheduled')
    expect(countReminderRows()).toBe(1)
    expect(h.respondSpy).toHaveBeenCalledTimes(1) // still just the one decision
  })
})

// ── Argus r2 BLOCKER 2 — double-schedule race is reported as "already scheduled"
describe('Argus r2 BLOCKER 2 — concurrent approval INSERT conflict', () => {
  test('a UNIQUE-constraint conflict from a concurrent answer reports "already scheduled", not an error', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'race', schedule: { fire_at: 1_900_000_600 } }))
    await settle()
    const approveValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':a'))!.value
    const priorOptions = h.emitted[0]!.options.map((o) => o.value)

    // Simulate the racing approval answer having already inserted the row: our
    // INSERT trips idx_reminders_ritual_scheduled (migration 0107).
    h.createSpy.mockImplementationOnce(() => {
      throw new Error('UNIQUE constraint failed: reminders.ritual_id')
    })
    const r1 = await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: approveValue,
      topic_id: TOPIC,
      prior_option_values: priorOptions,
    })
    // Conflict = success: the ritual IS scheduled; never a retry-able error.
    expect(r1!.body.toLowerCase()).toContain('already scheduled')
    expect(r1!.body.toLowerCase()).not.toContain('again')
  })
})

// ── Argus r1 MAJOR — emit failure fully rolls back the proposal ───────────────

describe('Argus r1 MAJOR — approval-prompt emission failure rolls back', () => {
  function serviceWithEmit(emit: () => Promise<void>): {
    registry: ReturnType<typeof createRitualRegistry>
    approvals: ApprovalManager
    service: RitualRegistrationService
  } {
    const registry = createRitualRegistry({ rituals_dir })
    const approvals = new ApprovalManager(db, noopNotifier)
    const store = new ReminderStore(db)
    const service = createRitualRegistrationService({
      registry,
      rituals_dir,
      approvals,
      store,
      project_slug: SLUG,
      owner_user_id: OWNER,
      approval_topic_id: TOPIC,
      emit,
    })
    return { registry, approvals, service }
  }

  test('a throwing emit unregisters the def, deletes both files, cancels the pending grant, and re-propose works', async () => {
    let failNext = true
    const { registry, approvals, service } = serviceWithEmit(async () => {
      if (failNext) throw new Error('channel adapter down')
    })
    await expect(service.propose(proposal({ id: 'rollback' }))).rejects.toThrow(
      /rolled back|re-propose|emit/i,
    )
    // fully torn down
    expect(registry.get('rollback')).toBeUndefined()
    expect(existsSync(join(rituals_dir, 'rollback.md'))).toBe(false)
    expect(existsSync(join(rituals_dir, 'rollback.def.json'))).toBe(false)
    expect(approvals.listPending(SLUG)).toHaveLength(0) // no orphan pending grant

    // re-propose now succeeds — the duplicate guard / 'wx' EEXIST no longer blocks
    failNext = false
    const res = await service.propose(proposal({ id: 'rollback' }))
    expect(res.status).toBe('pending_approval')
    expect(registry.get('rollback')).toBeDefined()
    expect(existsSync(join(rituals_dir, 'rollback.md'))).toBe(true)
  })

  test('a web def rolls back BOTH the content and egress grants when the content emit throws', async () => {
    const { approvals, service } = serviceWithEmit(async () => {
      throw new Error('channel adapter down')
    })
    await expect(
      service.propose(
        proposal({ id: 'web-rollback', tool_surface: ['Read', 'WebSearch'], egress: 'web', prompt: 'search the web' }),
      ),
    ).rejects.toThrow(/rolled back|re-propose|emit/i)
    // both minted approval rows (content + egress) are cancelled
    expect(approvals.listPending(SLUG)).toHaveLength(0)
  })
})

// ── Argus r1 minor — rituals_status surfaces a denied grant ───────────────────

describe('Argus r1 minor — status reports denied', () => {
  test('a denied ritual reports approval="denied", not "none"', async () => {
    const h = makeHarness()
    await h.service.propose(proposal({ id: 'denyme' }))
    await settle()
    const denyValue = h.emitted[0]!.options.find((o) => o.value.endsWith(':d'))!.value
    await h.service.handleOwnerButtonAnswer({
      user_id: OWNER,
      user_text: denyValue,
      topic_id: TOPIC,
      prior_option_values: h.emitted[0]!.options.map((o) => o.value),
    })
    const row = h.service.status().find((r) => r.ritual_id === 'denyme')!
    expect(row.approval).toBe('denied')
    expect(row.scheduled).toBe(false)
  })
})

// ── token codec unit ──────────────────────────────────────────────────────────

describe('token codec', () => {
  test('uuidToToken → 22 base64url chars; tokenToUuid round-trips; full option ≤ 37 bytes', () => {
    const uuid = '12345678-9abc-4def-8123-456789abcdef'
    const token = uuidToToken(uuid)
    expect(token).toHaveLength(22)
    expect(tokenToUuid(token)).toBe(uuid)
    expect(Buffer.byteLength(`rap:${token}:a`, 'utf8')).toBeLessThanOrEqual(VALUE_BYTE_CAP)
  })

  test('tokenToUuid rejects malformed input', () => {
    expect(tokenToUuid('short')).toBeNull()
    expect(tokenToUuid('!'.repeat(22))).toBeNull()
  })
})
