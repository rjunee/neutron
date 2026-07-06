/**
 * Sprint cc-substrate-migration-3-sites (2026-05-31).
 *
 * Renamed from `build-llm-router-cc-substrate.test.ts` (K11a2 — refactor
 * unit; `buildGatewayAnthropicMessagesClient` moved out of
 * `build-llm-router.ts` into its own module, `build-anthropic-messages-client.ts`).
 *
 * Tests for `buildGatewayAnthropicMessagesClient` — the substrate adapter
 * that wraps a CC-subprocess `Substrate` into the `AnthropicMessagesClient`
 * shape the LLM router expects. The adapter packs `system + messages` into
 * `spec.prompt`, dispatches via `substrate.start(spec)`, and accumulates
 * `token` events into the returned `AnthropicMessageResponse.content[0].text`.
 *
 * Uses a `fakeSubstrate(...)` helper (NOT the spawn stub from
 * build-import-substrate.test.ts — that's for testing the substrate itself;
 * here we just need a `Substrate` stub that yields canned events while
 * capturing the inbound spec).
 */

import { expect, test } from 'bun:test'

import { buildGatewayAnthropicMessagesClient } from '../build-anthropic-messages-client.ts'
import { BEST_MODEL } from '../../../runtime/models.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'

/**
 * Capture-and-yield Substrate stub. Each `start(spec)` call records the
 * spec into `seen` and returns a SessionHandle whose `events` iterator
 * emits the canned sequence supplied at construction (or a default of
 * a single token + completion).
 */
function fakeSubstrate(opts?: {
  events?: ReadonlyArray<Event>
}): {
  substrate: Substrate
  seen: AgentSpec[]
  cancelled: { value: boolean }
} {
  const seen: AgentSpec[] = []
  const cancelled = { value: false }
  const defaultEvents: Event[] = [
    { kind: 'token', text: 'ok' },
    {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: 'fake',
    },
  ]
  const events = opts?.events ?? defaultEvents
  return {
    cancelled,
    seen,
    substrate: {
      start(spec: AgentSpec): SessionHandle {
        seen.push(spec)
        const iter = (async function* (): AsyncGenerator<Event, void, void> {
          for (const ev of events) {
            yield ev
          }
        })()
        const handle: SessionHandle = {
          events: iter,
          async respondToTool(): Promise<void> {
            throw new Error('not supported')
          },
          async cancel(): Promise<void> {
            cancelled.value = true
          },
          tool_resolution: 'internal',
        }
        return handle
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Packs system + single-turn message into spec.prompt.
// ---------------------------------------------------------------------------

test('packs system + single-turn message into spec.prompt as "<system>\\n\\n<body>"', async () => {
  const { substrate, seen } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  await client.messages.create({
    model: 'claude-opus-4-7',
    system: 'You are a classifier.',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 100,
  })
  expect(seen.length).toBe(1)
  expect(seen[0]!.prompt).toBe('You are a classifier.\n\nhello')
})

// ---------------------------------------------------------------------------
// 2. args.model wins (Argus r1 BLOCKING #1, 2026-05-31).
//
// The router escalates Haiku → Sonnet per-pass via args.model on the SAME
// AnthropicMessagesClient instance. If the adapter discards args.model and
// forces the factory default, every pass dispatches the same model — the
// escalation path is dead, both passes run inside the wrong timeout, and the
// `[llm-router]` log lines report the wrong model so incidents like the
// Sonnet 429 line recorded in docs/research/AS-BUILT-archive-2026-07.md
// become unattributable.
// ---------------------------------------------------------------------------

test('args.model ALWAYS wins (Haiku→Sonnet escalation depends on this)', async () => {
  const { substrate, seen } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({
    substrate,
    default_model: 'claude-opus-4-7',
  })
  await client.messages.create({
    model: 'claude-haiku-4-5-20251001', // pass 1: fast model
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
  })
  expect(seen[0]!.model_preference[0]).toBe('claude-haiku-4-5-20251001')
  await client.messages.create({
    model: 'claude-sonnet-4-6', // pass 2: smart model on the SAME client
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
  })
  expect(seen[1]!.model_preference[0]).toBe('claude-sonnet-4-6')
})

// ---------------------------------------------------------------------------
// 3. default_model is BEST_MODEL when omitted AND args.model is undefined.
//
// Note: AnthropicMessagesClient's interface requires `model` on create(),
// so in practice this defensive default rarely fires. We pin it as the
// fallback shape for any future caller that accidentally omits args.model.
// ---------------------------------------------------------------------------

test('default_model is BEST_MODEL fallback when args.model is undefined', async () => {
  const { substrate, seen } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  await client.messages.create({
    model: undefined as unknown as string, // simulate a forgetful caller
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
  })
  expect(seen[0]!.model_preference[0]).toBe(BEST_MODEL)
})

test('default_model override is used when args.model is undefined', async () => {
  const { substrate, seen } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({
    substrate,
    default_model: 'claude-sonnet-4-6',
  })
  await client.messages.create({
    model: undefined as unknown as string,
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
  })
  expect(seen[0]!.model_preference[0]).toBe('claude-sonnet-4-6')
})

// ---------------------------------------------------------------------------
// 4. tools: [] always.
// ---------------------------------------------------------------------------

test('captured spec.tools is always empty (router never declares tools)', async () => {
  const { substrate, seen } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  await client.messages.create({
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
  })
  expect(seen[0]!.tools.length).toBe(0)
})

// ---------------------------------------------------------------------------
// 5. Multi-turn messages render as User:/Assistant:/User: sequence.
// ---------------------------------------------------------------------------

test('multi-turn messages render with explicit User: / Assistant: prefixes', async () => {
  const { substrate, seen } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  await client.messages.create({
    model: 'm',
    system: 's',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'q' },
    ],
    max_tokens: 50,
  })
  expect(seen[0]!.prompt).toBe('s\n\nUser: hi\n\nAssistant: hello\n\nUser: q')
})

// ---------------------------------------------------------------------------
// 6. Returns { content: [{ text: <accumulated tokens> }] }.
// ---------------------------------------------------------------------------

test('returns content[0].text equal to the accumulated token stream', async () => {
  const { substrate } = fakeSubstrate({
    events: [
      { kind: 'token', text: '{"action":"advance"}' },
      {
        kind: 'completion',
        usage: { input_tokens: 1, output_tokens: 1 },
        substrate_instance_id: 'fake',
      },
    ],
  })
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  const resp = await client.messages.create({
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
  })
  expect(resp.content.length).toBe(1)
  expect(resp.content[0]!.text).toBe('{"action":"advance"}')
})

// ---------------------------------------------------------------------------
// 7. Rethrows error events with 'llm-router:' prefix.
// ---------------------------------------------------------------------------

test('error events are rethrown with the "llm-router:" prefix', async () => {
  const { substrate } = fakeSubstrate({
    events: [{ kind: 'error', message: 'rate_limit: x', retryable: true }],
  })
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  await expect(
    client.messages.create({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'm' }],
      max_tokens: 50,
    }),
  ).rejects.toThrow(/llm-router:.*rate_limit/)
})

// ---------------------------------------------------------------------------
// 8. signal.abort() cancels the handle.
// ---------------------------------------------------------------------------

test('AbortSignal firing cancels the handle (collectTokensToString rethrows as aborted)', async () => {
  // Build a fake substrate whose events generator never completes
  // synchronously — uses a deferred promise so we can observe the abort
  // landing.
  let resolveBlock: () => void
  const blockPromise = new Promise<void>((r) => {
    resolveBlock = r
  })
  const cancelled = { value: false }
  const substrate: Substrate = {
    start(): SessionHandle {
      const iter = (async function* (): AsyncGenerator<Event, void, void> {
        await blockPromise
        yield {
          kind: 'completion',
          usage: { input_tokens: 0, output_tokens: 0 },
          substrate_instance_id: 'fake',
        }
      })()
      return {
        events: iter,
        async respondToTool(): Promise<void> {
          throw new Error('not supported')
        },
        async cancel(): Promise<void> {
          cancelled.value = true
          resolveBlock()
        },
        tool_resolution: 'internal',
      }
    },
  }

  const client = buildGatewayAnthropicMessagesClient({ substrate })
  const ac = new AbortController()
  const callPromise = client.messages.create({
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 50,
    signal: ac.signal,
  })
  // Fire abort after the call is in-flight.
  queueMicrotask(() => ac.abort())
  await expect(callPromise).rejects.toThrow(/llm-router:.*aborted/i)
  expect(cancelled.value).toBe(true)
})

// ---------------------------------------------------------------------------
// 9. Throws on empty prompt.
// ---------------------------------------------------------------------------

test('empty system + empty messages throws an "empty prompt" error', async () => {
  const { substrate } = fakeSubstrate()
  const client = buildGatewayAnthropicMessagesClient({ substrate })
  await expect(
    client.messages.create({
      model: 'm',
      system: '',
      messages: [],
      max_tokens: 50,
    }),
  ).rejects.toThrow(/empty prompt/)
})
