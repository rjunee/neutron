/**
 * @neutronai/research-core — sub-agent harness tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_SUB_AGENT_MODEL,
  PerOwnerConcurrencyGate,
  RETRY_FEEDBACK_MARKER,
  SubAgentConcurrencyExceededError,
  SubAgentTimeoutError,
  buildCannedSubAgentDispatcher,
  dispatchResearchSubAgent,
  type RuntimeSubAgentDispatcher,
} from '../src/sub-agent.ts'
import { SONNET_MODEL } from '@neutronai/runtime/models.ts'
import {
  SUB_AGENT_DEFAULT_BUDGET_MS,
  SUB_AGENT_MIN_BUDGET_MS,
} from '../src/manifest.ts'
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
        { runtime_sub_agent: slow, concurrency_gate: gate, min_budget_ms: 0 },
      ),
    ).rejects.toThrow(SubAgentTimeoutError)
    expect(gate.inFlightFor('t')).toBe(0)
  })

  test('outer budget timeout aborts the dispatch signal + releases the slot (Argus r2 BLOCKER orphan-halt)', async () => {
    // The dispatcher hangs past budget_ms; the outer race trips. We assert the
    // slot is released AND the signal handed to the dispatcher is aborted — the
    // hook a long-running agentic dispatch honors to stop burning resources
    // after its concurrency slot is freed.
    let sawSignal: AbortSignal | undefined
    const slow: RuntimeSubAgentDispatcher = {
      async dispatch(input) {
        sawSignal = input.signal
        await new Promise((r) => setTimeout(r, 200))
        return { text: '', model: 'x', tool_calls: [] }
      },
    }
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    await expect(
      dispatchResearchSubAgent(
        { query: 'a', project_slug: 't', project_id: 'p', budget_ms: 40 },
        { runtime_sub_agent: slow, concurrency_gate: gate, min_budget_ms: 0 },
      ),
    ).rejects.toThrow(SubAgentTimeoutError)
    expect(gate.inFlightFor('t')).toBe(0)
    expect(sawSignal).toBeDefined()
    expect(sawSignal!.aborted).toBe(true)
  })

  test('successful dispatch also aborts the signal on completion (idempotent cleanup)', async () => {
    let sawSignal: AbortSignal | undefined
    const ok: RuntimeSubAgentDispatcher = {
      async dispatch(input) {
        sawSignal = input.signal
        return { text: 'x', model: 'm', tool_calls: [] }
      },
    }
    const gate = new PerOwnerConcurrencyGate({ cap: 1 })
    await dispatchResearchSubAgent(
      { query: 'a', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: ok, concurrency_gate: gate },
    )
    expect(gate.inFlightFor('t')).toBe(0)
    // Signal was aborted by the finally after the dispatch already resolved —
    // a harmless no-op for the settled call, proving cleanup always fires.
    expect(sawSignal!.aborted).toBe(true)
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
      { runtime_sub_agent: hangs, concurrency_gate: gate, min_budget_ms: 0 },
    ).catch(() => null)
    const p2 = dispatchResearchSubAgent(
      { query: 'q2', project_slug: 't', project_id: 'p', budget_ms: 50 },
      { runtime_sub_agent: hangs, concurrency_gate: gate, min_budget_ms: 0 },
    ).catch(() => null)
    // Third call hits the cap synchronously inside acquire().
    expect(() =>
      dispatchResearchSubAgent(
        { query: 'q3', project_slug: 't', project_id: 'p', budget_ms: 50 },
        { runtime_sub_agent: hangs, concurrency_gate: gate, min_budget_ms: 0 },
      ),
    ).toThrow(SubAgentConcurrencyExceededError)
    await Promise.all([p1, p2])
  })
})

describe('task 7 — Sonnet default + retry feedback + tools_available', () => {
  // T9 — default sub-agent model is SONNET_MODEL, not a hardcoded Haiku.
  test('T9 DEFAULT_SUB_AGENT_MODEL === SONNET_MODEL', () => {
    expect(DEFAULT_SUB_AGENT_MODEL).toBe(SONNET_MODEL)
  })

  // T10 — retry_feedback threading: absent → user_prompt is the raw query;
  // present → query + marker + feedback appended, system prompt unchanged.
  test('T10 retry_feedback appends after the query behind the marker; system prompt stable', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: 'x' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    await dispatchResearchSubAgent(
      { query: 'how does X work', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(dispatcher.calls[0]!.user_prompt).toBe('how does X work')
    expect(dispatcher.calls[0]!.system_prompt).toContain('Atlas')

    await dispatchResearchSubAgent(
      {
        query: 'how does X work',
        project_slug: 't',
        project_id: 'p',
        retry_feedback: 'your JSON was malformed',
      },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    const retryCall = dispatcher.calls[1]!
    expect(retryCall.user_prompt.startsWith('how does X work')).toBe(true)
    expect(retryCall.user_prompt).toContain(RETRY_FEEDBACK_MARKER)
    expect(retryCall.user_prompt).toContain('your JSON was malformed')
    expect(retryCall.system_prompt).toContain('Atlas')
  })

  // T11 — tools_available passthrough from the dispatcher response.
  test('T11 tools_available: true passes through; absent → false', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [
        { query_match: 'with-tools', text: 'x', tools_available: true },
        { query_match: /./, text: 'x' },
      ],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    const withTools = await dispatchResearchSubAgent(
      { query: 'with-tools please', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(withTools.tools_available).toBe(true)
    const withoutTools = await dispatchResearchSubAgent(
      { query: 'no marker here', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(withoutTools.tools_available).toBe(false)
  })
})

describe('Argus r2 major — budget floor clamp (unrunnable sub-floor budget)', () => {
  // A budget below the agentic loop's `FINALIZE_MARGIN_MS` (20s) forces the
  // sub-agent to finalize on iteration 1 with ZERO tool calls, which trips the
  // orchestrator's grounding gate and fails the whole deep run with a misleading
  // "made zero tool calls" error. The floor guarantees a runnable budget.
  test('a below-floor budget_ms is clamped UP to SUB_AGENT_MIN_BUDGET_MS before dispatch', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: 'x' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    await dispatchResearchSubAgent(
      { query: 'q', project_slug: 't', project_id: 'p', budget_ms: 5_000 },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(dispatcher.calls[0]!.budget_ms).toBe(SUB_AGENT_MIN_BUDGET_MS)
  })

  test('an at-or-above-floor budget_ms passes through unclamped', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: 'x' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    const big = 10 * 60 * 1000
    await dispatchResearchSubAgent(
      { query: 'q', project_slug: 't', project_id: 'p', budget_ms: big },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(dispatcher.calls[0]!.budget_ms).toBe(big)
  })

  test('an omitted budget_ms resolves to the default (which is above the floor)', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: 'x' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    await dispatchResearchSubAgent(
      { query: 'q', project_slug: 't', project_id: 'p' },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate },
    )
    expect(dispatcher.calls[0]!.budget_ms).toBe(SUB_AGENT_DEFAULT_BUDGET_MS)
  })

  test('a non-finite / non-positive budget_ms (NaN, Infinity, 0, negative) falls back to the default, never poisoning Math.max', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      const dispatcher = buildCannedSubAgentDispatcher({
        responses: [{ query_match: /./, text: 'x' }],
      })
      const gate = new PerOwnerConcurrencyGate({ cap: 2 })
      await dispatchResearchSubAgent(
        { query: 'q', project_slug: 't', project_id: 'p', budget_ms: bad },
        { runtime_sub_agent: dispatcher, concurrency_gate: gate },
      )
      expect(dispatcher.calls[0]!.budget_ms).toBe(SUB_AGENT_DEFAULT_BUDGET_MS)
    }
  })

  test('min_budget_ms:0 seam disables the floor (testing seam, not a flag)', async () => {
    const dispatcher = buildCannedSubAgentDispatcher({
      responses: [{ query_match: /./, text: 'x' }],
    })
    const gate = new PerOwnerConcurrencyGate({ cap: 2 })
    await dispatchResearchSubAgent(
      { query: 'q', project_slug: 't', project_id: 'p', budget_ms: 5_000 },
      { runtime_sub_agent: dispatcher, concurrency_gate: gate, min_budget_ms: 0 },
    )
    expect(dispatcher.calls[0]!.budget_ms).toBe(5_000)
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
