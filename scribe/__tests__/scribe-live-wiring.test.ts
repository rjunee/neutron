/**
 * LIVE-wiring assertion (the anti-built-but-not-wired gate).
 *
 * Proves the chat-bridge ACTUALLY invokes the scribe hook on a real
 * `user_message` advance — not that a scribe module merely exists. Per CLAUDE.md
 * "Spec is the source of truth": every spec'd module invocation needs an
 * explicit `toHaveBeenCalled` (or on-disk artifact) proving the path fires.
 *
 * Two layers:
 *   1. The chat-bridge fires `scribeOnUserTurn` with the user's turn text after
 *      `engine.advance`, and ONLY for `user_message` (not button_choice).
 *   2. The production-shape wiring `(i) => scribe.handleUserTurn(i)` reaches
 *      scribe's `extractAndWrite` end-to-end (substrate.start called).
 */

import { describe, test, expect, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWebChatBridge, InMemoryWebChatSenderRegistry } from '../../gateway/http/chat-bridge.ts'
import { InMemoryConsumedTokens } from '../../runtime/consumed-tokens-in-memory.ts'
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

/** Minimal engine satisfying the bridge's user_message path. */
function fakeEngine(): {
  advanceCalls: unknown[]
  recordInboundReceived(): Promise<void>
  advance(input: unknown): Promise<unknown>
  start(): Promise<unknown>
  acceptChoice(): Promise<unknown>
  tick(): Promise<void>
  emitCurrentPhasePrompt(): Promise<unknown>
} {
  const advanceCalls: unknown[] = []
  return {
    advanceCalls,
    async recordInboundReceived(): Promise<void> {},
    async advance(input: unknown): Promise<unknown> {
      advanceCalls.push(input)
      return { outcome: 'advanced', state: {} }
    },
    async start(): Promise<unknown> {
      return { prompt_id: 'pid', was_new: true, state: {} }
    },
    async acceptChoice(): Promise<unknown> {
      return { outcome: 'advanced', state: {} }
    },
    async tick(): Promise<void> {},
    async emitCurrentPhasePrompt(): Promise<unknown> {
      return { outcome: 'advanced', state: {} }
    },
  }
}

function makeBridge(scribeOnUserTurn: (i: unknown) => void): ReturnType<typeof buildWebChatBridge> {
  return buildWebChatBridge({
    expected_project_slug: 'acme',
    resolveKey: async () => null,
    consumedTokens: new InMemoryConsumedTokens(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: fakeEngine() as any,
    registry: new InMemoryWebChatSenderRegistry(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scribeOnUserTurn: scribeOnUserTurn as any,
  })
}

describe('scribe live-wiring — chat-bridge fires scribeOnUserTurn', () => {
  test('user_message advance fires the hook with the turn text', async () => {
    const hook = mock((_i: unknown) => {})
    const bridge = makeBridge(hook)
    await bridge.handleInbound({
      project_slug: 'acme',
      user_id: 'u-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: { type: 'user_message', body: LONG_TURN } as any,
      send: () => {},
    })
    expect(hook).toHaveBeenCalledTimes(1)
    const arg = hook.mock.calls[0]![0] as {
      project_slug: string
      user_id: string
      text: string
      observed_at: number
    }
    expect(arg.project_slug).toBe('acme')
    expect(arg.user_id).toBe('u-1')
    expect(arg.text).toBe(LONG_TURN)
    expect(typeof arg.observed_at).toBe('number')
  })

  test('user_message on a PROJECT topic also fires the hook (not just General)', async () => {
    const hook = mock((_i: unknown) => {})
    const bridge = makeBridge(hook)
    await bridge.handleInbound({
      project_slug: 'acme',
      user_id: 'u-1',
      // active_topic_id != General → routes through the project-topic stub.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      active_topic_id: 'web:u-1:project-alpha' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: { type: 'user_message', body: LONG_TURN } as any,
      send: () => {},
    })
    expect(hook).toHaveBeenCalledTimes(1)
    const arg = hook.mock.calls[0]![0] as { topic_id: string; text: string }
    expect(arg.topic_id).toBe('web:u-1:project-alpha')
    expect(arg.text).toBe(LONG_TURN)
  })

  test('button_choice does NOT fire the scribe hook', async () => {
    const hook = mock((_i: unknown) => {})
    const bridge = makeBridge(hook)
    await bridge.handleInbound({
      project_slug: 'acme',
      user_id: 'u-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: { type: 'button_choice', prompt_id: 'p', choice_value: 'yes' } as any,
      send: () => {},
    })
    expect(hook).not.toHaveBeenCalled()
  })

  test('production wiring (i) => scribe.handleUserTurn(i) reaches extractAndWrite end-to-end', async () => {
    // A substrate that records dispatch + completes empty.
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

    const bridge = makeBridge((i) => scribe.handleUserTurn(i as never))
    await bridge.handleInbound({
      project_slug: 'acme',
      user_id: 'u-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: { type: 'user_message', body: LONG_TURN } as any,
      send: () => {},
    })
    // handleUserTurn is fire-and-forget; let the microtask + extract settle.
    await new Promise((r) => setTimeout(r, 30))
    expect(starts.length).toBe(1)
  })
})
