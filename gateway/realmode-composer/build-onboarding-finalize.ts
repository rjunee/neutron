/**
 * @neutronai/gateway/realmode-composer — onboarding finalizer (Path 1).
 *
 * Path 1 (onboarding-as-CC-session) replaces the button-driven wow-moment
 * dispatch with a CONVERSATIONAL interview: the live chat agent gathers the
 * required fields turn by turn, and a fire-and-forget scribe calls
 * `finalize(...)` the moment those fields are complete. The same entry point
 * is reused at HISTORY-IMPORT completion (when an `import_result` supplies the
 * proposed projects instead of the user naming them in chat).
 *
 * `finalize` does what the old wow dispatcher's terminal actions did, minus
 * any button prompt:
 *
 *   1. Idempotency gate — a row already at phase `completed` is a no-op.
 *   2. Persona — compose the owner's SOUL/USER/priority-map from the captured
 *      `phase_state` and commit them to `<owner_home>/persona/`, then
 *      `personaLoader.invalidate()` so the next chat turn loads the REAL
 *      persona instead of the cold-start default.
 *   3. Projects — for each project the user named (or each
 *      `import_result.proposed_projects` entry), create the real
 *      `projects` DB row + its cli wow-shell `topics` binding (so the rail's
 *      `SELECT id,name FROM projects WHERE deleted_at IS NULL` returns it),
 *      then materialize the on-disk `Projects/<slug>/` doc set + MEMORY/gbrain
 *      project page via the shared project materializer.
 *   4. State — `stateStore.upsert` to phase `completed` (+ `completed_at`,
 *      `wow_fired:true`).
 *   5. Live rail — `emitProjectsChanged(user_id)` so the project rail refreshes.
 *
 * Discipline (mirrors the wow-moment spec § 4.2): EVERY step is best-effort
 * and failure-isolated. `finalize` never throws to its caller (the caller is a
 * fire-and-forget scribe); a persona, materialize, or DB failure is swallowed +
 * logged and never aborts the remaining steps. The phase is still flipped to
 * `completed` even if persona/project work partially failed — persona can
 * regenerate later and the daily overnight re-fire backfills missing on-disk
 * project repos (the materializer's STATUS.md marker keeps re-runs idempotent).
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  OnboardingState,
  OnboardingStateStore,
} from '../../onboarding/interview/state-store.ts'
import type { ImportResult } from '../../onboarding/history-import/types.ts'
import type { ProjectDb } from '../../persistence/index.ts'
import type { ProjectDocComposer } from '../../onboarding/wow-moment/project-materializer.ts'
import type { CapturedProject } from '../../onboarding/wow-moment/action-types.ts'
import type { SyncHook } from '../../runtime/entity-writer.ts'

import { PersonaComposer } from '../../onboarding/persona-gen/compose.ts'
import { buildCringeChecker } from '../../onboarding/persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '../../onboarding/archetypes/library.ts'
import { buildComposeInput } from '../../onboarding/interview/engine-internals.ts'
import {
  slugifyProjectId,
  synthesizeProjectContext,
} from '../../onboarding/wow-moment/project-identity.ts'
import { buildProjectMaterializer } from '../../onboarding/wow-moment/project-materializer.ts'
import { buildProjectPageIndexer } from './build-project-page-indexer.ts'

/**
 * The persona composer surface `finalize` consumes. Matches the public
 * methods of `PersonaComposer` we use; declared as a structural seam so tests
 * can inject a fake without standing up the archetype/cringe pipeline. When
 * `OnboardingFinalizeDeps.personaComposer` is omitted, a real `PersonaComposer`
 * is built per `build-landing-stack.ts` (curated archetype library + cringe
 * checker, persona files under `<owner_home>/persona/`).
 */
export interface PersonaComposerLike {
  compose(input: ReturnType<typeof buildComposeInput>): Promise<unknown>
  commit(draft: unknown): Promise<unknown>
}

export interface OnboardingFinalizeDeps {
  owner_home: string
  /** Instance internal handle / project_slug (logging + materializer origin). */
  project_slug: string
  db: ProjectDb
  stateStore: OnboardingStateStore
  /** Steady-state persona reader — call .invalidate() after committing persona files. */
  personaLoader: { invalidate(filename?: string): void }
  /** Substrate-backed Anthropic client for project-doc LLM synthesis. Optional → deterministic template docs. */
  projectDocComposer?: ProjectDocComposer | null
  /** Shared GBrain syncHook so materialized project pages fan out to MEMORY/gbrain. Optional. */
  gbrainSyncHook?: SyncHook
  /** Fire a projects_changed app-ws frame for the owner after projects are created. */
  emitProjectsChanged: (user_id: string) => void
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
  /**
   * Test seam — inject a persona composer to avoid standing up the real
   * archetype/cringe pipeline. Defaults to a real `PersonaComposer`
   * constructed the same way `build-landing-stack.ts` does. The public
   * `finalize` contract is unaffected by this optional injection point.
   */
  personaComposer?: PersonaComposerLike
}

export interface OnboardingFinalizer {
  /**
   * Idempotent. When called:
   *  1. If state.phase is already 'completed', return immediately (idempotent).
   *  2. Compose + commit the owner persona files from phase_state, then
   *     personaLoader.invalidate() so the next chat turn loads the real persona.
   *  3. Materialize each project the user named (phase_state.primary_projects)
   *     — OR import_result.proposed_projects when an import_result is supplied —
   *     into: a real `projects` DB row + its General/topic binding, on-disk
   *     Projects/<slug>/ docs, and a MEMORY/gbrain project page. Reuse the
   *     existing project materializer; do NOT re-present any button prompt.
   *  4. stateStore.upsert phase:'completed', completed_at, wow_fired:true.
   *  5. emitProjectsChanged(user_id) so the rail refreshes live.
   * Never throws to the caller (the caller is a fire-and-forget scribe). Swallow
   * + log per-step failures; persona/materialize/db failures must not abort the
   * others (best-effort, each isolated).
   */
  finalize(input: {
    user_id: string
    topic_id: string
    state: OnboardingState
    import_result?: ImportResult | null
  }): Promise<void>
}

export function buildOnboardingFinalize(deps: OnboardingFinalizeDeps): OnboardingFinalizer {
  const now = deps.now ?? ((): number => Date.now())
  const log =
    deps.log ??
    ((level, msg, meta): void => {
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        `[onboarding-finalize] project=${deps.project_slug} ${msg}${
          meta !== undefined ? ` ${safeMeta(meta)}` : ''
        }`,
      )
    })

  return {
    async finalize(input): Promise<void> {
      // (1) Idempotency gate — a row already at `completed` is a no-op. We
      // read the LIVE row (not the passed-in snapshot) so a concurrent
      // finalize that already committed short-circuits us cleanly.
      try {
        const live = await deps.stateStore.get(deps.project_slug, input.user_id)
        if (live !== null && live.phase === 'completed') {
          log('info', 'finalize: already completed; no-op', { user_id: input.user_id })
          return
        }
      } catch (err) {
        // A state read failure must not strand the user — fall through and
        // attempt the work; the terminal upsert below re-asserts the phase.
        log('warn', 'finalize: state read failed; continuing', { err: errStr(err) })
      }

      const import_result = input.import_result ?? null

      // (2) Persona — compose + commit from phase_state, then invalidate the
      // steady-state loader. Failure-isolated: on any error we log and press
      // on (the phase still flips to completed; persona regenerates later).
      await commitPersona(deps, input.state, log)

      // (3) Projects — DB rows + topic bindings + on-disk materialization.
      await materializeProjects(deps, input.state, import_result, now, log)

      // (4) Terminal state — flip to `completed`. This is the load-bearing
      // write: even if persona/projects partially failed, the user must not
      // be stranded mid-onboarding.
      try {
        await deps.stateStore.upsert({
          project_slug: deps.project_slug,
          user_id: input.user_id,
          phase: 'completed',
          completed_at: now(),
          wow_fired: true,
        })
      } catch (err) {
        log('error', 'finalize: terminal upsert failed', { err: errStr(err) })
      }

      // (5) Live rail refresh.
      try {
        deps.emitProjectsChanged(input.user_id)
      } catch (err) {
        log('warn', 'finalize: emitProjectsChanged failed', { err: errStr(err) })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

/**
 * Compose + commit the owner persona files from the captured interview
 * `phase_state`, then invalidate the steady-state persona loader so the next
 * chat turn reads the freshly-committed SOUL/USER/priority-map. Best-effort:
 * a PersonaError (cringe-cap, commit failure) is logged and swallowed — the
 * persona can regenerate later, and finalize must still complete onboarding.
 */
async function commitPersona(
  deps: OnboardingFinalizeDeps,
  state: OnboardingState,
  log: NonNullable<OnboardingFinalizeDeps['log']>,
): Promise<void> {
  try {
    const composer = deps.personaComposer ?? buildDefaultPersonaComposer(deps.owner_home)
    const composeInput = buildComposeInput(deps.project_slug, state)
    const draft = await composer.compose(composeInput)
    await composer.commit(draft)
    deps.personaLoader.invalidate()
    log('info', 'persona committed + loader invalidated', {})
  } catch (err) {
    log('warn', 'persona compose/commit failed; continuing', { err: errStr(err) })
  }
}

/**
 * Construct the production `PersonaComposer` the same way
 * `build-landing-stack.ts` does (curated `ArchetypeLibrary` + cringe checker,
 * persona files written under `<owner_home>/persona/`).
 */
function buildDefaultPersonaComposer(owner_home: string): PersonaComposer {
  const archetypes = new ArchetypeLibrary({
    dataDir: defaultArchetypeDataDirFromRepo(),
    cacheDir: join(owner_home, 'cache', 'archetype-extensions'),
  })
  return new PersonaComposer({
    cringeChecker: buildCringeChecker(),
    ownerHomeFor: (_slug: string): string => join(owner_home, 'persona'),
    archetypes,
  })
}

/**
 * Resolve the in-repo curated archetype data dir relative to this source file.
 * This module lives at `<repo>/gateway/realmode-composer/`, so the data dir is
 * two levels up at `<repo>/onboarding/archetypes/data` — identical to the
 * resolver in `build-landing-stack.ts`.
 */
function defaultArchetypeDataDirFromRepo(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'onboarding', 'archetypes', 'data')
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * For each named project (or each `import_result.proposed_projects` entry when
 * an import drives finalize), create the real `projects` row + its cli
 * wow-shell `topics` binding, then materialize the on-disk doc set + memory
 * page. Each project is isolated: one project's failure never blocks its
 * siblings, and a materialization failure never rolls back the committed rows.
 */
async function materializeProjects(
  deps: OnboardingFinalizeDeps,
  state: OnboardingState,
  import_result: ImportResult | null,
  now: () => number,
  log: NonNullable<OnboardingFinalizeDeps['log']>,
): Promise<void> {
  const projects = resolveProjects(state, import_result)
  if (projects.length === 0) {
    log('info', 'no projects to materialize', {})
    return
  }

  // Shared materializer — CC-substrate doc composer (optional) + GBrain page
  // indexer (built from the optional syncHook). Mirrors the wow dispatcher's
  // enriched instance, just without a button surface.
  const materializer = buildProjectMaterializer({
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

  // Dedup by slug — two names can normalize to the same project_id, and we
  // must not double-create a row or double-materialize a folder.
  const seenSlugs = new Set<string>()
  for (const project of projects) {
    const slug = slugifyProjectId(project.name)
    if (seenSlugs.has(slug)) continue
    seenSlugs.add(slug)
    try {
      const outcome = await ensureProjectRow(deps, project, slug, import_result, now())
      if (outcome === 'skipped') {
        // A soft-deleted row holds this slug — the user deleted the project.
        // Honor that: never resurrect it, never materialize, never report it.
        continue
      }
      // On-disk materialization is best-effort + non-throwing per the
      // materializer's own contract; a failure lands in its outcome only.
      await materializer.materialize({
        project,
        slug,
        import_result,
      })
    } catch (err) {
      // Isolate: log this project's failure and continue with the rest.
      log('warn', 'project materialize failed; continuing', {
        project: project.name,
        err: errStr(err),
      })
    }
  }
}

/**
 * Resolve the project list finalize should materialize. An `import_result`
 * (history-import completion path) is authoritative: its `proposed_projects`
 * are the projects. Otherwise the conversational interview path reads the
 * names the user gave from `phase_state.primary_projects` (a string array;
 * object entries with a `name` are tolerated defensively).
 */
function resolveProjects(
  state: OnboardingState,
  import_result: ImportResult | null,
): CapturedProject[] {
  if (import_result !== null) {
    return import_result.proposed_projects
      .map((p) => ({ name: p.name.trim(), rationale: p.rationale }))
      .filter((p) => p.name.length > 0)
  }
  const raw = state.phase_state['primary_projects']
  if (!Array.isArray(raw)) return []
  const out: CapturedProject[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name.length > 0) out.push({ name })
    } else if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      const name = ((item as { name: string }).name ?? '').trim()
      if (name.length > 0) out.push({ name })
    }
  }
  return out
}

/**
 * Create one real `projects` row + its cli wow-shell `topics` binding in a
 * single transaction, keyed on the deterministic `slugifyProjectId(name)` so
 * the rail's `SELECT id,name FROM projects WHERE deleted_at IS NULL` returns
 * it. Replicates the minimal write `03-project-shells.ts`'s (module-private)
 * `reconcileProject` performs — matching its exact column set, the
 * `INSERT OR IGNORE` idempotency, the NULL `projects.topic_id` (migration 0053
 * reserves it for the Telegram thread id; cli shells have none), and the
 * soft-deleted-row skip (never resurrect a project the user deleted).
 *
 * Returns 'created' when a new row landed this run, 'existing' when one was
 * already present (idempotent re-run), 'skipped' when a soft-deleted row holds
 * the slug.
 */
async function ensureProjectRow(
  deps: OnboardingFinalizeDeps,
  project: CapturedProject,
  slug: string,
  import_result: ImportResult | null,
  nowMs: number,
): Promise<'created' | 'existing' | 'skipped'> {
  const name = project.name.trim()
  const description = synthesizeProjectContext(project, import_result)
  const iso = new Date(nowMs).toISOString() // projects.created_at/updated_at are TEXT ISO
  const topicTs = nowMs / 1000 // topics.created_at/updated_at are REAL epoch-seconds
  return deps.db.transaction(async (tx) => {
    // A soft-deleted row occupying this id is intentional user state (they
    // deleted the project). Never resurrect/bind/report it.
    const deletedRow = deps.db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL`,
      )
      .get(slug)
    if (deletedRow != null) return 'skipped'

    const existingRow = deps.db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(slug)
    const exists = existingRow != null

    if (!exists) {
      // persona left NULL by design — the synthesized at-rest context lands in
      // `description`; persona is a post-onboarding settings concern.
      await tx.run(
        `INSERT OR IGNORE INTO projects
           (id, name, description, persona, privacy_mode, billing_mode,
            created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'private', 'personal', ?, ?)`,
        [slug, name, description, iso, iso],
      )
    }
    // The wow-shell topic IS the durable binding marker; INSERT OR IGNORE on
    // its (channel_kind, channel_topic_id) keeps re-fires idempotent.
    await tx.run(
      `INSERT OR IGNORE INTO topics
         (id, project_slug, project_id, channel_kind, channel_topic_id,
          privacy_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, 'cli', ?, 'regular', 'active', ?, ?)`,
      [randomUUID(), deps.project_slug, slug, `wow-shell-${slug}`, topicTs, topicTs],
    )
    return exists ? 'existing' : 'created'
  })
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function safeMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta)
  } catch {
    return '[unserializable meta]'
  }
}
