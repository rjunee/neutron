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
 * This test pins today's agreement in BOTH directions:
 *   1. Compile-time bidirectional parity via typed-identity assertions.
 *      A function PARAMETER is genuinely typed as its full declared union
 *      — unlike a `const x: T = initializer`, which TypeScript control-flow-
 *      narrows to the initializer's (narrower) type, silently defeating the
 *      reverse assignment. So we assign a parameter of one side's union to
 *      the OTHER side's type:
 *        - `(m: EngineMode): AppMode => m` fails to compile if the ENGINE
 *          union ever WIDENS (a new engine member the app type lacks).
 *        - `(m: AppMode): EngineMode => m` fails to compile if the APP
 *          union ever WIDENS (a new app member the engine type lacks).
 *      Both together ⇒ the two unions are exactly equal. (Codex verified the
 *      earlier loop-based check only caught ENGINE-widening — the narrowing
 *      trap above — so the app→engine direction is added here explicitly.)
 *   2. The REAL engine constants (`ALL_AGENT_ENGAGEMENT_MODES`,
 *      `DEFAULT_AGENT_ENGAGEMENT_MODE`) — `connect/agent-engagement.ts` has
 *      zero imports, so it's safe to import directly here — are checked at
 *      runtime for set-equality against the exhaustive app-side enumeration.
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

// ── Compile-time bidirectional subset assertions ────────────────────────
// These are pure type-level checks — their VALUE is irrelevant; the mere
// fact that they typecheck is the guardrail. A function parameter carries
// its full declared union type with no control-flow narrowing, so each
// assignment forces the target union to be a superset of the source.

/** Fails to compile if EngineMode gains a member AppMode lacks. */
const _engineIsSubsetOfApp = (m: EngineMode): AppMode => m
/** Fails to compile if AppMode gains a member EngineMode lacks. */
const _appIsSubsetOfEngine = (m: AppMode): EngineMode => m

// The exhaustive app-side enumeration used for the runtime set-equality
// check. Its declared type is `readonly AppMode[]`, and a `never`-guarded
// exhaustive switch below proves it lists EVERY app-side member (so a
// silent app-side widening can't slip past the runtime assertion either).
const ALL_APP_ENGAGEMENT_MODES: readonly AppMode[] = ['tag_gated', 'all_messages']

/**
 * Exhaustive over AppMode: if `app/lib/projects-client.ts` widens the union,
 * the `default` branch's `never` assignment stops compiling — a second,
 * app-direction compile trip wire paralleling the engine-direction switch.
 */
function appModeToEngine(m: AppMode): EngineMode {
  switch (m) {
    case 'tag_gated':
      return 'tag_gated'
    case 'all_messages':
      return 'all_messages'
    default: {
      const _never: never = m
      return _never
    }
  }
}

describe('AgentEngagementMode — connect/agent-engagement.ts ↔ app/lib/projects-client.ts mirror', () => {
  test('typed-identity assertions cover BOTH widening directions at compile time', () => {
    // Runtime bodies are trivial; the guarantee is compile-time. Exercise
    // them so the functions are not dead code and the round-trip is real.
    for (const v of ALL_AGENT_ENGAGEMENT_MODES) {
      expect(_engineIsSubsetOfApp(v)).toBe(v)
      expect(_appIsSubsetOfEngine(v)).toBe(v)
      expect(appModeToEngine(v)).toBe(v)
    }
  })

  test('engine list and app enumeration are set-equal (divergence in either direction fails)', () => {
    // Runtime backstop to the compile-time assertions: the engine's own
    // runtime list must equal the exhaustive app-side enumeration. A member
    // present on exactly one side fails here even if some future tsconfig
    // change were to soften the type checks.
    expect(new Set(ALL_AGENT_ENGAGEMENT_MODES)).toEqual(new Set(ALL_APP_ENGAGEMENT_MODES))
  })

  test('the engine union has exactly the two members the app type permits (exhaustiveness)', () => {
    // Engine-direction exhaustive switch: a third engine member stops this
    // compiling (no matching case). Complements the app-direction switch
    // (`appModeToEngine`) above.
    const engineToApp = (m: EngineMode): AppMode => {
      switch (m) {
        case 'tag_gated':
          return 'tag_gated'
        case 'all_messages':
          return 'all_messages'
      }
    }
    for (const v of ALL_AGENT_ENGAGEMENT_MODES) {
      expect(engineToApp(v)).toBe(v)
    }
  })

  test('DEFAULT_AGENT_ENGAGEMENT_MODE is a member of the app-side union', () => {
    const asApp: AppMode = DEFAULT_AGENT_ENGAGEMENT_MODE
    expect(ALL_APP_ENGAGEMENT_MODES).toContain(asApp)
  })
})
