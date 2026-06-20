/**
 * Research Core S1 r2 — Argus r2 regression guards.
 *
 *   1. BLOCKER (`research_start` / `research_status` / `research_fetch`
 *      MCP tools without `project_id`): the legacy MCP tool inputs do
 *      NOT carry `project_id` (the manifest declares it optional with
 *      "defaults to 'default'" semantics). The shared
 *      `ResearchProjectBackend` requires it and throws
 *      `ResearchInputError('project_id','must be a non-empty string')`
 *      on the empty string. The gateway's `research_core` factory MUST
 *      wrap the shared backend so omitted/empty `project_id` defaults
 *      to `'default'` at the MCP boundary. Without the wrap, an LLM
 *      agent calling `research_start({query:'foo'})` per the
 *      documented schema 500s.
 *
 *   2. IMPORTANT (lazy anthropic re-resolve): the `get_anthropic_pool`
 *      getter passed into `buildResearchLlmCallForOwner` MUST re-run
 *      the resolver on each call so an instance that lands at boot with
 *      no credentials OR re-pastes Max OAuth mid-session OR has its
 *      `.env` re-written by synthetic-auth provisioning gets the fresh
 *      pool on the next call without a gateway restart.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ResearchStoreResolver,
  buildProductionResearchCoreWiring,
  type ResearchLlmCall,
} from '../../cores/free/research/index.ts'

import {
  buildResearchLlmCallForOwner,
  wrapResearchBackendWithDefaultProjectId,
} from '../index.ts'

const OWNER = 'research-mcp-default-project-fixture'

const HAPPY_BRIEF = JSON.stringify({
  topic: 'water cycle in tropical climates',
  key_findings: ['evaporation drives the loop'],
  sources: [{ title: 'wiki', url: 'https://en.wikipedia.org/wiki/Water_cycle' }],
  confidence_level: 'medium',
  recommendations: ['read tropical biome literature'],
  claims: [
    {
      claim: 'tropical climates have more solar input than temperate ones',
      evidence: 'Equatorial regions receive ~25% more solar irradiance',
      citation: 'https://en.wikipedia.org/wiki/Tropical_climate',
      confidence: 'high',
    },
  ],
})

interface Harness {
  owner_home: string
  resolver: ResearchStoreResolver
  wiring: ReturnType<typeof buildProductionResearchCoreWiring>
  close(): void
}

function startHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-research-mcp-default-'))
  const owner_home = join(tmp, 'home')
  const llm_call: ResearchLlmCall = async () => HAPPY_BRIEF
  const wiring = buildProductionResearchCoreWiring({
    project_slug: OWNER,
    owner_home,
    llm_call,
    default_project_id: 'default',
  })
  return {
    owner_home,
    resolver: wiring.resolver,
    wiring,
    close: () => {
      wiring.resolver.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// BLOCKER guard — MCP `research_start` / `_status` / `_fetch` without
// `project_id` MUST land on the canonical 'default' sidecar.
// ---------------------------------------------------------------------------

test('BLOCKER: wrapped backend defaults omitted project_id to "default" on start/status/fetch — Argus r2 (2026-05-21)', async () => {
  // The wrapper helper is exported from gateway/index.ts so this
  // regression test pins the wrapper's contract directly.
  const harness = startHarness()
  try {
    const wrapped = wrapResearchBackendWithDefaultProjectId(
      harness.wiring.project_backend,
    )

    // 1. start({query}) — no project_id — succeeds (lands on 'default').
    const startResult = await (wrapped as unknown as {
      start: (input: { query: string }) => Promise<{ task_id: string; status: string }>
    }).start({ query: 'foo' })
    expect(typeof startResult.task_id).toBe('string')
    expect(startResult.task_id.length).toBeGreaterThan(0)
    expect(startResult.status).toBe('completed')

    // 2. status({task_id}) — no project_id — succeeds for the same task.
    const statusResult = await (wrapped as unknown as {
      status: (input: { task_id: string }) => Promise<{ task_id: string; status: string }>
    }).status({ task_id: startResult.task_id })
    expect(statusResult.task_id).toBe(startResult.task_id)
    expect(statusResult.status).toBe('completed')

    // 3. fetch({task_id}) — no project_id — returns the persisted brief.
    const fetchResult = await (wrapped as unknown as {
      fetch: (input: {
        task_id: string
      }) => Promise<{ task_id: string; status: string; brief?: { topic: string } }>
    }).fetch({ task_id: startResult.task_id })
    expect(fetchResult.brief?.topic).toBe('water cycle in tropical climates')

    // 4. Verify the brief actually landed on the canonical 'default'
    // sidecar — proof the wrapper threaded 'default' rather than '' or
    // a phantom project_id.
    const handle = await harness.resolver.resolve('default')
    const allTasks = handle.store.list({ limit: 200 })
    expect(allTasks.length).toBeGreaterThanOrEqual(1)
    expect(allTasks.some((t) => t.id === startResult.task_id)).toBe(true)
  } finally {
    harness.close()
  }
})

test('BLOCKER: empty-string project_id is also coerced to "default"', async () => {
  const harness = startHarness()
  try {
    const wrapped = wrapResearchBackendWithDefaultProjectId(
      harness.wiring.project_backend,
    )

    const startResult = await (wrapped as unknown as {
      start: (input: {
        query: string
        project_id: string
      }) => Promise<{ task_id: string; status: string }>
    }).start({ query: 'foo', project_id: '' })
    expect(startResult.status).toBe('completed')

    const handle = await harness.resolver.resolve('default')
    const allTasks = handle.store.list({ limit: 200 })
    expect(allTasks.some((t) => t.id === startResult.task_id)).toBe(true)
  } finally {
    harness.close()
  }
})

test('BLOCKER: explicit non-default project_id is honoured — wrapper is additive, not destructive', async () => {
  const harness = startHarness()
  try {
    const wrapped = wrapResearchBackendWithDefaultProjectId(
      harness.wiring.project_backend,
    )

    const result = await wrapped.start({ query: 'foo', project_id: 'alpha' })
    expect(result.status).toBe('completed')

    // Brief landed in 'alpha' sidecar, not in 'default'.
    const alphaHandle = await harness.resolver.resolve('alpha')
    expect(alphaHandle.store.list({ limit: 200 }).some((t) => t.id === result.task_id)).toBe(
      true,
    )
    const defaultHandle = await harness.resolver.resolve('default')
    expect(defaultHandle.store.list({ limit: 200 }).some((t) => t.id === result.task_id)).toBe(
      false,
    )
  } finally {
    harness.close()
  }
})

// ---------------------------------------------------------------------------
// Substrate contract — buildResearchLlmCallForOwner dispatches through the
// injected Substrate; null-substrate yields the "no credentials" error.
//
// Sprint cc-substrate-migration-3-sites (2026-05-31) — replaces the pre-
// substrate `get_anthropic_pool` lazy-resolve guard. Per-call freshness
// is now the substrate's own responsibility (tested in
// gateway/realmode-composer/__tests__/build-llm-call-substrate.test.ts);
// at THIS layer we only need to verify the closure threads the
// `{system,user,max_tokens,model}` call shape into `spec.prompt` correctly
// and surfaces the substrate's response.
// ---------------------------------------------------------------------------

test('buildResearchLlmCallForOwner: null substrate throws no-credentials error', async () => {
  const llmCall = buildResearchLlmCallForOwner({
    project_slug: OWNER,
    slug_suffix: 'project',
    substrate: null,
  })
  await expect(
    llmCall({ system: 's', user: 'u', max_tokens: 10, model: 'm' }),
  ).rejects.toThrow(/no anthropic credentials/)
})

test('buildResearchLlmCallForOwner: packs system+user into spec.prompt and returns accumulated tokens', async () => {
  type AgentSpec = import('../../runtime/substrate.ts').AgentSpec
  type Substrate = import('../../runtime/substrate.ts').Substrate
  type SessionHandle = import('../../runtime/session-handle.ts').SessionHandle
  type Event = import('../../runtime/events.ts').Event

  const captured: AgentSpec[] = []
  const fakeSubstrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      captured.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'stubbed-response' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'research-fake',
        }
      })()
      return {
        events,
        respondToTool: async () => {
          throw new Error('fake substrate: respondToTool unused')
        },
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }

  const llmCall = buildResearchLlmCallForOwner({
    project_slug: OWNER,
    slug_suffix: 'project',
    substrate: fakeSubstrate,
  })

  const result = await llmCall({
    system: 'You are a researcher.',
    user: 'Summarise this URL.',
    max_tokens: 100,
    model: 'claude-opus-4-7',
  })
  expect(result).toBe('stubbed-response')
  expect(captured.length).toBe(1)
  expect(captured[0]!.prompt).toBe('You are a researcher.\n\nSummarise this URL.')
  expect(captured[0]!.tools).toEqual([])
  expect(captured[0]!.model_preference).toEqual(['claude-opus-4-7'])
  expect(captured[0]!.max_tokens).toBe(100)
})

test('buildResearchLlmCallForOwner: substrate errors rethrown with [research-core] prefix', async () => {
  type AgentSpec = import('../../runtime/substrate.ts').AgentSpec
  type Substrate = import('../../runtime/substrate.ts').Substrate
  type SessionHandle = import('../../runtime/session-handle.ts').SessionHandle
  type Event = import('../../runtime/events.ts').Event

  const fakeSubstrate: Substrate = {
    start(_spec: AgentSpec): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'error', message: 'rate_limit: upstream blip', retryable: true }
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
  const llmCall = buildResearchLlmCallForOwner({
    project_slug: OWNER,
    slug_suffix: 'project',
    substrate: fakeSubstrate,
  })
  await expect(
    llmCall({ system: 's', user: 'u', max_tokens: 10, model: 'm' }),
  ).rejects.toThrow(/research-core/)
})
