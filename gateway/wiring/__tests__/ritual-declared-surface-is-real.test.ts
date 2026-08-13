/**
 * A RITUAL MAY NOT DECLARE A TOOL THAT DOES NOT EXIST ON THE SESSION IT RUNS ON.
 *
 * The bug this closes, in the owner's words: *"Kaizen ritual said it can't do web
 * search."* It couldn't. `kaizen` declares `WebSearch`; the warm chat session it
 * composes on was spawned with `Read, Glob, Grep, Write, Edit, Bash, Skill,
 * Workflow` and nothing else. A missing built-in produces NO ERROR — just an agent
 * that reports it has no such tool — so the gap was invisible from every side.
 *
 * ⚠️ AND IT MADE AN APPROVAL PROMPT LIE. A ritual declaring a web tool must be
 * approved for `egress: 'web'` through a SEPARATE grant reading "may reach the
 * public internet". The owner granted it. The tool was never there, so the grant
 * could never do anything — and an approval prompt that overstates what it grants
 * spends the credibility the whole gate rests on.
 *
 * WHY NEITHER SIDE COULD SEE IT ALONE — the same shape as the push-kind drift in
 * `wire-types/push-kind.ts`. `reminders/rituals.ts` validates a declaration
 * INTERNALLY (is `WebSearch` a legal token? is it consistent with `egress`?) and
 * `build-live-agent-turn.ts` owns the surface that actually gets spawned. Both were
 * green; their UNION was broken. This test is the join, and it lives in `gateway`
 * because that is the one package legitimately declaring both.
 *
 * IT IS NOT A CONTAINMENT CHECK, and must not be read as one. `tool_surface` is not
 * applied per fire (`reminders/ritual-fire.ts` — the warm-session reuse guard would
 * evict the session), so a ritual can always reach MORE than it declared. This
 * asserts the other direction, which is the one that silently under-delivers: never
 * LESS than it declared.
 */

import { describe, expect, test } from 'bun:test'

import { BUNDLED_RITUAL_DEFS } from '@neutronai/reminders/bundled-rituals.ts'

import { LIVE_AGENT_TOOL_NAMES } from '../build-live-agent-turn.ts'

/** Only bare built-in names are comparable; an `mcp__*` bridge token is granted by
 *  a different mechanism (`--allowedMcpTools`) and is out of scope here. */
function builtinsOf(surface: readonly string[]): string[] {
  return surface.filter((t) => !t.startsWith('mcp__'))
}

describe('every bundled ritual can actually reach what it declares', () => {
  test('there ARE bundled rituals to check — positive control', () => {
    // Without this, an empty def list would make every assertion below pass
    // vacuously and report the union as verified when nothing was compared.
    expect(BUNDLED_RITUAL_DEFS.length).toBeGreaterThan(0)
    expect(
      BUNDLED_RITUAL_DEFS.some((d) => builtinsOf(d.tool_surface).includes('WebSearch')),
    ).toBe(true)
  })

  for (const def of BUNDLED_RITUAL_DEFS) {
    test(`'${def.id}' declares nothing the live session lacks`, () => {
      const missing = builtinsOf(def.tool_surface).filter(
        (t) => !(LIVE_AGENT_TOOL_NAMES as readonly string[]).includes(t),
      )
      expect(missing).toEqual([])
    })
  }

  test("a ritual promising web access has a session that can perform it", () => {
    // The specific failure the owner hit: an approved egress grant over a
    // capability the code could not exercise.
    const webRituals = BUNDLED_RITUAL_DEFS.filter((d) => d.egress === 'web')
    expect(webRituals.length).toBeGreaterThan(0)
    for (const d of webRituals) {
      const webTools = builtinsOf(d.tool_surface).filter(
        (t) => t === 'WebSearch' || t === 'WebFetch',
      )
      expect(webTools.length).toBeGreaterThan(0)
      for (const t of webTools) {
        expect([...LIVE_AGENT_TOOL_NAMES]).toContain(t)
      }
    }
  })
})
