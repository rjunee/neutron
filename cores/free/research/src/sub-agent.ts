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

export interface ResearchSubAgentInput {
  query: string
  project_id: string
  project_slug: string
  /** Default `SUB_AGENT_DEFAULT_BUDGET_MS` (5 min). */
  budget_ms?: number
  /** Default Haiku 4.5 (FAST_MODEL from runtime/models.ts). */
  model?: string
  /** Subset of the Core's tool whitelist. Defaults to all three. */
  tools?: readonly string[]
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
}

export interface RuntimeSubAgentDispatchInput {
  system_prompt: string
  user_prompt: string
  model: string
  tools: readonly string[]
  budget_ms: number
}

export interface RuntimeSubAgentDispatchResult {
  text: string
  model: string
  tool_calls: readonly ResearchSubAgentToolCall[]
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
  try {
    const result = await runWithTimeout(
      deps.runtime_sub_agent.dispatch({
        system_prompt: buildSubAgentSystemPrompt(input.query),
        user_prompt: input.query,
        model,
        tools,
        budget_ms,
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
    }
  } finally {
    release()
  }
}

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

/** Default Haiku 4.5 model id. Re-export of the runtime constant kept
 *  inside the Core so the harness has no direct dependency on
 *  `runtime/models.ts` — the production wireup passes the FAST_MODEL
 *  string in explicitly. */
export const DEFAULT_SUB_AGENT_MODEL = 'claude-haiku-4-5-20251001'

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
        }
      }
      throw new Error(
        `buildCannedSubAgentDispatcher: no canned response matched query: ` +
          input.user_prompt.slice(0, 200),
      )
    },
  }
}
