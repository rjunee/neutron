/**
 * P-A — the live-agent first-turn system context instructs the agent to
 * reference drafted docs with the tappable `[name](docs:/<id>/<path>)` marker
 * (which the client linkifies + opens in the Documents tab) instead of a raw
 * `Projects/…md` filesystem path.
 *
 * The composed first-turn prompt is delivered as `AgentSpec.prompt`; a capturing
 * substrate records it so we can assert the guidance is present.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { Event } from '../../../runtime/events.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-docref-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Substrate that captures the spec it's started with, then completes fast. */
function makeCapturingSubstrate(captured: { spec: AgentSpec | null }): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      captured.spec = spec
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'ok' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'stub' }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

describe('build-live-agent-turn — doc-reference guidance (P-A)', () => {
  test('first-turn system context teaches the docs:/ tappable-link convention', async () => {
    const captured: { spec: AgentSpec | null } = { spec: null }
    const run = buildLiveAgentTurn({
      substrate: makeCapturingSubstrate(captured),
      personaLoader: { async load(): Promise<string> { return '' } },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
    })
    const res = await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      user_text: 'draft me a brief',
      send: () => {},
      observed_at: 0,
    })
    expect(res.outcome).toBe('replied')
    const prompt = captured.spec?.prompt ?? ''
    // The guidance names the exact marker convention + the Documents tab, and
    // tells the agent NOT to paste raw Projects/ paths.
    expect(prompt).toContain('docs:/')
    expect(prompt).toContain('Documents tab')
    expect(prompt.toLowerCase()).toContain('tappable link')
  })
})
