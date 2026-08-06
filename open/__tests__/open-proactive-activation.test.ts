/**
 * P1-4 — proactive messaging ACTIVATION wiring (open composer).
 *
 * The morning-brief + idle-nudge-sweep modules were built + tested but DEAD:
 * they register only when `CompositionInput.tasks.proactive` is set, and the
 * Open composer never set it. These tests pin that the composer now wires
 * `tasks.proactive` so the daily brief registers + posts through the durable
 * web sink, with the LLM seams present on a credentialed boot and absent
 * (graceful) on an LLM-less one — never behind a feature flag. As of 2026-07-30
 * the idle-nudge SWEEP is wired too: the composer supplies `listIdleTopics`
 * (`buildOwnerIdleTopicEnumerator` over both of the owner's topic roots), so
 * the sweep cron registers.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { appWsTopicId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'

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

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-proactive-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-proactive-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1' // force handoff default: ignore any host `claude` login (#101 Keychain probe)
  delete process.env['NOTIFY_SOCKET']
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Open proactive activation wiring', () => {
  test('a credentialed boot wires tasks.proactive (brief active + ready nudge gate) with the durable sink + LLM seams', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-proactive-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const proactive = composition.tasks?.proactive
    expect(proactive).toBeDefined()

    // The brief posts to the owner's General app-ws topic — the SAME topic the
    // connected React/Expo client binds + the live-agent reply path uses, so a
    // fired brief reaches the open socket live (live-delivery fix 2026-06-28).
    expect(proactive!.resolveGeneralTopic?.()).toBe(appWsTopicId(OWNER_USER_ID))

    // A DURABLE web sink is wired (NOT the live-only ChannelRouter) so a
    // timer-fired post survives a disconnected socket.
    expect(typeof proactive!.sink?.send).toBe('function')

    // The ≥7 nudge quality gate is present on a credentialed boot. (`composeBrief`
    // was asserted here too, for the second morning brief ISSUES #504 deleted.)
    expect(typeof proactive!.rateNudge).toBe('function')

    // The idle-nudge SWEEP is ON (2026-07-30). It was withheld while its
    // production enumeration was wrong in two ways — an agent-polluted activity
    // watermark that let the nudge re-arm on its own post, and a single-root
    // scan blind to whichever client the owner wasn't using. Both are fixed
    // (`last_user_activity_at` + dual `web:`/`app:` roots, proved by
    // gateway/proactive/__tests__/idle-nudge-no-repeat.test.ts), so the
    // composer now supplies `listIdleTopics` and the sweep cron registers.
    expect(typeof proactive!.listIdleTopics).toBe('function')
    const candidates = await proactive!.listIdleTopics!()
    // One candidate, not a fan-out: Open has ONE ranker pick per day, delivered
    // to the same General app-ws topic as the brief.
    expect(candidates).toEqual([
      { topic_id: appWsTopicId(OWNER_USER_ID), project_slug: 'owner', last_activity_ms: null },
    ])

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  test('threads the HOST LOCAL timezone into the brief scheduler — not the hardcoded Pacific default', async () => {
    // Ryan: "Detect local computer time not hardcode pt." Before this fix the
    // composer never set `tasks.proactive.timezone`, so `runMorningBrief` fell
    // back to the module's hardcoded `America/Los_Angeles` and a non-Pacific
    // owner got the brief computed for the wrong local day/hour. Pin that the
    // composer now resolves the host zone (`process.env.TZ` override → runtime
    // zone) and threads it through, so a non-PT host drives a non-PT brief.
    process.env['TZ'] = 'Asia/Tokyo'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const proactive = composition.tasks?.proactive
    expect(proactive).toBeDefined()
    expect(proactive!.timezone).toBe('Asia/Tokyo')
    // And explicitly NOT the old hardcoded Pacific default.
    expect(proactive!.timezone).not.toBe('America/Los_Angeles')

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  test('an LLM-less boot still wires proactive (ships ON) but with the LLM seams absent', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const proactive = composition.tasks?.proactive
    expect(proactive).toBeDefined()
    // No feature flag — the general topic + durable sink are wired regardless.
    expect(proactive!.resolveGeneralTopic?.()).toBe(appWsTopicId(OWNER_USER_ID))
    expect(typeof proactive!.sink?.send).toBe('function')
    // LLM seams degrade to absent (no quality gate) rather than crashing the boot.
    expect(proactive!.rateNudge).toBeUndefined()

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  /**
   * The sweep's PRODUCER. `gateway/tasks/p6/nudge-engine.ts:449` is the only
   * non-test writer of `current_focus_pick`, and the idle-nudge sweep's
   * `readTodayPick` returns `no_pick` (`gateway/proactive/idle-nudge-sweep.ts:187`)
   * when that table is empty — so with the nudge cron off, the sweep this
   * composer ships ON can never post. The flag shipped in 49f2bcd3, was removed
   * alongside `listIdleTopics` in d4b669fc, and was NOT restored when
   * `listIdleTopics` came back: consumer alive, producer dead.
   *
   * These assertions are deliberately made against what the PRODUCTION composer
   * actually returns — not a hand-built config literal — so the exact regression
   * that happened (an edit that drops the key from `open/composer.ts`) reds here.
   */
  test('a credentialed boot ENABLES the nudge engine cron with a real llm — the sweep has a producer', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-proactive-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.tasks?.enable_nudge_engine_cron).toBe(true)
    // Enabling the cron WITHOUT an llm is strictly worse than leaving it off:
    // `runNudgePass` runs the staleness pass (which decays focus scores) before
    // it bails at the `llm === null` check, so an llm-less tick mutates task
    // state daily and still never writes a pick. The llm is a dependency of the
    // flag, not an optional extra.
    expect(composition.tasks?.nudge_engine).toBeDefined()
    expect(composition.tasks?.nudge_engine?.llm).not.toBeNull()
    expect(typeof composition.tasks?.nudge_engine?.llm).toBe('function')

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  test('an LLM-less boot does NOT enable the nudge cron (a dependency, not a feature flag)', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // Registering an llm-less nudge cron would decay focus scores every day
    // while never producing a pick. Better to not register it at all.
    expect(composition.tasks?.enable_nudge_engine_cron).toBeUndefined()
    expect(composition.tasks?.nudge_engine).toBeUndefined()

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
