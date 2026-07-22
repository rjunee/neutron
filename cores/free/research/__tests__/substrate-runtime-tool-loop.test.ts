/**
 * @neutronai/research-core — task 10: agentic tool loop in the runtime
 * sub-agent dispatcher.
 *
 * The production dispatcher emulates a tool protocol over sequential
 * text `llm_call` rounds: it advertises a strict JSON
 * `{"tool_call":{"tool","input"}}` envelope, executes the named
 * executor, threads a `[TOOL_RESULT <name>]` block into the next
 * round's user prompt, and loops until the model emits the final brief
 * JSON. These tests drive it with a scripted fake `llm_call` (a queue
 * capturing every {system,user,model,max_tokens}) + recording
 * executors so the round-trip, caps, error handling, truncation, and
 * v1 back-compat degradation are all pinned.
 */

import { expect, test } from 'bun:test'

import {
  buildRuntimeResearchSubAgentDispatcher,
  FINALIZE_MARKER,
  TOOL_RESULT_BLOCK_MARKER,
  type ResearchSubAgentToolExecutors,
} from '../src/substrate-runtime.ts'
import type { RuntimeSubAgentDispatchInput } from '../src/sub-agent.ts'

interface Captured {
  system: string
  user: string
  max_tokens: number
  model: string
}

/** A scripted llm_call: pops the next response off the queue per call,
 *  recording each invocation's args. Runs out → throws (a test bug). */
function scriptedLlm(responses: string[]): {
  llm_call: (i: Captured) => Promise<string>
  calls: Captured[]
} {
  const calls: Captured[] = []
  let i = 0
  return {
    calls,
    llm_call: async (input: Captured): Promise<string> => {
      calls.push(input)
      if (i >= responses.length) {
        throw new Error(`scriptedLlm: no response #${i + 1} scripted`)
      }
      return responses[i++]!
    },
  }
}

function baseInput(
  over: Partial<RuntimeSubAgentDispatchInput> = {},
): RuntimeSubAgentDispatchInput {
  return {
    system_prompt: 'You are Atlas, a structured research synthesist.',
    user_prompt: 'research neutron agents',
    model: 'test-model',
    tools: ['research_vault_search', 'research_web_search', 'research_web_fetch'],
    budget_ms: 5 * 60 * 1000,
    ...over,
  }
}

const FINAL_BRIEF = JSON.stringify({
  topic: 't',
  key_findings: ['f'],
  sources: [],
  confidence_level: 'low',
  recommendations: [],
  claims: [{ claim: 'c', confidence: 'unverified' }],
})

test('T1 round-trip: tool_call envelope → executor → result threaded → final JSON', async () => {
  // call#1 returns a prose-WRAPPED envelope (proves extractJson leniency);
  // call#2 returns the final brief JSON.
  const envelope =
    'Sure, let me search first.\n{"tool_call":{"tool":"research_web_search","input":{"query":"neutron agents"}}}'
  const { llm_call, calls } = scriptedLlm([envelope, FINAL_BRIEF])

  const received: Array<{ args: unknown; project_id: string | null }> = []
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_web_search: async (args, ctx) => {
      received.push({ args, project_id: ctx.project_id })
      return { hits: [{ title: 't', url: 'https://x', snippet: 's' }] }
    },
  }

  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
  })
  const result = await dispatcher.dispatch(baseInput({ project_id: 'p1' }))

  // 2 llm calls total.
  expect(calls.length).toBe(2)
  // Executor received the parsed input + the project scope.
  expect(received).toHaveLength(1)
  expect(received[0]!.args).toEqual({ query: 'neutron agents' })
  expect(received[0]!.project_id).toBe('p1')
  // call#2's user carries the threaded tool result.
  expect(calls[1]!.user).toContain(TOOL_RESULT_BLOCK_MARKER('research_web_search'))
  expect(calls[1]!.user).toContain('"title":"t"')
  expect(calls[1]!.user).toContain('https://x')
  // The system prompt carries the protocol rider + the tool names.
  expect(calls[0]!.system).toContain('Tool-use protocol')
  expect(calls[0]!.system).toContain('research_web_search')
  // Result shape.
  expect(result.text).toBe(FINAL_BRIEF)
  expect(result.tools_available).toBe(true)
  expect(result.tool_calls).toEqual([
    { tool: 'research_web_search', success: true, elapsed_ms: expect.any(Number) },
  ])
})

test('T2 round cap: max_tool_rounds:2 → 3 llm calls (2 rounds + forced finalize)', async () => {
  const envelope =
    '{"tool_call":{"tool":"research_web_search","input":{"query":"q"}}}'
  const finalizeText = 'FORCED FINAL ' + FINAL_BRIEF
  const { llm_call, calls } = scriptedLlm([envelope, envelope, finalizeText])
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_web_search: async () => ({ hits: [] }),
  }
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
    max_tool_rounds: 2,
  })
  const result = await dispatcher.dispatch(baseInput())

  expect(calls.length).toBe(3)
  expect(result.tool_calls.length).toBe(2)
  // The last call was the forced finalize turn.
  expect(calls[2]!.user).toContain(FINALIZE_MARKER)
  expect(result.text).toBe(finalizeText)
})

test('T3 budget cap: <FINALIZE_MARGIN_MS remaining after round 1 → finalize (2 llm calls)', async () => {
  const envelope =
    '{"tool_call":{"tool":"research_web_search","input":{"query":"q"}}}'
  const finalizeText = 'BUDGET FINAL ' + FINAL_BRIEF
  const { llm_call, calls } = scriptedLlm([envelope, finalizeText])
  // Clock is a pure read of `clock`; only the (slow) executor advances it,
  // so the finalize decision is robust to how many times now() is called.
  let clock = 0
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_web_search: async () => {
      clock += 25_000 // consume most of the 30s budget in one tool round
      return { hits: [] }
    },
  }
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
    now: () => clock,
  })
  const result = await dispatcher.dispatch(baseInput({ budget_ms: 30_000 }))

  expect(calls.length).toBe(2)
  expect(calls[1]!.user).toContain(FINALIZE_MARKER)
  expect(result.tool_calls.length).toBe(1)
  expect(result.text).toBe(finalizeText)
})

test('T4 unknown tool → error threaded, success:false, loop continues to final', async () => {
  const envelope = '{"tool_call":{"tool":"research_bogus","input":{}}}'
  const { llm_call, calls } = scriptedLlm([envelope, FINAL_BRIEF])
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_web_search: async () => ({ hits: [] }),
  }
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
  })
  const result = await dispatcher.dispatch(baseInput())

  expect(calls.length).toBe(2)
  expect(result.tool_calls).toEqual([
    { tool: 'research_bogus', success: false, elapsed_ms: 0 },
  ])
  expect(calls[1]!.user).toContain('is not available')
  expect(result.text).toBe(FINAL_BRIEF)
})

test('T5 throwing executor → {error} threaded, success:false, loop continues', async () => {
  const envelope =
    '{"tool_call":{"tool":"research_web_search","input":{"query":"q"}}}'
  const { llm_call, calls } = scriptedLlm([envelope, FINAL_BRIEF])
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_web_search: async () => {
      throw new Error('boom from executor')
    },
  }
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
  })
  const result = await dispatcher.dispatch(baseInput())

  expect(result.tool_calls).toEqual([
    { tool: 'research_web_search', success: false, elapsed_ms: expect.any(Number) },
  ])
  expect(calls[1]!.user).toContain('boom from executor')
  expect(result.text).toBe(FINAL_BRIEF)
})

test('T6 back-compat: no tool_executors → single llm call, v1 shape, user == user_prompt', async () => {
  const { llm_call, calls } = scriptedLlm([FINAL_BRIEF])
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({ llm_call })
  const result = await dispatcher.dispatch(baseInput())

  expect(calls.length).toBe(1)
  expect(calls[0]!.user).toBe('research neutron agents')
  // No rider spliced into the system prompt on the v1 path.
  expect(calls[0]!.system).not.toContain('Tool-use protocol')
  expect(result.tool_calls).toEqual([])
  expect(result.tools_available).toBe(false)
})

test('T7 offered-intersection empty → v1 path (tools requested have no executor)', async () => {
  const { llm_call, calls } = scriptedLlm([FINAL_BRIEF])
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_vault_search: async () => ({ hits: [] }),
  }
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
  })
  // Requested tool set has NO overlap with the executor map.
  const result = await dispatcher.dispatch(
    baseInput({ tools: ['research_web_search'] }),
  )

  expect(calls.length).toBe(1)
  expect(result.tools_available).toBe(false)
  expect(calls[0]!.user).toBe('research neutron agents')
})

test('T8 truncation: oversized tool result is capped at TOOL_RESULT_MAX_CHARS + suffix', async () => {
  const envelope =
    '{"tool_call":{"tool":"research_web_search","input":{"query":"q"}}}'
  const { llm_call, calls } = scriptedLlm([envelope, FINAL_BRIEF])
  const bigPayload = 'x'.repeat(120_000)
  const tool_executors: ResearchSubAgentToolExecutors = {
    research_web_search: async () => ({ blob: bigPayload }),
  }
  const dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call,
    tool_executors,
  })
  await dispatcher.dispatch(baseInput())

  const threaded = calls[1]!.user
  // Truncation suffix present.
  expect(threaded).toContain('...[truncated')
  // Extract the threaded [TOOL_RESULT ...] block and bound its length.
  const marker = TOOL_RESULT_BLOCK_MARKER('research_web_search')
  const idx = threaded.indexOf(marker)
  expect(idx).toBeGreaterThan(-1)
  const block = threaded.slice(idx + marker.length + 1) // skip marker + newline
  // 30_000 chars + a short truncation suffix; nowhere near the 120k payload.
  expect(block.length).toBeLessThan(30_000 + 64)
  expect(block.length).toBeGreaterThan(29_000)
})
