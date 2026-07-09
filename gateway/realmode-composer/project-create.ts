/**
 * @neutronai/gateway/realmode-composer — shared project-creation primitives.
 *
 * THE single code path that turns a project NAME into a real, usable project:
 *
 *   1. `ensureProjectRow` — the real `projects` DB row + its cli wow-shell
 *      `topics` binding, in one transaction. Idempotent (`INSERT OR IGNORE`),
 *      duplicate-row-safe (`resolveBindTarget`), and soft-delete-respecting
 *      (never resurrects a project the owner deleted).
 *   2. `materializeProjectScaffold` — the on-disk `Projects/<slug>/` doc set +
 *      git repo + MEMORY/gbrain project page, via the shared project
 *      materializer. Best-effort + non-throwing (the materializer's own
 *      contract).
 *
 * Onboarding finalize (`build-onboarding-finalize.ts`) materializes the
 * projects the owner named at signup through these EXACT primitives; the
 * user-initiated create-project capability (the project-rail "Create Project"
 * button → `POST /api/app/projects`, and the `create_project` agent tool) runs
 * the SAME two functions for a single name. No second project-creation path.
 *
 * Split rationale: the row write (step 1) is a fast, deterministic DB
 * transaction; the materialization (step 2) does git + (optional) LLM doc
 * synthesis and can take seconds. The create-project HTTP/tool path awaits the
 * row, fans the live rail refresh, and kicks materialization fire-and-forget —
 * exactly as onboarding finalize is itself dispatched fire-and-forget — so the
 * button stays snappy while the project's row/topic/Work-Board are usable
 * immediately and its docs fill in shortly after.
 */

import { randomUUID } from 'node:crypto'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import type { CapturedProject } from '@neutronai/onboarding/wow-moment/action-types.ts'
import type { ProjectDocComposer } from '@neutronai/onboarding/wow-moment/project-materializer.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'

import {
  slugifyProjectId,
  synthesizeProjectContext,
} from '@neutronai/onboarding/wow-moment/project-identity.ts'
import { buildProjectMaterializer } from '@neutronai/onboarding/wow-moment/project-materializer.ts'
import { buildProjectPageIndexer } from './build-project-page-indexer.ts'
import { defaultProjectEmoji } from '../projects/default-emoji.ts'

/**
 * The dependency surface for materializing a project. A structural subset of
 * `OnboardingFinalizeDeps` so the finalizer can pass itself straight through
 * (one code path), while the create-project capability builds a minimal one.
 */
export interface ProjectScaffoldDeps {
  owner_home: string
  /** Instance internal handle / project_slug (materializer origin + topic binding). */
  project_slug: string
  db: ProjectDb
  now?: () => number
  /** Substrate-backed Anthropic client for project-doc LLM synth. null → deterministic template docs. */
  projectDocComposer?: ProjectDocComposer | null
  /** Shared GBrain syncHook so the materialized project page fans to MEMORY/gbrain. Optional. */
  gbrainSyncHook?: SyncHook
}

export interface CreateProjectResult {
  /** 'created' — a new row landed this call; 'existing' — an idempotent
   *  re-create / a project already under this id; 'skipped' — a soft-deleted
   *  row holds the resolved id (the owner deleted it; never resurrect). */
  outcome: 'created' | 'existing' | 'skipped'
  /** The canonical project id (the slug, or a pre-existing row's id). */
  project_id: string
  /** The trimmed display name. */
  name: string
}

/**
 * Resolve which existing `projects` row a create should bind to BEFORE minting
 * a new slug-keyed row, so a project that already exists under a different id
 * is reused, never doubled. Two-step: the deterministic slug row
 * (`id = slugifyProjectId(name)`), else a live row whose NAME normalizes (via
 * the SAME slugifier) to this slug under a different id. Both lookups filter
 * `deleted_at IS NULL` so a soft-deleted row is never a bind target (the
 * caller separately detects + skips a soft-deleted row on the resolved id).
 */
export function resolveBindTarget(db: ProjectDb, slug: string): string {
  const byId = db
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(slug)
  if (byId != null) return byId.id
  const live = db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE deleted_at IS NULL`,
    )
    .all()
  for (const row of live) {
    if (slugifyProjectId(row.name) === slug) return row.id
  }
  return slug
}

/**
 * Create one real `projects` row + its cli wow-shell `topics` binding in a
 * single transaction. The project id is the deterministic
 * `slugifyProjectId(name)` OR — when a row already exists whose id matches the
 * slug or whose name slugifies to it — the existing row's id (see
 * `resolveBindTarget`). `INSERT OR IGNORE` keeps re-creates idempotent; the
 * NULL `projects.topic_id` matches migration 0053 (reserved for the Telegram
 * thread id; cli shells have none); a soft-deleted row on the resolved id is
 * never resurrected (returns `'skipped'`).
 *
 * Returns `bind_id` (the id the row/topic/materializer key off) + an outcome.
 */
export async function ensureProjectRow(
  db: ProjectDb,
  project_slug: string,
  project: CapturedProject,
  slug: string,
  import_result: ImportResult | null,
  nowMs: number,
): Promise<{ outcome: 'created' | 'existing' | 'skipped'; bind_id: string }> {
  const name = project.name.trim()
  const description = synthesizeProjectContext(project, import_result)
  const iso = new Date(nowMs).toISOString() // projects.created_at/updated_at are TEXT ISO
  const topicTs = nowMs / 1000 // topics.created_at/updated_at are REAL epoch-seconds
  return db.transaction(async (tx) => {
    // Resolve the row to bind: the slug row, OR an existing live row whose name
    // normalizes to the same slug under a different id. Reusing it kills the
    // duplicate-row class.
    const bind_id = resolveBindTarget(db, slug)

    // A soft-deleted row occupying this id is intentional user state (they
    // deleted the project). Never resurrect/bind/report it.
    const deletedRow = db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL`,
      )
      .get(bind_id)
    if (deletedRow != null) return { outcome: 'skipped' as const, bind_id }

    const existingRow = db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(bind_id)
    const exists = existingRow != null

    if (!exists) {
      // persona left NULL by design — the synthesized at-rest context lands in
      // `description`; persona is a post-onboarding settings concern.
      await tx.run(
        `INSERT OR IGNORE INTO projects
           (id, name, description, persona, emoji, privacy_mode, billing_mode,
            created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, NULL, ?, 'private', 'personal', ?, ?, ?)`,
        [bind_id, name, description, defaultProjectEmoji(name), iso, iso, iso],
      )
    }
    // The wow-shell topic IS the durable binding marker; INSERT OR IGNORE on
    // its (channel_kind, channel_topic_id) keeps re-creates idempotent AND a
    // reuse of a pre-existing row from minting a duplicate binding.
    await tx.run(
      `INSERT OR IGNORE INTO topics
         (id, project_slug, project_id, channel_kind, channel_topic_id,
          privacy_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, 'cli', ?, 'regular', 'active', ?, ?)`,
      [randomUUID(), project_slug, bind_id, `wow-shell-${bind_id}`, topicTs, topicTs],
    )
    return { outcome: exists ? ('existing' as const) : ('created' as const), bind_id }
  })
}

/**
 * Build the shared project materializer from scaffold deps — the SAME
 * CC-substrate doc composer (optional) + GBrain page indexer the onboarding
 * finalizer uses.
 */
export function buildScaffoldMaterializer(
  deps: ProjectScaffoldDeps,
): ReturnType<typeof buildProjectMaterializer> {
  const now = deps.now ?? ((): number => Date.now())
  return buildProjectMaterializer({
    owner_home: deps.owner_home,
    project_slug: deps.project_slug,
    db: deps.db,
    now,
    composer: deps.projectDocComposer ?? null,
    indexer: buildProjectPageIndexer({
      ownerDataDir: deps.owner_home,
      project_slug: deps.project_slug,
      ...(deps.gbrainSyncHook !== undefined ? { syncHook: deps.gbrainSyncHook } : {}),
    }),
  })
}

/**
 * Create the `projects` row + topic binding for a single named project (the
 * fast, deterministic half — no disk I/O). The user-initiated create-project
 * capability calls this, fans the live rail refresh, then kicks
 * `materializeProjectScaffold` fire-and-forget.
 */
export async function createProjectRow(
  deps: ProjectScaffoldDeps,
  input: { name: string },
): Promise<CreateProjectResult> {
  const now = deps.now ?? ((): number => Date.now())
  const name = input.name.trim()
  const slug = slugifyProjectId(name)
  const { outcome, bind_id } = await ensureProjectRow(
    deps.db,
    deps.project_slug,
    { name },
    slug,
    null,
    now(),
  )
  return { outcome, project_id: bind_id, name }
}

/**
 * Materialize the on-disk doc set + git repo + MEMORY/gbrain page for a project
 * whose row already exists. Best-effort + non-throwing (the materializer's own
 * contract); a failure lands in its outcome only and never rolls back the row.
 */
export async function materializeProjectScaffold(
  deps: ProjectScaffoldDeps,
  input: { name: string; project_id: string },
): Promise<void> {
  const materializer = buildScaffoldMaterializer(deps)
  await materializer.materialize({
    project: { name: input.name },
    slug: input.project_id,
    import_result: null,
  })
}
