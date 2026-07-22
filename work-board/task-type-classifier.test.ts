import { describe, expect, test } from 'bun:test'
import type { LlmCallFn } from '@neutronai/contracts/llm-call.ts'
import {
  CLASSIFY_SYSTEM_PROMPT,
  classifyWorkBoardTaskType,
  keywordTaskTypeFallback,
} from './task-type-classifier.ts'

/** A stub LLM returning a fixed string; records the calls it received. */
function stubLlm(reply: string): { llm: LlmCallFn; calls: Array<{ system: string; user: string; max_tokens: number }> } {
  const calls: Array<{ system: string; user: string; max_tokens: number }> = []
  return {
    llm: async (input) => {
      calls.push(input)
      return reply
    },
    calls,
  }
}

describe('classifyWorkBoardTaskType', () => {
  test('LLM path wins over the heuristic (research on a build-keyword title)', async () => {
    const { llm } = stubLlm('research')
    // keyword heuristic would say 'build' for this title.
    expect(keywordTaskTypeFallback('Fix the login bug')).toBe('build')
    const out = await classifyWorkBoardTaskType({ title: 'Fix the login bug', llm })
    expect(out).toBe('research')
  })

  test('LLM path wins over the heuristic (build on a research-keyword title)', async () => {
    const { llm } = stubLlm('build')
    expect(keywordTaskTypeFallback('Research competitor pricing')).toBe('research')
    const out = await classifyWorkBoardTaskType({ title: 'Research competitor pricing', llm })
    expect(out).toBe('build')
  })

  test('junk LLM reply → keyword fallback', async () => {
    const { llm } = stubLlm('I think this is neither')
    const out = await classifyWorkBoardTaskType({ title: 'Research competitor pricing', llm })
    expect(out).toBe('research') // keyword fallback engaged
  })

  test('LLM reply containing BOTH words → keyword fallback', async () => {
    const { llm } = stubLlm('build or research, hard to say')
    // keyword says build for this title → so a both-words reply falls back to build.
    const out = await classifyWorkBoardTaskType({ title: 'Add a settings panel', llm })
    expect(out).toBe('build')
  })

  test('LLM rejects → keyword fallback, promise still RESOLVES', async () => {
    const llm: LlmCallFn = async () => {
      throw new Error('boom')
    }
    const out = await classifyWorkBoardTaskType({ title: 'Compare vector DB options', llm })
    expect(out).toBe('research')
  })

  test('LLM never settles + tiny timeout → keyword fallback', async () => {
    const llm: LlmCallFn = () => new Promise<string>(() => {}) // never resolves
    const out = await classifyWorkBoardTaskType({
      title: 'Ship the dark mode toggle',
      llm,
      timeout_ms: 10,
    })
    expect(out).toBe('build')
  })

  test('llm: null → keyword fallback, no LLM invoked', async () => {
    let invoked = 0
    const spy: LlmCallFn = async () => {
      invoked += 1
      return 'research'
    }
    void spy // never wired
    const out = await classifyWorkBoardTaskType({ title: 'Research pricing', llm: null })
    expect(out).toBe('research')
    expect(invoked).toBe(0)
  })

  test('keywordTaskTypeFallback classification table', () => {
    expect(keywordTaskTypeFallback('Research competitors pricing')).toBe('research')
    expect(keywordTaskTypeFallback('What is the best DB for embeddings?')).toBe('research')
    expect(keywordTaskTypeFallback('Look into the flaky CI job')).toBe('research')
    expect(keywordTaskTypeFallback('Compare vector DB options')).toBe('research')
    expect(keywordTaskTypeFallback('Fix the login bug')).toBe('build')
    expect(keywordTaskTypeFallback('Add pagination to dashboard')).toBe('build')
    expect(keywordTaskTypeFallback('Ship dark mode')).toBe('build')
    expect(keywordTaskTypeFallback('Wire up the webhook retry')).toBe('build')
  })

  test('LLM receives the locked system prompt + title + max_tokens 16', async () => {
    const { llm, calls } = stubLlm('build')
    await classifyWorkBoardTaskType({ title: 'Add a feature', llm })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      system: CLASSIFY_SYSTEM_PROMPT,
      user: 'Add a feature',
      max_tokens: 16,
    })
  })
})
