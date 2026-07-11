/**
 * tests/integration/adapter-equivalence.test.ts
 *
 * Verifies that the same `AgentSpec` produces an equivalent `Event` SHAPE on
 * both the Claude Code adapter and the GPT-5.5 Responses API adapter when both
 * are driven by mocked transports.
 *
 * The point is NOT to verify upstream-API behavior (that's behavioral-spec
 * fixture territory). The point is the substrate contract: same input → same
 * shape of output, regardless of which underlying API the adapter targets —
 * token events that concatenate to the reply, a terminal completion carrying a
 * usage object + session, `tool_resolution='internal'`, and a `respondToTool`
 * that throws.
 *
 * Post-S3 rip-replace the CC adapter is the persistent interactive REPL (no
 * mockable `claude -p` transport), so the CC half is driven by a fake PTY host +
 * the real dev-channel/sink seam. The GPT-5.5 adapter still has a `fetchImpl`
 * seam and is unchanged. Exact usage byte-equality (an artifact of seeding both
 * mocks with the same numbers) is no longer asserted — the REPL surfaces its own
 * usage shape; the contract is "both emit a completion with a usage object".
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { Event } from '@neutronai/runtime/events.ts'
import type { PtyChild, PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
} from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { createGptResponsesApiSubstrate } from '@neutronai/runtime/adapters/gpt-5-5-api/index.ts'
import { getOpenAiModelPreference, OPENAI_BEST_MODEL } from '@neutronai/runtime/models-openai.ts'
import { selectSubstrateFactory } from '@neutronai/runtime/adapters/select-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

function ssePayload(frames: ReadonlyArray<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`).join('\n') + '\n'
}

function mockFetch(body: string): typeof fetch {
  return (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
}

/** A fake `claude`+dev-channel PTY host: serves /health and echoes each
 *  /message back as the given canned reply. */
function makeReplyHost(reply: string): PtyHost {
  return {
    spawn(argv: string[]): PtyChild {
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { turn_id?: string }
            void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 4242 })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 4242,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
}

function ccSubstrateOpts(host: PtyHost) {
  return {
    substrate_instance_id: 'cc-1',
    cwd: '/tmp/neutron-adapter-equiv',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
  } as const
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of events) out.push(e)
  return out
}

function gptBody(): string {
  return ssePayload([
    { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'hello' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: ' world' } },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 7 } },
      },
    },
  ])
}

describe('adapter equivalence (mocked transport)', () => {
  test('CC and GPT-5.5 API produce an equivalent token + completion SHAPE for the same AgentSpec', async () => {
    const cc = createPersistentReplSubstrate(ccSubstrateOpts(makeReplyHost('hello world')))
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk-openai' },
      substrate_instance_id: 'gpt-1',
      mcpResolver: async () => ({}),
      fetchImpl: mockFetch(gptBody()),
    })
    const spec = {
      prompt: 'say hello world',
      tools: [],
      model_preference: ['model-a'],
    }
    const ccEvents = await collect(cc.start(spec).events)
    const gptEvents = await collect(gpt.start(spec).events)

    const ccTokens = ccEvents
      .filter((e) => e.kind === 'token')
      .map((e) => (e as { text: string }).text)
      .join('')
    const gptTokens = gptEvents
      .filter((e) => e.kind === 'token')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(ccTokens).toBe('hello world')
    expect(gptTokens).toBe('hello world')

    const ccComp = ccEvents.find((e) => e.kind === 'completion')
    const gptComp = gptEvents.find((e) => e.kind === 'completion')
    expect(ccComp?.kind).toBe('completion')
    expect(gptComp?.kind).toBe('completion')
    if (ccComp?.kind === 'completion' && gptComp?.kind === 'completion') {
      // Both carry a usage object of the same shape (exact numbers differ — the
      // REPL doesn't parse upstream token usage; GPT does).
      expect(typeof ccComp.usage.input_tokens).toBe('number')
      expect(typeof ccComp.usage.output_tokens).toBe('number')
      expect(typeof gptComp.usage.input_tokens).toBe('number')
      expect(typeof gptComp.usage.output_tokens).toBe('number')
      expect(typeof ccComp.substrate_instance_id).toBe('string')
      expect(typeof gptComp.substrate_instance_id).toBe('string')
      expect(typeof ccComp.session?.id).toBe('string')
      expect(typeof gptComp.session?.id).toBe('string')
    }
  })

  test('both adapters expose tool_resolution=internal and respondToTool throws', async () => {
    const cc = createPersistentReplSubstrate(ccSubstrateOpts(makeReplyHost('ok')))
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt',
      mcpResolver: async () => ({}),
      fetchImpl: mockFetch(gptBody()),
    })
    const ccHandle = cc.start({ prompt: 'x', tools: [], model_preference: ['m'] })
    const gptHandle = gpt.start({ prompt: 'x', tools: [], model_preference: ['m'] })
    expect(ccHandle.tool_resolution).toBe('internal')
    expect(gptHandle.tool_resolution).toBe('internal')
    await expect(ccHandle.respondToTool('x', {})).rejects.toThrow(/respondToTool called on .*tool_resolution=internal/)
    await expect(gptHandle.respondToTool('x', {})).rejects.toThrow(/respondToTool called on .*tool_resolution=internal/)
    await ccHandle.cancel()
    await gptHandle.cancel()
    for await (const _ev of gptHandle.events) {
      // drain
    }
  })

  test('GPT-5.5 API: spec.messages must be replayed in initial request body (Codex r1 P1 fix)', async () => {
    let bodySeen: { input: Array<{ role: string; content: string }> } | undefined
    const recordingFetch = (async (_url: string | URL, init?: RequestInit) => {
      bodySeen = JSON.parse(String(init?.body))
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(gptBody()))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-replay',
      mcpResolver: async () => ({}),
      fetchImpl: recordingFetch,
    })
    const handle = gpt.start({
      prompt: 'and again',
      tools: [],
      model_preference: ['gpt-5-5'],
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
    })
    await collect(handle.events)
    expect(bodySeen).toBeDefined()
    const inputRoles = bodySeen!.input.map((m) => m.role)
    const inputContents = bodySeen!.input.map((m) => m.content)
    expect(inputRoles).toEqual(['user', 'assistant', 'user'])
    expect(inputContents).toEqual(['first', 'reply', 'and again'])
  })

  test('selector-built GPT (gpt-5.6 registry preference) emits the same completion SHAPE as CC', async () => {
    // Drive the GPT adapter through the SAME factory the composer selects for
    // provider='openai', with the registry's gpt-5.6 model preference — proving
    // the swappable path produces a contract-equivalent Event stream.
    const selected = selectSubstrateFactory('openai')
    expect(selected.provider).toBe('openai')
    const gpt = selected.create({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-5-6',
      mcpResolver: async () => ({}),
      fetchImpl: mockFetch(gptBody()),
    })
    const pref = getOpenAiModelPreference()
    expect(pref[0]).toBe(OPENAI_BEST_MODEL)
    const events = await collect(gpt.start({ prompt: 'hi', tools: [], model_preference: pref }).events)
    const tokens = events
      .filter((e) => e.kind === 'token')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(tokens).toBe('hello world')
    const comp = events.find((e) => e.kind === 'completion')
    expect(comp?.kind).toBe('completion')
    if (comp?.kind === 'completion') {
      expect(typeof comp.usage.input_tokens).toBe('number')
      expect(typeof comp.substrate_instance_id).toBe('string')
    }
  })

  test.skipIf(!process.env['OPENAI_API_KEY'])('GPT-5.6 live: smoke test against real OpenAI Responses API', async () => {
    const gpt = createGptResponsesApiSubstrate({
      env: process.env,
      substrate_instance_id: 'gpt-live',
      mcpResolver: async () => ({}),
    })
    const handle = gpt.start({
      prompt: 'reply with the word ok',
      tools: [],
      model_preference: getOpenAiModelPreference(),
      max_tokens: 16,
    })
    const events = await collect(handle.events)
    const completion = events.find((e) => e.kind === 'completion')
    expect(completion?.kind).toBe('completion')
  })
})
