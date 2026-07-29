/**
 * @neutronai/channels/app-ws — agent_message_partial wire shape tests (P5.1).
 *
 * The substrate dispatcher does not emit `agent_message_partial`
 * envelopes today — that's a later P5.x sprint. The client-side
 * primitive lands inert. Even so, the envelope type must:
 *   - be a member of the `AppWsOutbound` union (so emitDirect can
 *     push it through `registry.send`);
 *   - carry the locked field shape (`{ v, type, message_id,
 *     body_delta, ts, project_id? }`).
 */

import { describe, expect, it } from 'bun:test'

import { AppWsAdapter } from '../adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import type {
  AppWsOutbound,
  AppWsOutboundAgentMessagePartial,
} from '../envelope.ts'

describe('AppWsOutboundAgentMessagePartial', () => {
  it('is a member of the AppWsOutbound union', () => {
    const partial: AppWsOutboundAgentMessagePartial = {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'mid-1',
      body_delta: 'chunk',
      ts: 1,
    }
    const env: AppWsOutbound = partial
    expect(env.type).toBe('agent_message_partial')
  })

  it('can be pushed through the registry via emitDirect', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const adapter = new AppWsAdapter({
      registry,
      receiver: { receive: async () => undefined },
      now: () => 1,
      generate_message_id: () => 'mid-1',
    })
    const env: AppWsOutboundAgentMessagePartial = {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'streaming-1',
      body_delta: 'first chunk ',
      ts: 1,
      project_id: 'proj-1',
    }
    const ok = adapter.emitDirect('app:sam', env)
    expect(ok).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      v: 1,
      type: 'agent_message_partial',
      message_id: 'streaming-1',
      body_delta: 'first chunk ',
      project_id: 'proj-1',
    })
  })
})
