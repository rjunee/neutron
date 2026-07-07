/**
 * K11b0 re-anchor — `scribe.handleUserTurn(...)` reaches `extractAndWrite`
 * end-to-end (substrate.start dispatched).
 *
 * This was previously asserted by `scribe-live-wiring.test.ts` test 4, which
 * drove scribe THROUGH the dead `buildWebChatBridge` `scribeOnUserTurn` hook.
 * That bridge surface was excised in K11b0; the chat-time firing is now covered
 * by `open/__tests__/open-app-ws-scribe-wiring.test.ts`. This survivor pins the
 * scribe-internal path directly (no bridge), so the extract→substrate wiring
 * stays regression-guarded.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate } from '../../runtime/substrate.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { SyncHook } from '../../runtime/entity-writer.ts'
import { createScribe } from '../index.ts'
import { createState } from '../scribe-budget.ts'
import type { WriteEntityFn } from '../write-to-gbrain.ts'

const t0 = Date.now()
const LONG_TURN =
  'Had a productive sync with Dana Reeves at Northstar about the migration roadmap and budget.'

describe('scribe.handleUserTurn — direct extract→substrate wiring', () => {
  test('handleUserTurn reaches extractAndWrite end-to-end (substrate.start dispatched)', async () => {
    const starts: unknown[] = []
    const substrate: Substrate = {
      start(spec): SessionHandle {
        starts.push(spec)
        async function* gen(): AsyncGenerator<Event> {
          yield { kind: 'token', text: '{"entities":[],"relations":[]}' }
          yield {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: 'fake',
          }
        }
        return {
          events: gen(),
          async respondToTool(): Promise<void> {
            throw new Error('no tools')
          },
          async cancel(): Promise<void> {},
          tool_resolution: 'internal',
        }
      },
    }
    const noopSyncHook: SyncHook = { async onEntityWrite(): Promise<void> {} }
    const noopWriteEntity: WriteEntityFn = async (i) => ({
      path: `/x/${i.slug}.md`,
      changed: false,
      newLinks: [],
    })

    const scribe = createScribe({
      substrate,
      syncHook: noopSyncHook,
      ownerDataDir: mkdtempSync(join(tmpdir(), 'scribe-wire-')),
      project_slug: 'acme',
      budget: createState(join(mkdtempSync(join(tmpdir(), 'scribe-wire-b-')), '.s.json'), t0),
      writeEntity: noopWriteEntity,
      now: () => t0,
    })

    // Call the scribe hook DIRECTLY (the production shape is
    // `(i) => scribe.handleUserTurn(i)`), not through any chat surface.
    scribe.handleUserTurn({
      project_slug: 'acme',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      text: LONG_TURN,
      observed_at: t0,
    })
    // handleUserTurn is fire-and-forget; let the microtask + extract settle.
    await new Promise((r) => setTimeout(r, 30))
    expect(starts.length).toBe(1)
  })
})
