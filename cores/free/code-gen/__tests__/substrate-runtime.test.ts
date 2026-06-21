import { describe, expect, test } from 'bun:test'

import type {
  SubagentDispatchInput,
  SubagentDispatchResult,
} from '../src/runtime-runner.ts'
import {
  buildCannedCodegenLlmCall,
  buildRuntimeSubagentDispatch,
  type CodegenToolBlock,
  type CodegenToolDefinition,
  type CodegenToolHandler,
} from '../src/substrate-runtime.ts'
import {
  ARGUS_TOOL_DEFS as REAL_ARGUS_TOOL_DEFS,
  ATLAS_TOOL_DEFS,
  FORGE_TOOL_DEFS as REAL_FORGE_TOOL_DEFS,
  SENTINEL_TOOL_DEFS,
  buildSentinelToolHandlers,
} from '../src/tool-handlers.ts'

const FORGE_TOOL_DEFS: CodegenToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a file.',
    input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
]

const ARGUS_TOOL_DEFS: CodegenToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a file.',
    input_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
  },
]

function makeInput(overrides: Partial<SubagentDispatchInput> = {}): SubagentDispatchInput {
  return {
    instance_key: 't-1',
    kind: 'forge',
    model: 'claude-sonnet-4-6',
    system: 'be excellent',
    user_message: 'do the thing',
    worktree_path: '/tmp/ws',
    parent_task_id: 'task-1',
    timeout_ms: 60_000,
    ...overrides,
  }
}

const stubHandlers: Record<string, CodegenToolHandler> = {
  read: async () => ({ content: 'stub-result' }),
  bash: async () => ({ content: 'stub-bash' }),
}

describe('buildRuntimeSubagentDispatch', () => {
  test('multi-turn loop with 2 tool_use turns then end_turn produces terminal text', async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'thinking...',
          tool_calls: [
            {
              type: 'tool_use',
              id: 'a',
              name: 'read',
              input: { file: 'x.ts' },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          text: 'considered',
          tool_calls: [
            {
              type: 'tool_use',
              id: 'b',
              name: 'bash',
              input: { command: 'ls' },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          text: 'PR_NUMBER=1\nBRANCH=x\nWORKTREE=/x',
          tool_calls: [],
          stop_reason: 'end_turn',
        },
      ],
    })

    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: stubHandlers },
    })

    const result = await dispatch(makeInput())
    expect(result.status).toBe('completed')
    expect(result.result).toBe('PR_NUMBER=1\nBRANCH=x\nWORKTREE=/x')
    expect(llm.calls.length).toBe(3)
  })

  test('tool dispatch failure returns is_error', async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'reading',
          tool_calls: [
            { type: 'tool_use', id: 'a', name: 'read', input: { file: 'x.ts' } },
          ],
          stop_reason: 'tool_use',
        },
        {
          text: 'recovered',
          tool_calls: [],
          stop_reason: 'end_turn',
        },
      ],
    })

    const handlers: Record<string, CodegenToolHandler> = {
      read: async () => {
        throw new Error('oops')
      },
    }

    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: handlers },
    })

    const result = await dispatch(makeInput())
    expect(result.status).toBe('completed')
    expect(result.result).toBe('recovered')

    // Inspect the second llm_call — its messages[-1] should be the
    // is_error tool_result block.
    const secondCall = llm.calls[1]
    expect(secondCall).toBeDefined()
    const lastMsg = secondCall!.messages[secondCall!.messages.length - 1]
    expect(lastMsg!.role).toBe('user')
    const content = lastMsg!.content
    expect(Array.isArray(content)).toBe(true)
    const arr = content as Array<{
      type: string
      content?: string
      is_error?: boolean
    }>
    expect(arr[0]!.type).toBe('tool_result')
    expect(arr[0]!.is_error).toBe(true)
    expect(arr[0]!.content).toBe('oops')
  })

  test('deadline elapsed returns timed_out', async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'slow',
          tool_calls: [],
          stop_reason: 'end_turn',
          delay_ms: 200,
        },
      ],
    })

    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: stubHandlers },
    })

    // Force the deadline to elapse BEFORE the second tool-use call by
    // scripting the closure to slow each turn.
    const llm2 = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'thinking',
          tool_calls: [
            { type: 'tool_use', id: 'a', name: 'read', input: { file: 'x' } },
          ],
          stop_reason: 'tool_use',
          delay_ms: 100,
        },
        {
          text: 'still thinking',
          tool_calls: [
            { type: 'tool_use', id: 'b', name: 'read', input: { file: 'y' } },
          ],
          stop_reason: 'tool_use',
          delay_ms: 100,
        },
      ],
    })
    const dispatch2 = buildRuntimeSubagentDispatch({
      llm_call: llm2,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: stubHandlers },
    })

    const result = await dispatch2(makeInput({ timeout_ms: 50 }))
    expect(result.status).toBe('timed_out')
    expect(result.result).toBe('timed_out')
    // Silence the unused warning on `dispatch` / `llm` — they're kept
    // to assert the helper is wired up symmetrically.
    void dispatch
    void llm
  })

  test('max_turns_per_subagent exceeded surfaces last text as completed', async () => {
    const responses = Array.from({ length: 51 }, (_, i) => ({
      text: `turn-${i}`,
      tool_calls: [
        {
          type: 'tool_use' as const,
          id: `t-${i}`,
          name: 'read',
          input: { file: 'x.ts' },
        },
      ],
      stop_reason: 'tool_use' as const,
    }))
    const llm = buildCannedCodegenLlmCall({ responses })

    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: stubHandlers },
      max_turns_per_subagent: 50,
    })

    const result = await dispatch(makeInput())
    expect(result.status).toBe('completed')
    // The loop runs exactly 50 turns (indices 0..49) before giving up.
    expect(result.result).toBe('turn-49')
    expect(llm.calls.length).toBe(50)
  })

  test('missing tool handler returns is_error tool_result and loop continues', async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'trying foo',
          tool_calls: [
            { type: 'tool_use', id: 'a', name: 'foo', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        {
          text: 'gave up on foo',
          tool_calls: [],
          stop_reason: 'end_turn',
        },
      ],
    })

    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: {} }, // no handlers
    })

    const result = await dispatch(makeInput())
    expect(result.status).toBe('completed')
    expect(result.result).toBe('gave up on foo')

    const secondCall = llm.calls[1]
    expect(secondCall).toBeDefined()
    const lastMsg = secondCall!.messages[secondCall!.messages.length - 1]
    const arr = lastMsg!.content as Array<{
      type: string
      content?: string
      is_error?: boolean
    }>
    expect(arr[0]!.type).toBe('tool_result')
    expect(arr[0]!.is_error).toBe(true)
    expect(arr[0]!.content).toContain('not available')
  })

  test('lifecycle hooks fire', async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [
        { text: 'done', tool_calls: [], stop_reason: 'end_turn' },
      ],
    })

    let started: { input: SubagentDispatchInput; run_id: string } | undefined
    let completed: { run_id: string; result: SubagentDispatchResult } | undefined

    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: FORGE_TOOL_DEFS, argus: ARGUS_TOOL_DEFS },
      tool_handlers_by_kind: { forge: stubHandlers },
      mint_run_id: () => 'run-fixed-id',
      on_subagent_start: async (input, run_id) => {
        started = { input, run_id }
      },
      on_subagent_complete: async (run_id, result) => {
        completed = { run_id, result }
      },
    })

    const result = await dispatch(makeInput())
    expect(result.subagent_run_id).toBe('run-fixed-id')
    expect(started).toBeDefined()
    expect(started!.run_id).toBe('run-fixed-id')
    expect(completed).toBeDefined()
    expect(completed!.run_id).toBe('run-fixed-id')
    expect(completed!.result.status).toBe('completed')
  })
})

/**
 * Per-kind toolset routing — the seam the round-3 BLOCKER lived at.
 *
 * Before this fix `buildRuntimeSubagentDispatch` branched
 * `kind === 'forge' ? forge_defs : argus_defs`, so EVERY non-forge kind —
 * including the persona agents atlas/sentinel — fell to Argus's read-only
 * `[read, bash]` set and was physically unable to write its deliverable.
 * The trident-side test masked this by stubbing the dispatch and asserting
 * only the system prompt. These tests run the REAL substrate against the
 * REAL production tool defs/handlers and assert the TOOLSET that reaches
 * the model (and the handler that runs) for each kind.
 */
describe('buildRuntimeSubagentDispatch — per-kind toolset routing', () => {
  const realToolDefsByKind = () => ({
    forge: REAL_FORGE_TOOL_DEFS,
    argus: REAL_ARGUS_TOOL_DEFS,
    atlas: ATLAS_TOOL_DEFS,
    sentinel: SENTINEL_TOOL_DEFS,
  })

  const KIND_DEFS = [
    ['forge', REAL_FORGE_TOOL_DEFS],
    ['argus', REAL_ARGUS_TOOL_DEFS],
    ['atlas', ATLAS_TOOL_DEFS],
    ['sentinel', SENTINEL_TOOL_DEFS],
  ] as const

  for (const [kind, expected] of KIND_DEFS) {
    test(`${kind} is offered its OWN toolset on the real substrate seam`, async () => {
      const llm = buildCannedCodegenLlmCall({
        responses: [{ text: 'done', tool_calls: [], stop_reason: 'end_turn' }],
      })
      const dispatch = buildRuntimeSubagentDispatch({
        llm_call: llm,
        tool_defs_by_kind: realToolDefsByKind(),
        tool_handlers_by_kind: { forge: {}, argus: {}, atlas: {}, sentinel: {} },
      })

      await dispatch(makeInput({ kind }))

      const offered = (llm.calls[0]?.tools ?? []).map((t) => t.name)
      expect(offered).toEqual(expected.map((t) => t.name))
      // None of the persona kinds silently collapse onto Argus's set.
      if (kind !== 'argus') {
        expect(offered).not.toEqual(REAL_ARGUS_TOOL_DEFS.map((t) => t.name))
      }
    })
  }

  test('atlas is write-capable; sentinel + argus are read-only (no write/edit)', () => {
    const atlas = ATLAS_TOOL_DEFS.map((t) => t.name)
    expect(atlas).toContain('write')
    expect(atlas).toContain('edit')
    for (const defs of [SENTINEL_TOOL_DEFS, REAL_ARGUS_TOOL_DEFS]) {
      const names = defs.map((t) => t.name)
      expect(names).not.toContain('write')
      expect(names).not.toContain('edit')
    }
  })

  test("atlas's write tool_use is dispatched to a real handler (Atlas can write)", async () => {
    const writes: Record<string, unknown>[] = []
    const atlasHandlers: Record<string, CodegenToolHandler> = {
      write: async (input) => {
        writes.push(input)
        return { content: 'wrote out.md' }
      },
    }
    const llm = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'writing the deliverable',
          tool_calls: [
            {
              type: 'tool_use',
              id: 'w',
              name: 'write',
              input: { file: 'out.md', content: 'hi' },
            },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', tool_calls: [], stop_reason: 'end_turn' },
      ],
    })
    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: realToolDefsByKind(),
      tool_handlers_by_kind: { atlas: atlasHandlers },
    })

    const out = await dispatch(makeInput({ kind: 'atlas' }))
    expect(out.status).toBe('completed')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ file: 'out.md', content: 'hi' })
  })

  test("sentinel's write tool_use is rejected — it has no write handler", async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [
        {
          text: 'attempting to mutate',
          tool_calls: [
            { type: 'tool_use', id: 'w', name: 'write', input: { file: 'x' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'gave up', tool_calls: [], stop_reason: 'end_turn' },
      ],
    })
    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: realToolDefsByKind(),
      tool_handlers_by_kind: { sentinel: buildSentinelToolHandlers() },
    })

    await dispatch(makeInput({ kind: 'sentinel' }))

    const secondCall = llm.calls[1]
    expect(secondCall).toBeDefined()
    const lastMsg = secondCall!.messages[secondCall!.messages.length - 1]
    const arr = lastMsg!.content as Array<{
      type: string
      content?: string
      is_error?: boolean
    }>
    expect(arr[0]!.type).toBe('tool_result')
    expect(arr[0]!.is_error).toBe(true)
    expect(arr[0]!.content).toContain('not available')
  })

  test('a kind with no configured toolset throws (no silent fallback)', async () => {
    const llm = buildCannedCodegenLlmCall({
      responses: [{ text: 'x', tool_calls: [], stop_reason: 'end_turn' }],
    })
    const dispatch = buildRuntimeSubagentDispatch({
      llm_call: llm,
      tool_defs_by_kind: { forge: REAL_FORGE_TOOL_DEFS }, // atlas omitted
      tool_handlers_by_kind: { forge: {} },
    })

    expect(dispatch(makeInput({ kind: 'atlas' }))).rejects.toThrow(
      /no tool defs configured for sub-agent kind 'atlas'/,
    )
  })
})

describe('buildCannedCodegenLlmCall', () => {
  test('fixture helper round-trips inputs into calls[]', async () => {
    const canned = buildCannedCodegenLlmCall({
      responses: [
        { text: 'a', tool_calls: [], stop_reason: 'end_turn' },
        { text: 'b', tool_calls: [], stop_reason: 'end_turn' },
        { text: 'c', tool_calls: [], stop_reason: 'end_turn' },
      ],
    })

    const fire = async (msg: string) =>
      await canned({
        system: 's',
        messages: [{ role: 'user', content: msg }],
        max_tokens: 8192,
        model: 'claude-sonnet-4-6',
      })

    const r1 = await fire('one')
    const r2 = await fire('two')
    const r3 = await fire('three')

    expect(r1.text).toBe('a')
    expect(r2.text).toBe('b')
    expect(r3.text).toBe('c')
    expect(canned.calls.length).toBe(3)
    expect((canned.calls[0]!.messages[0]!.content as string)).toBe('one')
    expect((canned.calls[1]!.messages[0]!.content as string)).toBe('two')
    expect((canned.calls[2]!.messages[0]!.content as string)).toBe('three')
  })

  test('throws clear error when no response matches', async () => {
    const canned = buildCannedCodegenLlmCall({ responses: [] })
    expect(
      canned({
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 8192,
        model: 'claude-sonnet-4-6',
      }),
    ).rejects.toThrow(/no response configured/)
  })
})

// Silence unused-import lint on the tool-block type — it documents the
// expected shape of tool_calls in the scripted responses above.
void (null as unknown as CodegenToolBlock)
