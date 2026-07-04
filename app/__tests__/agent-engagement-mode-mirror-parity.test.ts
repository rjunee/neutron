/**
 * @neutronai/app — AgentEngagementMode mirror-parity test (refactor G3).
 *
 * `connect/agent-engagement.ts` is the source of truth for the Connect
 * group-chat agent-engagement literal union (also backed by migration
 * 0088). `app/lib/projects-client.ts:28` keeps its own copy of the same
 * literal union so the mobile client bundle doesn't pull in the gateway's
 * `connect/` module — a comment-only mirror with nothing enforcing
 * agreement (see the docstring on the app-side declaration).
 *
 * This test pins today's agreement:
 *   1. Bidirectional structural assignment — a value typed as the engine's
 *      `AgentEngagementMode` assigns to the app's type and back; `tsc
 *      --noEmit` fails at compile time if either union gains/loses/renames
 *      a member on just one side.
 *   2. The REAL engine constants (`ALL_AGENT_ENGAGEMENT_MODES`,
 *      `DEFAULT_AGENT_ENGAGEMENT_MODE`) — `connect/agent-engagement.ts` has
 *      zero imports, so it's safe to import directly here — are checked
 *      against the exhaustive set the app-side type permits.
 *
 * Today both sides agree on exactly `'tag_gated' | 'all_messages'` — this
 * test characterizes that agreement, not a fix.
 */

import { describe, expect, test } from 'bun:test'

import {
  ALL_AGENT_ENGAGEMENT_MODES,
  DEFAULT_AGENT_ENGAGEMENT_MODE,
  type AgentEngagementMode as EngineMode,
} from '../../connect/agent-engagement'

import type { AgentEngagementMode as AppMode } from '../lib/projects-client'

describe('AgentEngagementMode — connect/agent-engagement.ts ↔ app/lib/projects-client.ts mirror', () => {
  test('every engine mode assigns to the app type and back (bidirectional structural check)', () => {
    for (const v of ALL_AGENT_ENGAGEMENT_MODES) {
      const asApp: AppMode = v
      const backToEngine: EngineMode = asApp
      expect(backToEngine).toBe(v)
    }
  })

  test('the engine union has exactly the two members the app type permits', () => {
    // Exhaustiveness probe: if the engine union ever grows a third member,
    // this switch stops compiling (no `default` case) — a compile-time trip
    // wire independent of the runtime assertion below.
    const exhaustive = (m: EngineMode): AppMode => {
      switch (m) {
        case 'tag_gated':
          return 'tag_gated'
        case 'all_messages':
          return 'all_messages'
      }
    }
    for (const v of ALL_AGENT_ENGAGEMENT_MODES) {
      expect(exhaustive(v)).toBe(v)
    }
    expect(new Set(ALL_AGENT_ENGAGEMENT_MODES)).toEqual(
      new Set<AppMode>(['tag_gated', 'all_messages']),
    )
  })

  test('DEFAULT_AGENT_ENGAGEMENT_MODE is a member of the app-side union', () => {
    const asApp: AppMode = DEFAULT_AGENT_ENGAGEMENT_MODE
    expect(['tag_gated', 'all_messages']).toContain(asApp)
  })
})
