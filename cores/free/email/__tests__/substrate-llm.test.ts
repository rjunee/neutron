/**
 * Email-Managed Core — substrate-backed Haiku LLM caller.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.3 + § 3.4.
 * Forge fix-pass r1 (2026-05-21) — Argus r1 BLOCKER #1 closure.
 *
 * The factory under test wraps a `Substrate` (runtime/substrate.ts)
 * into a `(prompt: string) => Promise<string>` callable that the
 * Core's `composeTriage` + `composeBriefSummary` consume. These
 * tests assert:
 *
 *   - happy path: substrate emits token events + completion →
 *     joined token text is returned
 *   - prompt + model_preference + max_tokens flow through to
 *     `substrate.start(spec)` unmodified
 *   - error event before completion → throws
 *   - stream ends without completion → throws
 *   - default max_tokens is `DEFAULT_EMAIL_LLM_MAX_TOKENS`
 *   - downstream wiring: `composeTriage` driven by the substrate-
 *     backed callable actually invokes the substrate (the
 *     spec-conformance regression guard against placeholder-LLM
 *     shipping as a no-op)
 */

import { describe, expect, test } from 'bun:test'

import type {
  AgentSpec,
  Event,
  SessionHandle,
  Substrate,
} from '@neutronai/runtime'

import {
  DEFAULT_EMAIL_LLM_MAX_TOKENS,
  buildSubstrateEmailLlm,
} from '../src/substrate-llm.ts'
import { composeTriage } from '../src/triage.ts'
import { composeBriefSummary } from '../src/summarizer.ts'
import type { GmailMessageFull, GmailMessageMeta } from '../src/contract.ts'
import type { EmailSummary } from '../src/summarizer.ts'

interface RecordedCall {
  spec: AgentSpec
}

interface BuildStubSubstrateOpts {
  events?: Event[]
  /** Throw from inside the events generator (mid-stream) instead of
   *  emitting events. */
  midStreamThrow?: Error
}

function buildStubSubstrate(opts: BuildStubSubstrateOpts = {}): {
  substrate: Substrate
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      calls.push({ spec })
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (opts.midStreamThrow !== undefined) {
          throw opts.midStreamThrow
        }
        for (const ev of opts.events ?? []) {
          yield ev
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {
          throw new Error('not implemented')
        },
        async cancel(): Promise<void> {
          /* noop */
        },
        tool_resolution: 'internal' as const,
      }
    },
  }
  return { substrate, calls }
}

function completion(usage = { input_tokens: 1, output_tokens: 2 }): Event {
  return {
    kind: 'completion',
    usage,
    substrate_instance_id: 'test-stub',
  }
}

describe('buildSubstrateEmailLlm — happy path', () => {
  test('joins token events into the returned string', async () => {
    const { substrate } = buildStubSubstrate({
      events: [
        { kind: 'token', text: 'Hello, ' },
        { kind: 'token', text: 'world!' },
        completion(),
      ],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'claude-haiku-4-5-20251001' })
    const out = await llm('prompt body')
    expect(out).toBe('Hello, world!')
  })

  test('forwards prompt + model_preference + max_tokens to substrate.start', async () => {
    const { substrate, calls } = buildStubSubstrate({
      events: [{ kind: 'token', text: 'ok' }, completion()],
    })
    const llm = buildSubstrateEmailLlm({
      substrate,
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
    })
    await llm('the prompt')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.spec.prompt).toBe('the prompt')
    expect(calls[0]!.spec.model_preference).toEqual(['claude-haiku-4-5-20251001'])
    expect(calls[0]!.spec.max_tokens).toBe(256)
    expect(calls[0]!.spec.tools).toEqual([])
  })

  test('default max_tokens is DEFAULT_EMAIL_LLM_MAX_TOKENS', async () => {
    const { substrate, calls } = buildStubSubstrate({
      events: [completion()],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'claude-haiku-4-5-20251001' })
    await llm('prompt')
    expect(calls[0]!.spec.max_tokens).toBe(DEFAULT_EMAIL_LLM_MAX_TOKENS)
  })

  test('ignores non-token / non-error events (thinking, tool_call, status, tool_result_ack)', async () => {
    const { substrate } = buildStubSubstrate({
      events: [
        { kind: 'thinking', text: 'planning…' },
        { kind: 'status', message: 'rotated credential' },
        { kind: 'token', text: 'real text' },
        completion(),
      ],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'm' })
    const out = await llm('prompt')
    expect(out).toBe('real text')
  })
})

describe('buildSubstrateEmailLlm — error paths', () => {
  test('error event before completion → throws', async () => {
    const { substrate } = buildStubSubstrate({
      events: [
        { kind: 'token', text: 'partial' },
        { kind: 'error', message: 'HTTP 429: rate limit', retryable: true },
      ],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'm' })
    await expect(llm('p')).rejects.toThrow(/substrate error/)
  })

  test('stream ends without completion → throws', async () => {
    const { substrate } = buildStubSubstrate({
      events: [{ kind: 'token', text: 'partial' }],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'm' })
    await expect(llm('p')).rejects.toThrow(/without a completion event/)
  })

  test('iterator throws mid-stream → throws', async () => {
    const { substrate } = buildStubSubstrate({
      midStreamThrow: new Error('upstream blew up'),
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'm' })
    await expect(llm('p')).rejects.toThrow(/upstream blew up/)
  })
})

describe('downstream wiring — composeTriage drives the substrate (not the fallback)', () => {
  // Argus r1 BLOCKER #1 closure: assert the substrate-backed LLM
  // is ACTUALLY invoked by composeTriage in the production happy
  // path. Without this guard, a misconfigured wiring that silently
  // routes through the deterministic fallback would pass every
  // surrounding test (the fallback is itself well-behaved). The
  // CLAUDE.md "Spec is the source of truth" forbidden pattern is
  // "placeholder phase-prompt bodies that ship as no-ops" — this
  // test is the regression guard against the same shape recurring
  // for the triage agent.
  test('composeTriage with substrate-backed LLM hits substrate.start exactly once + outcome=ok', async () => {
    const inbox: GmailMessageMeta[] = [
      {
        id: 'm1',
        thread_id: 't1',
        subject: 'unread thing',
        from: 'a@x.com',
        snippet: 's1',
        internal_date: new Date(1000).toISOString(),
        label_ids: ['INBOX', 'UNREAD'],
      },
    ]
    // Substrate emits a JSON-shaped top-5 the triage parser
    // accepts; outcome should be 'ok' (NOT 'llm_error' — which
    // would indicate the fallback ranking fired).
    const jsonBody = JSON.stringify([
      { message_id: 'm1', rank: 1, reason: 'unread ping from a@x.com' },
    ])
    const { substrate, calls } = buildStubSubstrate({
      events: [
        { kind: 'token', text: jsonBody },
        completion(),
      ],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'claude-haiku-4-5-20251001' })
    const triage = await composeTriage({
      inbox,
      userTz: 'UTC',
      llm,
      model: 'claude-haiku-4-5-20251001',
    })
    expect(triage.outcome).toBe('ok')
    expect(triage.items).toHaveLength(1)
    expect(triage.items[0]?.message_id).toBe('m1')
    expect(triage.items[0]?.reason).toBe('unread ping from a@x.com')
    // Crucial assertion: the substrate WAS dispatched. A wiring
    // bug that routed straight to the fallback (or threw before
    // reaching the LLM) would leave `calls.length === 0`.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.spec.prompt.length).toBeGreaterThan(0)
  })

  test('composeBriefSummary with substrate-backed LLM hits substrate.start exactly once + outcome=ok', async () => {
    const message: GmailMessageFull = {
      id: 'msg-1',
      thread_id: 't1',
      subject: 'Quick question',
      from: 'alice@x.com',
      to: ['user@example.com'],
      cc: [],
      snippet: 'Could you review the design today?',
      internal_date: new Date(1000).toISOString(),
      label_ids: ['INBOX'],
      body_text: 'Hi Sam, could you review the design today? Thanks.',
    }
    const structured: EmailSummary = {
      message_id: 'msg-1',
      from: 'alice@x.com',
      subject: 'Quick question',
      key_points: ['Asks for design review today'],
      sentiment: 'neutral',
      ask_or_response: 'ask',
    }
    const briefBody =
      'Alice is asking you to review the design today. She sent the request to you directly, marked the body short, and called out a same-day expectation.'
    const { substrate, calls } = buildStubSubstrate({
      events: [
        { kind: 'token', text: briefBody },
        completion(),
      ],
    })
    const llm = buildSubstrateEmailLlm({ substrate, model: 'claude-haiku-4-5-20251001' })
    const brief = await composeBriefSummary({
      structuredRow: structured,
      rawMessage: message,
      llm,
      model: 'claude-haiku-4-5-20251001',
    })
    expect(brief.outcome).toBe('ok')
    expect(brief.text).toBe(briefBody)
    // Regression guard: substrate.start was actually called.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.spec.prompt).toContain('alice@x.com')
    expect(calls[0]!.spec.prompt).toContain('Asks for design review today')
  })
})
