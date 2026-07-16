/**
 * @neutronai/onboarding/overnight — the dispatcher.
 *
 * The Neutron-Open port of Vajra's `overnight-dispatcher.ts`, with the
 * Ryan-locked design correction: each queued item runs as a TRIDENT RUN.
 * The dispatcher creates a `code_trident_runs` row per item (via the
 * injected `trident` seam → `trident/store.ts`) and the Trident tick drives
 * it Forge→Argus→merge. The advance tick POLLS those runs and records each
 * item's REAL terminal result; the morning brief reports only that.
 *
 * Three tick branches, driven by the existing per-project cron (renamed
 * `overnight-<slug>`, ~30 min):
 *
 *   1. SCAN (only inside 23:00–07:00 local) — reconcile any hand-seeded
 *      STATUS.md bullets into queue rows, re-render the agent-maintained
 *      STATUS.md block, gate `[context:]`, and dispatch the highest-priority
 *      queued items up to budget (2 concurrent / 8 per window).
 *   2. ADVANCE (runs anytime — items dispatched near 06:30 finish after the
 *      window closes) — poll each in-flight item's Trident run; on a terminal
 *      phase, record the real result + write a result doc + re-render
 *      STATUS.md.
 *   3. REPORTER (once at ≥06:50 local) — see `morning-brief.ts`.
 *
 * Pure helpers (window/budget) are exported for direct testing; runtime glue
 * (the Trident seam, STATUS.md IO, result-doc writer) is injected.
 */

import {
  checkContextGate,
  parseOvernightSection,
  renderOvernightSection,
  spliceOvernightSection,
  type ContextGateRejectionReason,
  type StatusMdIO,
} from './status-md-sync.ts'
import type {
  OvernightItem,
  OvernightPriority,
  OvernightQueueStore,
} from './queue-store.ts'
import { nextOwkId, owkDatePrefix } from './queue-store.ts'

// =============================================================================
// Window / cadence / budget constants
// =============================================================================

/** Default local time zone. Overridable per-instance via the dispatcher config. */
export const DEFAULT_TZ = 'America/Los_Angeles'

export const WINDOW_OPEN_HOUR = 23 // 23:00 local
export const WINDOW_CLOSE_HOUR = 7 // 07:00 local

export const REPORTER_LOCAL_HOUR = 6
export const REPORTER_LOCAL_MINUTE = 50

/** Documented caps (Vajra code drifted to 4/40; the spec pins 2/8). */
export const MAX_CONCURRENT_DEFAULT = 2
export const MAX_PER_WINDOW_DEFAULT = 8

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function envMaxConcurrent(): number {
  return parsePositiveInt(process.env.NEUTRON_OVERNIGHT_MAX_CONCURRENT, MAX_CONCURRENT_DEFAULT)
}
export function envMaxPerWindow(): number {
  return parsePositiveInt(process.env.NEUTRON_OVERNIGHT_MAX_PER_WINDOW, MAX_PER_WINDOW_DEFAULT)
}

// =============================================================================
// Time-window helpers (all in the configured TZ)
// =============================================================================

export function localParts(
  nowMs: number,
  tz = DEFAULT_TZ,
): { hour: number; minute: number; date: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(nowMs))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00'
  let hour = parseInt(get('hour'), 10)
  if (hour === 24) hour = 0
  return {
    hour,
    minute: parseInt(get('minute'), 10),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/** True iff `nowMs` is inside the overnight window (23:00–07:00 local). */
export function inOvernightWindow(nowMs: number, tz = DEFAULT_TZ): boolean {
  const { hour } = localParts(nowMs, tz)
  return hour >= WINDOW_OPEN_HOUR || hour < WINDOW_CLOSE_HOUR
}

function shiftLocalDate(yyyymmdd: string, deltaDays: number): string {
  const [y, m, d] = yyyymmdd.split('-').map((s) => parseInt(s, 10))
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`shiftLocalDate: malformed date '${yyyymmdd}'`)
  }
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + deltaDays)
  const yy = dt.getUTCFullYear().toString().padStart(4, '0')
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = dt.getUTCDate().toString().padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** Local YYYY-MM-DD the current window opened on, or null outside the window. */
export function currentWindowDate(nowMs: number, tz = DEFAULT_TZ): string | null {
  const { hour, date } = localParts(nowMs, tz)
  if (hour >= WINDOW_OPEN_HOUR) return date
  if (hour < WINDOW_CLOSE_HOUR) return shiftLocalDate(date, -1)
  return null
}

/** Whether the reporter should fire for the current window date. */
export function shouldReport(nowMs: number, tz = DEFAULT_TZ): boolean {
  const { hour, minute } = localParts(nowMs, tz)
  if (hour > REPORTER_LOCAL_HOUR) return hour < WINDOW_CLOSE_HOUR // 06:50–06:59 only really
  return hour === REPORTER_LOCAL_HOUR && minute >= REPORTER_LOCAL_MINUTE
}

const PRIORITY_RANK: Record<OvernightPriority, number> = { P1: 0, P2: 1, P3: 2 }

// =============================================================================
// Trident seam — each item runs AS a Trident run
// =============================================================================

export interface OvernightTridentCreateInput {
  owner_slug: string
  repo_path: string
  task: string
  slug: string
  ralph: boolean
  /** Resolved `[context:]` file text, threaded into the run's task. */
  context_text?: string
}

export interface OvernightTridentHandle {
  id: string
  slug: string
}

/** Terminal-aware snapshot of a Trident run the advance tick polls. */
export interface OvernightTridentSnapshot {
  phase: string
  failure_reason: string | null
  branch: string | null
  pr: number | null
}

export interface OvernightTridentSeam {
  createRun(input: OvernightTridentCreateInput): Promise<OvernightTridentHandle>
  getRun(id: string): OvernightTridentSnapshot | null
}

const TRIDENT_TERMINAL = new Set(['done', 'failed', 'stopped'])

// =============================================================================
// Opted-in project enumeration + result-doc writer seams
// =============================================================================

export interface OptedInProject {
  slug: string
  /** Absolute path to the project repo root (`Projects/<slug>/`). */
  repo_root: string
  /** Absolute path to the project's STATUS.md. */
  status_md_path: string
}

export interface ResultDocWriter {
  /** Persist the real run result into the repo; returns the relative path. */
  writeResultDoc(repo_root: string, item: OvernightItem, result: string): string
}

export interface RejectionSink {
  (input: {
    owner_slug: string
    item: OvernightItem
    reason: ContextGateRejectionReason
    detail: string
  }): void
}

// =============================================================================
// Dispatcher
// =============================================================================

export interface OvernightDispatcherDeps {
  store: OvernightQueueStore
  trident: OvernightTridentSeam
  io: StatusMdIO
  result_docs: ResultDocWriter
  /** Enumerate the opted-in projects each tick. */
  listOptedInProjects(): OptedInProject[]
  now(): number
  tz?: string
  max_concurrent?: number
  max_per_window?: number
  log?(msg: string): void
  on_rejection?: RejectionSink
}

export interface ScanResult {
  window_date: string
  reconciled: number
  dispatched: number
  rejected: number
}

export interface AdvanceResult {
  swept: number
  completed: number
  failed: number
}

export class OvernightDispatcher {
  constructor(private readonly deps: OvernightDispatcherDeps) {}

  private get tz(): string {
    return this.deps.tz ?? DEFAULT_TZ
  }
  private log(msg: string): void {
    this.deps.log?.(`[overnight] ${msg}`)
  }

  // ---- SCAN ------------------------------------------------------------

  /**
   * Reconcile + dispatch. Only meaningful inside the window. Returns null
   * when called outside the window (the caller skips dispatch but still
   * advances).
   */
  async runScanTick(): Promise<ScanResult | null> {
    const nowMs = this.deps.now()
    const window_date = currentWindowDate(nowMs, this.tz)
    if (window_date === null) return null

    let reconciled = 0
    const projects = this.deps.listOptedInProjects()
    for (const p of projects) {
      reconciled += await this.reconcileProject(p, nowMs)
      this.renderProject(p)
    }

    const { dispatched, rejected } = await this.dispatchUpToBudget(projects, window_date, nowMs)

    // Re-render after dispatch so in-flight transitions land in STATUS.md.
    for (const p of projects) this.renderProject(p)

    this.log(
      `scan: window=${window_date} reconciled=${reconciled} dispatched=${dispatched} rejected=${rejected}`,
    )
    return { window_date, reconciled, dispatched, rejected }
  }

  /**
   * Adopt any hand-seeded STATUS.md bullet that has no matching queue row
   * into a real `overnight_queue` row (the chat-driven queue's safety net —
   * normally the agent writes rows directly). Returns the count adopted.
   */
  private async reconcileProject(p: OptedInProject, nowMs: number): Promise<number> {
    const body = this.deps.io.read(p.status_md_path)
    if (body === null) return 0
    const bullets = parseOvernightSection(body)
    if (bullets.length === 0) return 0
    const existing = this.deps.store.listByProject(p.slug)
    const knownIds = new Set(existing.map((i) => i.id))
    const knownDescs = new Set(existing.map((i) => i.description))
    const allocated = new Set<string>(this.deps.store.list().map((i) => i.id))
    const today = owkDatePrefix(nowMs)
    let adopted = 0
    for (const b of bullets) {
      if (b.status === 'completed' || b.status === 'failed') continue
      if (b.id && knownIds.has(b.id)) continue
      if (!b.id && knownDescs.has(b.description)) continue
      if (!b.description) continue
      const id = b.id && !allocated.has(b.id) ? b.id : nextOwkId(today, allocated)
      allocated.add(id)
      await this.deps.store.create({
        id,
        owner_slug: p.slug,
        description: b.description,
        agent_role: b.agent_role,
        priority: b.priority,
        context_relpath: b.context_relpath,
        created_at: b.created_at ?? new Date(nowMs).toISOString(),
      })
      adopted++
    }
    return adopted
  }

  /** Re-render the STATUS.md overnight block from the project's queue rows. */
  private renderProject(p: OptedInProject): void {
    const items = this.deps.store.listByProject(p.slug)
    const body = this.deps.io.read(p.status_md_path)
    if (body === null) return
    const next = spliceOvernightSection(body, renderOvernightSection(items))
    if (next !== body) this.deps.io.write(p.status_md_path, next)
  }

  private async dispatchUpToBudget(
    projects: OptedInProject[],
    window_date: string,
    nowMs: number,
  ): Promise<{ dispatched: number; rejected: number }> {
    const maxConcurrent = this.deps.max_concurrent ?? envMaxConcurrent()
    const maxPerWindow = this.deps.max_per_window ?? envMaxPerWindow()
    const repoBySlug = new Map(projects.map((p) => [p.slug, p]))

    // Highest priority first, then oldest queued.
    const queued = this.deps.store
      .listByStatus('queued')
      .filter((i) => repoBySlug.has(i.owner_slug))
      .sort((a, b) => {
        if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
          return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        }
        return a.created_at.localeCompare(b.created_at)
      })

    let dispatched = 0
    let rejected = 0
    let inflight = this.deps.store.countInFlight()
    let started = this.deps.store.startedThisWindow(window_date)

    for (const item of queued) {
      if (inflight >= maxConcurrent) break
      if (started >= maxPerWindow) break
      const p = repoBySlug.get(item.owner_slug)
      if (!p) continue

      // HARD GATE — double-enforced at dispatch.
      const gate = checkContextGate(p.repo_root, item)
      if (!gate.ok) {
        rejected++
        this.deps.on_rejection?.({
          owner_slug: item.owner_slug,
          item,
          reason: gate.reason ?? 'missing-context-tag',
          detail: gate.detail ?? 'context gate failed',
        })
        this.log(`reject ${item.id} (${item.owner_slug}): ${gate.detail}`)
        continue
      }

      try {
        const handle = await this.deps.trident.createRun({
          owner_slug: item.owner_slug,
          repo_path: p.repo_root,
          task: item.description,
          slug: tridentSlugFor(item),
          ralph: item.ralph,
          ...(gate.context_text !== undefined ? { context_text: gate.context_text } : {}),
        })
        await this.deps.store.update(item.id, {
          status: 'in-flight',
          trident_run_id: handle.id,
          trident_slug: handle.slug,
          started_at: new Date(nowMs).toISOString(),
          window_date_local: window_date,
        })
        await this.deps.store.incrementStarted(window_date, 1)
        dispatched++
        inflight++
        started++
        this.log(`dispatch ${item.id} → trident run ${handle.id} (${handle.slug})`)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        const attempts = item.spawn_attempts + 1
        if (attempts >= 3) {
          await this.deps.store.update(item.id, {
            status: 'failed',
            spawn_attempts: attempts,
            result: `failed: ${reason}`,
            finished_at: new Date(nowMs).toISOString(),
          })
          this.log(`dispatch ${item.id} failed permanently after ${attempts} attempts: ${reason}`)
        } else {
          await this.deps.store.update(item.id, { spawn_attempts: attempts })
          this.log(`dispatch ${item.id} transient failure (attempt ${attempts}): ${reason}`)
        }
      }
    }
    return { dispatched, rejected }
  }

  // ---- ADVANCE ---------------------------------------------------------

  /**
   * Poll each in-flight item's Trident run. On a terminal phase, record the
   * REAL result, write a result doc into the repo, mark the item terminal,
   * and re-render STATUS.md. Runs anytime (items started near 06:30 finish
   * after the window closes).
   */
  async runAdvanceTick(): Promise<AdvanceResult> {
    const nowMs = this.deps.now()
    const inflight = this.deps.store.listByStatus('in-flight')
    const dirtyProjects = new Set<string>()
    let completed = 0
    let failed = 0

    for (const item of inflight) {
      if (!item.trident_run_id) continue
      const snap = this.deps.trident.getRun(item.trident_run_id)
      if (snap === null) continue
      if (!TRIDENT_TERMINAL.has(snap.phase)) continue

      const terminalOk = snap.phase === 'done'
      const result = terminalOk
        ? successResult(snap)
        : `failed: ${snap.failure_reason ?? snap.phase}`

      // Write the real result into the repo so the work is auditable on disk.
      const p = this.deps
        .listOptedInProjects()
        .find((x) => x.slug === item.owner_slug)
      if (p) {
        try {
          this.deps.result_docs.writeResultDoc(p.repo_root, { ...item, result }, result)
        } catch (err) {
          this.log(`result-doc write failed for ${item.id}: ${err}`)
        }
      }

      await this.deps.store.update(item.id, {
        status: terminalOk ? 'completed' : 'failed',
        result,
        finished_at: new Date(nowMs).toISOString(),
      })
      dirtyProjects.add(item.owner_slug)
      if (terminalOk) completed++
      else failed++
      this.log(`advance ${item.id} → ${terminalOk ? 'completed' : 'failed'} (${result})`)
    }

    if (dirtyProjects.size > 0) {
      const projects = this.deps.listOptedInProjects()
      for (const p of projects) {
        if (dirtyProjects.has(p.slug)) this.renderProject(p)
      }
    }

    return { swept: inflight.length, completed, failed }
  }
}

/** Stable Trident slug for an item (idempotent across re-dispatch). */
export function tridentSlugFor(item: OvernightItem): string {
  return `overnight-${item.id}`
}

/** Real success result string from a completed Trident run snapshot. */
export function successResult(snap: OvernightTridentSnapshot): string {
  if (typeof snap.pr === 'number' && snap.pr > 0) return `PR#${snap.pr}`
  if (snap.branch) return `merged ${snap.branch}`
  return 'merged'
}
