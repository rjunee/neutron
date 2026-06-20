/**
 * Unit tests for `gateway/cores/code-gen-factory.ts` — the
 * credential-resolving factory for Code-Gen Core's `CodegenLlmCall`.
 *
 * Tests cover:
 *   1. Max OAuth path → `Authorization: Bearer` header.
 *   2. BYO env path → `x-api-key` header.
 *   3. No-credential path → `credential_source: 'none'` + sentinel
 *      `llm_call` that throws `CodegenCredentialUnavailableError`.
 *   4. 401 retry: first call 401s → loader force-refresh → retry once
 *      → success.
 *   5. 401 retry exhausted: both calls 401 →
 *      `CodegenCredentialUnavailableError`.
 *
 * The factory NEVER imports `@anthropic-ai/sdk` statically — every
 * SDK invocation goes through the injected `anthropic_factory`
 * seam. Tests provide a stub matching the narrow
 * `CodegenAnthropicClient` shape; no SDK package is required for
 * these tests to run.
 */

import { describe, expect, test } from 'bun:test'

import {
  buildCodeGenLlmCall,
  CodegenCredentialUnavailableError,
  type CodegenAnthropicClient,
  type CodegenAnthropicFactory,
  type CodegenAuthHeader,
} from '../../cores/code-gen-factory.ts'
import type { OAuthCredentialSource } from '../../realmode-composer/resolve-llm-credentials.ts'
import type {
  CodegenLlmCallInput,
  CodegenLlmCallResult,
} from '../../../cores/free/code-gen/src/substrate-runtime.ts'

const DEFAULT_LLM_INPUT: CodegenLlmCallInput = {
  system: 'you are forge',
  messages: [{ role: 'user', content: 'do the thing' }],
  max_tokens: 1024,
  model: 'claude-sonnet-4-6',
  tools: [],
}

/** Build an OAuthCredentialSource that returns a static token. */
function fixedOAuthSource(
  token: { access_token: string; expires_at: number } | null,
): OAuthCredentialSource {
  return {
    async loadAccessToken() {
      return token
    },
  }
}

/** OAuthCredentialSource backed by a queue — successive calls dequeue. */
function queueOAuthSource(
  tokens: ReadonlyArray<{ access_token: string; expires_at: number } | null>,
): {
  source: OAuthCredentialSource
  calls: number
} {
  let i = 0
  const state = { calls: 0 }
  const source: OAuthCredentialSource = {
    async loadAccessToken() {
      state.calls += 1
      const t = tokens[i] ?? tokens[tokens.length - 1] ?? null
      i += 1
      return t
    },
  }
  return Object.assign(state, { source })
}

/** Disable the OAuth loader's cache so every call hits loadAccessToken. */
function buildPassthroughLoader(): typeof import('../../../runtime/adapters/claude-code/api-key-helper.ts').makeMaxOAuthSubscriptionLoader {
  return (input) => async () => {
    // Always call the source; ignore caching slack so tests can drive
    // the source directly via its queue.
    const cached = await input.loadCached()
    if (cached !== null && cached.access_token.length > 0) {
      return cached
    }
    try {
      const fresh = await input.refresh()
      if (typeof fresh.access_token === 'string' && fresh.access_token.length > 0) {
        return fresh
      }
    } catch {
      // fall through
    }
    return null
  }
}

/** Build a stub anthropic_factory + a captured-headers array. */
function recordingFactory(opts?: {
  responses?: ReadonlyArray<Partial<CodegenLlmCallResult> | Error>
}): {
  factory: CodegenAnthropicFactory
  headers: CodegenAuthHeader[]
  callCount: () => number
} {
  const headers: CodegenAuthHeader[] = []
  const responses = opts?.responses ?? [{ text: 'ok' }]
  let i = 0
  const factory: CodegenAnthropicFactory = ({ auth_header }) => {
    headers.push(auth_header)
    const client: CodegenAnthropicClient = {
      messages: {
        async create(_input) {
          const r = responses[i] ?? responses[responses.length - 1] ?? { text: 'ok' }
          i += 1
          if (r instanceof Error) throw r
          return {
            content: r.text !== undefined ? [{ type: 'text', text: r.text }] : [],
            stop_reason: r.stop_reason ?? 'end_turn',
            model: r.model ?? 'claude-sonnet-4-6',
          }
        },
      },
    }
    return client
  }
  return { factory, headers, callCount: () => i }
}

/** Build an error shape that ducks the SDK's 401 surface. */
function build401Error(): Error & { status: 401 } {
  const e = new Error('Unauthorized') as Error & { status: 401 }
  e.status = 401
  return e
}

describe('buildCodeGenLlmCall — credential resolution', () => {
  test('Max OAuth path resolves to Bearer header', async () => {
    const source = fixedOAuthSource({
      access_token: 'at-fresh-123',
      expires_at: Date.now() + 3_600_000,
    })
    const rec = recordingFactory()
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: source,
      env: {},
      anthropic_factory: rec.factory,
      build_oauth_loader: buildPassthroughLoader(),
    })
    expect(result.credential_source).toBe('max_oauth_subscription')
    expect(result.unavailable_message).toBeUndefined()

    // Invoke the llm_call and assert the captured auth header.
    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.text).toBe('ok')
    expect(rec.headers).toHaveLength(1)
    expect(rec.headers[0]).toEqual({
      name: 'Authorization',
      value: 'Bearer at-fresh-123',
    })
  })

  test('BYO env path resolves to x-api-key header', async () => {
    const rec = recordingFactory()
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: null,
      env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-test-byo-456' },
      anthropic_factory: rec.factory,
    })
    expect(result.credential_source).toBe('byo_env_api_key')
    expect(result.unavailable_message).toBeUndefined()

    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.text).toBe('ok')
    expect(rec.headers).toHaveLength(1)
    expect(rec.headers[0]).toEqual({
      name: 'x-api-key',
      value: 'sk-test-byo-456',
    })
  })

  test('BYO env path also wins when oauth_source is set but returns null', async () => {
    const source = fixedOAuthSource(null)
    const rec = recordingFactory()
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: source,
      env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-fallback' },
      anthropic_factory: rec.factory,
      build_oauth_loader: buildPassthroughLoader(),
    })
    expect(result.credential_source).toBe('byo_env_api_key')

    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.text).toBe('ok')
    expect(rec.headers[0]?.name).toBe('x-api-key')
  })

  test('No-credential path returns sentinel that throws on first call', async () => {
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: null,
      env: {},
    })
    expect(result.credential_source).toBe('none')
    expect(result.unavailable_message).toBeDefined()
    expect(result.unavailable_message).toMatch(/Claude Max|NEUTRON_ANTHROPIC_API_KEY/)

    let caught: unknown
    try {
      await result.llm_call(DEFAULT_LLM_INPUT)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CodegenCredentialUnavailableError)
    expect((caught as CodegenCredentialUnavailableError).code).toBe(
      'codegen_credential_unavailable',
    )
  })

  test('Empty NEUTRON_ANTHROPIC_API_KEY does NOT count as BYO', async () => {
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: null,
      env: { NEUTRON_ANTHROPIC_API_KEY: '' },
    })
    expect(result.credential_source).toBe('none')
  })
})

describe('buildCodeGenLlmCall — Bearer 401 retry', () => {
  test('401 retry: force-refresh once then succeed', async () => {
    // Queue feeds tokens in order. The factory probes once during
    // build, then llm_call fetches once before each SDK attempt; on
    // a 401 we re-fetch via the loader (force-refresh path).
    const queued = queueOAuthSource([
      { access_token: 'at-build-probe', expires_at: Date.now() + 3_600_000 },
      { access_token: 'at-attempt-1', expires_at: Date.now() + 3_600_000 },
      { access_token: 'at-after-refresh', expires_at: Date.now() + 3_600_000 },
    ])
    const rec = recordingFactory({
      responses: [build401Error(), { text: 'recovered' }],
    })
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: queued.source,
      env: {},
      anthropic_factory: rec.factory,
      build_oauth_loader: buildPassthroughLoader(),
    })
    expect(result.credential_source).toBe('max_oauth_subscription')

    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.text).toBe('recovered')

    // Two SDK calls: the failing one + the retry. Each ran against a
    // freshly-loaded token, so the SECOND call uses a strictly-newer
    // token than the first.
    expect(rec.callCount()).toBe(2)
    expect(rec.headers[0]).toEqual({
      name: 'Authorization',
      value: 'Bearer at-attempt-1',
    })
    expect(rec.headers[1]).toEqual({
      name: 'Authorization',
      value: 'Bearer at-after-refresh',
    })

    // The OAuth source was consulted at least 3x: build probe + first
    // attempt + retry force-refresh.
    expect(queued.calls).toBeGreaterThanOrEqual(3)
  })

  test('401 retry exhausted: second 401 raises CodegenCredentialUnavailableError', async () => {
    const queued = queueOAuthSource([
      { access_token: 'at-x', expires_at: Date.now() + 3_600_000 },
      { access_token: 'at-y', expires_at: Date.now() + 3_600_000 },
      { access_token: 'at-z', expires_at: Date.now() + 3_600_000 },
    ])
    const rec = recordingFactory({
      responses: [build401Error(), build401Error()],
    })
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: queued.source,
      env: {},
      anthropic_factory: rec.factory,
      build_oauth_loader: buildPassthroughLoader(),
    })
    expect(result.credential_source).toBe('max_oauth_subscription')

    let caught: unknown
    try {
      await result.llm_call(DEFAULT_LLM_INPUT)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CodegenCredentialUnavailableError)
    expect(rec.callCount()).toBe(2)
  })

  test('non-401 errors are NOT retried — surfaced to caller verbatim', async () => {
    const queued = queueOAuthSource([
      { access_token: 'at-x', expires_at: Date.now() + 3_600_000 },
      { access_token: 'at-x', expires_at: Date.now() + 3_600_000 },
    ])
    const e500 = Object.assign(new Error('Internal Server Error'), { status: 500 })
    const rec = recordingFactory({ responses: [e500] })
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: queued.source,
      env: {},
      anthropic_factory: rec.factory,
      build_oauth_loader: buildPassthroughLoader(),
    })

    let caught: unknown
    try {
      await result.llm_call(DEFAULT_LLM_INPUT)
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(e500)
    // No retry on a 500.
    expect(rec.callCount()).toBe(1)
  })
})

describe('buildCodeGenLlmCall — SDK protocol translation', () => {
  test('translates tool_use blocks into CodegenLlmCallResult.tool_calls', async () => {
    const factory: CodegenAnthropicFactory = () => ({
      messages: {
        async create() {
          return {
            content: [
              { type: 'text', text: 'thinking...' },
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'read',
                input: { path: 'README.md' },
              },
            ],
            stop_reason: 'tool_use',
            model: 'claude-sonnet-4-6',
          }
        },
      },
    })
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: null,
      env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-test' },
      anthropic_factory: factory,
    })
    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.text).toBe('thinking...')
    expect(r.stop_reason).toBe('tool_use')
    expect(r.tool_calls).toHaveLength(1)
    expect(r.tool_calls[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'read',
      input: { path: 'README.md' },
    })
    expect(r.model).toBe('claude-sonnet-4-6')
  })

  test('end_turn with no tool_use yields empty tool_calls', async () => {
    const factory: CodegenAnthropicFactory = () => ({
      messages: {
        async create() {
          return {
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            model: 'claude-sonnet-4-6',
          }
        },
      },
    })
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: null,
      env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-test' },
      anthropic_factory: factory,
    })
    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.text).toBe('done')
    expect(r.tool_calls).toEqual([])
    expect(r.stop_reason).toBe('end_turn')
  })

  test('unknown stop_reason falls back to end_turn', async () => {
    const factory: CodegenAnthropicFactory = () => ({
      messages: {
        async create() {
          return {
            content: [{ type: 'text', text: 'foo' }],
            stop_reason: 'something_new',
            model: 'claude-sonnet-4-6',
          }
        },
      },
    })
    const result = await buildCodeGenLlmCall({
      project_slug: 'acme',
      oauth_source: null,
      env: { NEUTRON_ANTHROPIC_API_KEY: 'sk-test' },
      anthropic_factory: factory,
    })
    const r = await result.llm_call(DEFAULT_LLM_INPUT)
    expect(r.stop_reason).toBe('end_turn')
  })
})
