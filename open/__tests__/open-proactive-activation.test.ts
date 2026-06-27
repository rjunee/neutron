/**
 * P1-4 — proactive messaging ACTIVATION wiring (open composer).
 *
 * The morning-brief + idle-nudge-sweep modules were built + tested but DEAD:
 * they register only when `CompositionInput.tasks.proactive` is set, and the
 * Open composer never set it. These tests pin that the composer now wires
 * `tasks.proactive` (so `build-core-modules` registers the crons) and the
 * nudge-engine cron that feeds the sweep, with the LLM seams present on a
 * credentialed boot and absent (graceful) on an LLM-less one — never behind a
 * feature flag.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { webTopicId } from '../../gateway/http/web-topic-id.ts'
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
  'NOTIFY_SOCKET',
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
  test('a credentialed boot wires tasks.proactive (brief + sweep) + the nudge engine + LLM seams', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-proactive-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const proactive = composition.tasks?.proactive
    expect(proactive).toBeDefined()

    // The brief posts to the owner's General web topic.
    expect(proactive!.resolveGeneralTopic?.()).toBe(webTopicId(OWNER_USER_ID))

    // The sweep can enumerate idle topics (empty history → empty list, no throw).
    const topics = await proactive!.listIdleTopics?.()
    expect(Array.isArray(topics)).toBe(true)

    // The Vajra-parity LLM seams are present on a credentialed boot.
    expect(typeof proactive!.composeBrief).toBe('function')
    expect(typeof proactive!.rateNudge).toBe('function')

    // The nudge ranker (which feeds the sweep its picks) is enabled.
    expect(composition.tasks?.enable_nudge_engine_cron).toBe(true)
    expect(composition.tasks?.nudge_engine?.llm).toBeDefined()

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
    // No feature flag — the brief topic + sweep enumeration are wired regardless.
    expect(proactive!.resolveGeneralTopic?.()).toBe(webTopicId(OWNER_USER_ID))
    expect(typeof proactive!.listIdleTopics).toBe('function')
    // LLM seams degrade to absent (the modules fall back to the pure template /
    // no quality gate) rather than crashing the boot.
    expect(proactive!.composeBrief).toBeUndefined()
    expect(proactive!.rateNudge).toBeUndefined()
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
