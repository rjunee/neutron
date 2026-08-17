/**
 * ISSUES #443 — the overnight-work MORNING BRIEF's delivery wiring.
 *
 * NAME COLLISION, stated up front because it has already misled readers: this
 * is `onboarding/overnight/morning-brief.ts`, the report on what the autonomous
 * OVERNIGHT-WORK engine did while the owner slept. It is NOT
 * `gateway/proactive/morning-brief.ts`, the daily proactive brief, which has
 * its own wiring and its own test (`open-proactive-activation.test.ts`). Two
 * subsystems, one filename.
 *
 * THE GAP. The overnight engine's handler registers UNCONDITIONALLY
 * (`gateway/composition/build-core-modules.ts:783-794`), so the work RAN on
 * every install: it scanned, dispatched Trident runs, and recorded real
 * results. But the reporter fires only when a delivery surface exists —
 * `onboarding/overnight/register.ts:254` reads
 * `shouldReport(...) && input.deliver !== undefined` — and the surface is
 * supplied by `CompositionInput.onboarding_overnight_cron.deliver`
 * (`gateway/composition/input/onboarding-input.ts:88`), which NO composer set.
 * The owner did the work and never saw the report, with every upstream stage
 * looking healthy.
 *
 * WHAT THESE TESTS PIN, and why they are written against the PRODUCTION
 * composer rather than a hand-built config literal: a config literal proves
 * only that the adapter's body is correct, which was never the failure. The
 * failure was that nothing constructed the adapter at all. So every assertion
 * below reads `buildOpenGraphComposer(...)`'s real output, and the last one
 * drives the REAL `runMorningBrief` consumer through it end-to-end into the
 * durable store.
 *
 * MUTATION-TESTED 2026-08-02 — see the PR body for the four deletions and the
 * exact failure text each produced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { appWsTopicId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { webTopicId } from '@neutronai/gateway/http/web-topic-id.ts'
import { OvernightQueueStore } from '@neutronai/onboarding/overnight/queue-store.ts'
import { runMorningBrief } from '@neutronai/onboarding/overnight/morning-brief.ts'
import { buildOvernightEngineHandler } from '@neutronai/onboarding/overnight/register.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

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
  topic_id: string
  body: string
  options_json: string
  resolved_at: number | null
}

/** Every durable chat row, newest first. */
function promptRows(): PromptRow[] {
  return db
    .raw()
    .query<PromptRow, []>(
      `SELECT topic_id, body, options_json, resolved_at
         FROM button_prompts
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all()
}

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-overnight-brief-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] =
    'open-overnight-brief-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-overnight-brief-test'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  db = openMigratedDbAt(process.env['NEUTRON_DB_PATH'])
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function composeOpen(): Promise<{
  composition: Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
  cleanup: () => void
}> {
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  return {
    composition,
    cleanup: (): void => {
      for (const c of composition.realmode_cleanups ?? []) {
        try {
          c()
        } catch {
          /* best-effort */
        }
      }
    },
  }
}

describe('Open overnight morning-brief delivery wiring (ISSUES #443)', () => {
  test('the production composer supplies the overnight reporter a delivery surface', async () => {
    const { composition, cleanup } = await composeOpen()
    try {
      // The exact absence that made the report vanish: the field itself.
      expect(composition.onboarding_overnight_cron).toBeDefined()
      expect(typeof composition.onboarding_overnight_cron?.deliver).toBe('function')
    } finally {
      cleanup()
    }
  }, 20_000)

  test('the composer also NAMES the brief topic — the reporter gate a delivery surface alone does not open', async () => {
    const { composition, cleanup } = await composeOpen()
    try {
      // Wiring `deliver` is necessary and NOT sufficient. `register.ts`'s
      // fallback resolves the topic from the completed onboarding row's
      // `phase_state.topic_id`, and Open's production onboarding path never
      // writes that key — the live-agent turn and the post-turn extractor
      // persist the extracted interview fields only, and the sole production
      // writer is the narrow upload-before-the-row-exists branch at
      // `onboarding/interview/engine.ts:836`. So the read returns null, the
      // gate closes, and the tick records 'report skipped: no General topic
      // resolved' with a perfectly good delivery surface sitting unused.
      expect(composition.onboarding_overnight_cron?.general_topic_id).toBe(
        appWsTopicId(OWNER_USER_ID),
      )
    } finally {
      cleanup()
    }
  }, 20_000)

  test('a delivered brief persists a DURABLE row — an overnight report fires with nobody connected', async () => {
    const { composition, cleanup } = await composeOpen()
    try {
      const deliver = composition.onboarding_overnight_cron?.deliver
      expect(typeof deliver).toBe('function')

      const body = 'OVERNIGHT_BRIEF_DURABILITY_PROBE'
      const accepted = await deliver!({ topic_id: appWsTopicId(OWNER_USER_ID), body })

      // Durable-first: the row IS the delivery, so acceptance must not be
      // conditioned on a live socket (there is none in this test, and there is
      // none at 06:50 on a real box either).
      expect(accepted).toBe(true)

      const row = promptRows().find((r) => r.body === body)
      // durability 'none' would persist NOTHING — the transient pill that is
      // gone before the owner looks. This assertion is the difference.
      expect(row).toBeDefined()
      // durability 'inert' — an already-RESOLVED agent history turn. A 'reply'
      // row would leave `resolved_at` NULL and become the topic's active
      // prompt, so the owner's next message would be read as an answer to the
      // overnight report.
      expect(row!.resolved_at).not.toBeNull()
      expect(row!.options_json).toBe('[]')
    } finally {
      cleanup()
    }
  }, 20_000)

  test('the brief lands on the app topic the client hydrates, whatever topic the reporter passes', async () => {
    const { composition, cleanup } = await composeOpen()
    try {
      const deliver = composition.onboarding_overnight_cron?.deliver
      // `onboarding/overnight/register.ts:294-317` resolves the reporter's
      // topic from the row the owner ONBOARDED on, which is whatever surface
      // ran onboarding — a `web:` topic on the web flow. The app-ws client
      // binds and hydrates ONLY the bare `app:<user>` topic, so forwarding that
      // verbatim is the #105 deliver-to-nobody shape: a durable row under a
      // topic nothing ever replays. Pass the wrong-surface topic explicitly and
      // pin that the composer's adapter re-homes it.
      const foreign = webTopicId(OWNER_USER_ID)
      const body = 'OVERNIGHT_BRIEF_TOPIC_PROBE'
      await deliver!({ topic_id: foreign, body })

      const rows = promptRows().filter((r) => r.body === body)
      expect(rows.map((r) => r.topic_id)).toEqual([appWsTopicId(OWNER_USER_ID)])
      expect(rows.some((r) => r.topic_id === foreign)).toBe(false)
    } finally {
      cleanup()
    }
  }, 20_000)

  test('the REAL runMorningBrief consumer posts a real overnight result through the composed surface', async () => {
    const { composition, cleanup } = await composeOpen()
    try {
      const deliver = composition.onboarding_overnight_cron?.deliver
      expect(typeof deliver).toBe('function')

      // A real terminal overnight item, written through the real queue store on
      // the SAME db the composition wired its ButtonStore to.
      const queue = new OvernightQueueStore(db)
      const windowDate = '2026-06-19'
      await queue.create({
        id: 'owk-20260619-001',
        owner_slug: 'acme',
        description: 'add pagination to the dashboard',
        context_relpath: 'docs/x.md',
      })
      await queue.update('owk-20260619-001', {
        status: 'completed',
        result: 'PR#1',
        finished_at: '2026-06-20T06:00:00Z',
        window_date_local: windowDate,
      })

      // The production consumer — not a re-implementation of it. If the
      // adapter's shape ever stops satisfying `MorningBriefDeps['deliver']`,
      // this is where it shows.
      const res = await runMorningBrief({
        store: queue,
        deliver: deliver!,
        general_topic_id: appWsTopicId(OWNER_USER_ID),
        now: () => Date.parse('2026-06-20T13:55:00Z'),
        tz: 'America/Los_Angeles',
        window_date: windowDate,
      })
      expect(res.status).toBe('reported')
      expect(res.items_reported).toBe(1)

      // The owner can actually READ it: the general summary and the per-project
      // detail are both durable rows on the topic the client hydrates, and the
      // detail carries the REAL result rather than a placeholder.
      const onTopic = promptRows().filter((r) => r.topic_id === appWsTopicId(OWNER_USER_ID))
      expect(onTopic.some((r) => r.body.includes('Overnight work'))).toBe(true)
      const detail = onTopic.find((r) => r.body.includes('add pagination to the dashboard'))
      expect(detail).toBeDefined()
      expect(detail!.body).toContain('PR#1')
    } finally {
      cleanup()
    }
  }, 20_000)

  test('the composed GRAPH registers overnight_handler, and it reports ONLY because the composer named the topic', async () => {
    const { composition, cleanup } = await composeOpen()
    const graph = await composeProductionGraph(composition)
    try {
      // (a) build-core-modules really threads the config into a REGISTERED
      // handler. Asserting the composition field alone would not prove the
      // handler exists to consume it.
      const cron = graph.get<{ handlers: CronHandlerRegistry }>('cron')
      expect(cron.handlers.get('overnight_handler')).toBeDefined()

      const cfg = composition.onboarding_overnight_cron
      expect(cfg?.deliver).toBeDefined()

      const queue = new OvernightQueueStore(db)
      await queue.create({
        id: 'owk-20260619-002',
        owner_slug: 'acme',
        description: 'wire the overnight report',
        context_relpath: 'docs/x.md',
      })
      await queue.update('owk-20260619-002', {
        status: 'completed',
        result: 'PR#2',
        finished_at: '2026-06-20T06:00:00Z',
        window_date_local: '2026-06-19',
      })

      // 06:55 Pacific — inside the reporter window. `now` is the only seam
      // injected here; `deliver` and `general_topic_id` are the production
      // composition's own values, and the DB is the same one the composition
      // wired its ButtonStore to.
      const reporterTime = Date.parse('2026-06-20T13:55:00Z')
      const ctx = { job_name: 'overnight-acme', owner_slug: 'acme', fired_at: reporterTime }

      const wired = buildOvernightEngineHandler({
        db,
        // The composition supplies the publisher credential; assert it is there
        // rather than substituting a stub, so an unwired composer fails here.
        publisher_credential: cfg!.publisher_credential,
        deliver: cfg!.deliver!,
        general_topic_id: cfg!.general_topic_id!,
        now: () => reporterTime,
        listOptedInProjects: () => [],
      })
      const wiredResult = await wired(ctx)
      expect(wiredResult.status).toBe('ok')
      expect(wiredResult.detail).toContain('report=reported')
      expect(wiredResult.detail).not.toContain('UNDELIVERED')
      expect(
        promptRows().some(
          (r) =>
            r.topic_id === appWsTopicId(OWNER_USER_ID) &&
            r.body.includes('wire the overnight report'),
        ),
      ).toBe(true)

      // (b) THE SECOND GAP, demonstrated rather than asserted in prose. Same
      // db, same production `deliver`, topic NOT supplied → the handler falls
      // back to the onboarding-row read, finds nothing, and posts nothing. This
      // is what a deliver-only fix would have shipped.
      const topicless = buildOvernightEngineHandler({
        db,
        // The composition supplies the publisher credential; assert it is there
        // rather than substituting a stub, so an unwired composer fails here.
        publisher_credential: cfg!.publisher_credential,
        deliver: cfg!.deliver!,
        now: () => reporterTime,
        listOptedInProjects: () => [],
      })
      const topiclessResult = await topicless(ctx)
      expect(topiclessResult.detail).toContain('report skipped: no General topic resolved')
    } finally {
      await graph.shutdown()
      cleanup()
    }
  }, 30_000)
})
