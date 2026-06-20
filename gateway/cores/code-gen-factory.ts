/**
 * @neutronai/gateway/cores — Code-Gen Core LLM-call credential factory.
 *
 * THE SOLE FILE in the Neutron repo that imports `@anthropic-ai/sdk`
 * for Code-Gen. The Core (`cores/free/code-gen/`) stays substrate-
 * agnostic — it programs against the narrow `CodegenLlmCall` closure
 * interface; this factory builds the closure against the resolved
 * owner credential.
 *
 * Resolution order (matches the locked spec in
 * docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
 * § Phase 4):
 *
 *   1. Anthropic Max OAuth via the per-instance
 *      `OAuthCredentialSource.loadAccessToken(internal_handle)` (the
 *      production composer already wires `wrapMaxOAuthSource(maxOAuth-
 *      Client)` against `MaxOAuthClient.getAccessToken`). When the
 *      loader returns a non-null `{access_token, expires_at}` we build
 *      an `llm_call` that emits `Authorization: Bearer <access_token>`
 *      and force-refreshes once on HTTP 401.
 *
 *   2. BYO `NEUTRON_ANTHROPIC_API_KEY` env var. When set and non-empty
 *      we build an `llm_call` that emits `x-api-key: <key>`.
 *
 *   3. Neither — return a sentinel `llm_call` that throws
 *      `CodegenCredentialUnavailableError` on first invocation, with a
 *      friendly install-hint message. `install_ok` stays TRUE; the chat
 *      surface (`/code <task>`) catches the error at dispatch time and
 *      surfaces the message to the user.
 *
 * The SDK import lives behind a dynamic `await import('@anthropic-ai/
 * sdk')` inside the default `anthropic_factory` so an instance without
 * Max OAuth or BYO env never loads the module. Tests inject their own
 * `anthropic_factory` and the SDK is never required to be installed
 * for `bun test` to pass.
 */

import {
  makeMaxOAuthSubscriptionLoader,
  type MaxOAuthSubscriptionLoader,
} from '../../runtime/adapters/claude-code/api-key-helper.ts'
import type {
  CodegenLlmCall,
  CodegenLlmCallInput,
  CodegenLlmCallResult,
  CodegenMessage,
  CodegenMessageContent,
  CodegenStopReason,
  CodegenToolBlock,
} from '../../cores/free/code-gen/src/substrate-runtime.ts'
import type { OAuthCredentialSource } from '../realmode-composer/resolve-llm-credentials.ts'

/** Friendly install hint surfaced to users when no Anthropic credential resolves. */
export const CODEGEN_UNAVAILABLE_MESSAGE =
  'Link your Claude Max account in Settings → Connectors → Anthropic, or set NEUTRON_ANTHROPIC_API_KEY env, to enable Code-Gen.'

/**
 * Thrown by the sentinel `llm_call` returned when neither Max OAuth nor
 * BYO env credentials resolve, AND by the Bearer-variant on persistent
 * 401 (after a single force-refresh retry).
 */
export class CodegenCredentialUnavailableError extends Error {
  readonly code = 'codegen_credential_unavailable' as const
  override readonly name = 'CodegenCredentialUnavailableError'
  constructor(message: string, readonly cause_error?: unknown) {
    super(message)
  }
}

/* ============== narrow SDK shape — injected via anthropic_factory ============== */

/** Auth header the factory plumbs into the SDK client. */
export interface CodegenAuthHeader {
  name: 'Authorization' | 'x-api-key'
  value: string
}

/**
 * The narrow Anthropic SDK surface this file consumes. Structural typing
 * keeps the static dependency on `@anthropic-ai/sdk` out of the file —
 * the default factory dynamically imports the real SDK; tests can pass
 * a stub matching this shape without installing anything.
 */
export interface CodegenAnthropicClient {
  messages: {
    create(input: {
      model: string
      max_tokens: number
      system?: string
      messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
      tools?: unknown[]
    }): Promise<CodegenAnthropicResponse>
  }
}

/** Subset of the SDK's `Message` response we read. */
export interface CodegenAnthropicResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >
  stop_reason: string | null
  model: string
}

/**
 * Construct a configured Anthropic SDK client (or a stub matching the
 * shape) from an auth header.
 */
export type CodegenAnthropicFactory = (input: {
  auth_header: CodegenAuthHeader
}) => CodegenAnthropicClient

/* ============== public API ============== */

export interface BuildCodeGenLlmCallOptions {
  /** Frozen instance `internal_handle` — passed to the OAuth loader. */
  project_slug: string
  /**
   * Anthropic Max OAuth source. Production wires
   * `wrapMaxOAuthSource(maxOAuthClient)`; tests pass a stub. Pass
   * `null` to skip the Max OAuth resolution step entirely (forces fall-
   * through to BYO env or the no-credential sentinel).
   */
  oauth_source: OAuthCredentialSource | null
  /** Env bag — read `NEUTRON_ANTHROPIC_API_KEY` (BYO fallback). */
  env: Readonly<Record<string, string | undefined>>
  /** SDK factory — defaults to dynamic `await import('@anthropic-ai/sdk')`. */
  anthropic_factory?: CodegenAnthropicFactory
  /** OAuth-loader factory — testing seam. */
  build_oauth_loader?: typeof makeMaxOAuthSubscriptionLoader
}

export interface BuildCodeGenLlmCallResult {
  llm_call: CodegenLlmCall
  credential_source: 'max_oauth_subscription' | 'byo_env_api_key' | 'none'
  /** Surfaced via the chat-bridge when `credential_source === 'none'`. */
  unavailable_message?: string
}

/**
 * Resolve an owner credential and build the `CodegenLlmCall` closure the
 * Code-Gen Core consumes. See file header for the resolution order.
 */
export async function buildCodeGenLlmCall(
  opts: BuildCodeGenLlmCallOptions,
): Promise<BuildCodeGenLlmCallResult> {
  const anthropic_factory = opts.anthropic_factory ?? defaultAnthropicFactory

  // 1. Anthropic Max OAuth — when an oauth_source is wired.
  if (opts.oauth_source !== null) {
    const build_loader = opts.build_oauth_loader ?? makeMaxOAuthSubscriptionLoader
    const oauth_source = opts.oauth_source
    const loader: MaxOAuthSubscriptionLoader = build_loader({
      instance_slug: opts.project_slug,
      loadCached: () => oauth_source.loadAccessToken(opts.project_slug),
      // Force-refresh: same path. The MaxOAuthClient's `getAccessToken`
      // re-promotes the refresh row on demand, so calling the source
      // again after a 401 surfaces a fresh token. When the source
      // returns null we surface a sentinel empty token — the loader's
      // own check (`refreshed.access_token.length === 0 → return null`)
      // treats that as "no credential, fall through" rather than
      // bubbling an exception up through `buildCodeGenLlmCall`.
      refresh: async () => {
        const r = await oauth_source.loadAccessToken(opts.project_slug)
        if (r === null) {
          return { access_token: '', expires_at: 0 }
        }
        return r
      },
    })
    const initial = await loader()
    if (initial !== null && initial.access_token.length > 0) {
      const llm_call = buildBearerLlmCall({
        loader,
        anthropic_factory,
        unavailable_message: CODEGEN_UNAVAILABLE_MESSAGE,
      })
      return { llm_call, credential_source: 'max_oauth_subscription' }
    }
  }

  // 2. BYO NEUTRON_ANTHROPIC_API_KEY env var.
  const env_key = opts.env['NEUTRON_ANTHROPIC_API_KEY']
  if (typeof env_key === 'string' && env_key.length > 0) {
    const llm_call = buildApiKeyLlmCall({
      api_key: env_key,
      anthropic_factory,
    })
    return { llm_call, credential_source: 'byo_env_api_key' }
  }

  // 3. No credential — sentinel closure that throws on first call.
  const llm_call: CodegenLlmCall = async () => {
    throw new CodegenCredentialUnavailableError(CODEGEN_UNAVAILABLE_MESSAGE)
  }
  return {
    llm_call,
    credential_source: 'none',
    unavailable_message: CODEGEN_UNAVAILABLE_MESSAGE,
  }
}

/* ============== internal — Bearer (Max OAuth) variant ============== */

interface BuildBearerLlmCallInput {
  loader: MaxOAuthSubscriptionLoader
  anthropic_factory: CodegenAnthropicFactory
  unavailable_message: string
}

/**
 * Build a `CodegenLlmCall` that emits `Authorization: Bearer <access_token>`.
 * On the first 401 from the SDK we re-invoke the loader (which force-
 * refreshes when stale) and retry ONCE. On the second 401 we throw
 * `CodegenCredentialUnavailableError` with the underlying error attached.
 */
function buildBearerLlmCall(input: BuildBearerLlmCallInput): CodegenLlmCall {
  return async function bearerLlmCall(
    call_input: CodegenLlmCallInput,
  ): Promise<CodegenLlmCallResult> {
    const first = await input.loader()
    if (first === null || first.access_token.length === 0) {
      throw new CodegenCredentialUnavailableError(input.unavailable_message)
    }
    try {
      return await invokeAnthropic({
        auth_header: { name: 'Authorization', value: `Bearer ${first.access_token}` },
        anthropic_factory: input.anthropic_factory,
        call_input,
      })
    } catch (err) {
      if (!is401Error(err)) throw err
      // Force-refresh and retry once. The loader internally re-issues
      // a fresh access_token when the cached one is stale or expired.
      const retry = await input.loader()
      if (retry === null || retry.access_token.length === 0) {
        throw new CodegenCredentialUnavailableError(input.unavailable_message, err)
      }
      try {
        return await invokeAnthropic({
          auth_header: { name: 'Authorization', value: `Bearer ${retry.access_token}` },
          anthropic_factory: input.anthropic_factory,
          call_input,
        })
      } catch (retryErr) {
        if (is401Error(retryErr)) {
          throw new CodegenCredentialUnavailableError(input.unavailable_message, retryErr)
        }
        throw retryErr
      }
    }
  }
}

/* ============== internal — x-api-key (BYO) variant ============== */

interface BuildApiKeyLlmCallInput {
  api_key: string
  anthropic_factory: CodegenAnthropicFactory
}

function buildApiKeyLlmCall(input: BuildApiKeyLlmCallInput): CodegenLlmCall {
  return async function apiKeyLlmCall(
    call_input: CodegenLlmCallInput,
  ): Promise<CodegenLlmCallResult> {
    return invokeAnthropic({
      auth_header: { name: 'x-api-key', value: input.api_key },
      anthropic_factory: input.anthropic_factory,
      call_input,
    })
  }
}

/* ============== internal — protocol translation ============== */

interface InvokeAnthropicInput {
  auth_header: CodegenAuthHeader
  anthropic_factory: CodegenAnthropicFactory
  call_input: CodegenLlmCallInput
}

async function invokeAnthropic(input: InvokeAnthropicInput): Promise<CodegenLlmCallResult> {
  const client = input.anthropic_factory({ auth_header: input.auth_header })
  const sdk_input: Parameters<typeof client.messages.create>[0] = {
    model: input.call_input.model,
    max_tokens: input.call_input.max_tokens,
    messages: input.call_input.messages.map(toSdkMessage),
  }
  if (input.call_input.system.length > 0) sdk_input.system = input.call_input.system
  if (input.call_input.tools !== undefined && input.call_input.tools.length > 0) {
    sdk_input.tools = input.call_input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
  }
  const response = await client.messages.create(sdk_input)
  return translateSdkResponse(response)
}

function toSdkMessage(m: CodegenMessage): { role: 'user' | 'assistant'; content: unknown } {
  // The SDK accepts the same string-or-block-array shape we expose on
  // CodegenMessage.content; we pass it through verbatim.
  return { role: m.role, content: m.content as unknown as CodegenMessageContent }
}

const VALID_STOP_REASONS: ReadonlyArray<CodegenStopReason> = [
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'pause_turn',
  'refusal',
]

function translateSdkResponse(res: CodegenAnthropicResponse): CodegenLlmCallResult {
  const text_parts: string[] = []
  const tool_calls: CodegenToolBlock[] = []
  for (const block of res.content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      text_parts.push((block as { text: string }).text)
    } else if (block.type === 'tool_use') {
      const tu = block as { id?: unknown; name?: unknown; input?: unknown }
      if (typeof tu.id === 'string' && typeof tu.name === 'string') {
        tool_calls.push({
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input:
            tu.input !== null && typeof tu.input === 'object'
              ? (tu.input as Record<string, unknown>)
              : {},
        })
      }
    }
    // Other block types (thinking, server_tool_use, etc.) are ignored
    // — the Code-Gen substrate doesn't expose them.
  }
  const raw_reason = typeof res.stop_reason === 'string' ? res.stop_reason : 'end_turn'
  const stop_reason: CodegenStopReason = VALID_STOP_REASONS.includes(
    raw_reason as CodegenStopReason,
  )
    ? (raw_reason as CodegenStopReason)
    : 'end_turn'
  return {
    text: text_parts.join(''),
    tool_calls,
    stop_reason,
    model: res.model,
  }
}

/* ============== internal — 401 detection ============== */

/**
 * Detect a 401 response from the Anthropic SDK. The SDK throws an
 * `APIError` subclass with a numeric `.status` property; we duck-type
 * to avoid a static dependency on the SDK class hierarchy.
 */
function is401Error(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') return status === 401
  // Some SDK error subclasses surface the status on `.statusCode` or as
  // a string-shaped `code`. Defensive against future SDK shape drift.
  const statusCode = (err as { statusCode?: unknown }).statusCode
  if (typeof statusCode === 'number') return statusCode === 401
  return false
}

/* ============== default real-SDK factory ============== */

/**
 * Default factory — dynamically imports `@anthropic-ai/sdk` so an instance
 * without Max OAuth or BYO env never loads the module. The SDK's
 * default export is the `Anthropic` constructor.
 *
 * The auth header is plumbed via `defaultHeaders` — Bearer for Max
 * OAuth, x-api-key for BYO. We also pass `apiKey: ''` to suppress the
 * SDK's "API key required" runtime check (the Bearer header is the
 * actual auth surface for Max OAuth tokens).
 */
const defaultAnthropicFactory: CodegenAnthropicFactory = (input) => {
  const auth_header = input.auth_header
  return {
    messages: {
      async create(create_input) {
        // Dynamic import — keeps the SDK out of the bundle for instances
        // who never resolve a credential. The import specifier is
        // built from a runtime-only expression so the TS compiler
        // doesn't statically resolve `@anthropic-ai/sdk`; the package
        // is loaded at runtime only when an instance actually attempts a
        // Code-Gen LLM call (instances without Max OAuth + without
        // NEUTRON_ANTHROPIC_API_KEY never reach this path).
        //
        // Production deploys MUST add `@anthropic-ai/sdk` to the
        // gateway's runtime dependencies; the import will throw at
        // first invocation otherwise.
        const sdkSpecifier = '@anthropic-ai/sdk'
        const mod = (await import(sdkSpecifier)) as {
          default: new (opts: {
            apiKey?: string
            authToken?: string
            defaultHeaders?: Record<string, string>
          }) => CodegenAnthropicClient
        }
        const client =
          auth_header.name === 'Authorization'
            ? new mod.default({
                // Strip the `Bearer ` prefix so the SDK builds the
                // header itself via `authToken`; otherwise it would
                // double-prefix.
                authToken: auth_header.value.replace(/^Bearer\s+/i, ''),
              })
            : new mod.default({ apiKey: auth_header.value })
        return client.messages.create(create_input)
      },
    },
  }
}
