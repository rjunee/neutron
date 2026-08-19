/**
 * Email Core consolidation P1 — the email-pipeline composition seam, asserted
 * against what the REAL composer emits.
 *
 * A hand-built config literal proves the consumer, never the producer
 * (ISSUES #439/#440). These boot `buildOpenGraphComposer` — the only composer
 * Open has — and read `composition.email_pipeline`. Delete the block from
 * `open/composer.ts` and this file reds.
 *
 * What it pins is the delivery discipline the PR #105 deliver-to-nobody
 * incident produced: a real `deliver`, aimed at the owner's BARE app topic,
 * with push present ALONGSIDE it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'

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
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-email-pipeline-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-tasks-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
  seedMigratedDb(process.env['NEUTRON_DB_PATH'])
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function cleanup(composition: { realmode_cleanups?: Array<() => void> }): void {
  for (const c of composition.realmode_cleanups ?? []) {
    try {
      c()
    } catch {
      /* best-effort */
    }
  }
}

describe('Open email-pipeline composition wiring', () => {
  test('the composer supplies the pipeline bundle: gmail, deliver, the owner topic, push', async () => {
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    const pipeline = composition.email_pipeline
    expect(pipeline).toBeDefined()
    expect(typeof pipeline?.gmail.listMessages).toBe('function')
    // The widened contract has to reach the tick — an old client would throw
    // `ensureLabel is not a function` on the first poll.
    expect(typeof pipeline?.gmail.ensureLabel).toBe('function')
    expect(typeof pipeline?.gmail.modifyMessage).toBe('function')
    expect(typeof pipeline?.deliver).toBe('function')
    // The owner's BARE app topic — the only topic the app client binds AND
    // hydrates. A suffixed topic is the #105 deliver-to-nobody shape.
    expect(pipeline?.escalation_topic_id).toBe('app:owner')
    // Push is ALONGSIDE chat, never instead of it — but it must be present.
    expect(pipeline?.push).not.toBeNull()
    expect(typeof pipeline?.push?.pushAll).toBe('function')
    expect(typeof pipeline?.resolveTimezone).toBe('function')
    expect(pipeline?.owner_home).toBe(tmpDir)

    cleanup(composition)
  }, 20_000)

  test('an LLM-less boot passes llm:null — the cascade degrades, it does not crash', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.email_pipeline).toBeDefined()
    expect(composition.email_pipeline?.llm).toBeNull()

    cleanup(composition)
  }, 20_000)

  test('a credentialed boot passes the SUBSTRATE one-shot caller — no provider key', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-email-pipeline-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(typeof composition.email_pipeline?.llm).toBe('function')

    cleanup(composition)
  }, 20_000)
})
