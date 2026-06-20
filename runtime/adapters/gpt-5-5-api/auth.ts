/**
 * @neutronai/runtime — GPT-5.5 Responses API adapter: auth resolution.
 *
 * BYO `OPENAI_API_KEY` only. Subscription OAuth is reserved for the Codex CLI
 * adapter; the Responses API is the unambiguously ToS-clean path for hosted
 * hosted deployments — see internal design notes.
 *
 * No `apiKeyHelper`, no rotation chain. Multi-key dispatch is delegated to
 * `runtime/credential-pool.ts`: callers build a pool, pick a key per-call,
 * and pass it through `ResolvedAuth`. Keep this module dumb so the auth
 * surface stays ToS-clean and easy to audit.
 */

export interface OpenAiResolvedAuth {
  source: 'api_key'
  headers: Record<string, string>
}

export interface OpenAiResolveAuthOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** When provided, takes precedence over env (typical caller path: pool-selected key). */
  api_key?: string
}

export function resolveOpenAiAuth(opts: OpenAiResolveAuthOptions = {}): OpenAiResolvedAuth {
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {})
  const apiKey = opts.api_key ?? env['OPENAI_API_KEY']
  if (!apiKey) {
    throw new Error(
      'gpt-5-5-api adapter: no OPENAI_API_KEY resolved. Subscription OAuth is NOT supported on this adapter (use the gpt-5-5-codex-cli adapter for that path).',
    )
  }
  return {
    source: 'api_key',
    headers: { authorization: `Bearer ${apiKey}` },
  }
}
