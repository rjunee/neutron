/**
 * @neutronai/onboarding/overnight — production wiring.
 *
 * Builds the real `overnight_handler` cron handler (which superseded the
 * now-removed preview-only morning check-in stub `wow_overnight_handler`)
 * and the production seams it runs on:
 *
 *   • `buildOvernightTridentSeam` — each queued item becomes a real
 *     `code_trident_runs` row (via `TridentRunStore`), driven by the Trident
 *     tick (`trident/tick.ts`). The advance tick polls those rows.
 *   • `defaultStatusMdIO` / `defaultResultDocWriter` — real-fs STATUS.md
 *     sync + per-item result-doc persistence.
 *   • `enumerateOptedInProjects` — walk each `<owner_home>/Projects/<slug>/`
 *     STATUS.md for `autonomous_overnight_enabled: true`.
 *
 * The handler drives, per ~30-min tick: scan (in-window) → advance (always)
 * → reporter (once at ≥06:50). It NEVER throws — every failure lands as a
 * structured `{ status, detail }` so `cron_state` records it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProjectDb } from '../../persistence/index.ts'
import type {
  CronHandler,
  CronHandlerContext,
  CronHandlerRegistry,
  CronHandlerResult,
} from '../../cron/handlers.ts'
import {
  detectMergeMode,
  defaultGitModeProbe,
  type GitModeProbe,
} from '../../trident/git-mode.ts'
import { TridentRunStore } from '../../trident/store.ts'
import { OvernightQueueStore, type OvernightItem } from './queue-store.ts'
import {
  OvernightDispatcher,
  shouldReport,
  type OptedInProject,
  type OvernightTridentSeam,
  type ResultDocWriter,
} from './dispatcher.ts'
import { runMorningBrief, type MorningBriefDeliverInput } from './morning-brief.ts'
import { parseOptInFlag, type StatusMdIO } from './status-md-sync.ts'

export const OVERNIGHT_HANDLER_NAME = 'overnight_handler'

// ---------------------------------------------------------------------------
// Production seams
// ---------------------------------------------------------------------------

/** Real-fs STATUS.md reader/writer. */
export const defaultStatusMdIO: StatusMdIO = {
  read(path: string): string | null {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  write(path: string, content: string): void {
    writeFileSync(path, content)
  },
}

/**
 * Persist each item's REAL result into the repo at
 * `docs/overnight/<owk-id>.md` so the work is auditable on disk and the
 * morning brief is never the only record.
 */
export const defaultResultDocWriter: ResultDocWriter = {
  writeResultDoc(repo_root: string, item: OvernightItem, result: string): string {
    const rel = join('docs', 'overnight', `${item.id}.md`)
    const abs = join(repo_root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const body =
      `# Overnight result — ${item.id}\n\n` +
      `- Project: ${item.project_slug}\n` +
      `- Task: ${item.description}\n` +
      `- Agent: ${item.agent_role}${item.ralph ? ' (ralph)' : ''}\n` +
      `- Trident run: ${item.trident_run_id ?? '(none)'} (${item.trident_slug ?? '-'})\n` +
      `- Result: ${result}\n` +
      `- Finished: ${item.finished_at ?? new Date().toISOString()}\n`
    writeFileSync(abs, body)
    return rel
  },
}

/**
 * Build the Trident seam: create a `code_trident_runs` row per item and poll
 * it. `ralph` items use Ralph spec-driven build mode; the merge mode is
 * auto-detected per the run's repo (`pr` when a GitHub origin + `gh` exist,
 * else `local`).
 */
export function buildOvernightTridentSeam(
  tridentStore: TridentRunStore,
  probe: GitModeProbe = defaultGitModeProbe(),
): OvernightTridentSeam {
  return {
    async createRun(input) {
      const merge_mode = await detectMergeMode(input.repo_path, probe)
      // Thread the resolved context file into the run's task so the Forge
      // sub-agent sees it without re-reading (mirrors Vajra's prompt inject).
      const task = input.context_text
        ? `${input.task}\n\n--- context ---\n${input.context_text}`
        : input.task
      const run = await tridentStore.create({
        slug: input.slug,
        project_slug: input.project_slug,
        repo_path: input.repo_path,
        task,
        ralph: input.ralph,
        merge_mode,
      })
      return { id: run.id, slug: run.slug }
    },
    getRun(id) {
      const run = tridentStore.get(id)
      if (run === null) return null
      return {
        phase: run.phase,
        failure_reason: run.failure_reason,
        branch: run.branch,
        pr: run.pr,
      }
    },
  }
}

/**
 * Enumerate opted-in projects (each `<owner_home>/Projects/<slug>/`) whose
 * STATUS.md frontmatter carries `autonomous_overnight_enabled: true`.
 */
export function enumerateOptedInProjects(owner_home: string): OptedInProject[] {
  const projectsDir = join(owner_home, 'Projects')
  if (!existsSync(projectsDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return []
  }
  const out: OptedInProject[] = []
  for (const slug of entries) {
    const repo_root = join(projectsDir, slug)
    const status_md_path = join(repo_root, 'STATUS.md')
    if (!existsSync(status_md_path)) continue
    let body: string
    try {
      body = readFileSync(status_md_path, 'utf8')
    } catch {
      continue
    }
    if (!parseOptInFlag(body)) continue
    out.push({ slug, repo_root, status_md_path })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface OvernightEngineDeliver {
  (input: MorningBriefDeliverInput): boolean | Promise<boolean>
}

/**
 * Resolve OWNER_ROOT from the environment (mirrors gateway boot-helpers'
 * `resolveOwnerHome`, inlined to keep the onboarding module from depending
 * on the gateway layer). Honors `OWNER_HOME`, else derives from the locked
 * `<owner_home>/db/project.db` layout via `NEUTRON_DB_PATH`.
 */
export function resolveOwnerHomeFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env['OWNER_HOME']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const dbPath = env['NEUTRON_DB_PATH']
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    return dirname(dirname(dbPath))
  }
  return null
}

export interface BuildOvernightEngineInput {
  db: ProjectDb
  /**
   * OWNER_ROOT — projects live under `<owner_home>/Projects/<slug>/`. When
   * omitted, resolved from `OWNER_HOME` / `NEUTRON_DB_PATH` env (production
   * sets these per-instance). When neither resolves, the engine enumerates
   * no projects and every tick is a clean no-op.
   */
  owner_home?: string
  /** Deliver the morning brief + rejection notices. Absent → report-skipped. */
  deliver?: OvernightEngineDeliver
  tz?: string
  /** Test seams. */
  now?: () => number
  trident_seam?: OvernightTridentSeam
  io?: StatusMdIO
  result_docs?: ResultDocWriter
  listOptedInProjects?: () => OptedInProject[]
  /** Resolve a project slug → bound Telegram topic id (else General). */
  resolveProjectTopic?: (project_slug: string) => string | null
  log?: (msg: string) => void
}

interface OnboardingTopicRow {
  phase_state_json: string
}

/**
 * Build the production `overnight_handler`. Each fire: scan (in-window) →
 * advance (always) → reporter (once at ≥06:50). Reports the REAL Trident-run
 * results via the morning brief.
 */
export function buildOvernightEngineHandler(input: BuildOvernightEngineInput): CronHandler {
  const now = input.now ?? (() => Date.now())
  const tz = input.tz
  const queueStore = new OvernightQueueStore(input.db, () => new Date(now()).toISOString())
  const tridentSeam =
    input.trident_seam ?? buildOvernightTridentSeam(new TridentRunStore(input.db))
  const io = input.io ?? defaultStatusMdIO
  const result_docs = input.result_docs ?? defaultResultDocWriter
  const ownerHome = input.owner_home ?? resolveOwnerHomeFromEnv()
  const listOptedInProjects =
    input.listOptedInProjects ??
    (() => (ownerHome === null ? [] : enumerateOptedInProjects(ownerHome)))

  const dispatcher = new OvernightDispatcher({
    store: queueStore,
    trident: tridentSeam,
    io,
    result_docs,
    listOptedInProjects,
    now,
    ...(tz !== undefined ? { tz } : {}),
    ...(input.log !== undefined ? { log: input.log } : {}),
  })

  return async (ctx: CronHandlerContext): Promise<CronHandlerResult> => {
    try {
      const scan = await dispatcher.runScanTick()
      const advance = await dispatcher.runAdvanceTick()

      let reportDetail = 'no report this tick'
      if (shouldReport(now(), tz) && input.deliver !== undefined) {
        const generalTopic = resolveGeneralTopic(input.db)
        if (generalTopic !== null) {
          const briefDeps: Parameters<typeof runMorningBrief>[0] = {
            store: queueStore,
            deliver: input.deliver,
            general_topic_id: generalTopic,
            now,
            ...(tz !== undefined ? { tz } : {}),
            ...(input.resolveProjectTopic !== undefined
              ? { resolveProjectTopic: input.resolveProjectTopic }
              : {}),
            ...(input.log !== undefined ? { log: input.log } : {}),
          }
          const brief = await runMorningBrief(briefDeps)
          reportDetail = `report=${brief.status} (${brief.detail})`
        } else {
          reportDetail = 'report skipped: no General topic resolved'
        }
      }

      const scanDetail =
        scan === null
          ? 'scan skipped (outside window)'
          : `scan: dispatched=${scan.dispatched} rejected=${scan.rejected} reconciled=${scan.reconciled}`
      return {
        status: 'ok',
        detail: `${scanDetail}; advance: completed=${advance.completed} failed=${advance.failed}; ${reportDetail}`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown')
      return { status: 'error', detail: `overnight_handler failed: ${msg}` }
    }
  }
}

/**
 * Resolve the General/main topic id from the most-recently-completed
 * onboarding row's phase_state (same source the old check-in handler used).
 */
function resolveGeneralTopic(db: ProjectDb): string | null {
  const row = db
    .prepare<OnboardingTopicRow, []>(
      `SELECT phase_state_json
         FROM onboarding_state
        WHERE phase = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1`,
    )
    .get()
  if (row === undefined || row === null) return null
  try {
    const ps = JSON.parse(row.phase_state_json) as Record<string, unknown>
    return typeof ps['topic_id'] === 'string' ? ps['topic_id'] : null
  } catch {
    return null
  }
}

/**
 * Register `overnight_handler` in the production registry. Idempotent across
 * repeat calls (mirrors `registerImportRunningCron`'s guard). The JOB
 * (`overnight-<slug>`) is registered dynamically by wow-moment action 07 at
 * dispatch time; only the handler registration lives here.
 */
export function registerOvernightHandler(input: {
  handlers: CronHandlerRegistry
  handler: CronHandler
}): void {
  if (input.handlers.get(OVERNIGHT_HANDLER_NAME) === undefined) {
    input.handlers.register(OVERNIGHT_HANDLER_NAME, input.handler)
  }
}
