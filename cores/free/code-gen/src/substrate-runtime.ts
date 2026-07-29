/**
 * @neutronai/codegen-core — opaque LLM-call closure + sub-agent
 * dispatcher adapter (multi-turn tool loop).
 *
 * Mirrors `cores/free/research/src/substrate-runtime.ts` for the
 * Code-Gen Core. The Core programs against the narrow
 * `CodegenLlmCall` closure interface (system / messages[] / tools? /
 * max_tokens / model → text + tool_calls + stop_reason). The gateway
 * builds the actual closure against its credential pool inside
 * `gateway/cores/code-gen-factory.ts` — this Core never imports the
 * Anthropic SDK package directly.
 *
 * `buildRuntimeSubagentDispatch` wraps an `(llm_call,
 * tool_defs_by_kind, tool_handlers_by_kind)` triple into the
 * `SubagentDispatch` shape the existing `RuntimeCodegenRunner` consumes.
 * It runs a multi-turn loop:
 *
 *   1. Render the first user message into `messages: CodegenMessage[]`.
 *   2. Resolve the tool defs AND handlers for `input.kind` from the
 *      per-kind maps (`tool_defs_by_kind` / `tool_handlers_by_kind`).
 *      Each kind gets its OWN surface — forge/atlas write-capable,
 *      argus/sentinel read-only — with NO silent fallback: a kind with
 *      no configured entry throws rather than inheriting a wrong (e.g.
 *      Argus read-only) toolset.
 *   3. Loop up to `max_turns_per_subagent` (default 50):
 *      a. Bail with `status: 'timed_out'` if the deadline has elapsed.
 *      b. `llm_call({system, messages, tools, max_tokens, model})`.
 *      c. Append the reconstructed assistant turn to `messages`.
 *      d. If `stop_reason === 'end_turn'` OR `tool_calls.length === 0`
 *         return the terminal text with `status: 'completed'`.
 *      e. Otherwise dispatch every `tool_call` via `Promise.all` against
 *         `tool_handlers[name]`. Missing or throwing handlers emit a
 *         `tool_result` block with `is_error: true` so the loop can
 *         keep going (the LLM gets to see the error and recover).
 *      f. Append a `user` message containing all tool_result blocks.
 *   4. If the loop hits `max_turns_per_subagent` without an end_turn
 *      return the last assistant text — the orchestrator's
 *      `parseForgeOutput` will fail loudly if the contract terminals
 *      (PR_NUMBER / BRANCH / WORKTREE) aren't present, which is the
 *      right behavior (no silent truncation).
 *
 * See `docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md`
 * § "Architecture (the layer cake)" and § Phase 1 for the contract.
 */


/**
 * Sub-agent dispatch contract. Relocated here (from the deleted
 * `runtime-runner.ts` — the retired v1 code-gen pipeline) because
 * `buildRuntimeSubagentDispatch` below is what actually PRODUCES a
 * `SubagentDispatch`, so this is their cohesive owner.
 */
export interface SubagentDispatch {
  (input: SubagentDispatchInput): Promise<SubagentDispatchResult>
}

/**
 * Every sub-agent kind the substrate dispatch closure can serve. Each kind
 * resolves its OWN toolset in `buildRuntimeSubagentDispatch` — there is no
 * silent fallback, so a persona kind never inherits Argus's read-only
 * surface. Declared here so the Core carries no dependency on the trident
 * package.
 */
export type CodegenSubagentKind = 'forge' | 'argus' | 'atlas' | 'sentinel'

export interface SubagentDispatchInput {
  /** Instance key (passed through to the registry). */
  instance_key: string
  /** Sub-agent kind — forge / argus (build loop) or atlas / sentinel (persona). */
  kind: CodegenSubagentKind
  /** Sub-agent model id. */
  model: string
  /** Fully-rendered system prompt. */
  system: string
  /** Fully-rendered user message. */
  user_message: string
  /** The per-project worktree path the sub-agent operates in. */
  worktree_path: string
  /** Parent task id (used for sub-agent registry book-keeping). */
  parent_task_id: string
  /** Wall-clock budget for this sub-agent. */
  timeout_ms: number
}

export interface SubagentDispatchResult {
  /** The sub-agent's terminal output text. */
  result: string
  /** The opaque sub-agent run_id (used for cancellation + audit). */
  subagent_run_id: string
  /** Terminal status — 'completed' | 'failed' | 'cancelled' | 'timed_out'. */
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
}

/** Tool-use block — mirrors the Anthropic Messages API tool_use shape. */
export interface CodegenToolBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** Tool-result block returned to the model on the next user turn. */
export interface CodegenToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

/**
 * Message content. May be a bare string (user prompt, terminal
 * assistant text) or a content-block array (mid-loop tool_use /
 * tool_result turns).
 */
export type CodegenMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | CodegenToolBlock
      | CodegenToolResultBlock
    >

export interface CodegenMessage {
  role: 'user' | 'assistant'
  content: CodegenMessageContent
}

export interface CodegenToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface CodegenLlmCallInput {
  system: string
  messages: CodegenMessage[]
  tools?: CodegenToolDefinition[]
  max_tokens: number
  model: string
}

export type CodegenStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'

export interface CodegenLlmCallResult {
  /** Joined text blocks from the assistant turn (may be empty). */
  text: string
  /** Tool-use blocks emitted by the assistant (empty on end_turn). */
  tool_calls: CodegenToolBlock[]
  stop_reason: CodegenStopReason
  /** Resolved model id the call ran against (echo from the API). */
  model: string
}

/**
 * Opaque LLM-call closure. One call = one Messages-API request +
 * response. The Core never sees HTTP semantics, auth headers, or the
 * SDK. The gateway constructs this against the resolved instance
 * credential (Max OAuth Bearer or BYO `NEUTRON_ANTHROPIC_API_KEY`
 * x-api-key) and threads it through `buildRuntimeSubagentDispatch`.
 */
export interface CodegenLlmCall {
  (input: CodegenLlmCallInput): Promise<CodegenLlmCallResult>
}

/**
 * Per-invocation context handed to every tool handler. The handler
 * MUST resolve any file-path argument relative to `worktree_path`
 * and reject any path that escapes the worktree.
 */
export interface CodegenToolContext {
  worktree_path: string
  instance_key: string
  parent_task_id: string
}

/**
 * Tool handler — async function that takes a JSON-shaped `input`
 * (whatever the LLM emitted) and the per-invocation context, and
 * returns a text result with an optional `is_error` flag. Throwing is
 * fine — the adapter catches and surfaces the error as a tool_result
 * with `is_error: true`.
 */
export interface CodegenToolHandler {
  (
    input: Record<string, unknown>,
    ctx: CodegenToolContext,
  ): Promise<{ content: string; is_error?: boolean }>
}

export interface BuildRuntimeSubagentDispatchOptions {
  llm_call: CodegenLlmCall
  /**
   * Tool definitions exposed to the model, keyed by sub-agent kind. Each
   * kind gets its role-appropriate surface (forge/atlas write-capable,
   * argus/sentinel read-only). A kind dispatched without an entry throws
   * at dispatch time — there is deliberately NO fallback, so a persona
   * kind can never silently inherit a wrong (e.g. Argus read-only) set.
   */
  tool_defs_by_kind: Partial<
    Record<CodegenSubagentKind, readonly CodegenToolDefinition[]>
  >
  /**
   * Tool name → handler map, keyed by sub-agent kind. Resolved alongside
   * the defs so each kind's bash gating / write surface matches the tools
   * it is offered (e.g. Atlas's bash is unrestricted; Argus/Sentinel get
   * no write handler at all). Tools offered in `tool_defs_by_kind` but
   * missing from the kind's handler map emit `is_error: true` at runtime;
   * a kind dispatched with no handler map at all throws.
   */
  tool_handlers_by_kind: Partial<
    Record<CodegenSubagentKind, Record<string, CodegenToolHandler>>
  >
  /** Max tokens per Messages-API call. Default 8192. */
  max_tokens_per_turn?: number
  /** Hard cap on loop iterations. Default 50. */
  max_turns_per_subagent?: number
  /** Optional bookkeeping hook fired before the loop starts. */
  on_subagent_start?: (
    input: SubagentDispatchInput,
    run_id: string,
  ) => Promise<void> | void
  /** Optional bookkeeping hook fired after the loop terminates. */
  on_subagent_complete?: (
    run_id: string,
    result: SubagentDispatchResult,
  ) => Promise<void> | void
  /** Optional run_id factory (testing seam). Defaults to crypto.randomUUID(). */
  mint_run_id?: () => string
}

const DEFAULT_MAX_TOKENS_PER_TURN = 8192
const DEFAULT_MAX_TURNS_PER_SUBAGENT = 50

/**
 * Reconstruct the assistant's content-block array from the closure's
 * `{text, tool_calls}` result. The Messages API expects the full
 * content array echoed back on the next turn so the model can see its
 * own tool_use blocks alongside the matching tool_result blocks.
 */
function reconstructAssistantContent(
  res: CodegenLlmCallResult,
): CodegenMessageContent {
  const blocks: Array<
    { type: 'text'; text: string } | CodegenToolBlock
  > = []
  if (res.text.length > 0) {
    blocks.push({ type: 'text', text: res.text })
  }
  for (const tc of res.tool_calls) {
    blocks.push(tc)
  }
  if (blocks.length === 0) {
    // Pathological: API returned neither text nor tool_calls.
    // Mirror Anthropic's convention by emitting an empty text block so
    // the message structure stays valid.
    return [{ type: 'text', text: '' }]
  }
  return blocks
}

/**
 * Build a `SubagentDispatch` that runs the multi-turn tool loop
 * described in the module header. Production wires this with a real
 * `CodegenLlmCall` (gateway-side, against instance creds); tests pass a
 * canned closure built via `buildCannedCodegenLlmCall`.
 */
export function buildRuntimeSubagentDispatch(
  opts: BuildRuntimeSubagentDispatchOptions,
): SubagentDispatch {
  const max_tokens = opts.max_tokens_per_turn ?? DEFAULT_MAX_TOKENS_PER_TURN
  const max_turns = opts.max_turns_per_subagent ?? DEFAULT_MAX_TURNS_PER_SUBAGENT
  const mint_run_id = opts.mint_run_id ?? (() => crypto.randomUUID())

  return async function dispatch_subagent(
    input: SubagentDispatchInput,
  ): Promise<SubagentDispatchResult> {
    const run_id = mint_run_id()
    if (opts.on_subagent_start !== undefined) {
      await opts.on_subagent_start(input, run_id)
    }

    // Resolve this kind's OWN toolset + handlers. No silent fallback: a
    // kind with no configured surface throws rather than inheriting
    // another role's (the bug where atlas/sentinel fell to Argus's
    // read-only set and could not write their deliverable).
    const tool_defs = opts.tool_defs_by_kind[input.kind]
    const tool_handlers = opts.tool_handlers_by_kind[input.kind]
    if (tool_defs === undefined || tool_handlers === undefined) {
      throw new Error(
        `buildRuntimeSubagentDispatch: no ${
          tool_defs === undefined ? 'tool defs' : 'tool handlers'
        } configured for sub-agent kind '${input.kind}'`,
      )
    }
    const tools = [...tool_defs]
    const messages: CodegenMessage[] = [
      { role: 'user', content: input.user_message },
    ]
    const deadline_at = Date.now() + input.timeout_ms

    let last_text = ''

    for (let turn = 0; turn < max_turns; turn++) {
      if (Date.now() >= deadline_at) {
        const result: SubagentDispatchResult = {
          result: 'timed_out',
          subagent_run_id: run_id,
          status: 'timed_out',
        }
        if (opts.on_subagent_complete !== undefined) {
          await opts.on_subagent_complete(run_id, result)
        }
        return result
      }

      const res = await opts.llm_call({
        system: input.system,
        messages,
        tools,
        max_tokens,
        model: input.model,
      })

      last_text = res.text
      messages.push({
        role: 'assistant',
        content: reconstructAssistantContent(res),
      })

      if (res.stop_reason === 'end_turn' || res.tool_calls.length === 0) {
        const result: SubagentDispatchResult = {
          result: res.text,
          subagent_run_id: run_id,
          status: 'completed',
        }
        if (opts.on_subagent_complete !== undefined) {
          await opts.on_subagent_complete(run_id, result)
        }
        return result
      }

      // Dispatch all tool calls concurrently — Anthropic permits
      // parallel tool_use in a single assistant turn.
      const tool_results: CodegenToolResultBlock[] = await Promise.all(
        res.tool_calls.map(async (tc) => {
          const handler = tool_handlers[tc.name]
          if (handler === undefined) {
            return {
              type: 'tool_result',
              tool_use_id: tc.id,
              content: `tool '${tc.name}' not available to this sub-agent`,
              is_error: true,
            }
          }
          try {
            const out = await handler(tc.input, {
              worktree_path: input.worktree_path,
              instance_key: input.instance_key,
              parent_task_id: input.parent_task_id,
            })
            const block: CodegenToolResultBlock = {
              type: 'tool_result',
              tool_use_id: tc.id,
              content: out.content,
            }
            if (out.is_error === true) {
              block.is_error = true
            }
            return block
          } catch (err) {
            return {
              type: 'tool_result',
              tool_use_id: tc.id,
              content: err instanceof Error ? err.message : String(err),
              is_error: true,
            }
          }
        }),
      )

      messages.push({ role: 'user', content: tool_results })
    }

    // Loop hit max_turns_per_subagent. Surface the last assistant text
    // as a 'completed' result — the orchestrator's parseForgeOutput
    // will fail loudly if it doesn't see PR_NUMBER / BRANCH / WORKTREE,
    // which is the desired behavior (no silent truncation).
    const result: SubagentDispatchResult = {
      result: last_text,
      subagent_run_id: run_id,
      status: 'completed',
    }
    if (opts.on_subagent_complete !== undefined) {
      await opts.on_subagent_complete(run_id, result)
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Test fixture: canned CodegenLlmCall.
// ---------------------------------------------------------------------------

export interface CannedCodegenLlmCallResponse {
  text: string
  tool_calls?: CodegenToolBlock[]
  stop_reason?: CodegenStopReason
  model?: string
  /**
   * Optional match against the last `messages[-1].content` of the
   * llm_call input. When provided, the canned closure walks the
   * responses array and returns the first one whose `match` is
   * satisfied. A `string` match performs a substring check on the
   * stringified content; a `RegExp` is tested directly.
   */
  match?: RegExp | string
  /** Optional artificial delay (ms) before the response resolves. */
  delay_ms?: number
  /** Optional error to throw INSTEAD of returning a response. */
  throw?: Error
}

export interface CannedCodegenLlmCallOptions {
  responses: ReadonlyArray<CannedCodegenLlmCallResponse>
}

export interface CannedCodegenLlmCall {
  (input: CodegenLlmCallInput): Promise<CodegenLlmCallResult>
  /** Inspect the recorded calls (in invocation order). */
  readonly calls: ReadonlyArray<CodegenLlmCallInput>
}

function stringifyLastContent(input: CodegenLlmCallInput): string {
  const last = input.messages[input.messages.length - 1]
  if (last === undefined) return ''
  const c = last.content
  if (typeof c === 'string') return c
  return c
    .map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'tool_use') return JSON.stringify(b.input)
      if (b.type === 'tool_result') return b.content
      return ''
    })
    .join('\n')
}

/**
 * Test helper. Walks the configured responses in FIFO order, returning
 * the next response on each invocation. If a response defines `match`,
 * the helper skips to the first response whose match is satisfied
 * (still consuming each skipped response in order). When no response
 * matches, the closure throws with a clear error so the test surfaces
 * the missing fixture instead of silently hanging.
 */
export function buildCannedCodegenLlmCall(
  opts: CannedCodegenLlmCallOptions,
): CannedCodegenLlmCall {
  const responses: CannedCodegenLlmCallResponse[] = [...opts.responses]
  const calls: CodegenLlmCallInput[] = []
  let cursor = 0

  const fn = async (
    input: CodegenLlmCallInput,
  ): Promise<CodegenLlmCallResult> => {
    // Snapshot the input — the adapter mutates `messages` between
    // calls, so tests need a frozen-at-call-time copy.
    const snapshot: CodegenLlmCallInput = {
      system: input.system,
      messages: input.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string' ? m.content : m.content.map((b) => ({ ...b })),
      })),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      max_tokens: input.max_tokens,
      model: input.model,
    }
    calls.push(snapshot)
    let chosen: CannedCodegenLlmCallResponse | undefined
    while (cursor < responses.length) {
      const cand = responses[cursor]
      if (cand === undefined) break
      cursor++
      if (cand.match === undefined) {
        chosen = cand
        break
      }
      const probe = stringifyLastContent(input)
      const ok =
        cand.match instanceof RegExp
          ? cand.match.test(probe)
          : probe.includes(cand.match)
      if (ok) {
        chosen = cand
        break
      }
    }
    if (chosen === undefined) {
      throw new Error(
        `buildCannedCodegenLlmCall: no response configured for call #${calls.length}`,
      )
    }
    if (chosen.delay_ms !== undefined && chosen.delay_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, chosen!.delay_ms))
    }
    if (chosen.throw !== undefined) {
      throw chosen.throw
    }
    return {
      text: chosen.text,
      tool_calls: chosen.tool_calls ?? [],
      stop_reason: chosen.stop_reason ?? 'end_turn',
      // Local last-resort literal for this test-helper's canned model stamp — a
      // bundled Core (`cores/free/*`) may not import the host runtime/models.ts
      // (`cores-use-sdk-only` layering boundary). Real production dispatch
      // resolves the model via `input.model` from the host caller; this fallback
      // only stamps canned test responses that omit an explicit model. Keep in
      // sync with runtime/models.ts's `SONNET_MODEL` default.
      model: chosen.model ?? 'claude-sonnet-4-6',
    }
  }

  Object.defineProperty(fn, 'calls', {
    get: () => calls,
    enumerable: true,
  })
  return fn as CannedCodegenLlmCall
}
