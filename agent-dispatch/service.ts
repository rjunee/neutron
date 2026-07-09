/**
 * @neutronai/agent-dispatch — the general agent-dispatch service.
 *
 * This is the GENERAL dispatch surface the parity scan flagged as missing
 * (`docs/research/vajra-neutron-feature-parity-scan-2026-06-25.md` §2.F / §5.3:
 * "the Vajra multi-agent Forge/Atlas/Sentinel/Argus family is collapsed into
 * the single Trident dispatch loop … no standalone Atlas (research), Sentinel
 * (QA), or ad-hoc spawn equivalent to `spawn-agent.sh`"). Neutron had the
 * PRIMITIVE (`runtime/subagent/` registry + spawn-guard + watchdog) and a
 * dead-code persona dispatcher (`trident/agent-dispatch.ts`), but NO live path
 * that registers a named/ad-hoc background agent, spawns it via the substrate,
 * supervises it, and reports its result back to chat.
 *
 * `DispatchService` IS that path, built ON the existing primitive (it does not
 * fork a parallel registry):
 *
 *   1. `spawnSubagent` (`runtime/subagent/spawn.ts`) registers a
 *      `SubagentRecord` and enforces the SAME caps as every other dispatch —
 *      `MAX_CONCURRENT_SUBAGENTS`, the double-spawn guard (`spawn_key`).
 *   2. The substrate `dispatch` closure (in production the per-worktree
 *      CC-subprocess REPL the Open composer builds via
 *      `buildSubstrateTridentDispatch` → `createClaudeCodeSubstrateAuto` —
 *      NEVER a direct api.anthropic.com call) runs ONE turn to terminal text.
 *   3. On completion the registry status is driven terminal
 *      (`finished`/`crashed`) and a structured announcement (`announce.ts`) is
 *      handed to the `report` sink — the report-back to the originating
 *      chat/topic.
 *   4. The SAME registry is supervised by the already-ported agent-aware
 *      watchdog (`runtime/subagent/watchdog.ts`): a stuck/dead dispatch is
 *      reaped + surfaced (see `watchdog-report.ts` for the notifier adapter).
 *
 * PERSONA DELIVERY — folded into the user turn, not `system`. The runtime
 * `AgentSpec` (`runtime/substrate.ts`) has NO `system` field: the CC subprocess
 * owns its own system prompt (the `claude` binary's signature). The production
 * `buildSubstrateTridentDispatch` therefore drops `TridentDispatchInput.system`
 * entirely and only sends `user_message`. So to actually deliver a named
 * persona (Atlas/Sentinel) or the ad-hoc role to the dispatched agent, we
 * compose `<role>\n\n---\n\nYour task:\n\n<task>` into the `user_message` — the
 * same channel Forge/Argus ride. (We still pass the bare kind label as `system`
 * for structural compatibility with the `TridentDispatch` contract, but never
 * rely on it reaching the model.)
 */

import {
  formatAnnouncement,
  renderAnnouncementMarkdown,
  type AnnouncementPayload,
} from '@neutronai/runtime/subagent/announce.ts'
import {
  cancelRun,
  type ControlState,
  registerCanceller,
} from '@neutronai/runtime/subagent/control.ts'
import type { AgentKind, SubagentRecord, SubagentStatus } from '@neutronai/runtime/subagent/registry.ts'
import type { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { spawnSubagent, type DelegationVerifier, type SpawnInput } from '@neutronai/runtime/subagent/spawn.ts'
import {
  AGENT_KIND_BY_DISPATCH_KIND,
  ADHOC_SYSTEM_PROMPT,
  type DispatchKind,
  type DispatchPersonaKind,
} from './prompts.ts'
import {
  assessDispatchReadiness,
  type DispatchReadinessTarget,
} from '@neutronai/work-board/dispatch-readiness.ts'

/** Where a dispatch result should be delivered back. */
export interface DeliveryTarget {
  channel: string
  binding_id: string
}

/**
 * Work Board Phase 2b — the minimal board surface the dispatch chokepoint needs
 * to enforce the no-untracked-dispatches + ask-before-acting rules and to bind
 * the spawned run to its Plan item (fork `⑂`). `WorkBoardStore` satisfies it
 * structurally (`get` / `attachRun` / `clearRun`).
 */
export interface DispatchBoardBinder {
  get(project_slug: string, id: string): (DispatchReadinessTarget & { id: string }) | null
  /** Bind a run to the item (linked_run_id + status=in_progress). */
  attachRun(project_slug: string, id: string, run_id: string): Promise<unknown>
  /** Clear the run binding on terminal (fork icon goes dark; status untouched). */
  clearRun(project_slug: string, id: string, run_id: string): Promise<unknown>
}

/** Thrown when a dispatch violates the board-binding chokepoint rules. The
 *  tool / command surfaces map it to a clean rejection (incl. the ask-gate
 *  clarifying-question guidance) rather than a crashed dispatch. */
export class DispatchValidationError extends Error {
  readonly code: 'missing_board_item' | 'unknown_board_item' | 'underspecified'
  constructor(code: DispatchValidationError['code'], message: string) {
    super(message)
    this.name = 'DispatchValidationError'
    this.code = code
  }
}

/**
 * One substrate turn → terminal text. STRUCTURAL match to
 * `trident/session.ts:TridentDispatch` so the production composer can pass the
 * very same `buildSubstrateTridentDispatch` closure the Trident loop uses —
 * this service does not import trident (no layering inversion) and does not
 * spin a second substrate.
 */
export interface DispatchTurnInput {
  kind: AgentKind
  /** Bare kind label — structural only; the persona rides `user_message`. */
  system: string
  user_message: string
  repo_path: string
  /** Owning run id for audit (the registry run_id). */
  trident_run_id: string
  model: string
  timeout_ms: number
  /**
   * Cancellation signal. A production `DispatchTurn` (`substrate-turn.ts`) MUST
   * cancel the underlying substrate when this aborts, so a `/dispatch stop` or a
   * watchdog reap actually terminates the spawned subprocess rather than only
   * marking the registry terminal. Optional so a test stub can ignore it.
   */
  signal?: AbortSignal
}

export interface DispatchTurnResult {
  result: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
}

export interface DispatchTurn {
  (input: DispatchTurnInput): Promise<DispatchTurnResult>
}

/** Loaded persona role text + provenance (file vs inline fallback). */
export interface PersonaPrompt {
  content: string
  source: 'file' | 'fallback'
}

/** Loads the persona role for a named kind. Defaults to the trident loader. */
export interface PersonaLoader {
  (kind: DispatchPersonaKind): PersonaPrompt
}

/** Structured report-back handed to the `report` sink on terminal. */
export interface DispatchReport {
  run_id: string
  kind: DispatchKind
  agent_kind: AgentKind
  status: SubagentStatus
  /** Canonical Markdown announcement (from `announce.ts`). */
  markdown: string
  payload: AnnouncementPayload
  /** The dispatched agent's terminal text (truncated to 4 KiB). */
  result: string
  delivery_target?: DeliveryTarget
}

export interface DispatchReporter {
  (report: DispatchReport): void | Promise<void>
}

export interface DispatchRequest {
  kind: DispatchKind
  /** The task / instructions handed to the agent. */
  task: string
  /**
   * Work Board Phase 2b — the Plan item this dispatch is bound to. REQUIRED:
   * a dispatch with no board_item_id is REJECTED at the chokepoint (no
   * untracked dispatches, Ryan-locked). The item must exist + be specified
   * enough (the ask-before-acting gate); on success the run is bound to it.
   */
  board_item_id: string
  /**
   * The Work Board STORAGE SCOPE the `board_item_id` lives under — the active
   * project's scope key (`workBoardScopeKey(owner_slug, project_id)`). The
   * `work_board_*` tools scope a created/listed item to the ACTIVE project, so a
   * board-bound dispatch MUST look the item up under the SAME scope or it 404s as
   * `unknown_board_item`. Defaults to the service's bound `project_slug` (the
   * owner/General slug) when absent — General turns + legacy callers unchanged.
   */
  board_scope?: string
  /** Working dir the agent runs in. Defaults to the service's bound path. */
  repo_path?: string
  /** Model id. Defaults to the service's bound default. */
  model?: string
  /** Wall-clock budget (ms). Defaults to the service's bound default. */
  timeout_ms?: number
  /** Where to report the result back. Defaults to the service's bound target. */
  delivery_target?: DeliveryTarget
  /**
   * Logical de-dup key for the double-spawn guard. When set, a second dispatch
   * with the same key (while the first is live) coalesces onto the in-flight
   * run instead of spawning a twin. Namespaced per kind+task by the caller.
   */
  spawn_key?: string
  on_duplicate?: 'coalesce' | 'refuse'
}

/** Handle returned by `dispatch` — the run id + a promise that settles on terminal. */
export interface DispatchHandle {
  run_id: string
  record: SubagentRecord
  /** Resolves when the dispatch reaches a terminal state + has been reported. */
  completion: Promise<DispatchOutcome>
}

export interface DispatchOutcome {
  run_id: string
  kind: DispatchKind
  agent_kind: AgentKind
  status: SubagentStatus
  result: string
  payload: AnnouncementPayload
}

export interface DispatchServiceDeps {
  registry: SubagentRegistry
  control: ControlState
  /** One substrate turn → terminal text (production: the CC-subprocess closure). */
  dispatch: DispatchTurn
  /** Report-back sink (production: post to the originating chat/topic). */
  report: DispatchReporter
  /** Instance this dispatcher belongs to (registry scoping + caps). */
  instance_key: string
  /** Work Board Phase 2b — the board binder (the dispatch chokepoint's
   *  existence + ask-gate lookups + the run binding/clear). */
  board: DispatchBoardBinder
  /** Project the bound board items live under (server-derived instance slug). */
  project_slug: string
  /** Default working dir for a dispatch when the request omits `repo_path`. */
  repo_path: string
  /**
   * Default model id, or a thunk resolving it. A thunk is resolved PER-DISPATCH
   * so the model-update watchdog's adopted id reaches new runs (pass the
   * `getBestModel` accessor); a plain string pins a fixed model.
   */
  default_model: string | (() => string)
  /** Default wall-clock budget (ms). Defaults to 30 min. */
  timeout_ms?: number
  /** Default delivery target for report-back when a request omits one. */
  delivery_target?: DeliveryTarget
  /** Persona loader (test seam). Defaults to a throwing stub — production injects the trident loader. */
  persona_loader: PersonaLoader
  /** run_id factory (test seam). */
  mint_run_id?: () => string
  /** Now-injection (test seam). */
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const MAX_REPORTED_RESULT_BYTES = 4 * 1024

/** Top-level dispatches never nest, so a delegation token is never minted. */
const REJECT_DELEGATION: DelegationVerifier = async () => {
  throw new Error('agent-dispatch: top-level dispatch never carries a delegation token')
}

/**
 * The general agent-dispatch service. Construct ONE per instance (the gateway
 * owns the live one); it shares the instance's `SubagentRegistry` +
 * `ControlState` with the Trident loop + the lifecycle watchdog.
 */
export class DispatchService {
  private readonly deps: DispatchServiceDeps
  private readonly timeout_ms: number
  /** run_id → live handle. The coalesce detector + a GC root for the detached completion. */
  private readonly inflight = new Map<string, DispatchHandle>()

  constructor(deps: DispatchServiceDeps) {
    this.deps = deps
    this.timeout_ms = deps.timeout_ms ?? DEFAULT_TIMEOUT_MS
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * Dispatch a named/ad-hoc background agent. Registers the run synchronously
   * (so the cap + guard apply before any process is spawned), fires the
   * substrate turn in the background, and returns a handle immediately. The
   * result is reported back via the `report` sink when the turn settles.
   *
   * A `spawn_key` collision with a live run coalesces onto the existing handle
   * (no twin process, same completion promise).
   */
  async dispatch(req: DispatchRequest): Promise<DispatchHandle> {
    // ── Board-binding chokepoint (Phase 2b) — enforced BEFORE any spawn so a
    //    rejected dispatch costs nothing. No untracked dispatches.
    const board_item_id = typeof req.board_item_id === 'string' ? req.board_item_id.trim() : ''
    if (board_item_id.length === 0) {
      throw new DispatchValidationError(
        'missing_board_item',
        'Every dispatch must be bound to a Plan item — no board_item_id was supplied. Add the ' +
          'work to the Plan first (work_board_add), then dispatch against that item id.',
      )
    }
    // The board scope of the ACTIVE project (from the tool ctx) — the item was
    // created/listed under it, so the existence check + binding must key here too.
    const board_scope = req.board_scope ?? this.deps.project_slug
    const item = this.deps.board.get(board_scope, board_item_id)
    if (item === null) {
      throw new DispatchValidationError(
        'unknown_board_item',
        `No Plan item "${board_item_id}" on this project's board. Use work_board_list to find the id.`,
      )
    }
    const readiness = assessDispatchReadiness(item)
    if (!readiness.ready) {
      // The ask-before-acting gate. The dispatch is BLOCKED; the caller asks.
      throw new DispatchValidationError('underspecified', readiness.reason ?? 'Plan item is underspecified.')
    }

    const agent_kind = AGENT_KIND_BY_DISPATCH_KIND[req.kind]
    const delivery_target = req.delivery_target ?? this.deps.delivery_target

    const spawnInput: SpawnInput = {
      instance_key: this.deps.instance_key,
      agent_kind,
    }
    if (delivery_target !== undefined) spawnInput.delivery_target = delivery_target
    if (req.spawn_key !== undefined) spawnInput.spawn_key = req.spawn_key
    if (req.on_duplicate !== undefined) spawnInput.on_duplicate = req.on_duplicate

    const spawnDeps: Parameters<typeof spawnSubagent>[1] = {
      registry: this.deps.registry,
      verify_delegation: REJECT_DELEGATION,
    }
    if (this.deps.mint_run_id !== undefined) spawnDeps.mint_run_id = this.deps.mint_run_id

    const record = await spawnSubagent(spawnInput, spawnDeps)

    // Coalesced onto an in-flight run (the double-spawn guard returned a live
    // record we already launched)? Hand back its existing handle — same
    // process, same completion promise — instead of firing a second turn.
    const existing = this.inflight.get(record.run_id)
    if (existing !== undefined) return existing

    // BIND the run to its Plan item (linked_run_id + status=in_progress → fork
    // `⑂`). The terminal report clears it. Best-effort: a board write outage
    // must not turn a valid dispatch into a rejected one.
    try {
      await this.deps.board.attachRun(board_scope, board_item_id, record.run_id)
    } catch {
      // swallow — the dispatch still proceeds; the icon just won't light.
    }

    // Fresh run → flip to running + launch the substrate turn in the background.
    const running = this.deps.registry.update(record.run_id, { status: 'running' })
    const handle = this.launch(running, req.kind, agent_kind, req, delivery_target, board_item_id, board_scope)
    this.inflight.set(record.run_id, handle)
    return handle
  }

  /**
   * Stop a live dispatch. Drives the registry record to `cancelled` and fires
   * the registered canceller. The underlying substrate turn (which owns its own
   * wall-clock timeout) may still settle later; that late result is discarded
   * because the record is already terminal — see the guard in `launch`.
   */
  async stop(run_id: string): Promise<boolean> {
    const rec = this.deps.registry.byRunId(run_id)
    if (rec === undefined) return false
    if (rec.status === 'finished' || rec.status === 'crashed' || rec.status === 'cancelled') {
      return false
    }
    await cancelRun(this.deps.control, run_id, 'caller_cancelled')
    return true
  }

  /** Live dispatches owned by this instance (excludes the Trident build agents). */
  liveDispatches(): SubagentRecord[] {
    const owned = new Set<AgentKind>(['atlas', 'sentinel', 'core'])
    return this.deps.registry
      .byOwner(this.deps.instance_key)
      .filter((r) => owned.has(r.agent_kind) && (r.status === 'pending' || r.status === 'running'))
  }

  /** Compose the persona/role for a kind into the user turn (see file header). */
  private systemFor(kind: DispatchKind): string {
    if (kind === 'adhoc') return ADHOC_SYSTEM_PROMPT
    const persona: DispatchPersonaKind = kind === 'research' ? 'atlas' : 'sentinel'
    return this.deps.persona_loader(persona).content
  }

  private launch(
    record: SubagentRecord,
    kind: DispatchKind,
    agent_kind: AgentKind,
    req: DispatchRequest,
    delivery_target: DeliveryTarget | undefined,
    board_item_id: string,
    board_scope: string,
  ): DispatchHandle {
    const run_id = record.run_id
    const repo_path = req.repo_path ?? this.deps.repo_path
    const model =
      req.model ??
      (typeof this.deps.default_model === 'function'
        ? this.deps.default_model()
        : this.deps.default_model)
    const timeout_ms = req.timeout_ms ?? this.timeout_ms
    const role = this.systemFor(kind)
    const user_message = `${role}\n\n---\n\nYour task:\n\n${req.task}`

    // The canceller is the watchdog's / a caller-stop's hook. It aborts the
    // dispatch's `AbortController`, which a production `DispatchTurn`
    // (`substrate-turn.ts`) honors by calling `handle.cancel()` — so a stop /
    // reap ACTUALLY terminates the spawned subprocess, not just the registry
    // record. The terminal STATUS transition is still owned by cancelRun/failRun.
    const abort = new AbortController()
    registerCanceller(this.deps.control, run_id, async () => {
      abort.abort()
    })

    const completion = (async (): Promise<DispatchOutcome> => {
      let turn: DispatchTurnResult
      try {
        turn = await this.deps.dispatch({
          kind: agent_kind,
          system: agent_kind,
          user_message,
          repo_path,
          trident_run_id: run_id,
          model,
          timeout_ms,
          signal: abort.signal,
        })
      } catch {
        // A closure that throws (e.g. empty credential pool) is a crashed agent.
        turn = { result: '', status: 'failed' }
      }

      this.inflight.delete(run_id)

      const cur = this.deps.registry.byRunId(run_id)
      // Already driven terminal by a caller-stop or the watchdog while the turn
      // was in flight → don't clobber its status, just report the terminal it
      // landed on (the substrate's late text is discarded).
      if (
        cur !== undefined &&
        (cur.status === 'finished' || cur.status === 'crashed' || cur.status === 'cancelled')
      ) {
        return this.report(cur, kind, agent_kind, turn.result, delivery_target, board_item_id, board_scope)
      }

      // Normally cancellation runs through cancelRun/failRun (which set the
      // terminal status BEFORE the turn resolves, caught above); this mapping is
      // the fresh-completion path. Handle a `cancelled` turn defensively so an
      // abort that somehow lands here is not mis-recorded as `crashed`.
      const status: SubagentStatus =
        turn.status === 'completed'
          ? 'finished'
          : turn.status === 'cancelled'
            ? 'cancelled'
            : 'crashed'
      const patch: Partial<Omit<SubagentRecord, 'run_id'>> = {
        status,
        ended_at: this.now(),
      }
      if (turn.status === 'timed_out') patch.failure_reason = 'stuck'
      const updated = this.deps.registry.update(run_id, patch)
      this.deps.control.cancellers.delete(run_id)
      return this.report(updated, kind, agent_kind, turn.result, delivery_target, board_item_id, board_scope)
    })()

    // The completion promise can never reject (every path is caught), so a
    // caller that ignores it cannot trip an unhandled rejection.
    return { run_id, record, completion }
  }

  private async report(
    record: SubagentRecord,
    kind: DispatchKind,
    agent_kind: AgentKind,
    result: string,
    delivery_target: DeliveryTarget | undefined,
    board_item_id: string,
    board_scope: string,
  ): Promise<DispatchOutcome> {
    // Terminal reconcile — clear the run binding so the item's fork `⑂` icon
    // goes dark. Status is left as-is (the orchestrator decides completion via
    // work_board_complete); a non-build dispatch finishing ≠ the item being
    // done. Best-effort: a board write outage never breaks the report path.
    try {
      await this.deps.board.clearRun(board_scope, board_item_id, record.run_id)
    } catch {
      // swallow
    }
    const summary = summarize(result, record.status)
    const formatInput: Parameters<typeof formatAnnouncement>[0] = { record, summary }
    const deliverables = extractDeliverables(result)
    if (deliverables.length > 0) formatInput.deliverables = deliverables
    const payload = formatAnnouncement(formatInput)
    const markdown = renderAnnouncementMarkdown(payload)

    const report: DispatchReport = {
      run_id: record.run_id,
      kind,
      agent_kind,
      status: record.status,
      markdown,
      payload,
      result: truncateBytes(result, MAX_REPORTED_RESULT_BYTES),
    }
    if (delivery_target !== undefined) report.delivery_target = delivery_target

    try {
      await this.deps.report(report)
    } catch {
      // The report sink is best-effort — a delivery failure must not turn a
      // successful dispatch into a rejected completion promise.
    }

    return {
      run_id: record.run_id,
      kind,
      agent_kind,
      status: record.status,
      result,
      payload,
    }
  }
}

/** First non-empty line of the agent's text, or a status-derived fallback. */
function summarize(result: string, status: SubagentStatus): string {
  const firstLine = result
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine !== undefined && firstLine.length > 0) {
    return firstLine.slice(0, 280)
  }
  if (status === 'finished') return 'Dispatch finished (no summary text returned).'
  return `Dispatch ${status} (no output returned).`
}

/**
 * Pull deliverable references (PR URLs / numbers, absolute paths) out of the
 * agent's terminal text so the announcement lists them. Best-effort + bounded.
 */
function extractDeliverables(result: string): string[] {
  const out = new Set<string>()
  const prUrl = /https?:\/\/\S*\/pull\/\d+/g
  for (const m of result.matchAll(prUrl)) out.add(m[0])
  const prNum = /\bPR[ #]?(\d{1,6})\b/g
  for (const m of result.matchAll(prNum)) out.add(`PR #${m[1]}`)
  return [...out].slice(0, 10)
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes (no mid-char split). */
function truncateBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(s.slice(0, mid)).length <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}
