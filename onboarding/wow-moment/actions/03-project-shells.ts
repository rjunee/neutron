/**
 * Action 3 — project shells.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 #3. Fires when the user
 * confirmed ≥ 2 projects at `projects_proposed` OR (zero-confirm path)
 * Pass-2 `ImportResult.proposed_projects.length ≥ 2`. Per-project
 * transaction so failures don't cascade.
 *
 * ISSUES #95 (2026-06-05) — project shells are now REAL projects. The
 * pre-#95 implementation wrote ONLY a bare cli `topics` row with a fresh
 * random `project_id` and NO matching `projects` row. The `projects`
 * table (which holds `name`/`description`/`persona`/`topic_id`) stayed
 * empty, so the web sidebar — which lists projects by name from
 * `projects` — showed nothing usable. It was also non-idempotent (a
 * fresh random id per run piled up 24 orphan shells across 4 re-fires on
 * one prod instance) and logged `shells_created` regardless of what it
 * actually wrote (ships-as-no-op-logging-success).
 *
 * The fix, per project:
 *   - Derive a DETERMINISTIC `project_id` via `slugifyProjectId(name)` —
 *     the SAME slug the onboarding-handoff hook keys its per-project
 *     proactive seed prompt off of (`web:<user_id>:<slug>`), so the
 *     named sidebar project and the seed-question topic are ONE thing.
 *   - Transactionally `INSERT OR IGNORE` a real `projects` row (name +
 *     synthesized at-rest context) AND its `topics` binding
 *     (`channel_kind='cli'`, `channel_topic_id='wow-shell-<id>'`). The
 *     wow-shell topic IS the binding marker; `projects.topic_id` stays
 *     NULL (migration 0053 reserves it for the Telegram message_thread_id,
 *     which app/cli shells don't have). Deterministic ids make re-runs a
 *     no-op (idempotent).
 *   - One-time cleanup of legacy orphan `wow-shell-*` topics that have
 *     no matching `projects` row (the prod pile-up).
 *   - Honest metrics: `created` / `existing` / `failure_count` reflect
 *     what actually happened; success is never logged on a no-op.
 *
 * 2026-05-28 sprint — when `ctx.captured_projects` is non-empty the
 * engine has plumbed `primary_projects_confirmed` (the user's authored
 * answer at `projects_proposed`); that list is authoritative and the
 * `import_result.proposed_projects` merge + 5-project cap are skipped.
 * Pre-fix the action silently dropped Home Assistant + Side Project
 * (freeform-added entries that never landed in `import_result`) and
 * trimmed a 7-project confirm to 5. Same sprint dropped the
 * "Keep all / Drop one / Drop all" button keyboard — the user already
 * confirmed at `projects_proposed`; the shells-created emit is now a
 * passive declaration with freeform-only amendment.
 */

import type {
  CapturedProject,
  WowActionContext,
  WowActionModule,
  WowActionResult,
} from '../action-types.ts'
import { slugifyProjectId, synthesizeProjectContext } from '../project-identity.ts'
import { defaultProjectEmoji } from '../../../gateway/projects/default-emoji.ts'
import {
  buildProjectMaterializer,
  mapBounded,
  MATERIALIZE_CONCURRENCY,
  type MaterializeOutcome,
  type ProjectMaterializer,
} from '../project-materializer.ts'
import type { WowEngagement } from '../telemetry.ts'

const ACTION_ID = '03-project-shells' as const
const MIN_PROJECTS = 2

const action03: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(ctx: WowActionContext): boolean {
    return mergedProjects(ctx).length >= MIN_PROJECTS
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    const projects = mergedProjects(ctx)
    if (projects.length === 0) {
      // The user confirmed zero projects (deliberate skip-ahead). Nothing
      // to create; never emit a "shells created" lie.
      return {
        fired: false,
        reason: 'all_failed',
        redacted_payload: { count: 0, created: 0, existing: 0, failure_count: 0 },
      }
    }

    // One-time cleanup of legacy orphan shells: pre-#95 runs left bare
    // `wow-shell-*` topics with a random project_id and NO projects row.
    // They are the prod 24-orphan pile-up. Real (projects-backed) shells
    // are never matched by this predicate, so re-runs are a no-op.
    await cleanupOrphanShells(ctx)

    // `present` preserves input order for the passive-declaration body +
    // a stable idempotency seed; it carries every project that now has a
    // real row (whether newly created this run or already present).
    const present: string[] = []
    const created: string[] = []
    const existing: string[] = []
    const failures: Array<{ name: string; error: string }> = []
    // Dedup by SLUG, not just by lowercase name: two confirmed names can
    // normalize to the same project_id (e.g. "Home/Assistant" + "Home
    // Assistant" → "home-assistant", or all-punctuation names → "project").
    // Without this both reconcile against the same row — the second
    // INSERT/UPDATE no-ops — yet `present`/metrics would double-count and
    // the body would claim two shells for one real project.
    const seenSlugs = new Set<string>()
    // Item 4 — projects whose DB rows now exist get materialized on disk
    // AFTER the reconcile loop (best-effort, post-commit; spec § 4.2).
    // 'existing' rows are included so instances shelled BEFORE Item 4
    // landed (DB rows, zero disk) backfill on the daily overnight
    // re-fire — the materializer's own STATUS.md marker makes a second
    // pass over an already-materialized project a strict no-op.
    const materializeTargets: Array<{ project: CapturedProject; bind_id: string }> = []
    for (const p of projects) {
      const slug = slugifyProjectId(p.name)
      if (seenSlugs.has(slug)) continue
      seenSlugs.add(slug)
      try {
        const { outcome, bind_id } = await reconcileProject(ctx, p, slug)
        // 'skipped' — a soft-deleted row holds this slug; the user deleted it
        // and we honor that. Not present, not created/existing, not a
        // failure: the body simply never claims a shell for it.
        if (outcome === 'skipped') continue
        present.push(p.name)
        materializeTargets.push({ project: p, bind_id })
        if (outcome === 'created') created.push(p.name)
        else existing.push(p.name)
      } catch (err) {
        failures.push({ name: p.name, error: (err as Error).message })
      }
    }

    const materialization = await materializeProjects(ctx, materializeTargets)

    if (present.length === 0) {
      // Every project errored — honest failure, no emit.
      return {
        fired: false,
        reason: 'all_failed',
        redacted_payload: {
          count: 0,
          created: 0,
          existing: 0,
          failure_count: failures.length,
        },
      }
    }

    // GAP3 (onboarding-wow-handoff-fix, 2026-06-09) — SILENCE the receipt.
    // Pre-fix this action emitted a passive "I created shells for these
    // projects: … Let me know if any of these need changing." prompt to
    // the General topic. That receipt (a) ended in a pointless question and
    // (b) CONTENDED with the final-handoff GUIDE for the terminal General
    // slot — and on the live brief path the guide never fired, so the
    // receipt was the only terminal message Sam saw in his 2026-06-09
    // signup. The shells are created silently now (DB writes + telemetry
    // below are unchanged); the engine's final-handoff GUIDE is the single
    // message that names the projects and tells the user to click into each
    // one (see engine.ts dispatchWowAndAdvance → emitFinalHandoffPrompt,
    // which fires on BOTH the brief and no-brief paths after this dispatch).
    // The created-project list rides out on `redacted_payload.created_names`
    // so the engine/telemetry can reconcile shelled-count without re-querying.
    return {
      fired: true,
      reason: 'shells_created',
      redacted_payload: {
        // `count` = projects that now exist as real rows (created this
        // run + already present). `created`/`existing` split it honestly
        // so a re-run reports `created:0` instead of claiming N new shells.
        count: present.length,
        created: created.length,
        existing: existing.length,
        failure_count: failures.length,
        // Names the guide can reflect (Gap 1 makes these match the
        // confirmed list). Redacted payloads are telemetry-only.
        created_names: [...present],
        // Item 4 — on-disk materialization telemetry (counts only).
        materialized: materialization.materialized,
        materialize_existing: materialization.already,
        materialize_failures: materialization.failed,
        transcript_chunks_sliced: materialization.slice_chunks,
      },
    }
  },

  // 2026-05-28 — the keyboard is gone, but `decodeEngagement` is
  // retained for telemetry back-compat with any in-flight prompts that
  // still submit the legacy values. Production traffic resolves the
  // shells-created emit via freeform replies → `__freeform__`.
  decodeEngagement(value: string): WowEngagement | null {
    if (value === 'kept' || value === 'tweaked' || value === 'skipped') return value
    return null
  },
}

/**
 * Item 4 (post-onboarding-experience spec § ITEM 4) — materialize the
 * shelled projects on disk: real git repo + the project-folder-convention
 * § 3 doc set + transcript slices + memory index, via the injected
 * `ctx.materializer` (production: CC-substrate doc composer + GBrain
 * indexer wired in `build-wow-dispatcher.ts`) or a default-built
 * deterministic materializer (template docs, no index) when absent.
 *
 * BEST-EFFORT, post-commit (spec § 4.2): a materialization failure never
 * rolls back the `projects`/`topics` rows and never fails the action —
 * it lands in the redacted telemetry counts only. Bounded concurrency
 * per § 4.2c.
 */
async function materializeProjects(
  ctx: WowActionContext,
  targets: ReadonlyArray<{ project: CapturedProject; bind_id: string }>,
): Promise<{ materialized: number; already: number; failed: number; slice_chunks: number }> {
  const tally = { materialized: 0, already: 0, failed: 0, slice_chunks: 0 }
  if (targets.length === 0) return tally
  const materializer: ProjectMaterializer =
    ctx.materializer ??
    buildProjectMaterializer({
      owner_home: ctx.owner_home,
      project_slug: ctx.project_slug,
      db: ctx.db,
      now: () => ctx.now(),
    })
  let outcomes: MaterializeOutcome[]
  try {
    outcomes = await mapBounded(targets, MATERIALIZE_CONCURRENCY, (t) =>
      materializer.materialize({
        project: t.project,
        slug: t.bind_id,
        import_result: ctx.import_result,
      }),
    )
  } catch (err) {
    // The materializer is contractually non-throwing per project; this
    // catch is a belt-and-braces guard so a defect in it can never sink
    // the shells the DB transaction already committed.
    // eslint-disable-next-line no-console
    console.warn(
      `[03-project-shells] materialization pass threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    tally.failed = targets.length
    return tally
  }
  for (const o of outcomes) {
    if (o.reason === 'created') tally.materialized += 1
    else if (o.reason === 'already_materialized') tally.already += 1
    else tally.failed += 1
    tally.slice_chunks += o.slice_chunk_count
  }
  return tally
}

function mergedProjects(ctx: WowActionContext): CapturedProject[] {
  const seen = new Set<string>()
  const merged: CapturedProject[] = []
  for (const p of ctx.captured_projects) {
    const key = p.name.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(p)
  }
  // 2026-05-28 — when the user has confirmed at projects_proposed
  // (`ctx.projects_confirmed === true`) the engine has plumbed
  // `captured_projects` from `primary_projects_confirmed`
  // (see engine.ts:buildWowSignalsFromState). That list is the user's
  // verbatim answer; merging the larger `import_result.proposed_projects`
  // set would resurrect projects the user explicitly dropped during the
  // freeform-amend pass — OR, in the zero-state skip-ahead case
  // (`primary_projects_confirmed: []`), would create shells the user
  // explicitly declined. Either way we skip the import merge whenever
  // confirmation is observed.
  //
  // Legacy / unconfirmed callers (no `projects_confirmed` flag) keep
  // the pre-fix contract: dedupe-merge `captured_projects` and
  // `import_result.proposed_projects` so a fixture with 1 captured +
  // 2 imported still fires (Codex r2 pickup — pre-fix logic was
  // `length === 0` gated, which silently dropped the import side for
  // ANY non-empty captured input, breaking the m2-casey-style legacy
  // shape).
  const hasConfirmed = ctx.projects_confirmed === true
  if (!hasConfirmed && ctx.import_result !== null) {
    for (const p of ctx.import_result.proposed_projects) {
      const key = p.name.trim().toLowerCase()
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      merged.push({ name: p.name, rationale: p.rationale })
    }
  }
  return merged
}

/**
 * Delete legacy orphan shells: `wow-shell-*` topics whose `project_id`
 * has no matching `projects` row. Real shells written by `reconcileProject`
 * always have a backing `projects` row, so they are never swept. Runs once
 * per invocation; idempotent (a healthy instance deletes 0 rows).
 */
async function cleanupOrphanShells(ctx: WowActionContext): Promise<void> {
  await ctx.db.run(
    `DELETE FROM topics
       WHERE channel_topic_id LIKE 'wow-shell-%'
         AND project_id IS NOT NULL
         AND project_id NOT IN (SELECT id FROM projects)`,
    [],
  )
}

/**
 * Resolve which `projects` row a confirmed name should bind to, BEFORE we
 * mint a new slug-keyed row. Two-step:
 *
 *   1. The deterministic slug row (`id = slugifyProjectId(name)`).
 *   2. Failing that, a live row whose NAME normalizes to the same slug but
 *      was persisted under a DIFFERENT id. Example: a row id `northwind` with
 *      name "Northwind Labs" — which slugifies to `northwind-labs`, NOT
 *      `northwind`. Keying only on the slug missed it, so an owner confirming
 *      "Northwind Labs" minted a SECOND live "Northwind Labs" (id
 *      `northwind-labs`) while the original `northwind` row lingered →
 *      `GET /api/app/projects` showed TWO. This name-normalized fallback
 *      resolves the existing row instead — the exact duplicate-shell class #95
 *      exists to kill. (The original trigger was the now-removed
 *      `KNOWN_PROJECTS` demo seed; the fallback still guards any pre-existing
 *      unbound row.)
 *
 * A name-slug match means SAME project identity, so we resolve it whether
 * or not it's already shelled — `reconcileProject` then treats an
 * already-shelled row as a no-op (`'existing'`), which is what keeps a
 * SECOND run from minting the slug duplicate the seed row already covers.
 * Both lookups filter `deleted_at IS NULL` so a soft-deleted row is never
 * resolved as a bind target — `reconcileProject` separately detects a
 * soft-deleted row sitting on the resolved id and returns `'skipped'`.
 */
function resolveBindTarget(
  ctx: WowActionContext,
  project_id: string,
): string {
  const byId = ctx.db
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(project_id)
  if (byId !== undefined && byId !== null) return byId.id
  const live = ctx.db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE deleted_at IS NULL`,
    )
    .all()
  for (const row of live) {
    if (slugifyProjectId(row.name) === project_id) return row.id
  }
  return project_id
}

/**
 * Has the wow-moment already minted this project's cli shell? The
 * `topics` row (`wow-shell-<id>`) is the durable binding marker — NOT
 * `projects.topic_id`, which migration 0053 reserves for the Telegram
 * `message_thread_id` (consumed by agent-settings rename/delete/merge via
 * editForumTopic/closeForumTopic) and which therefore stays NULL for
 * app/cli shells that have no Telegram thread. Writing the internal
 * topics UUID there would feed a non-numeric id to editForumTopic on a
 * later rename. The wow-shell topic's existence is what makes the DAILY
 * overnight re-fire a true no-op that never clobbers a name/description
 * the user has since edited.
 */
function hasShellTopic(ctx: WowActionContext, bind_id: string): boolean {
  const row = ctx.db
    .prepare<{ one: number }, [string]>(
      `SELECT 1 AS one FROM topics
         WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
    )
    .get(`wow-shell-${bind_id}`)
  return row !== undefined && row !== null
}

/**
 * Materialize one real project + its `topics` binding in a single
 * transaction. The project id is the deterministic slug OR the id of a
 * name-matched unbound seed row (see `resolveBindTarget`). Returns
 * `'created'` when this run materialized the project, `'existing'` when a
 * prior wow run already shelled it (idempotent re-run / overnight
 * re-fire), `'skipped'` when a soft-deleted row holds the resolved id (the
 * user deleted the project via agent-settings — we never resurrect it,
 * bind a shell to it, or report it created; the caller drops it entirely so
 * the body never claims a shell for a row hidden behind the
 * `/api/app/projects` `deleted_at IS NULL` filter). Three live cases, keyed
 * on the wow-shell topic marker:
 *
 *   1. No `projects` row at all → INSERT a real project (name +
 *      synthesized context). `topic_id` stays NULL (Telegram thread id per
 *      0053; app/cli shells have none).
 *   2. Row exists but has NO wow-shell topic yet — a boot-seeded demo row
 *      (`neutron`/`acme`/`northwind`) or a slug row from a partial
 *      prior run. BIND a wow-shell topic AND correct `name`/`description`
 *      to the user's confirmed values (demo defaults are wrong for this
 *      user — e.g. seed "Northwind Labs" placeholder vs the confirmed real
 *      project). Counts as `'created'`.
 *   3. Row exists AND already has its wow-shell topic — a prior wow run OR
 *      a project the user has since edited. Do NOT clobber name/
 *      description: the overnight pass re-fires DAILY, so this MUST be a
 *      no-op → `'existing'`.
 *
 * The topics `INSERT OR IGNORE` (on the `(channel_kind, channel_topic_id)`
 * partial-unique index, `wow-shell-<id>`) keeps a concurrent re-fire
 * idempotent.
 */
async function reconcileProject(
  ctx: WowActionContext,
  p: CapturedProject,
  project_id: string,
): Promise<{ outcome: 'created' | 'existing' | 'skipped'; bind_id: string }> {
  const name = p.name.trim()
  const description = synthesizeProjectContext(p, ctx.import_result)
  const nowMs = ctx.now()
  const topicTs = nowMs / 1000 // topics.created_at/updated_at are REAL epoch-seconds
  const iso = new Date(nowMs).toISOString() // projects.created_at/updated_at are TEXT ISO
  return ctx.db.transaction(async (tx) => {
    // Resolve the row to bind (slug row, or an unbound seed row whose name
    // normalizes to the same slug — kills the seed-id≠name-slug duplicate).
    const bind_id = resolveBindTarget(ctx, project_id)
    // A SOFT-DELETED row occupying this exact id is intentional user state —
    // they deleted the project via agent-settings (delete_project). We must
    // NOT resurrect it (the slug `id` is the PK, so the INSERT below would
    // OR-IGNORE-collide and silently no-op) NOR bind a wow-shell topic to it
    // NOR report it created — that's the r2 BLOCKER: the body would claim a
    // shell for a row that stays HIDDEN behind the `/api/app/projects`
    // `deleted_at IS NULL` filter. Honest behavior: skip it entirely so the
    // daily overnight re-fire never resurrects a project the user deleted.
    const deletedRow = ctx.db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL`,
      )
      .get(bind_id)
    if (deletedRow !== undefined && deletedRow !== null) {
      return { outcome: 'skipped' as const, bind_id }
    }
    const existingRow = ctx.db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(bind_id)
    const exists = existingRow !== undefined && existingRow !== null
    const alreadyShelled = exists && hasShellTopic(ctx, bind_id)
    const topic_id = ctx.uuid() // topics row id; NOT written to projects.topic_id
    let outcome: 'created' | 'existing'
    if (!exists) {
      // persona is left NULL by design — the synthesized at-rest context
      // lands in `description` (always non-empty + named); persona is a
      // post-onboarding settings concern, not materialized here.
      await tx.run(
        `INSERT OR IGNORE INTO projects
           (id, name, description, persona, emoji, privacy_mode, billing_mode,
            created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, NULL, ?, 'private', 'personal', ?, ?, ?)`,
        [bind_id, name, description, defaultProjectEmoji(name), iso, iso, iso],
      )
      outcome = 'created'
    } else if (!alreadyShelled) {
      // Existing row, not yet shelled (demo seed / partial prior run).
      // Bind + correct name/description. Leave projects.topic_id alone.
      await tx.run(
        `UPDATE projects
            SET name = ?, description = ?, updated_at = ?
          WHERE id = ?`,
        [name, description, iso, bind_id],
      )
      outcome = 'created'
    } else {
      // Already shelled — never clobber (overnight re-fire).
      outcome = 'existing'
    }
    await tx.run(
      `INSERT OR IGNORE INTO topics
         (id, project_slug, project_id, channel_kind, channel_topic_id,
          privacy_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, 'cli', ?, 'regular', 'active', ?, ?)`,
      [topic_id, ctx.project_slug, bind_id, `wow-shell-${bind_id}`, topicTs, topicTs],
    )
    return { outcome, bind_id }
  })
}

export default action03
