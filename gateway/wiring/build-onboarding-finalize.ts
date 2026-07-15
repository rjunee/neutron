/**
 * @neutronai/gateway/wiring — onboarding finalizer (Path 1).
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
 * Discipline (mirrors the wow-moment spec § 4.2): the persona + project steps are
 * best-effort and failure-isolated — a persona or materialize failure is swallowed
 * + logged and never aborts the remaining steps, and the phase still flips to
 * `completed` even if that work partially failed (persona regenerates later and the
 * daily overnight re-fire backfills missing on-disk project repos; the
 * materializer's STATUS.md marker keeps re-runs idempotent). The ONE exception is
 * the load-bearing terminal `completed` write: if IT fails, `finalize` REJECTS
 * (rather than reporting a false completion) so the throw-tolerant caller (a
 * fire-and-forget scribe / boot recovery) logs it and the next trigger retries, and
 * a coalesced contender sees the same rejection instead of a false success.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  OnboardingState,
  OnboardingStateStore,
} from '@neutronai/onboarding/interview/state-store.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  ProjectDocComposer,
  MaterializeOutcome,
} from '@neutronai/onboarding/wow-moment/project-materializer.ts'
import type { CapturedProject } from '@neutronai/onboarding/wow-moment/action-types.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'

import { PersonaComposer } from '@neutronai/onboarding/persona-gen/compose.ts'
import { buildCringeChecker } from '@neutronai/onboarding/persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '@neutronai/onboarding/archetypes/library.ts'
import { buildComposeInput } from '@neutronai/onboarding/interview/engine-internals.ts'
import { readNonWorkInterests } from '@neutronai/onboarding/interview/engine-internals.ts'
import {
  slugifyProjectId,
  findRelatedImportSignal,
} from '@neutronai/onboarding/wow-moment/project-identity.ts'
import { capProposedProjects } from '@neutronai/onboarding/interview/phase-prompts.ts'
import {
  buildScaffoldMaterializer,
  ensureProjectRow,
} from './project-create.ts'
import {
  buildProjectDocReader,
  buildDeterministicProjectOpening,
  buildNoContextProjectOpening,
  finalizeOpeningBody,
  indexProposedProjects,
  synthesizeMatchFromSignal,
  type ProjectOpeningDocs,
} from './build-onboarding-handoff.ts'
import type { ProjectKickoff } from './build-project-kickoff.ts'

/**
 * Item 6 (Path-1 closing handoff, 2026-06-30) — the deterministic closing
 * message emitted into the owner's General topic right after onboarding
 * finalizes + the project rail refreshes. Path-1 finalize previously emitted NO
 * closing, so the interview just went quiet after the last answer with no signal
 * that projects had been created or where to find them. Points the owner at the
 * populated left rail; uses "Work" (the user-facing name for the per-project
 * work board) per the M1 UX redesign rename (was "Plan"). Em-dash-free (Sam hard rule).
 */
const ONBOARDING_CLOSING_MESSAGE =
  "You're all set. I've created your projects - they're in the left rail. Open one to find its Work, Documents, and Chat, and we can dig in whenever you're ready."

/**
 * No-projects variant of the closing (item 6). The finalizer intentionally
 * completes even when the owner named no projects (or every one was
 * skipped/failed), so the default copy ("I've created your projects ... in the
 * left rail") would be a lie + point at an empty rail. This honest fallback makes
 * no claim about a populated rail (Codex P2, 2026-06-30). Em-dash-free.
 */
const ONBOARDING_CLOSING_MESSAGE_NO_PROJECTS =
  "You're all set, and I've got what I need to start helping. Tell me what you'd like to work on - or say \"create a project\" - and I'll take it from there."

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
  /**
   * Fire a one-shot `onboarding_completed` app-ws frame at the terminal
   * transition (Managed post-onboarding claim redirect signal). Called exactly
   * once — the finalizer no-ops a re-entry on an already-`completed` row, so
   * this can't double-fire. Optional: on Open self-host the composer still
   * wires it (the frame is harmless; the client no-ops when no claim URL is
   * configured), but tests / LLM-less paths may omit it. Best-effort + non-
   * throwing by contract; NEVER blocks finalize.
   */
  emitOnboardingCompleted?: (user_id: string) => void
  /**
   * Item 6/7 (Path-1 closing + per-project opening, 2026-06-30) — deliver a
   * deterministic agent message into a chat topic. `project_id === null` targets
   * the owner's General topic (the closing handoff); a non-null `project_id`
   * targets THAT project's topic (its opening message). The composer wires this
   * to the SAME durable-history + live-fan path a live-agent reply uses (persist
   * a `button_prompts` row on `app:<user>[:<project>]` + push to the socket), so
   * the message both renders live and hydrates on reload. Best-effort + non-
   * throwing by contract; omitted on the LLM-less path → no closing/opening
   * (onboarding can't run LLM-less anyway). NEVER blocks finalize.
   *
   * `dedupe_key` is a STABLE per-(topic, message-kind) idempotency seed. Finalize
   * is reachable from several recovery paths (post-turn extractor onComplete,
   * the import-completion watcher, reconnect recovery) that can overlap or retry
   * before the terminal `completed` upsert is observed, so the composer keys the
   * durable `button_prompts` row on it (collapsing duplicate history rows) AND
   * suppresses the live re-send when the row already existed — a re-finalize
   * therefore never double-posts the closing or a project opening.
   */
  emitChatMessage?: (input: {
    user_id: string
    project_id: string | null
    body: string
    dedupe_key: string
  }) => void | Promise<void>
  /**
   * AGENTIC KICKOFF (2026-07-01) — the one-time per-project kickoff. When wired,
   * `emitProjectOpenings` asks it for a richer agentic opening (draft a starting
   * doc / offer a deadline reminder / ask a hobby engaging questions) BEFORE the
   * deterministic prompt-the-user opening; it returns null for projects too thin
   * to do a good job, so those degrade to the deterministic opening. Optional:
   * omitted → every project gets the deterministic opening (unchanged behaviour).
   * Built in `open/composer.ts` from the CC-substrate composer + GBrain indexer.
   */
  projectKickoff?: ProjectKickoff
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
   * Idempotent + single-flight per user. When called:
   *  1. Concurrent finalizes for the SAME user COALESCE onto one run — a later
   *     caller SHARES the in-flight run's outcome (success or failure) rather than
   *     double-running or silently no-oping.
   *  2. Read the LIVE durable row. If it is already 'completed', return
   *     immediately. Otherwise this live row — NOT the passed-in `state` snapshot,
   *     which may be stale by the time this run wins the coalescing race — is what
   *     persona + materialization operate on, so whichever caller wins finalizes
   *     the FRESHEST committed state.
   *  3. Compose + commit the owner persona files from the live phase_state, then
   *     personaLoader.invalidate() so the next chat turn loads the real persona.
   *  4. Materialize each project named in the live phase_state.primary_projects
   *     — OR import_result.proposed_projects when an import_result is present —
   *     into: a real `projects` DB row + its General/topic binding, on-disk
   *     Projects/<slug>/ docs, and a MEMORY/gbrain project page.
   *  5. stateStore.upsert phase:'completed', completed_at, wow_fired:true.
   *  6. emitProjectsChanged(user_id) so the rail refreshes live.
   * Per-step persona/materialize failures are SWALLOWED + logged (best-effort,
   * each isolated). The LOAD-BEARING terminal `completed` write is the exception:
   * if it fails, finalize REJECTS so the caller (a throw-tolerant fire-and-forget
   * scribe / boot recovery) logs it and the next trigger retries — and a coalesced
   * contender observes the SAME rejection instead of a false success.
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

  // COALESCE concurrent finalizes for the same user onto ONE in-flight run. Boot
  // recovery (rearmFromDurableState), the on_session_open reconnect replay, and the
  // post-turn extractor can ALL fire finalize at once, and the (read completed-gate →
  // persona → materialize → write completed) sequence is NOT atomic — without
  // coalescing two callers both pass the gate and DOUBLE-compose persona +
  // DOUBLE-materialize projects (Codex F8 P1). A contender SHARES the active run's
  // promise — success OR failure — rather than silently no-oping, so it can never
  // falsely report success when the owner's terminal write fails (Codex F8 r2). The
  // Map read/insert is atomic in the single-threaded, single-owner Open process
  // (cross-process is precluded by one-process-per-NEUTRON_HOME).
  const inFlight = new Map<string, Promise<void>>()
  return {
    finalize(input): Promise<void> {
      const existing = inFlight.get(input.user_id)
      if (existing !== undefined) {
        log('info', 'finalize: joining the in-flight finalize for this user', { user_id: input.user_id })
        return existing
      }
      const running = (async (): Promise<void> => {
      // (1) Idempotency gate + FRESH SNAPSHOT. Read the LIVE durable row rather
      // than trusting the passed-in `input.state`, which can be stale by the time
      // this run wins the coalescing race — a newer caller that joined us may have
      // persisted additional fields/projects durably first. A row already at
      // `completed` is a no-op; otherwise the live row is what persona +
      // materialization operate on, so whichever caller wins finalizes the FRESHEST
      // committed state (Codex F8 r3). Fall back to the caller snapshot only if the
      // read fails.
      let effectiveState = input.state
      try {
        const live = await deps.stateStore.get(deps.project_slug, input.user_id)
        if (live !== null) {
          if (live.phase === 'completed') {
            log('info', 'finalize: already completed; no-op', { user_id: input.user_id })
            return
          }
          effectiveState = live
        }
      } catch (err) {
        // A state read failure must not strand the user — fall through with the
        // passed-in snapshot; the terminal upsert below re-asserts the phase.
        log('warn', 'finalize: state read failed; using caller snapshot', { err: errStr(err) })
      }

      // (2) Persona — compose + commit from the live phase_state read above, then
      // invalidate the steady-state loader. Failure-isolated: on any error we log and
      // press on (the phase still flips to completed; persona regenerates later).
      await commitPersona(deps, effectiveState, log)

      // (3) Projects — RE-READ the live durable row as LATE as possible (right before
      // materialization). Persona compose above is the dominant await; a field/project
      // the owner added DURING it (e.g. the post-turn extractor persisting one more
      // primary project, then its finalize coalescing into THIS run) is still picked up
      // here and materialized.
      //
      // OPTIMISTIC READ-COMPARE-MATERIALIZE LOOP (Codex F8 r5). Even after re-reading,
      // a project could land DURING materializeProjects' awaits and then be permanently
      // suppressed once we mark `completed`. Close that window WITHOUT store CAS support:
      // materialize, then RE-READ; if the project set grew, re-materialize the fuller
      // (idempotent) set and re-check. Fall through to the terminal write ONLY on a
      // re-read that shows NO change — and because NO await separates that stable check
      // from the `completed` upsert below, no mutation can interleave in the gap
      // (single-threaded), so a completed row can never suppress an un-materialized
      // project. Bounded to avoid a pathological livelock of continuous mutation.
      let materializeState = effectiveState
      try {
        const fresh = await deps.stateStore.get(deps.project_slug, input.user_id)
        if (fresh !== null) {
          // A concurrent (non-coalesced) finalize may have completed us in the gap.
          if (fresh.phase === 'completed') {
            log('info', 'finalize: completed during compose; no-op', { user_id: input.user_id })
            return
          }
          materializeState = fresh
        }
      } catch (err) {
        log('warn', 'finalize: pre-materialize re-read failed; using earlier snapshot', {
          err: errStr(err),
        })
      }

      // Prefer the freshest row's import_result; fall back to the caller's (e.g. when a
      // read failed and we're on the passed-in snapshot).
      const deriveImportResult = (s: OnboardingState): ImportResult | null =>
        s.phase_state['import_result'] !== null && typeof s.phase_state['import_result'] === 'object'
          ? (s.phase_state['import_result'] as ImportResult)
          : null
      // Stable comparison key for the materialization-driving project set (the field the
      // post-turn extractor mutates). Set-equality via sort so order can't false-trigger.
      const projectSetKey = (s: OnboardingState): string => {
        const raw = s.phase_state['primary_projects']
        const arr = Array.isArray(raw) ? (raw as unknown[]).map(String) : []
        return [...arr].sort().join(',')
      }

      let import_result = deriveImportResult(materializeState) ?? input.import_result ?? null
      // Returns the projects that actually landed (created/existing, not the soft-deleted
      // skips) so the per-project opening step below can seed each chat.
      let materialized = await materializeProjects(deps, materializeState, import_result, now, log)

      const MAX_MATERIALIZE_REPASSES = 4
      for (let pass = 0; pass < MAX_MATERIALIZE_REPASSES; pass++) {
        let after: OnboardingState | null
        try {
          after = await deps.stateStore.get(deps.project_slug, input.user_id)
        } catch (err) {
          log('warn', 'finalize: post-materialize re-read failed; completing with current set', {
            err: errStr(err),
          })
          break
        }
        if (after === null) break
        if (after.phase === 'completed') {
          log('info', 'finalize: completed concurrently; no-op', { user_id: input.user_id })
          return
        }
        if (projectSetKey(after) === projectSetKey(materializeState)) break // stable — safe to complete
        // A project landed during materialize — re-materialize the fuller set (idempotent).
        materializeState = after
        import_result = deriveImportResult(after) ?? import_result
        materialized = await materializeProjects(deps, after, import_result, now, log)
        if (pass === MAX_MATERIALIZE_REPASSES - 1) {
          log('warn', 'finalize: project set still churning after max repasses; completing', {
            user_id: input.user_id,
          })
        }
      }

      // (4) Terminal state — flip to `completed`. Load-bearing: if THIS write fails
      // the owner is NOT completed, so SURFACE the failure (reject) rather than
      // pressing on to emit a "you're all set" closing for a row that isn't actually
      // completed. The rejection reaches the caller (fireAndForget in boot recovery /
      // the watcher + extractor try/catch) which logs it, and the NEXT finalize
      // trigger (boot, reconnect, or the next turn) retries — finalize is idempotent.
      // Coalesced contenders share THIS rejection, so none falsely reports success
      // (Codex F8 r2). Persona/projects may have partially landed; the retry re-runs
      // them idempotently.
      await deps.stateStore.upsert({
        project_slug: deps.project_slug,
        user_id: input.user_id,
        phase: 'completed',
        completed_at: now(),
        wow_fired: true,
      })

      // (5) Live rail refresh.
      try {
        deps.emitProjectsChanged(input.user_id)
      } catch (err) {
        log('warn', 'finalize: emitProjectsChanged failed', { err: errStr(err) })
      }

      // (5b) One-shot onboarding-complete signal (Managed post-onboarding claim
      // redirect). On a Managed install the client redirects to the configured
      // claim page on receipt; on Open self-host the client no-ops (no claim URL
      // in its bootstrap). Emitted BEFORE the closing/opening messages so a slow
      // opening compose can't delay the redirect, and independent of the
      // `emitChatMessage` seam. Reached ONLY after the terminal `completed` write
      // succeeded (a failed write rejects above), so the owner really is completed
      // and the reconnect-recovery replay — which checks `phase === 'completed'` —
      // fires consistently. Best-effort.
      try {
        deps.emitOnboardingCompleted?.(input.user_id)
      } catch (err) {
        log('warn', 'finalize: emitOnboardingCompleted failed', { err: errStr(err) })
      }

      // (6) Per-project opening messages (item 7) — seed each newly-materialized
      // project's chat with a content-aware opening (a summary + ONE next move),
      // composed from the materialized docs (STATUS.md / README) with the import
      // signal as fallback. Best-effort + isolated: one project's failure never
      // blocks the others or the closing message.
      // (7) Closing handoff message (item 6) — a deterministic General message
      // pointing the owner at the populated rail. Emitted AFTER emitProjectsChanged
      // so the projects are guaranteed present in the rail when it lands.
      // Both run only when an emit seam is wired (LLM path).
      if (deps.emitChatMessage !== undefined) {
        await emitProjectOpenings(deps, input.user_id, materialized, import_result, log)
        try {
          // Only claim a populated rail when projects actually landed; otherwise
          // an honest no-projects close (the finalizer completes even with zero
          // materialized projects).
          await deps.emitChatMessage({
            user_id: input.user_id,
            project_id: null,
            body:
              materialized.length > 0
                ? ONBOARDING_CLOSING_MESSAGE
                : ONBOARDING_CLOSING_MESSAGE_NO_PROJECTS,
            dedupe_key: 'onboarding_closing',
          })
        } catch (err) {
          log('warn', 'finalize: closing message emit failed', { err: errStr(err) })
        }
      }
      })()
      // Release the claim once the run SETTLES (success or failure) so a later
      // legitimate finalize (a genuinely new onboarding for the same user_id) isn't
      // permanently blocked; the completed-gate no-ops a re-finalize of a done row.
      const tracked = running.finally(() => {
        inFlight.delete(input.user_id)
      })
      inFlight.set(input.user_id, tracked)
      return tracked
    },
  }
}

/**
 * Compose + emit the per-project opening message for each materialized project.
 * Reuses the SAME deterministic opening composer + doc reader the legacy
 * phase-machine handoff (`build-onboarding-handoff.ts`) used, so Path-1 and the
 * legacy path produce identical opening prose. Each project is isolated; a doc-
 * read or emit failure for one project is logged and skipped.
 */
async function emitProjectOpenings(
  deps: OnboardingFinalizeDeps,
  user_id: string,
  materialized: MaterializedProject[],
  import_result: ImportResult | null,
  log: NonNullable<OnboardingFinalizeDeps['log']>,
): Promise<void> {
  if (materialized.length === 0 || deps.emitChatMessage === undefined) return
  const readProjectDoc = buildProjectDocReader({ owner_home: deps.owner_home })
  const proposedByName = indexProposedProjects(import_result)
  for (const project of materialized) {
    try {
      const docs: ProjectOpeningDocs = {
        readme: readProjectDoc(project.project_id, 'README.md'),
        transcript_summary: readProjectDoc(
          project.project_id,
          join('docs', 'transcript-summary.md'),
        ),
        status_md: readProjectDoc(project.project_id, 'STATUS.md'),
      }
      // Match the import signal the same way the handoff hook does: a direct
      // `proposed_projects` row by name, else a cross-project synthesized
      // stand-in, else null (the composer then leans on the materialized docs).
      const matched = proposedByName.get(project.name.toLowerCase()) ?? null
      const effectiveMatch =
        matched ?? synthesizeMatchFromSignal(project.name, findRelatedImportSignal(project.name, import_result))
      // AGENTIC KICKOFF (2026-07-01) — first ask the one-time kickoff for a
      // richer opening (draft a doc / offer a reminder / ask engaging questions).
      // It returns null when the project is too thin to do a good job (work
      // projects) so we degrade to the deterministic prompt-the-user opening
      // below. Best-effort + non-throwing by its own contract.
      let body = ''
      if (deps.projectKickoff !== undefined) {
        try {
          const kickoff = await deps.projectKickoff.composeKickoff({
            project_id: project.project_id,
            name: project.name.trim(),
            is_interest: project.is_interest,
            docs,
            matched: effectiveMatch,
            import_result,
            outcome: project.outcome,
          })
          if (kickoff !== null) {
            body = finalizeOpeningBody(kickoff.body)
            log('info', 'finalize: agentic kickoff fired', {
              project: project.name,
              action: kickoff.action,
              ...(kickoff.doc_relpath !== undefined ? { doc: kickoff.doc_relpath } : {}),
              indexed: kickoff.indexed,
            })
          }
        } catch (err) {
          // Kickoff must never block the opening — fall through to deterministic.
          log('warn', 'finalize: kickoff failed; using deterministic opening', {
            project: project.name,
            err: errStr(err),
          })
        }
      }
      if (body.trim().length === 0) {
        // DATA-SUFFICIENCY GATE (2026-07-01 SEV1 — "STOP M2" b). The kickoff
        // declined (a thin WORK project — a thin HOBBY already returned engaging
        // questions above, never null). If the materializer flagged this project
        // as having NO real context, emit the HONEST prompt instead of letting
        // the deterministic composer fabricate a "here's where X stands" summary
        // off the minimal placeholder STATUS.md. `has_context` defaults to true
        // when the outcome is missing (materialize threw) so we never suppress a
        // legitimate summary; in that case the deterministic composer's own
        // § 4.4 no-history fallback still keeps the opening honest.
        const composition =
          project.outcome !== null && project.outcome.has_context === false
            ? buildNoContextProjectOpening(project.name.trim())
            : buildDeterministicProjectOpening(project.name, effectiveMatch, docs)
        body = finalizeOpeningBody(composition.body)
      }
      if (body.trim().length === 0) continue
      // SAME dedupe key as the deterministic opening: the agentic kickoff fills
      // the ONE per-project opening slot, so it is one-time by construction and
      // the on-connect opening recovery (open/composer.ts ensureProjectOpeningOnEntry)
      // collapses onto the same durable row instead of double-posting.
      await deps.emitChatMessage({
        user_id,
        project_id: project.project_id,
        body,
        dedupe_key: `onboarding_opening:${project.project_id}`,
      })
    } catch (err) {
      log('warn', 'finalize: per-project opening emit failed; continuing', {
        project: project.name,
        err: errStr(err),
      })
    }
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
 * This module lives at `<repo>/gateway/wiring/`, so the data dir is
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

/** A project that actually landed a DB row this finalize (created or pre-
 *  existing, NOT a soft-deleted skip) — the set the per-project opening step
 *  seeds. `project_id` is the canonical bind id the topic + on-disk repo key on. */
interface MaterializedProject {
  project_id: string
  name: string
  /** True iff materialized from a hobby/interest answer (steers the kickoff). */
  is_interest: boolean
  /**
   * The materializer's per-project outcome — `slice_chunk_count` /
   * `summary_written` / `llm_docs` are the strongest "enough signal" proxies
   * (real transcript history matched this project). Previously discarded here;
   * threaded through so the per-project agentic kickoff can gate on it. Null
   * when materialization threw before producing an outcome (kickoff then leans
   * on the on-disk docs + import signal alone).
   */
  outcome: MaterializeOutcome | null
}

/**
 * For each named project (or each `import_result.proposed_projects` entry when
 * an import drives finalize), create the real `projects` row + its cli
 * wow-shell `topics` binding, then materialize the on-disk doc set + memory
 * page. Each project is isolated: one project's failure never blocks its
 * siblings, and a materialization failure never rolls back the committed rows.
 * Returns the projects that landed a row (skips excluded) for the opening step.
 */
async function materializeProjects(
  deps: OnboardingFinalizeDeps,
  state: OnboardingState,
  import_result: ImportResult | null,
  now: () => number,
  log: NonNullable<OnboardingFinalizeDeps['log']>,
): Promise<MaterializedProject[]> {
  const projects = resolveProjects(state, import_result)
  if (projects.length === 0) {
    log('info', 'no projects to materialize', {})
    return []
  }
  const materialized: MaterializedProject[] = []

  // Shared materializer — the SAME CC-substrate doc composer (optional) +
  // GBrain page indexer the user-initiated create-project capability uses
  // (`project-create.ts`). One materialization code path.
  const materializer = buildScaffoldMaterializer(deps)

  // Dedup by slug — two names can normalize to the same project_id, and we
  // must not double-create a row or double-materialize a folder.
  const seenSlugs = new Set<string>()
  for (const project of projects) {
    const slug = slugifyProjectId(project.name)
    if (seenSlugs.has(slug)) continue
    seenSlugs.add(slug)
    try {
      const { outcome, bind_id } = await ensureProjectRow(
        deps.db,
        deps.project_slug,
        project,
        slug,
        import_result,
        now(),
      )
      if (outcome === 'skipped') {
        // A soft-deleted row holds this slug — the user deleted the project.
        // Honor that: never resurrect it, never materialize, never report it.
        continue
      }
      // On-disk materialization is best-effort + non-throwing per the
      // materializer's own contract; a failure lands in its outcome only.
      // Materialize against the RESOLVED bind id (which may be a pre-existing
      // row's id, not the freshly-computed slug) so the on-disk repo + memory
      // page index against the same project the DB row binds to.
      const materializeOutcome = await materializer.materialize({
        project,
        slug: bind_id,
        import_result,
      })
      // Record the landed project so the opening-message step can seed its
      // chat. Keyed on the resolved bind id (matches the topic + on-disk repo).
      // Carry `is_interest` + the materialize outcome so the per-project agentic
      // kickoff can pick a hobby-vs-work opening and gate on real signal.
      materialized.push({
        project_id: bind_id,
        name: project.name.trim(),
        is_interest: project.is_interest === true,
        outcome: materializeOutcome,
      })
    } catch (err) {
      // Isolate: log this project's failure and continue with the rest.
      log('warn', 'project materialize failed; continuing', {
        project: project.name,
        err: errStr(err),
      })
    }
  }
  return materialized
}

/** The names the user gave conversationally — `phase_state.primary_projects`
 *  (a string array; object entries with a `name` are tolerated defensively). */
function interviewProjects(state: OnboardingState): CapturedProject[] {
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
 * Resolve the project list finalize should materialize.
 *
 * THE BUG (M1 E2E Round 2, 2026-06-29): when an `import_result` was present this
 * returned ONLY `import_result.proposed_projects` and ignored
 * `phase_state.primary_projects`. But in Path-1 the conversational preamble asks
 * the owner to name ≥3 projects, and `primary_projects` is the union of the
 * projects they typed into the Neutron chat PLUS any the import merged in;
 * `proposed_projects` only ever contains projects derived from the ChatGPT/Claude
 * *export*. So any project the owner named in conversation that wasn't also in
 * their export got silently DROPPED — no `projects` row, no topic, no on-disk
 * repo, no gbrain page — even though persona-gen (which reads `primary_projects`)
 * still referenced it, leaving the rail and the persona disagreeing. This is the
 * exact defect the legacy engine already documents + fixed (`engine.ts` ~5180:
 * "fell through to merging `import_result.proposed_projects` only — silently
 * dropping any project the user added via freeform"); the Path-1 finalizer
 * reverted to the broken behavior.
 *
 * THE FIX: materialize the UNION. The import-proposed entries come first so they
 * win the slug dedup (they carry the import `rationale`); every interview-named
 * project whose slug isn't already covered is appended. With `import_result` null
 * this is unchanged (interview-only). The caller's `seenSlugs` dedup +
 * `resolveBindTarget` already make a superset safe.
 *
 * CURATION DROPS (import-curation handoff, 2026-06-29): the union is defensive —
 * it independently re-pulls `import_result.proposed_projects`, so subtracting a
 * dropped project from `phase_state.primary_projects` alone is NOT enough (the
 * import side re-adds it). When the owner explicitly drops a proposed project
 * during curation ("drop Family Home"), the post-turn extractor records it under
 * `phase_state.dropped_projects`; we EXCLUDE those slugs from BOTH union sources
 * here so a dropped project is never materialized. (The extractor also subtracts
 * them from `primary_projects`, so persona-gen — which reads `primary_projects` —
 * agrees.) Mirrors the legacy engine's `(prior ∪ adds) MINUS removals`.
 */
function resolveProjects(
  state: OnboardingState,
  import_result: ImportResult | null,
): CapturedProject[] {
  const droppedRaw = state.phase_state['dropped_projects']
  const dropped = new Set(
    (Array.isArray(droppedRaw) ? droppedRaw : [])
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => slugifyProjectId(s)),
  )
  // Reconcile the IMPORT contribution to the DISPLAYED proposal. The
  // presentation caps the proposal at MAX_ANALYSIS_PROJECTS, so only the first
  // `MAX_ANALYSIS_PROJECTS` import projects were ever shown + droppable; cap the
  // import side here too so a >cap synthesis can't materialize a project the user
  // never saw. The engine already caps both `import_result` AND the
  // `primary_projects` merge to the same bound at the stamp chokepoint
  // (advanceFromImportRunningOnComplete), so `primary_projects` carries only the
  // displayed import names plus the owner's EXPLICIT conversational adds — we
  // trust it verbatim (do NOT filter it against the import overflow, which would
  // wrongly drop an explicit add whose name happens to collide with an unshown
  // overflow proposal). Union semantics are unchanged: import-displayed ∪
  // primary, minus the owner's curation drops.
  const fromImport =
    import_result !== null
      ? capProposedProjects(import_result.proposed_projects)
          .map((p) => ({ name: p.name.trim(), rationale: p.rationale }))
          .filter((p) => p.name.length > 0)
      : []
  // HOBBY PROJECTS (2026-07-01) — the onboarding interview also asks about
  // outside-work interests/hobbies, but historically those answers materialized
  // NOTHING: they land in a SEPARATE field (`phase_state.non_work_interests` +
  // `import_result.inferred_interests`) this resolver never read, so they reached
  // persona-gen (USER/SOUL.md) but never a `projects` row / on-disk repo.
  // Materialize them too, as `is_interest` projects: the on-disk repo + doc set is
  // identical to a work project (the materializer is source-agnostic); the flag
  // only steers the per-project agentic kickoff toward a hobby-appropriate opening.
  // Interest entries come LAST in the union so a work project of the same name
  // wins the slug dedup (it carries the richer work rationale + import signal).
  const fromInterests = collectInterestProjects(state, import_result)
  const out: CapturedProject[] = []
  const seen = new Set<string>()
  for (const p of [...fromImport, ...interviewProjects(state), ...fromInterests]) {
    const slug = slugifyProjectId(p.name)
    if (seen.has(slug)) continue
    seen.add(slug)
    if (dropped.has(slug)) continue
    out.push(p)
  }
  return out
}

/**
 * HOBBY PROJECTS (2026-07-01) — the interest-derived contribution to the
 * materialized project set. Unions the conversationally-captured hobbies
 * (`phase_state.non_work_interests`, read via the canonical
 * `readNonWorkInterests` reader) with the import-inferred interests
 * (`import_result.inferred_interests`), mapping each `{name, basis?}` to a
 * `CapturedProject{name, rationale?, is_interest:true}`. Dedupes by slug so a
 * hobby that appears in both sources materializes once. The caller's
 * `seen`/`dropped` dedup then subtracts anything already covered by a work
 * project (work wins) or dropped during curation. `rationale` is carried from an
 * import interest's `basis` so the materialized repo's synthesized context has
 * real grounding; conversational hobbies have no rationale.
 */
function collectInterestProjects(
  state: OnboardingState,
  import_result: ImportResult | null,
): CapturedProject[] {
  const out: CapturedProject[] = []
  const seen = new Set<string>()
  const push = (name: string, rationale?: string): void => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const slug = slugifyProjectId(trimmed)
    if (slug.length === 0 || seen.has(slug)) return
    seen.add(slug)
    const entry: CapturedProject = { name: trimmed, is_interest: true }
    if (typeof rationale === 'string' && rationale.trim().length > 0) {
      entry.rationale = rationale.trim()
    }
    out.push(entry)
  }
  for (const interest of readNonWorkInterests(state.phase_state)) {
    push(interest.name)
  }
  const inferred = import_result?.inferred_interests
  if (Array.isArray(inferred)) {
    for (const row of inferred) {
      if (row === null || typeof row !== 'object') continue
      const name = typeof row.name === 'string' ? row.name : ''
      const basis = typeof row.basis === 'string' ? row.basis : undefined
      push(name, basis)
    }
  }
  return out
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
