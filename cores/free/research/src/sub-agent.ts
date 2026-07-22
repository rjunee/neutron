/**
 * @neutronai/research-core — in-process sub-agent harness for
 * `/research deep <topic>`.
 *
 * Wraps the runtime sub-agent dispatcher with the Research Core's
 * tool whitelist (vault_search / web_search / web_fetch), a per-instance
 * concurrency cap (default 2), a per-task wall-clock budget (default
 * 5 min), and the Atlas-shape system prompt.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.3.
 */

import {
  SUB_AGENT_DEFAULT_BUDGET_MS,
  SUB_AGENT_DEFAULT_CONCURRENCY_CAP,
} from './manifest.ts'
import {
  RESEARCH_SUB_AGENT_TOOL_WHITELIST,
  buildSubAgentSystemPrompt,
} from './sub-agent-prompt.ts'
import { SONNET_MODEL } from '@neutronai/runtime/models.ts'

export interface ResearchSubAgentInput {
  query: string
  project_id: string
  project_slug: string
  /** Default `SUB_AGENT_DEFAULT_BUDGET_MS` (5 min). */
  budget_ms?: number
  /** Default SONNET_MODEL (runtime/models.ts). */
  model?: string
  /** Subset of the Core's tool whitelist. Defaults to all three. */
  tools?: readonly string[]
  /** Set on retry attempts; appended to the user prompt after the query
   *  (behind `RETRY_FEEDBACK_MARKER`) so the sub-agent sees WHY the prior
   *  attempt was rejected. The system prompt stays keyed on the original
   *  query so the engineering-rider heuristic is stable across retries. */
  retry_feedback?: string
}

export interface ResearchSubAgentToolCall {
  tool: string
  success: boolean
  elapsed_ms: number
}

export interface ResearchSubAgentResult {
  raw_brief_text: string
  model: string
  elapsed_ms: number
  tool_calls: readonly ResearchSubAgentToolCall[]
  outcome: 'ok' | 'timeout' | 'error'
  /** Whether the dispatcher actually offered the whitelisted tools to
   *  the model. `false` when the dispatcher omits it / reports false —
   *  the orchestrator only enforces zero-tool grounding when this is true. */
  tools_available: boolean
}

export interface RuntimeSubAgentDispatchInput {
  system_prompt: string
  user_prompt: string
  model: string
  tools: readonly string[]
  budget_ms: number
  /** Per-project scoping for tool executors (e.g. vault search resolves
   *  this project's sidecar). Additive/optional — a canned dispatcher
   *  that ignores it stays byte-identical. */
  project_id?: string
  /** Cooperative-cancellation signal. `dispatchResearchSubAgent` aborts
   *  this the instant the outer `budget_ms` race trips (SubAgentTimeoutError)
   *  OR the dispatch otherwise settles. A long-running agentic dispatcher
   *  MUST stop issuing further `llm_call` / tool rounds once it fires — a
   *  timed-out run whose concurrency slot has already been released must not
   *  keep burning LLM/tool resources under the freed slot (Argus r2 BLOCKER).
   *  A canned dispatcher that ignores it stays byte-identical. */
  signal?: AbortSignal
}

export interface RuntimeSubAgentDispatchResult {
  text: string
  model: string
  tool_calls: readonly ResearchSubAgentToolCall[]
  /** Whether the dispatcher actually offered the whitelisted tools to the
   *  model. Absent/undefined = unknown → the orchestrator must NOT enforce
   *  tool grounding. The v1 tool-less production dispatcher reports `false`. */
  tools_available?: boolean
}

export interface RuntimeSubAgentDispatcher {
  dispatch(
    input: RuntimeSubAgentDispatchInput,
  ): Promise<RuntimeSubAgentDispatchResult>
}

export class SubAgentConcurrencyExceededError extends Error {
  readonly code = 'sub_agent_concurrency_exceeded' as const
  readonly project_slug: string
  readonly cap: number
  constructor(project_slug: string, cap: number) {
    super(
      `project ${project_slug} already has ${cap} sub-agent runs in flight; ` +
        'try again once one completes',
    )
    this.name = 'SubAgentConcurrencyExceededError'
    this.project_slug = project_slug
    this.cap = cap
  }
}

export class SubAgentTimeoutError extends Error {
  readonly code = 'sub_agent_timeout' as const
  readonly budget_ms: number
  constructor(budget_ms: number) {
    super(`sub-agent run exceeded budget of ${budget_ms}ms`)
    this.name = 'SubAgentTimeoutError'
    this.budget_ms = budget_ms
  }
}

/**
 * Per-instance concurrency gate. In-memory; one gate per gateway
 * process (boot constructs and shares it across all sub-agent spawns).
 *
 * `acquire(project_slug)` returns a release fn; if the cap is already
 * reached for that instance, throws `SubAgentConcurrencyExceededError`.
 *
 * Cap is configurable via constructor; default
 * `SUB_AGENT_DEFAULT_CONCURRENCY_CAP` (2).
 */
export class PerOwnerConcurrencyGate {
  private readonly cap: number
  private readonly inFlight = new Map<string, number>()

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? SUB_AGENT_DEFAULT_CONCURRENCY_CAP
  }

  inFlightFor(project_slug: string): number {
    return this.inFlight.get(project_slug) ?? 0
  }

  acquire(project_slug: string): () => void {
    const current = this.inFlight.get(project_slug) ?? 0
    if (current >= this.cap) {
      throw new SubAgentConcurrencyExceededError(project_slug, this.cap)
    }
    this.inFlight.set(project_slug, current + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const after = (this.inFlight.get(project_slug) ?? 1) - 1
      if (after <= 0) {
        this.inFlight.delete(project_slug)
      } else {
        this.inFlight.set(project_slug, after)
      }
    }
  }
}

export interface DispatchResearchSubAgentDeps {
  runtime_sub_agent: RuntimeSubAgentDispatcher
  concurrency_gate: PerOwnerConcurrencyGate
  /** Override clock (testing seam). */
  now?: () => number
}

export async function dispatchResearchSubAgent(
  input: ResearchSubAgentInput,
  deps: DispatchResearchSubAgentDeps,
): Promise<ResearchSubAgentResult> {
  const budget_ms = input.budget_ms ?? SUB_AGENT_DEFAULT_BUDGET_MS
  const model = input.model ?? DEFAULT_SUB_AGENT_MODEL
  const tools = input.tools ?? RESEARCH_SUB_AGENT_TOOL_WHITELIST
  const now = deps.now ?? ((): number => Date.now())
  const release = deps.concurrency_gate.acquire(input.project_slug)
  const start = now()
  // System prompt stays keyed on the ORIGINAL query so the engineering-rider
  // heuristic is stable across retries. Retry feedback is appended to the
  // user prompt AFTER the query so existing canned-dispatcher `includes(query)`
  // matching keeps working.
  const user_prompt =
    input.retry_feedback === undefined
      ? input.query
      : input.query + '\n\n' + RETRY_FEEDBACK_MARKER + '\n' + input.retry_feedback
  // Cooperative-cancellation controller: aborted the instant the outer
  // budget race trips (or the dispatch otherwise settles), so a timed-out
  // agentic dispatch stops burning LLM/tool resources after its concurrency
  // slot is released (Argus r2 BLOCKER).
  const controller = new AbortController()
  try {
    const result = await runWithTimeout(
      deps.runtime_sub_agent.dispatch({
        system_prompt: buildSubAgentSystemPrompt(input.query),
        user_prompt,
        model,
        tools,
        budget_ms,
        project_id: input.project_id,
        signal: controller.signal,
      }),
      budget_ms,
    )
    const elapsed_ms = now() - start
    return {
      raw_brief_text: result.text,
      model: result.model,
      elapsed_ms,
      tool_calls: result.tool_calls,
      outcome: 'ok',
      tools_available: result.tools_available === true,
    }
  } finally {
    // Fires on timeout, error, AND success. On timeout this is what tells the
    // orphaned dispatch loop to stop; on success/error the dispatch has
    // already settled so the abort is a harmless no-op.
    controller.abort()
    release()
  }
}

/** Marker prefixing the retry feedback appended to a sub-agent's user
 *  prompt on the 2nd attempt. Plain hyphen (no em dash). */
export const RETRY_FEEDBACK_MARKER = '[RETRY - PREVIOUS ATTEMPT REJECTED]'

async function runWithTimeout<T>(p: Promise<T>, budget_ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SubAgentTimeoutError(budget_ms))
    }, budget_ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Default sub-agent model = SONNET_MODEL (env-overridable via
 *  `NEUTRON_SONNET_MODEL`). Deep research needs real reasoning and
 *  sustained tool-use discipline; Haiku produced ungrounded,
 *  unparseable briefs (2026-07 dogfood incident). Production uses this
 *  default because `deep()` does NOT pass `model` to the dispatcher. */
export const DEFAULT_SUB_AGENT_MODEL: string = SONNET_MODEL

/**
 * Build a canned `RuntimeSubAgentDispatcher` for tests. Returns
 * pre-recorded responses keyed by `query`. The dispatcher records
 * every call so tests can inspect what was asked.
 */
export interface CannedSubAgentDispatcherInput {
  responses: ReadonlyArray<{
    query_match: RegExp | string
    text: string
    model?: string
    tool_calls?: readonly ResearchSubAgentToolCall[]
    /** Whether this response reports the tools as available (arms the
     *  orchestrator's zero-tool grounding gate). Omit = unknown. */
    tools_available?: boolean
    /** If set, the dispatcher will hang for at least this many ms before
     *  returning — used to exercise the budget-timeout path. */
    delay_ms?: number
    /** If set, the dispatcher will throw this error instead of returning. */
    throw?: Error
  }>
  default_model?: string
}

export interface CannedSubAgentDispatcher extends RuntimeSubAgentDispatcher {
  readonly calls: ReadonlyArray<RuntimeSubAgentDispatchInput>
}

export function buildCannedSubAgentDispatcher(
  opts: CannedSubAgentDispatcherInput,
): CannedSubAgentDispatcher {
  const calls: RuntimeSubAgentDispatchInput[] = []
  const default_model = opts.default_model ?? DEFAULT_SUB_AGENT_MODEL
  return {
    get calls() {
      return calls
    },
    async dispatch(
      input: RuntimeSubAgentDispatchInput,
    ): Promise<RuntimeSubAgentDispatchResult> {
      calls.push(input)
      for (const r of opts.responses) {
        const matches =
          r.query_match instanceof RegExp
            ? r.query_match.test(input.user_prompt)
            : input.user_prompt.includes(r.query_match)
        if (!matches) continue
        if (r.delay_ms !== undefined && r.delay_ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, r.delay_ms))
        }
        if (r.throw !== undefined) throw r.throw
        return {
          text: r.text,
          model: r.model ?? default_model,
          tool_calls: r.tool_calls ?? [],
          ...(r.tools_available !== undefined
            ? { tools_available: r.tools_available }
            : {}),
        }
      }
      throw new Error(
        `buildCannedSubAgentDispatcher: no canned response matched query: ` +
          input.user_prompt.slice(0, 200),
      )
    },
  }
}
