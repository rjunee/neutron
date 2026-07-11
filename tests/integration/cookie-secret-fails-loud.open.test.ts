/**
 * S2 (c) — the Open composer must FAIL LOUD when
 * `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET` is unset, never fall back to the old
 * guessable `open-ephemeral-<slug>` constant. Mutation-verify: restore that
 * fallback and this test goes green (i.e. it catches the weak-secret branch).
 *
 * Modelled on the Open onboarding integration harness (temp NEUTRON_HOME + real
 * project.db) but drives composition only up to the cookie-secret gate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let home: IsolatedHome

function recordingSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: ['NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET', 'ANTHROPIC_API_KEY'],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      // S2 (c) under test — deliberately UNSET.
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: undefined,
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-cookie-secret-test',
    },
  })
})

afterEach(() => {
  home.restore()
})

describe('S2 (c) — cookie secret fails loud when unset', () => {
  test('composer REJECTS with a loud NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET error', async () => {
    const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    applyMigrations(db.raw())
    const composer = buildOpenGraphComposer({
      env: process.env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      substrateFactory: (() => recordingSubstrate()) as any,
    })
    try {
      await expect(composer({ db, project_slug: 'owner' })).rejects.toThrow(
        /NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET/,
      )
    } finally {
      db.close()
    }
  })
})
