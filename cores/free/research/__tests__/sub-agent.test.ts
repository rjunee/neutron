/**
 * @neutronai/research-core — sub-agent harness tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'

import {
  PerOwnerConcurrencyGate,
  SubAgentConcurrencyExceededError,
  SubAgentTimeoutError,
  buildCannedSubAgentDispatcher,
  dispatchResearchSubAgent,
  type RuntimeSubAgentDispatcher,
} from '../src/sub-agent.ts'
import {
  RESEARCH_SUB_AGENT_TOOL_WHITELIST,
  buildSubAgentSystemPrompt,
  isEngineeringShapeQuery,
} from '../src/sub-agent-prompt.ts'

describe('PerOwnerConcurrencyGate', () => {
  test('acquire / release decrements the counter', () => {
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    const r1 = gate.acquire('t')
    const r2 = gate.acquire('t')
    expect(gate.inFlightFor('t')).toBe(2)
    r1()
    expect(gate.inFlightFor('t')).toBe(1)
    r2()
    expect(gate.inFlightFor('t')).toBe(0)
  })

  test('throws when at cap', () => {
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    const r1 = gate.acquire('t')
    expect(() => gate.acquire('t')).toThrow(SubAgentConcurrencyExceededError)
    r1()
    // After release the cap is available again.
    const r2 = gate.acquire('t')
    r2()
  })

  test('double-release is idempotent', () => {
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    const release = gate.acquire('t')
    release()
    release()
    expect(gate.inFlightFor('t')).toBe(0)
  })

  test('per-project isolation — other project unaffected', () => {
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    const a = gate.acquire('a')
    const b = gate.acquire('b')
    expect(gate.inFlightFor('a')).toBe(1)
    expect(gate.inFlightFor('b')).toBe(1)
    a()
    b()
  })
})

describe('dispatchResearchSubAgent', () => {
  test('passes the Atlas-shape system prompt verbatim + the tool whitelist', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: '{"topic":"x","key_findings":[],"sources":[],"confidence_level":"low","recommendations":[]}' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    await dispatchResearchSubAgent(
      { query: 'how does X work', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(dispatcher.calls).toHaveLength(1)
    const call = dispatcher.calls[0]!
    expect(call.system_prompt).toContain('Atlas')
    expect(call.system_prompt).toContain('SOURCES-CITED INVARIANT')
    expect(call.tools).toEqual(RESEARCH_SUB_AGENT_TOOL_WHITELIST)
  })

  test('releases the concurrency slot after a successful run', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: 'x' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    await dispatchResearchSubAgent(
      { query: 'a', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(gate.inFlightFor('t')).toBe(0)
  })

  test('releases the concurrency slot even on dispatcher error', async () => {
    const failing: RuntimeSubAgentDispatcher = {
      async dispatch(): Promise<never> {
        throw new Error('boom')
      },
    }
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    await expect(
      dispatchResearchSubAgent(
        { query: 'a', project_slug: 't', project_id: 'p' },
        { runtime_sub_agent: failing, concurrency_gate: gate },
      ),
    ).rejects.toThrow(/boom/)
    expect(gate.inFlightFor('t')).toBe(0)
  })

  test('budget timeout fires when dispatcher hangs', async () => {
    const slow: RuntimeSubAgentDispatcher = {
      async dispatch() {
        await new Promise((r) => setTimeout(r, 200))
        return { text: '', model: 'x', tool_calls: [] }
      },
    }
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    await expect(
      dispatchResearchSubAgent(
        { query: 'a', project_slug: 't', project_id: 'p', budget_ms: 60 },
        { runtime_sub_agent: slow, concurrency_gate: gate },
      ),
    ).rejects.toThrow(SubAgentTimeoutError)
    expect(gate.inFlightFor('t')).toBe(0)
  })

  test('concurrency cap rejects the (cap+1)-th in-flight task', async () => {
    const hangs: RuntimeSubAgentDispatcher = {
      async dispatch() {
        await new Promise((r) => setTimeout(r, 1000))
        return { text: '', model: 'x', tool_calls: [] }
      },
    }
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    // Kick off two concurrent dispatches (no await yet).
    const p1 = dispatchResearchSubAgent(
      { query: 'q1', project_slug: 't', project_id: 'p', budget_ms: 50 },
      { runtime_sub_agent: hangs, concurrency_gate: gate },
    ).catch(() => null)
    const p2 = dispatchResearchSubAgent(
      { query: 'q2', project_slug: 't', project_id: 'p', budget_ms: 50 },
      { runtime_sub_agent: hangs, concurrency_gate: gate },
    ).catch(() => null)
    // Third call hits the cap synchronously inside acquire().
    expect(() =>
      dispatchResearchSubAgent(
        { query: 'q3', project_slug: 't', project_id: 'p', budget_ms: 50 },
        { runtime_sub_agent: hangs, concurrency_gate: gate },
      ),
    ).toThrow(SubAgentConcurrencyExceededError)
    await Promise.all([p1, p2])
  })
})

describe('Atlas-shape system prompt', () => {
  test('base prompt includes the locked persona + tool list + sources-cited invariant', () => {
    const p = buildSubAgentSystemPrompt('what is X')
    expect(p).toContain('Atlas')
    expect(p).toContain('research_vault_search')
    expect(p).toContain('research_web_search')
    expect(p).toContain('research_web_fetch')
    expect(p).toContain('SOURCES-CITED INVARIANT')
    expect(p).toContain('confidence:"unverified"')
  })

  test('engineering-shape queries get the spec-conformance-diff rider', () => {
    const p = buildSubAgentSystemPrompt('how should we shape the migration sprint')
    expect(p).toContain('5-line spec-conformance-diff')
    expect(p).toContain('Engineering-shape topics')
  })

  test('non-engineering queries do NOT get the rider', () => {
    const p = buildSubAgentSystemPrompt('what is the capital of france')
    expect(p).not.toContain('Engineering-shape topics')
  })

  test('isEngineeringShapeQuery — positive + negative samples', () => {
    expect(isEngineeringShapeQuery('design the schema')).toBe(true)
    expect(isEngineeringShapeQuery('sprint plan for Q3')).toBe(true)
    expect(isEngineeringShapeQuery('API contract review')).toBe(true)
    expect(isEngineeringShapeQuery('best vegan ramen in SF')).toBe(false)
  })
})
