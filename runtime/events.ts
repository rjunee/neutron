/**
 * @neutronai/runtime — Event tagged union for substrate adapters.
 *
 * VERBATIM per `docs/engineering-plan.md` § B.P1 (substrate-adapter shape) and
 * the substrate-adapter spec § 2.2. The plan says "No interpretation:
 * the doc has them verbatim, this code has them verbatim." — do not deviate.
 *
 * Coalescing rule (§ 2.2 line 450): implementations bound internal buffers
 * (backpressure); only `kind: 'token'` events MAY be coalesced. Adapters MUST
 * NOT coalesce `tool_call`, `completion`, or `error` events. Cancellation:
 * `iterator.return()` propagates to the adapter's `cancel()`.
 */

/**
 * Token-usage shape carried on `completion` events. Mirrors Anthropic's
 * `message.usage` block plus the optional cache fields. Adapters fill what
 * their substrate provides; consumers should treat absent fields as 0.
 */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * Event tagged union. Discriminator: `kind`. Verbatim per § B.P1 lines 418-426.
 *
 * - `token` — incremental assistant text. Coalesce-OK (the only kind that is).
 * - `tool_call` — external mode: caller MUST `respondToTool(call_id, result)`.
 *                 internal mode: informational only (substrate / its adjacent
 *                 MCP server resolves inline; caller does NOT respond).
 * - `tool_result_ack` — emitted ONLY in external mode after caller responds.
 * - `thinking` — extended-thinking deltas (Anthropic) or reasoning text (gpt).
 * - `completion` — terminal event for the turn. Always includes `usage`,
 *                  `substrate_instance_id`, optional `session` continuation
 *                  hint, optional `dollars` (Private substrate only).
 * - `error` — terminal-or-mid-stream error. `retryable` + `retry_after_ms`
 *             telegraph the adapter's recovery hint; the additive `code?`
 *             (O3) telegraphs the typed failure CLASS so consumers classify on
 *             a discriminant instead of regexing `message`.
 * - `status` — non-fatal informational signal (e.g. "rotated credential",
 *              "cache cold after rotation"). Pure UX/observability.
 */

/**
 * Typed substrate/runtime failure classes (O3). Stamped ADDITIVELY on the
 * `error` event's `code?` field at the producer's throw/emit site, so downstream
 * classifiers read a discriminant first and fall back to message-prose regex
 * only for legacy events that predate the stamp (one release). The registered
 * code table (retryable default + description per class) lives in `./errors.ts`.
 *
 * The nine classes unify the two pre-existing ad-hoc taxonomies:
 *   - the credential-resolution reasons (`no_credentials` / `all_cooldown` /
 *     `oauth_refresh` — formerly `ScrubbedAuthEnvError.reason`), and
 *   - the message-regex substrate classifiers (`binary_not_found` /
 *     `channel_wedged` / `turn_timeout` / `auth_invalid` / `http_status` /
 *     `rate_limited` / `aborted`).
 *
 * Additive to the locked Event union: `code` is OPTIONAL, so every existing
 * `{ kind: 'error', … }` literal stays valid and the wire shape is unchanged.
 */
export type SubstrateErrorClass =
  | 'binary_not_found'
  | 'channel_wedged'
  | 'turn_timeout'
  | 'auth_invalid'
  | 'http_status'
  | 'rate_limited'
  | 'aborted'
  | 'no_credentials'
  | 'all_cooldown'
  | 'oauth_refresh'

export type Event =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; tool_name: string; args: unknown; call_id: string }
  | { kind: 'tool_result_ack'; call_id: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'completion'
      usage: TokenUsage
      session?: { id: string; last_active_at: number }
      substrate_instance_id: string
      dollars?: number
    }
  | {
      kind: 'error'
      message: string
      retryable: boolean
      retry_after_ms?: number
      /** O3 typed failure class — stamped at the producer; consumers classify on
       *  this before falling back to `message` regex. Optional + additive. */
      code?: SubstrateErrorClass
    }
  | { kind: 'status'; message: string }
