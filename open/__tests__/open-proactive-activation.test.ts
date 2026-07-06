/**
 * P1-4 — proactive messaging ACTIVATION wiring (open composer).
 *
 * The morning-brief + idle-nudge-sweep modules were built + tested but DEAD:
 * they register only when `CompositionInput.tasks.proactive` is set, and the
 * Open composer never set it. These tests pin that the composer now wires
 * `tasks.proactive` so the daily brief registers + posts through the durable
 * web sink, with the LLM seams present on a credentialed boot and absent
 * (graceful) on an LLM-less one — never behind a feature flag. The idle-nudge
 * SWEEP is deliberately not auto-enabled (no `listIdleTopics`); its gate is
 * ready but a correct production enumeration is a documented follow-up.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { appWsTopicId } from '../../channels/adapters/app-ws/envelope.ts'
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

    // The LLM brief composer + the ≥7 nudge quality gate are present on a
    // credentialed boot.
    expect(typeof proactive!.composeBrief).toBe('function')
    expect(typeof proactive!.rateNudge).toBe('function')

    // The idle-nudge SWEEP is deliberately NOT auto-enabled (no listIdleTopics):
    // a correct production enumeration needs a user-turn-only activity watermark
    // + dual web:/app: namespace (see composer comment +
    // docs/research/AS-BUILT-archive-2026-07.md). The gate is
    // wired and ready; the sweep cron only registers once listIdleTopics lands.
    expect(proactive!.listIdleTopics).toBeUndefined()

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
    // No feature flag — the brief topic + durable sink are wired regardless.
    expect(proactive!.resolveGeneralTopic?.()).toBe(appWsTopicId(OWNER_USER_ID))
    expect(typeof proactive!.sink?.send).toBe('function')
    // LLM seams degrade to absent (the modules fall back to the pure template /
    // no quality gate) rather than crashing the boot.
    expect(proactive!.composeBrief).toBeUndefined()
    expect(proactive!.rateNudge).toBeUndefined()

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
