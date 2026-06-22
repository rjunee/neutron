import { describe, expect, test } from 'bun:test'

import type { Substrate } from '../../runtime/substrate.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'

import {
  composeJudgePrompt,
  detectCorrection,
  looksLikeCorrection,
  parseJudgment,
} from '../detector.ts'

function completingSubstrate(text: string, onStart?: (spec: unknown) => void): Substrate {
  return {
    start(spec): SessionHandle {
      onStart?.(spec)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'fake' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('no tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

function erroringSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'error', message: 'boom', retryable: false }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

describe('looksLikeCorrection (deterministic pre-gate)', () => {
  test('admits clear correction cues', () => {
    for (const s of [
      'No, that is wrong.',
      'Actually I meant the staging server',
      "don't do that again",
      'use spaces, not tabs',
      'from now on, address me as Ryan',
      'You should be using the v2 API instead',
      'Please always run the tests first',
      'never push to main',
    ]) {
      expect(looksLikeCorrection(s)).toBe(true)
    }
  })

  test('rejects ordinary turns', () => {
    for (const s of [
      'Thanks, that works great',
      'Can you summarize the meeting notes?',
      'What time is the standup tomorrow?',
      'Sounds good to me',
      '',
      '   ',
    ]) {
      expect(looksLikeCorrection(s)).toBe(false)
    }
  })
})

describe('parseJudgment', () => {
  test('parses a direct correction verdict', () => {
    const v = parseJudgment('{"is_correction":true,"wrong":"used tabs","right":"use spaces","why":"style"}')
    expect(v.is_correction).toBe(true)
    expect(v.right).toBe('use spaces')
  })

  test('strips a markdown fence', () => {
    const v = parseJudgment('```json\n{"is_correction":true,"wrong":"","right":"do X","why":""}\n```')
    expect(v.is_correction).toBe(true)
    expect(v.right).toBe('do X')
  })

  test('is_correction:false collapses to the negative verdict', () => {
    const v = parseJudgment('{"is_correction":false,"wrong":"","right":"","why":""}')
    expect(v).toEqual({ is_correction: false, wrong: '', right: '', why: '' })
  })

  test('a correction with no `right` learning is discarded', () => {
    const v = parseJudgment('{"is_correction":true,"wrong":"x","right":"","why":"y"}')
    expect(v.is_correction).toBe(false)
  })

  test('garbage → negative verdict', () => {
    expect(parseJudgment('not json').is_correction).toBe(false)
    expect(parseJudgment('').is_correction).toBe(false)
  })
})

describe('detectCorrection (LLM judge over the substrate)', () => {
  test('returns the parsed verdict and sends a judge prompt', async () => {
    let seen: { prompt?: string } = {}
    const sub = completingSubstrate(
      '{"is_correction":true,"wrong":"assumed prod","right":"default to staging","why":"safer"}',
      (spec) => {
        seen = spec as { prompt?: string }
      },
    )
    const v = await detectCorrection(
      { substrate: sub },
      { user_text: 'no, use staging', agent_text: 'I deployed to prod.' },
    )
    expect(v.is_correction).toBe(true)
    expect(v.right).toBe('default to staging')
    expect(seen.prompt).toContain('learning-keeper')
    expect(seen.prompt).toContain('I deployed to prod.')
    expect(seen.prompt).toContain('no, use staging')
  })

  test('a non-correction exchange yields is_correction:false', async () => {
    const sub = completingSubstrate('{"is_correction":false,"wrong":"","right":"","why":""}')
    const v = await detectCorrection({ substrate: sub }, { user_text: 'thanks!', agent_text: 'done' })
    expect(v.is_correction).toBe(false)
  })

  test('a substrate error propagates as a throw', async () => {
    await expect(
      detectCorrection({ substrate: erroringSubstrate() }, { user_text: 'x', agent_text: 'y' }),
    ).rejects.toThrow(/substrate error/)
  })
})

describe('composeJudgePrompt', () => {
  test('orders assistant reply then owner response', () => {
    const p = composeJudgePrompt('AGENT_SAID', 'OWNER_SAID')
    expect(p.indexOf('AGENT_SAID')).toBeLessThan(p.indexOf('OWNER_SAID'))
  })
})
