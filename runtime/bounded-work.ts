/**
 * @neutronai/runtime — THE BOUNDED-WORK CONTRACT.
 *
 * The one artefact every rebuild lane depends on, and the reason it exists as a
 * file rather than a convention: today the orchestration primitives are AMBIENT
 * GLOBALS injected by the Claude Code Workflow runtime — `agent()`, `parallel()`,
 * `phase()`, `budget`, `log()` — which is precisely why there is exactly one
 * implementation of them. `trident/inner-workflow.mjs` is a function body, not a
 * module (`trident/testing/load-escalation-gate.ts:5`). Naming the contract is what
 * makes a second and third provider possible at all.
 *
 * THE SPLIT, from `docs/plans/harness-orchestrator-pivot-2026-09-11.md`:
 *
 *   §3.1  the project REPL is the orchestrator — it holds the conversation, it runs
 *         the build, and it is the ONLY thing that asks the owner a question.
 *   §3.2  "Same model as the REPL → a subagent inside it. Warm cache, shared MCP
 *         connections, no new process." Different model → a headless worker. A
 *         worker NEVER talks to the owner; it returns "blocked on X" and the
 *         orchestrator decides whether that is worth the owner's attention.
 *         (Observation, not an amendment: Pi implements "inside it" through an
 *         extension that starts a child process, so it meets the split without
 *         meeting the rationale. See the plan's 2026-09-15 Pi section.)
 *   §3.6  Neutron owns the loop, the harness owns the turn.
 *
 * So: the HOST owns the loop and every measurement (deterministic TS, never a
 * model). A RUNNER owns one turn of one harness. Nothing here abstracts goals,
 * heartbeats or compaction — §3.6 rejects that explicitly, and this contract is
 * deliberately the narrow seam it permits instead.
 */

/** A full git object id. The host measures these; a worker may claim one. */
export type Oid = string

export type Placement = 'in-repl' | 'headless'

/**
 * Decided by the HOST, never by a worker or a prompt: a worker whose provider is
 * the project REPL's provider runs INSIDE it (§3.2 — warm cache, shared MCP
 * connections, no new process); anything else is a headless turn of the other
 * harness. Pi reaches "inside it" through an extension that starts a child
 * process: the split still holds, the no-new-process rationale does not.
 * Measured cost of getting this wrong, from §3.8: each headless job paid
 * 23,799 / 23,799 / 27,603 cache-read tokens purely to warm up.
 */
export function placementFor(workerProvider: Provider, replProvider: Provider): Placement {
  return workerProvider === replProvider ? 'in-repl' : 'headless'
}

export type { Provider } from './provider.ts'
import type { Provider } from './provider.ts'

export type WorkerRole =
  | 'plan' | 'build' | 'fix' | 'review' | 'synthesis'
  | 'replan' | 'probe' | 'resolve' | 'arbitrate' | 'fix-leak'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A named tool surface. `'none'` is the judge's — the arbiter stays toolless. */
export type ToolGrant = 'none' | 'read-only' | 'edit' | 'edit-and-run'

export interface BoundedWorkRequest {
  /** Durable identity. `step_id` is the IDEMPOTENCY KEY: a retry of the same step
   *  must not be a second unit of work. */
  readonly run_id: string
  readonly step_id: string
  readonly role: WorkerRole
  /** The RESOLVED model id, not a tier label. What is logged is what ran — the
   *  CLI's default has moved underneath this system once already, invisibly
   *  (`docs/plans/2026-08-09-multi-substrate-build-agent.md` §F). */
  readonly model_id: string
  readonly effort: Effort | null
  readonly cwd: string
  readonly writable: boolean
  readonly network: boolean
  readonly tools: ToolGrant
  /** ON DISK, never argv. Briefs exceed MAX_ARG_STRLEN and a truncated brief is a
   *  silently different task (`trident/brief-parts.ts`). */
  readonly brief: { readonly path: string; readonly integrity: string }
  /** THE TRAILER: a host-chosen path the worker's HARNESS writes, and the host
   *  then validates and re-measures. Generalised from `trident/codex-build.sh`'s
   *  own "why the trailer is a file and not the tail of stdout". */
  readonly result: { readonly schema: string; readonly path: string }
  /** §3.3 cross-provider continuity. One owner per id. */
  readonly thread: { readonly id: string } | null
  readonly budget: { readonly wall_ms: number }
  /**
   * LITERALLY THE TYPE `false`. A worker never needs an owner decision, because
   * §3.2 says a worker never talks to the owner — it returns `blocked` and the
   * orchestrator decides. Making this unconstructible rather than merely
   * documented is what stops the emit/resume protocol §3.4 withdrew from growing
   * back one call site at a time.
   */
  readonly needs_approval_decision: false
}

/**
 * Every kind here is a DISTINCT answer, and `unknown` is the one that earns its
 * place: "could not find out" must never share a branch with "found nothing",
 * because the default of that collapse is always the permissive one. Measured
 * this week: a fire seam returned `fired` on any completion event, so four runs
 * sat marked `running` while the launcher had replied, in words, NOT FIRED.
 */
export type BoundedWorkOutcome = (
  | { kind: 'completed'; result: unknown; usage: Usage | null; model_reported: string | null; thread_id: string | null }
  /** §3.2: "If it cannot proceed it returns 'blocked on X' to the orchestrator." */
  | { kind: 'blocked'; on: string }
  | { kind: 'refused'; reason: RefusalReason }
  | { kind: 'failed'; class: 'infra' | 'timeout' | 'killed'; detail: string }
  | { kind: 'unknown'; detail: string }
) & { readonly observation?: ProviderObservation }

/** Host observation of provider transport metadata, independent of result authority.
 * Missing metrics are unknown, not zero. Input excludes the two cache categories. */
export interface ProviderObservation {
  readonly source: 'claude-cli-json' | 'codex-cli-jsonl'
  readonly started_at_ms: number
  readonly finished_at_ms: number
  readonly observed_at_ms: number
  readonly model_reported: string | null
  readonly thread_id: string | null
  readonly usage: {
    readonly input_tokens: number | null
    readonly output_tokens: number | null
    readonly cache_read_input_tokens: number | null
    readonly cache_creation_input_tokens: number | null
    readonly cost_usd: number | null
  }
}

export type RefusalReason =
  | 'provider-not-connected'
  | 'capability-unsupported'
  | 'cli-contract'
  | 'placement-unavailable'

export interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
}

export type Supported = { readonly ok: true }
export type Unsupported = { readonly ok: false; readonly reason: RefusalReason; readonly detail: string }

export interface WorkerHandle {
  readonly run_id: string
  readonly step_id: string
  readonly pid?: number
}

/**
 * One harness, one turn. A runner never decides placement, never asks the owner,
 * and never establishes a measurement the host can make itself.
 */
export interface WorkerRunner {
  readonly provider: Provider
  /**
   * Consulted at CARD ADMISSION, not at the phase. A project whose REPL provider
   * cannot host a role in the placement it resolves to is refused when the card
   * is dispatched, with a typed reason — never at minute 90 of a build.
   */
  supports(role: WorkerRole, placement: Placement): Supported | Unsupported
  run(req: BoundedWorkRequest, placement: Placement, signal: AbortSignal): Promise<BoundedWorkOutcome>
  /** The `run-evidence` vocabulary, unchanged: a probe that cannot see is
   *  `unknown`, which is not `nothing`. */
  liveness(handle: WorkerHandle): Promise<'activity' | 'nothing' | 'unknown'>
}

/**
 * A runner that runs nothing, for the lanes that must develop against the
 * contract before any real runner exists. Scripted per step_id so a test states
 * what it wants back without a process, a pane, or a token.
 */
export function fakeRunner(
  provider: Provider,
  script: {
    readonly outcomes?: ReadonlyMap<string, BoundedWorkOutcome>
    readonly supports?: (role: WorkerRole, placement: Placement) => Supported | Unsupported
    readonly liveness?: 'activity' | 'nothing' | 'unknown'
  } = {},
): WorkerRunner & { readonly calls: BoundedWorkRequest[] } {
  const calls: BoundedWorkRequest[] = []
  return {
    provider,
    calls,
    supports: (role, placement) => script.supports?.(role, placement) ?? { ok: true },
    run: async (req) => {
      calls.push(req)
      return (
        script.outcomes?.get(req.step_id) ?? {
          kind: 'unknown',
          detail: `fakeRunner: no scripted outcome for step ${req.step_id}`,
        }
      )
    },
    liveness: async () => script.liveness ?? 'unknown',
  }
}
