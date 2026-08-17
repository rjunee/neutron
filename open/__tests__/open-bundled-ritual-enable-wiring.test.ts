/**
 * The bundled rituals had no reachable approval path — the boot ENABLE wiring.
 *
 * THE DEFECT. Three rituals ship bundled (`morning-brief`, `evening-wrap`,
 * `kaizen`). The composer seeds their templates copy-if-absent and calls
 * `registerBundledRituals(registry)`, which makes the defs KNOWN. Registration
 * is NOT approval, and nothing ever REQUESTED approval for them: the request +
 * prompt emission lives in `requestApprovalAndEmit`
 * (`reminders/ritual-registration.ts`), reached ONLY from `propose()` (the
 * agent-authored path, which refuses a bundled id as `duplicate_id`) and
 * `enable()` — which no boot path called. So no owner-tappable prompt was ever
 * emitted, an unapproved ritual can never fire, and the owner had NO path at all
 * to turn his own bundled rituals on, while status reported them as awaiting an
 * approval that had never been offered.
 *
 * WHY THESE TESTS BOOT THE PRODUCTION COMPOSER rather than calling the sweep
 * against a hand-built config literal: a literal would prove the sweep's body
 * works, which was never the failure. The failure was that nothing CALLED it.
 * So every assertion below reads what `buildOpenGraphComposer(...)` +
 * `composeProductionGraph(...)` actually did to the real DB and the real
 * `<owner_home>/rituals` directory — the ritual executor factory (and therefore
 * the sweep) runs inside the reminders module's `start`, so composing alone is
 * not enough; the graph has to boot.
 *
 * MUTATION-TESTED — see the PR body for both deletions and the exact failure
 * text each produced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { writeOwnerTimezone } from '@neutronai/gateway/storage/owner-metadata.ts'
import { BUNDLED_RITUAL_DEFAULT_CRONS } from '@neutronai/reminders/index.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The three ids the engine ships. Named literally so a silent drop is visible. */
const BUNDLED_IDS = ['morning-brief', 'evening-wrap', 'kaizen'] as const
/** `kaizen` is the only `egress:'web'` def, so it costs a SECOND, separate grant. */
const EGRESS_IDS = ['kaizen'] as const

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
  'TZ',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

interface PromptRow {
  body: string
  options_json: string
  resolved_at: number | null
}

function promptRows(): PromptRow[] {
  return db
    .raw()
    .query<PromptRow, []>(
      `SELECT body, options_json, resolved_at
         FROM button_prompts
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all()
}

/** Durable approval prompts for one ritual's CONTENT grant. */
function contentPrompts(id: string): PromptRow[] {
  return promptRows().filter((r) => r.body.startsWith(`Ritual approval needed: ${id}`))
}

/** Durable prompts for one ritual's SEPARATE network-egress grant. */
function egressPrompts(id: string): PromptRow[] {
  return promptRows().filter((r) => r.body.startsWith(`Network egress for ritual: ${id}`))
}

interface ApprovalRow {
  tool_name: string
  status: string
  decided_by: string | null
}

function approvalRows(): ApprovalRow[] {
  return db
    .raw()
    .query<ApprovalRow, []>(
      `SELECT tool_name, status, decided_by FROM tool_approvals
        WHERE tool_name LIKE 'ritual:%' OR tool_name LIKE 'ritual-egress:%'
        ORDER BY requested_at ASC, rowid ASC`,
    )
    .all()
}

function ritualReminderRows(): Array<{ ritual_id: string | null; recurrence_spec: string | null }> {
  return db
    .raw()
    .query<{ ritual_id: string | null; recurrence_spec: string | null }, []>(
      `SELECT ritual_id, recurrence_spec FROM reminders WHERE ritual_id IS NOT NULL`,
    )
    .all()
}

/**
 * Put the owner past onboarding — the gate the sweep waits on. These approval
 * prompts are durability-'reply' messages on the General topic, so firing them
 * mid-onboarding would replace the welcome opener and capture the owner's next
 * message as a ritual answer; the sweep defers until onboarding is terminal.
 */
async function completeOnboarding(): Promise<void> {
  const now = Date.now()
  await db.run(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at,
        completed_at, persona_files_committed, wow_fired)
     VALUES (?, ?, 'completed', '{}', ?, ?, ?, 1, 1)`,
    ['owner', OWNER_USER_ID, now, now, now],
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/**
 * One full boot of the production composer + graph, then a clean shutdown —
 * i.e. exactly what a gateway restart does. Returns after the boot's
 * fire-and-forget bundled-ritual sweep has been given `settleMs` to finish.
 *
 * `settleMs` is what makes the "no duplicate on restart" assertion meaningful:
 * a second prompt, if the guard were absent, is emitted within this window. The
 * guard mutation in the PR body is the proof the window is wide enough — with
 * the guard removed the duplicate lands and the assertion reds.
 */
async function bootOnce(opts: { waitForPrompts?: boolean; settleMs?: number } = {}): Promise<void> {
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  try {
    if (opts.waitForPrompts === true) {
      await waitFor(
        () =>
          BUNDLED_IDS.every((id) => contentPrompts(id).length >= 1) &&
          EGRESS_IDS.every((id) => egressPrompts(id).length >= 1),
      )
    }
    await sleep(opts.settleMs ?? 2_000)
  } finally {
    await graph.shutdown()
    for (const c of composition.realmode_cleanups ?? []) {
      try {
        c()
      } catch {
        /* best-effort */
      }
    }
  }
}

beforeEach(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-bundled-ritual-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] =
    'open-bundled-ritual-enable-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-bundled-ritual-test'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  db = openMigratedDbAt(process.env['NEUTRON_DB_PATH'])
  // A stored zone, so the cron resolution exercises the real
  // `instance_metadata.timezone` read rather than only its fallback.
  await writeOwnerTimezone(db, 'owner', 'America/Los_Angeles')
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('bundled rituals are reachable — the boot enable sweep', () => {
  test('one boot emits exactly ONE owner-tappable approval prompt per bundled ritual', async () => {
    await completeOnboarding()
    await bootOnce({ waitForPrompts: true })

    for (const id of BUNDLED_IDS) {
      const prompts = contentPrompts(id)
      // THE DEFECT, pinned: before the fix this was 0 for all three — registered,
      // reported as pending, and unapprovable because nothing ever asked.
      expect(prompts.length).toBe(1)
      const prompt = prompts[0]!
      // Owner-TAPPABLE: the Approve/Deny buttons carry the opaque `rap:` tokens
      // `handleOwnerButtonAnswer` matches on. A bodyless notice would not be a
      // path to enabling anything.
      const options = JSON.parse(prompt.options_json) as Array<{ label: string; value: string }>
      expect(options.map((o) => o.label)).toEqual(['Approve', 'Deny'])
      expect(options.every((o) => /^rap:[A-Za-z0-9_-]{22}:(a|d)$/.test(o.value))).toBe(true)
      // Unresolved — it is the live prompt waiting on him, not history.
      expect(prompt.resolved_at).toBeNull()
      // The FULL prompt bytes are quoted verbatim so he is deciding on what will
      // actually run, and the stated cadence is the default cron.
      expect(prompt.body).toContain(BUNDLED_RITUAL_DEFAULT_CRONS[id]!)
    }

    // `kaizen` reaches the web, so approving its content must not imply egress:
    // it gets its own second grant + prompt. The other two must NOT.
    expect(egressPrompts('kaizen').length).toBe(1)
    expect(egressPrompts('morning-brief').length).toBe(0)
    expect(egressPrompts('evening-wrap').length).toBe(0)

    // The durable enable marker + the schedule it recorded.
    for (const id of BUNDLED_IDS) {
      const defPath = join(tmpDir, 'rituals', `${id}.def.json`)
      expect(existsSync(defPath)).toBe(true)
      const record = JSON.parse(readFileSync(defPath, 'utf8')) as {
        schedule: { fire_at: number; recurrence_spec?: string }
      }
      expect(record.schedule.recurrence_spec).toBe(BUNDLED_RITUAL_DEFAULT_CRONS[id]!)
      expect(record.schedule.fire_at).toBeGreaterThan(Date.now() / 1000)
    }
  }, 120_000)

  test('a SECOND boot re-prompts nothing — a restart does not re-ask', async () => {
    await completeOnboarding()
    await bootOnce({ waitForPrompts: true })
    const afterFirst = promptRows().length

    await bootOnce()

    for (const id of BUNDLED_IDS) expect(contentPrompts(id).length).toBe(1)
    for (const id of EGRESS_IDS) expect(egressPrompts(id).length).toBe(1)
    // No duplicate grants either — a re-request would mint a second pending row
    // per ritual and leave a stale token live.
    expect(approvalRows().length).toBe(BUNDLED_IDS.length + EGRESS_IDS.length)
    // And nothing ELSE was duplicated into the durable chat log.
    expect(promptRows().length).toBe(afterFirst)
  }, 180_000)

  test('the rituals stay UNAPPROVED and UNSCHEDULED until the owner taps', async () => {
    await completeOnboarding()
    await bootOnce({ waitForPrompts: true })

    const rows = approvalRows()
    expect(rows.length).toBe(BUNDLED_IDS.length + EGRESS_IDS.length)
    // NO auto-approval anywhere: every grant is pending and nobody decided it.
    // The sweep fixes reachability, never consent.
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
    expect(rows.every((r) => r.decided_by === null)).toBe(true)
    for (const id of BUNDLED_IDS) {
      expect(rows.some((r) => r.tool_name === `ritual:${id}`)).toBe(true)
    }

    // Scheduling happens on approve, not on enable — an unapproved ritual has no
    // reminder row, so the tick loop has nothing to fire.
    expect(ritualReminderRows()).toEqual([])
  }, 120_000)

  test('a boot MID-ONBOARDING prompts nothing — the welcome opener owns that screen', async () => {
    // No `completeOnboarding()`: a brand-new instance has no `onboarding_state`
    // row at all, which the composer's onboarding predicate reads as "still
    // onboarding". These prompts are durability-'reply' messages on the General
    // topic, so each becomes the topic's ACTIVE prompt — fired here they would
    // put four approval walls where the welcome opener belongs and capture the
    // owner's next message as a ritual answer instead of an onboarding answer.
    // An ungated first draft of this sweep did exactly that and broke
    // `tests/integration/onboarding-welcome-seed-once.open.test.ts` plus the
    // `last_seen_seq:0` fresh-topic assertion in
    // `open/__tests__/open-app-ws-durable-chatlog.test.ts`.
    await bootOnce()

    for (const id of BUNDLED_IDS) expect(contentPrompts(id).length).toBe(0)
    for (const id of EGRESS_IDS) expect(egressPrompts(id).length).toBe(0)
    expect(approvalRows()).toEqual([])
    // Deferred, not half-done: no durable enable marker is left behind, so the
    // first boot AFTER onboarding completes still emits the prompts.
    for (const id of BUNDLED_IDS) {
      expect(existsSync(join(tmpDir, 'rituals', `${id}.def.json`))).toBe(false)
    }

    // And that next boot does exactly that — the deferral costs a restart, not
    // the feature.
    await completeOnboarding()
    await bootOnce({ waitForPrompts: true })
    for (const id of BUNDLED_IDS) expect(contentPrompts(id).length).toBe(1)
  }, 180_000)
})
