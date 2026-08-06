/**
 * CROSS-LAYER guard: a fired reminder must present the OWNER'S LIVE-CHAT tool
 * surface, because that is what makes it land ON the owner's warm session instead
 * of destroying it.
 *
 * THE MECHANISM THIS PROTECTS. Fired reminders — plain nudges and rituals alike —
 * compose on `liveAgentSubstrate`, the SAME `cc-agent-*` substrate the live chat
 * uses and the only one wiring the native-MCP tool bridge. The persistent-REPL pool
 * compares each request's `--tools` surface against the one the warm child was
 * spawned with and, on a MISMATCH, evicts the child and respawns it
 * (`runtime/adapters/claude-code/persistent/spawn.ts:824,837`; the live-agent
 * docblock says outright that "a varying surface would thrash the pool"). So a
 * reminder that composes with a narrower surface does not get a narrower sandbox —
 * it tears down the owner's live chat REPL, and his next chat turn tears it down
 * again.
 *
 * WHY A TEST AND NOT A COMMENT. The constant lives in `gateway/wiring` and the
 * dispatcher lives in `reminders`, which sits BELOW the gateway and cannot import
 * from it (`reminders/index.ts` refuses that edge on purpose). So the two surfaces
 * are wired together only at the composition root, by one argument in
 * `open/composer.ts` — `tool_names: LIVE_AGENT_TOOL_NAMES`. Nothing inside either
 * package can notice if that argument is dropped: the dispatcher silently falls back
 * to its own narrower `['Read','Glob','Grep']` default and every fired reminder
 * starts evicting the chat session. This file is the only place that can see both
 * halves at once.
 *
 * MUTATION-KILL: delete `tool_names: LIVE_AGENT_TOOL_NAMES` from the
 * `buildReminderDispatcher({...})` call in `open/composer.ts` → the dispatcher falls
 * back to its default and the LAST test here (which pins that the default is NOT the
 * chat surface) documents exactly what regresses. Change either surface without the
 * other → the first two tests go RED.
 */

import { describe, expect, test } from 'bun:test'

import { buildReminderDispatcher, type ReminderLlm } from '@neutronai/reminders/dispatcher.ts'
import type { Reminder } from '@neutronai/reminders/store.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'

import { LIVE_AGENT_TOOL_NAMES } from '../build-live-agent-turn.ts'

function reminderRow(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'rem-1',
    owner_slug: 'owner',
    topic_id: null,
    message: 'take a walk',
    fire_at: 1,
    status: 'pending',
    recurrence: null,
    recurrence_spec: null,
    ritual_id: null,
    created_at: 0,
    ...over,
  } as Reminder
}

/** Dispatch one reminder and return the `spec.tools` names the turn requested. */
async function surfaceFor(input: {
  tool_names?: ReadonlyArray<string>
}): Promise<readonly string[]> {
  const specs: AgentSpec[] = []
  const llm: ReminderLlm = {
    compose: async (spec) => {
      specs.push(spec)
      return 'composed'
    },
  }
  const dispatcher = buildReminderDispatcher({
    outbound: { post: async () => true },
    llm,
    resolveTopicId: () => 'app:owner',
    ...(input.tool_names !== undefined ? { tool_names: input.tool_names } : {}),
  })
  await dispatcher.dispatch(reminderRow())
  expect(specs).toHaveLength(1)
  return specs[0]!.tools.map((t) => t.name)
}

describe('fired-reminder tool surface vs the live-chat surface', () => {
  test('a dispatcher given LIVE_AGENT_TOOL_NAMES requests EXACTLY that surface', async () => {
    const surface = await surfaceFor({ tool_names: LIVE_AGENT_TOOL_NAMES })
    expect([...surface]).toEqual([...LIVE_AGENT_TOOL_NAMES])
  })

  test('the live-chat surface carries the write/exec tools — the accepted #504 consequence', () => {
    // Stated as an assertion rather than a comment because it IS the trade the
    // owner signed off on: a ritual firing into the warm session can do anything
    // that session can, and that session has Bash. If this list is ever narrowed,
    // the honest `description` strings on the bundled ritual defs (which no longer
    // promise "no shell, no writes, no network") should be revisited with it.
    expect([...LIVE_AGENT_TOOL_NAMES]).toContain('Bash')
    expect([...LIVE_AGENT_TOOL_NAMES]).toContain('Write')
    expect([...LIVE_AGENT_TOOL_NAMES]).toContain('Edit')
  })

  test("the dispatcher's OWN default is NOT the chat surface — so the composer must pass it", async () => {
    // The canary. If this ever becomes equal, the cross-layer wiring stopped being
    // load-bearing and this guard stopped guarding anything; if the composer drops
    // the argument, THIS is the surface production would silently start using, and
    // every fired reminder would evict the owner's warm chat REPL.
    const fallback = await surfaceFor({})
    expect([...fallback]).not.toEqual([...LIVE_AGENT_TOOL_NAMES])
    expect(fallback.length).toBeLessThan(LIVE_AGENT_TOOL_NAMES.length)
  })
})
