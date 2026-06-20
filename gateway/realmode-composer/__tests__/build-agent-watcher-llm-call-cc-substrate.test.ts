/**
 * Sprint cc-substrate-migration-3-sites (2026-05-31).
 *
 * Tests for `buildAgentWatcherLlmCall` — the substrate adapter that wraps
 * a CC-subprocess `Substrate` into the `AgentWatcherLlmCall` closure the
 * inline-comment watcher invokes. Adapter responsibilities:
 *
 *   - return null when substrate is null (no Anthropic credentials)
 *   - pack composedSystem + rendered messages into spec.prompt
 *   - default model = BEST_MODEL; honor input.model override
 *   - splice persona via composeSystemPrompt when personaLoader is non-null
 *   - swallow personaLoader.load() throws (warn + dispatch w/o persona)
 *   - forward call.signal → handle.cancel()
 *   - return {text} from accumulated tokens
 *   - rethrow error events with `agent-watcher:` prefix
 *   - throw on empty prompt
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAgentWatcherLlmCall } from '../build-agent-watcher-llm-call.ts'
import { PersonaPromptLoader } from '../persona-loader.ts'
import { BEST_MODEL } from '../../../runtime/models.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'watcher-llm-call-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

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
    { kind: 'token', text: 'reply' },
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
// 1. null substrate → factory returns null.
// ---------------------------------------------------------------------------

test('null substrate → factory returns null (watcher LLM path disabled)', () => {
  const fn = buildAgentWatcherLlmCall({ substrate: null, url_slug: 't1' })
  expect(fn).toBeNull()
})

// ---------------------------------------------------------------------------
// 2. Packs composedSystem + messages into spec.prompt (no personaLoader).
// ---------------------------------------------------------------------------

test('packs call.system + single-turn message into spec.prompt as "<system>\\n\\n<body>"', async () => {
  const { substrate, seen } = fakeSubstrate()
  const fn = buildAgentWatcherLlmCall({ substrate, url_slug: 't1' })
  expect(fn).not.toBeNull()
  await fn!({
    system: 'You are the reply agent.',
    messages: [{ role: 'user', content: 'Why this comment?' }],
    max_tokens: 200,
  })
  expect(seen.length).toBe(1)
  // Single-turn → renderMessagesArray returns the bare body (no User: prefix).
  expect(seen[0]!.prompt).toBe('You are the reply agent.\n\nWhy this comment?')
})

// ---------------------------------------------------------------------------
// 3. Default model is BEST_MODEL.
// ---------------------------------------------------------------------------

test('default model is BEST_MODEL when input.model is omitted', async () => {
  const { substrate, seen } = fakeSubstrate()
  const fn = buildAgentWatcherLlmCall({ substrate, url_slug: 't1' })
  await fn!({
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 100,
  })
  expect(seen[0]!.model_preference[0]).toBe(BEST_MODEL)
})

// ---------------------------------------------------------------------------
// 4. Passes input.model when supplied.
// ---------------------------------------------------------------------------

test('passes input.model when supplied at factory time', async () => {
  const { substrate, seen } = fakeSubstrate()
  const fn = buildAgentWatcherLlmCall({
    substrate,
    url_slug: 't1',
    model: 'claude-sonnet-4-6',
  })
  await fn!({
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 100,
  })
  expect(seen[0]!.model_preference[0]).toBe('claude-sonnet-4-6')
})

// ---------------------------------------------------------------------------
// 5. Persona splice is applied when personaLoader is non-null.
// ---------------------------------------------------------------------------

test('persona splice applied via composeSystemPrompt when personaLoader returns body', async () => {
  // Seed a real PersonaPromptLoader with one populated file so .load()
  // returns the composed persona block. The composer's `composeSystemPrompt`
  // then layers `# Persona\n\n<persona>\n\n---\n\n<base>`.
  const personaDir = join(tmpRoot, 'persona')
  mkdirSync(personaDir, { recursive: true })
  writeFileSync(join(personaDir, 'SOUL.md'), 'You are Nova.', 'utf8')
  const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
  const persona = await loader.load()
  expect(persona.length).toBeGreaterThan(0) // sanity — loader resolved a body

  const { substrate, seen } = fakeSubstrate()
  const fn = buildAgentWatcherLlmCall({
    substrate,
    url_slug: 't1',
    personaLoader: loader,
  })
  await fn!({
    system: 'WATCHER_BASE',
    messages: [{ role: 'user', content: 'comment body' }],
    max_tokens: 100,
  })
  // composedSystem starts with the `# Persona` header (composeSystemPrompt
  // shape), and the user body lands after `\n\n` post-system.
  const prompt = seen[0]!.prompt
  expect(prompt.startsWith('# Persona')).toBe(true)
  expect(prompt).toContain('You are Nova.')
  expect(prompt).toContain('WATCHER_BASE')
  expect(prompt.endsWith('\n\ncomment body')).toBe(true)
})

// ---------------------------------------------------------------------------
// 6. personaLoader.load() throws → warn + dispatch without persona splice.
// ---------------------------------------------------------------------------

test('personaLoader.load() rejecting → dispatch still fires WITHOUT persona splice', async () => {
  const throwingLoader = {
    async load(): Promise<string> {
      throw new Error('loader exploded')
    },
  } as unknown as PersonaPromptLoader

  const { substrate, seen } = fakeSubstrate()
  const fn = buildAgentWatcherLlmCall({
    substrate,
    url_slug: 't1',
    personaLoader: throwingLoader,
  })
  await fn!({
    system: 'BASE',
    messages: [{ role: 'user', content: 'msg' }],
    max_tokens: 100,
  })
  // Dispatch happened (substrate captured the spec).
  expect(seen.length).toBe(1)
  // No persona splice — prompt is base + body, byte-identical to the
  // no-loader path.
  expect(seen[0]!.prompt).toBe('BASE\n\nmsg')
})

// ---------------------------------------------------------------------------
// 7. call.signal forwards to handle.cancel.
// ---------------------------------------------------------------------------

test('call.signal aborting cancels the inner substrate handle', async () => {
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

  const fn = buildAgentWatcherLlmCall({ substrate, url_slug: 't1' })
  const ac = new AbortController()
  const callPromise = fn!({
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 100,
    signal: ac.signal,
  })
  queueMicrotask(() => ac.abort())
  await expect(callPromise).rejects.toThrow(/agent-watcher:.*aborted/i)
  expect(cancelled.value).toBe(true)
})

// ---------------------------------------------------------------------------
// 8. Returns { text } from accumulated tokens.
// ---------------------------------------------------------------------------

test('returns { text } equal to the concatenated token stream', async () => {
  const { substrate } = fakeSubstrate({
    events: [
      { kind: 'token', text: 'hello ' },
      { kind: 'token', text: 'world' },
      {
        kind: 'completion',
        usage: { input_tokens: 1, output_tokens: 2 },
        substrate_instance_id: 'fake',
      },
    ],
  })
  const fn = buildAgentWatcherLlmCall({ substrate, url_slug: 't1' })
  const out = await fn!({
    system: 's',
    messages: [{ role: 'user', content: 'm' }],
    max_tokens: 100,
  })
  expect(out.text).toBe('hello world')
})

// ---------------------------------------------------------------------------
// 9. Rethrows error events with 'agent-watcher:' prefix.
// ---------------------------------------------------------------------------

test('error events are rethrown with the "agent-watcher:" prefix', async () => {
  const { substrate } = fakeSubstrate({
    events: [{ kind: 'error', message: 'upstream 503', retryable: true }],
  })
  const fn = buildAgentWatcherLlmCall({ substrate, url_slug: 't1' })
  await expect(
    fn!({
      system: 's',
      messages: [{ role: 'user', content: 'm' }],
      max_tokens: 100,
    }),
  ).rejects.toThrow(/agent-watcher:/)
})

// ---------------------------------------------------------------------------
// 10. Empty prompt — production currently builds `<system>\n\n<messages>` so
//     even with system='' + messages=[] the prompt is `"\n\n"` (length 2)
//     and the `prompt.length === 0` guard is unreachable. The watcher's
//     contract relies on the watcher base body always being non-empty (the
//     full reply-agent prompt is non-trivial). This test documents the
//     present behavior so a future tightening of the empty-prompt check
//     (e.g. trim before length) is caught.
// ---------------------------------------------------------------------------

test('empty system + empty messages → dispatch fires with bare "\\n\\n" prompt (empty-prompt guard unreachable today)', async () => {
  const { substrate, seen } = fakeSubstrate()
  const fn = buildAgentWatcherLlmCall({ substrate, url_slug: 't1' })
  await fn!({
    system: '',
    messages: [],
    max_tokens: 100,
  })
  expect(seen.length).toBe(1)
  expect(seen[0]!.prompt).toBe('\n\n')
})
