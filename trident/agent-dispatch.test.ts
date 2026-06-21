import { describe, expect, test } from 'bun:test'
import { dispatchAgent } from './agent-dispatch.ts'
import { AGENT_PROMPT_FALLBACK, DISPATCH_AGENT_KINDS } from './agent-prompts.ts'
import type { TridentDispatch, TridentDispatchInput } from './session.ts'

/**
 * Atlas + Sentinel were not dispatchable before this — the dispatch layer
 * was Forge/Argus-only. These tests pin that all four typed agents can be
 * dispatched through the SAME one-turn closure, AND that each agent's
 * on-disk `prompts/<kind>.md` contract reaches the dispatch as its system
 * prompt (the explicit VERIFY: "assert the loaded prompt reached the agent
 * config, not the inline string").
 */

function recordingDispatch(): {
  dispatch: TridentDispatch
  calls: TridentDispatchInput[]
} {
  const calls: TridentDispatchInput[] = []
  const dispatch: TridentDispatch = async (input) => {
    calls.push(input)
    return { result: `did ${input.kind} work`, status: 'completed' }
  }
  return { dispatch, calls }
}

describe('dispatchAgent — Atlas + Sentinel now dispatchable alongside Forge/Argus', () => {
  for (const kind of DISPATCH_AGENT_KINDS) {
    test(`${kind}: loaded prompts/${kind}.md reaches the dispatch as system`, async () => {
      const { dispatch, calls } = recordingDispatch()
      // Inject a stub loader so the assertion is hermetic — the system
      // prompt the dispatch sees is exactly what the loader returned.
      const FAKE = `SYSTEM CONTRACT FOR ${kind} :: line2`
      const out = await dispatchAgent(
        {
          kind,
          task: 'do the thing',
          repo_path: '/repo',
          model: 'claude-sonnet-4-6',
          timeout_ms: 1000,
        },
        { dispatch, prompt_deps: { load_prompt: () => FAKE } },
      )

      expect(calls).toHaveLength(1)
      const sent = calls[0]!
      expect(sent.kind).toBe(kind)
      // The loaded prompt-file content is the SYSTEM prompt…
      expect(sent.system).toBe(FAKE)
      // …NOT the literal kind label (the old inline behaviour).
      expect(sent.system).not.toBe(kind)
      // …and NOT the inline fallback (the file loaded).
      expect(sent.system).not.toBe(AGENT_PROMPT_FALLBACK[kind])
      // The task is the user turn; a typed dispatch carries no trident phase.
      expect(sent.user_message).toBe('do the thing')
      expect(sent.phase).toBeUndefined()

      expect(out.kind).toBe(kind)
      expect(out.prompt_source).toBe('file')
      expect(out.status).toBe('completed')
      expect(out.result).toBe(`did ${kind} work`)
    })
  }

  test('atlas + sentinel carry their REAL on-disk persona into the dispatch', async () => {
    const { dispatch, calls } = recordingDispatch()
    await dispatchAgent(
      { kind: 'atlas', task: 'research X', repo_path: '/r', model: 'm', timeout_ms: 1 },
      { dispatch },
    )
    await dispatchAgent(
      { kind: 'sentinel', task: 'review Y', repo_path: '/r', model: 'm', timeout_ms: 1 },
      { dispatch },
    )
    expect(calls[0]?.system).toContain('You are Atlas')
    expect(calls[1]?.system).toContain('You are Sentinel')
  })

  test('a missing prompt file degrades to the inline fallback (prompt_source=fallback)', async () => {
    const { dispatch, calls } = recordingDispatch()
    const out = await dispatchAgent(
      { kind: 'atlas', task: 't', repo_path: '/r', model: 'm', timeout_ms: 1 },
      {
        dispatch,
        prompt_deps: {
          load_prompt: () => {
            throw new Error('ENOENT')
          },
        },
      },
    )
    expect(out.prompt_source).toBe('fallback')
    expect(calls[0]?.system).toBe(AGENT_PROMPT_FALLBACK.atlas)
  })

  test('forge + argus still dispatch (no regression to the existing kinds)', async () => {
    const { dispatch, calls } = recordingDispatch()
    const forge = await dispatchAgent(
      { kind: 'forge', task: 'build', repo_path: '/r', model: 'm', timeout_ms: 1 },
      { dispatch, prompt_deps: { load_prompt: () => 'FORGE SYS' } },
    )
    const argus = await dispatchAgent(
      { kind: 'argus', task: 'review', repo_path: '/r', model: 'm', timeout_ms: 1 },
      { dispatch, prompt_deps: { load_prompt: () => 'ARGUS SYS' } },
    )
    expect(forge.kind).toBe('forge')
    expect(argus.kind).toBe('argus')
    expect(calls[0]?.system).toBe('FORGE SYS')
    expect(calls[1]?.system).toBe('ARGUS SYS')
  })

  test('uses the supplied trident_run_id for audit, else mints one', async () => {
    const { dispatch, calls } = recordingDispatch()
    await dispatchAgent(
      {
        kind: 'forge',
        task: 't',
        repo_path: '/r',
        model: 'm',
        timeout_ms: 1,
        trident_run_id: 'run-abc',
      },
      { dispatch },
    )
    await dispatchAgent(
      { kind: 'forge', task: 't', repo_path: '/r', model: 'm', timeout_ms: 1 },
      { dispatch, mint_run_id: () => 'minted-xyz' },
    )
    expect(calls[0]?.trident_run_id).toBe('run-abc')
    expect(calls[1]?.trident_run_id).toBe('minted-xyz')
  })
})
