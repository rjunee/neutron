import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { readOwnerTimezone, writeOwnerTimezone } from '../../storage/owner-metadata.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import { openAdmission } from './project-admission-fixture.ts'

const NOW = Date.parse('2026-08-14T00:30:00.000Z')
let tmp: string
let db: ProjectDb
let store: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-owner-time-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  store = new ButtonStore({ db, now: () => NOW })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function substrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'stub' }
      })()
      return { events, async respondToTool() {}, async cancel() {}, tool_resolution: 'internal' }
    },
  }
}

function turn(text: string): LiveAgentTurnRequest {
  return {
    project_slug: 'owner',
    user_id: 'owner',
    topic_id: 'app:owner',
    user_text: text,
    observed_at: NOW,
    send: () => undefined,
  }
}

describe('live owner clock frame', () => {
  test('cold and warm turns carry the owner date when it differs from UTC', async () => {
    const specs: AgentSpec[] = []
    await writeOwnerTimezone(db, 'owner', 'America/Los_Angeles')
    const run = buildLiveAgentTurn({
      admission: openAdmission(),
      substrate: substrate(specs),
      personaLoader: { async load() { return '' } },
      ownerTimezone: (slug) => readOwnerTimezone(db, slug),
      buttonStore: store,
      project_slug: 'owner',
      owner_home: tmp,
      now: () => NOW,
    })

    await run(turn('first'))
    await run(turn('second'))

    for (const spec of specs) {
      expect(spec.prompt).toContain('Owner timezone: America/Los_Angeles')
      expect(spec.prompt).toContain('Current owner-local date and time: 2026-08-13 17:30:00 GMT-07:00')
      expect(spec.prompt).not.toContain('Current owner-local date and time: 2026-08-14')
    }
  })

  test('an unknown zone is named as unknown instead of using the host clock', async () => {
    const specs: AgentSpec[] = []
    const run = buildLiveAgentTurn({
      admission: openAdmission(),
      substrate: substrate(specs),
      personaLoader: { async load() { return '' } },
      ownerTimezone: () => null,
      buttonStore: store,
      project_slug: 'owner',
      owner_home: tmp,
      now: () => NOW,
    })

    await run(turn('hello'))
    expect(specs[0]!.prompt).toContain('Owner timezone and local time are unavailable')
    expect(specs[0]!.prompt).not.toContain('2026-08-14')
  })
})
