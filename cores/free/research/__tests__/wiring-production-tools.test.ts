/**
 * @neutronai/research-core — task 10: production wiring threads the
 * three REAL sub-agent tool executors.
 *
 * `buildProductionResearchCoreWiring` builds the vault-search /
 * web-search / web-fetch executors and hands them to the runtime
 * dispatcher. These tests drive the wiring with a scripted `llm_call`
 * and assert:
 *   (a) a vault round runs REAL `searchPriorBriefs` on the real (empty)
 *       sidecar and threads `{"hits":[]}`, and `deep()` completes;
 *   (b) `research_web_fetch` enforces the allow-list (evil host → error);
 *   (c) `research_web_search` degrades gracefully with no Tavily key;
 *   (d) `research_web_search` returns hits when a key + fetcher are wired.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildProductionResearchCoreWiring,
  TOOL_RESULT_BLOCK_MARKER,
  type ResearchLlmCall,
  type BuildProductionResearchCoreWiringOptions,
} from '../index.ts'
import type { RuntimeSubAgentDispatchInput } from '../src/sub-agent.ts'

const OWNER = 'wiring-tools-test'
const PROJECT = 'default'

const BRIEF_WITH_CITATION = JSON.stringify({
  topic: 'wiring tools',
  key_findings: ['a finding'],
  sources: [{ title: 's', url: 'https://en.wikipedia.org/wiki/X' }],
  confidence_level: 'medium',
  recommendations: ['do the thing'],
  claims: [
    {
      claim: 'a cited claim',
      evidence: 'from a source',
      citation: 'https://en.wikipedia.org/wiki/X',
      confidence: 'high',
    },
  ],
})

interface Captured {
  system: string
  user: string
  max_tokens: number
  model: string
}

let tmp: string
let wirings: Array<ReturnType<typeof buildProductionResearchCoreWiring>>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-research-wiring-tools-'))
  wirings = []
})
afterEach(() => {
  for (const w of wirings) w.resolver.closeAll()
  rmSync(tmp, { recursive: true, force: true })
})

/** Build wiring with a scripted (queue) llm_call in a fresh sub-home. */
function makeWiring(
  responses: string[],
  extra: Partial<BuildProductionResearchCoreWiringOptions> = {},
): {
  wiring: ReturnType<typeof buildProductionResearchCoreWiring>
  calls: Captured[]
} {
  const calls: Captured[] = []
  let i = 0
  const llm_call: ResearchLlmCall = async (input) => {
    calls.push(input)
    if (i >= responses.length) {
      throw new Error(`makeWiring llm_call: no response #${i + 1} scripted`)
    }
    return responses[i++]!
  }
  const owner_home = join(tmp, `home-${wirings.length}`)
  const wiring = buildProductionResearchCoreWiring({
    project_slug: OWNER,
    owner_home,
    llm_call,
    default_project_id: PROJECT,
    ...extra,
  })
  wirings.push(wiring)
  return { wiring, calls }
}

function dispatchInput(
  over: Partial<RuntimeSubAgentDispatchInput> = {},
): RuntimeSubAgentDispatchInput {
  return {
    system_prompt: 'You are Atlas.',
    user_prompt: 'a research question',
    model: 'test-model',
    tools: ['research_vault_search', 'research_web_search', 'research_web_fetch'],
    budget_ms: 60_000,
    project_id: PROJECT,
    ...over,
  }
}

test('(a) vault round runs real searchPriorBriefs on the empty sidecar; deep() completes', async () => {
  const vaultEnvelope =
    '{"tool_call":{"tool":"research_vault_search","input":{"query":"prior briefs"}}}'
  const { wiring, calls } = makeWiring([vaultEnvelope, BRIEF_WITH_CITATION])

  const result = await wiring.project_backend.deep({
    query: 'a deep research question',
    project_id: PROJECT,
  })
  expect(result.status).toBe('completed')

  // Two llm calls: the vault round + the final brief.
  expect(calls.length).toBe(2)
  // call#2's user carries the REAL (empty) vault result threaded back.
  expect(calls[1]!.user).toContain(TOOL_RESULT_BLOCK_MARKER('research_vault_search'))
  expect(calls[1]!.user).toContain('"hits":[]')
})

test('(b) web_fetch enforces the allow-list — evil host threads an error, success:false', async () => {
  const fetchEnvelope =
    '{"tool_call":{"tool":"research_web_fetch","input":{"url":"https://evil-not-allowlisted.example/"}}}'
  const { wiring, calls } = makeWiring([fetchEnvelope, BRIEF_WITH_CITATION])

  const res = await wiring.sub_agent_dispatcher.dispatch(dispatchInput())

  const fetchCall = res.tool_calls.find((t) => t.tool === 'research_web_fetch')
  expect(fetchCall).toBeDefined()
  expect(fetchCall!.success).toBe(false)
  expect(calls[1]!.user).toContain('not in the allow-list')
})

test('(c) web_search degrades gracefully with no Tavily key', async () => {
  const searchEnvelope =
    '{"tool_call":{"tool":"research_web_search","input":{"query":"neutron"}}}'
  const { wiring, calls } = makeWiring([searchEnvelope, BRIEF_WITH_CITATION])
  // No tavily_api_key passed → provider unavailable.

  const res = await wiring.sub_agent_dispatcher.dispatch(dispatchInput())

  const searchCall = res.tool_calls.find((t) => t.tool === 'research_web_search')
  expect(searchCall!.success).toBe(false)
  expect(calls[1]!.user).toContain('web search unavailable')
})

test('(d) web_search returns hits when a key + fetcher are wired', async () => {
  const searchEnvelope =
    '{"tool_call":{"tool":"research_web_search","input":{"query":"neutron agents"}}}'
  const tavilyBody = JSON.stringify({
    results: [
      {
        title: 'Neutron agents',
        url: 'https://example.com/neutron',
        content: 'a snippet about agents',
        score: 0.9,
      },
    ],
  })
  const web_search_fetcher = (async () =>
    new Response(tavilyBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

  const { wiring, calls } = makeWiring([searchEnvelope, BRIEF_WITH_CITATION], {
    tavily_api_key: async () => 'k',
    web_search_fetcher,
  })

  const res = await wiring.sub_agent_dispatcher.dispatch(dispatchInput())

  const searchCall = res.tool_calls.find((t) => t.tool === 'research_web_search')
  expect(searchCall!.success).toBe(true)
  expect(calls[1]!.user).toContain('Neutron agents')
  expect(calls[1]!.user).toContain('https://example.com/neutron')
})
