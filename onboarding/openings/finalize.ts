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
  buildProjectMaterializer,
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
  buildProjectDocReader,
  buildDeterministicProjectOpening,
  buildNoContextProjectOpening,
  finalizeOpeningBody,
  indexProposedProjects,
  synthesizeMatchFromSignal,
  type ProjectOpeningDocs,
} from './project-opening.ts'
import type { ProjectKickoff } from './kickoff.ts'

/**
 * Path-1 STARTING message (2026-07-18) — emitted into the owner's General topic
 * the instant finalize commits to materializing projects, BEFORE persona compose
 * / project materialization / the per-project opening composes.
 *
 * THE BUG (live, Ryan's install 2026-07-18): with 9 projects the openings landed
 * one at a time over SEVERAL MINUTES (each is an LLM compose) and the ONE message
 * telling the owner what to do next — the closing — arrived dead last. Projects
 * silently appeared in the rail with zero orientation and the owner asked "its
 * unclear what im supposed to do next". This message closes that silent window.
 *
 * Same `deps.emitChatMessage` seam + `project_id: null` (General) as the closing;
 * its own stable `dedupe_key` so a re-entered finalize never double-posts it.
 * Em-dash-free (Sam hard rule).
 */
const ONBOARDING_STARTING_MESSAGE =
  "Got it, setting up your projects now. One moment while I put everything together."

/**
 * Item 6 (Path-1 closing handoff, 2026-06-30) — the deterministic closing
 * message emitted into the owner's General topic right after onboarding
 * finalizes + the project rail refreshes. Path-1 finalize previously emitted NO
 * closing, so the interview just went quiet after the last answer with no signal
 * that projects had been created or where to find them. Points the owner at the
 * populated left rail; uses "Work" (the user-facing name for the per-project
 * work board) per the M1 UX redesign rename (was "Plan"). Em-dash-free (Sam hard rule).
 *
 * 2026-07-18: the copy now names BOTH affordances explicitly — click into each
 * project in the left rail, AND ask general questions right here in this chat.
 * The owner had no idea the General chat stayed available after onboarding.
 */
const ONBOARDING_CLOSING_MESSAGE =
  "You're all set. I've created your projects and they're in the left rail. Click into each one to find its Work, Documents, and Chat. If you have any general questions, just ask me right here in this chat."

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
  /** Instance internal handle / owner_slug (logging + materializer origin). */
  owner_slug: string
  db: ProjectDb
  stateStore: OnboardingStateStore
  /** Steady-state persona reader — call .invalidate() after committing persona files. */
  personaLoader: { invalidate(filename?: string): void }
  /** Substrate-backed Anthropic client for project-doc LLM synthesis. Optional → deterministic template docs. */
  projectDocComposer?: ProjectDocComposer | null
  /** Shared GBrain syncHook so materialized project pages fan out to MEMORY/gbrain. Optional. */
  gbrainSyncHook?: SyncHook
  /**
   * C8 — injected project-creation seams. The shared create-project primitives
   * (`gateway/wiring/project-create.ts`) live in the COMPOSITION layer (they are
   * shared with the user-initiated create-project capability), so this
   * product-layer finalizer receives them injected rather than importing
   * composition (depcruise `nobody-imports-composition`). Semantics are identical
   * to the pre-C8 in-module `ensureProjectRow(...)` + `buildScaffoldMaterializer(deps)`
   * calls — the composition root wires the very same functions/instance.
   *
   * `ensureProjectRow`: create the real `projects` row + its cli wow-shell topic
   * binding (idempotent, soft-delete-respecting); returns the resolved `bind_id`.
   */
  ensureProjectRow: (
    db: ProjectDb,
    owner_slug: string,
    project: CapturedProject,
    slug: string,
    import_result: ImportResult | null,
    nowMs: number,
  ) => Promise<{ outcome: 'created' | 'existing' | 'skipped'; bind_id: string }>
  /**
   * The shared on-disk project materializer (`buildScaffoldMaterializer(deps)`
   * in composition). Best-effort + non-throwing per its own contract; its
   * per-project `MaterializeOutcome` gates the agentic kickoff.
   */
  materializer: ReturnType<typeof buildProjectMaterializer>
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
   *
   * RESOLVES `true` iff the row is now `completed` (by this call OR already-completed);
   * `false` when finalization DEFERRED or ABORTED without completing (churn budget
   * exhausted, a non-finalizable phase, a deleted row, …). Callers that gate on "did
   * onboarding actually complete" (e.g. suppressing the runner's wrap-up) MUST honor this
   * result and not assume success (Codex F8 r14).
   */
  finalize(input: {
    user_id: string
    topic_id: string
    state: OnboardingState
    import_result?: ImportResult | null
  }): Promise<boolean>
}

export function buildOnboardingFinalize(deps: OnboardingFinalizeDeps): OnboardingFinalizer {
  const now = deps.now ?? ((): number => Date.now())
  const log =
    deps.log ??
    ((level, msg, meta): void => {
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        `[onboarding-finalize] project=${deps.owner_slug} ${msg}${
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
  const inFlight = new Map<string, Promise<boolean>>()
  return {
    finalize(input): Promise<boolean> {
      const existing = inFlight.get(input.user_id)
      if (existing !== undefined) {
        log('info', 'finalize: joining the in-flight finalize for this user', { user_id: input.user_id })
        return existing
      }
      const running = (async (): Promise<boolean> => {
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
        const live = await deps.stateStore.get(deps.owner_slug, input.user_id)
        if (live === null) {
          // A SUCCESSFUL read that finds NO row: the durable row was deleted / reset. Do
          // NOT finalize a ghost from a stale caller snapshot (that would commit persona +
          // create projects for a row that no longer exists) — abort (Codex F8 r11). This
          // is distinct from a read THROW (handled below), where we couldn't read at all
          // and the caller snapshot is the best available basis.
          log('info', 'finalize: durable row absent; nothing to finalize', { user_id: input.user_id })
          return false
        }
        effectiveState = live
      } catch (err) {
        // A state read THROW (not a null result) must not strand the user — fall through
        // with the passed-in snapshot; the terminal CAS still guards the real phase/state.
        log('warn', 'finalize: state read failed; using caller snapshot', { err: errStr(err) })
      }

      // Enforce the finalizable-phase ALLOWLIST on effectiveState — whether it came from the
      // live read OR the caller-snapshot fallback (a read THROW must NOT bypass the
      // allowlist; the CAS only pins phase==expected, so an early/terminal/import phase in
      // the snapshot would otherwise complete). Never finalize from a non-allowlisted phase
      // (Codex F8 r12/r13).
      if (!isFinalizablePhase(effectiveState.phase)) {
        log('info', 'finalize: phase not finalizable; no-op', {
          user_id: input.user_id,
          phase: effectiveState.phase,
        })
        // Already-completed counts as "finalized" for callers; any other non-finalizable
        // phase (early / import / failed) did NOT complete.
        return effectiveState.phase === 'completed'
      }

      const deriveImportResult = (s: OnboardingState): ImportResult | null =>
        s.phase_state['import_result'] !== null && typeof s.phase_state['import_result'] === 'object'
          ? (s.phase_state['import_result'] as ImportResult)
          : null

      // (2) STABILIZE — read the row until two consecutive reads agree on the WHOLE
      // phase_state, taking NO side effects. Persona compose + project materialization
      // happen ONLY after the state has quiesced (Phase 3 below), so a churning row creates
      // NOTHING before it settles — a deferral therefore leaves NO stale project rows to
      // reconcile, which is what made post-hoc reconciliation unsafe (soft-deletes conflict
      // with create-idempotency; Codex F8 r11–r15). Under continuous mutation this never
      // stabilizes → we defer having done nothing. Persona/materialize don't touch
      // phase_state, so a quiescent row stabilizes on the FIRST re-read.
      const MAX_STABILIZE_PASSES = 5
      let stableState: OnboardingState | null = null
      let candidate = effectiveState
      for (let pass = 0; pass < MAX_STABILIZE_PASSES; pass++) {
        let reread: OnboardingState | null
        try {
          reread = await deps.stateStore.get(deps.owner_slug, input.user_id)
        } catch (err) {
          log('warn', 'finalize: stabilize re-read failed; deferring to next trigger', {
            err: errStr(err),
          })
          return false
        }
        if (reread === null) {
          log('info', 'finalize: row vanished mid-run; nothing to complete', { user_id: input.user_id })
          return false
        }
        if (!isFinalizablePhase(reread.phase)) {
          // Completed concurrently / failed / live-import — never finalize on top of those.
          log('info', 'finalize: phase not finalizable during stabilize; aborting', {
            user_id: input.user_id,
            phase: reread.phase,
          })
          return reread.phase === 'completed'
        }
        if (phaseStateKey(reread) === phaseStateKey(candidate)) {
          stableState = reread
          break
        }
        candidate = reread // changed under us — read again
      }
      if (stableState === null) {
        // Never quiesced within the budget — DEFER having created NOTHING. Only happens
        // under continuous mutation (an active owner ⟹ more finalize triggers), so no real
        // owner is stranded and no stale project rows are left behind (Codex F8 r7/r8/r15).
        log('warn', 'finalize: phase_state never quiesced; deferring (no side effects taken)', {
          user_id: input.user_id,
        })
        return false
      }

      // (3) Persona + projects from the STABLE state — the ONLY place side effects happen.
      const import_result = deriveImportResult(stableState) ?? input.import_result ?? null

      // (3a) STARTING message (2026-07-18) — emitted BEFORE persona compose,
      // materialization, and the per-project opening composes, i.e. before the
      // multi-minute silent window the owner used to sit through. Conditions
      // mirror the closing's: only when the `emitChatMessage` seam is wired, and
      // ONLY when there is actually something to materialize (resolveProjects is
      // the very list `materializeProjects` iterates) so we never promise projects
      // on the zero-project path. Best-effort: an emit failure must never block
      // finalize. Its own stable `dedupe_key` means a re-entered finalize (a
      // deferred CAS retry, boot recovery) never shows the owner this twice — the
      // composer keys the durable row on it and suppresses the live re-send.
      //
      // The count EXCLUDES slugs held by a soft-deleted `projects` row: those are
      // projects the owner already deleted, `ensureProjectRow` reports them
      // `skipped` and never resurrects them, so counting them would promise
      // projects that will never land and then contradict itself with the
      // no-projects closing (Codex P2). The residual dishonest window — EVERY
      // `ensureProjectRow` call THROWING after this point — is a DB failure, where
      // a slightly-wrong message is not the owner's problem.
      const pendingProjectCount = countMaterializableProjects(deps, stableState, import_result)
      if (deps.emitChatMessage !== undefined && pendingProjectCount > 0) {
        try {
          await deps.emitChatMessage({
            user_id: input.user_id,
            project_id: null,
            body: ONBOARDING_STARTING_MESSAGE,
            dedupe_key: 'onboarding_starting',
          })
        } catch (err) {
          log('warn', 'finalize: starting message emit failed', { err: errStr(err) })
        }
      }

      const persona_committed = await commitPersona(deps, stableState, log)
      // materialized: the projects that landed (created/existing, not soft-deleted skips) —
      // the per-project opening step below seeds each one's chat.
      const materialized = await materializeProjects(deps, stableState, import_result, now, log)

      // (4) ATOMIC terminal write — complete IFF the row STILL equals the stable state we
      // just materialized (phase + phase_state). The only window is materialize→CAS; a loss
      // means a mutation (or a concurrent completion) slipped into it — defer + retry
      // (finalize is idempotent). We NEVER stamp `completed` over changed state (Codex F8
      // r5–r10). A terminal-write THROW is surfaced (reject) so the caller retries and a
      // coalesced contender sees the same rejection, not a false success (Codex F8 r2).
      let casOk: boolean
      try {
        casOk = await deps.stateStore.completeIfPhaseStateMatches({
          owner_slug: deps.owner_slug,
          user_id: input.user_id,
          expected_phase: stableState.phase,
          expected_phase_state: stableState.phase_state,
          completed_at: now(),
          // THE BUG (live, 2026-07-18): `persona_files_committed` read 0 in the DB
          // even though SOUL.md / USER.md / priority-map.md were on disk. Nothing on
          // the Path-1 finalize path ever wrote the flag — `commitPersona` writes the
          // files + invalidates the loader but persists nothing, and the terminal CAS
          // UPDATE set only phase/completed_at/wow_fired. The column therefore sat at
          // its schema DEFAULT 0 forever (migrations/0043_onboarding_state_wow_pushed_at.sql:53).
          // Carried on the SAME atomic terminal write rather than a second upsert, so
          // it can never disagree with the completion it describes, and it stays
          // truthful when persona compose failed (best-effort ⇒ false, not "completed").
          persona_files_committed: persona_committed,
        })
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err))
      }
      if (!casOk) {
        // A mutation (or a concurrent completion) landed in the tiny materialize→CAS window.
        // We materialized `stableState`'s projects but did NOT complete — defer + retry
        // (finalize is idempotent). We do NOT try to "undo" the materialization: post-hoc
        // cleanup of a just-created project is UNSAFE and would be worse than the residual it
        // chases (Codex F8 r17) —
        //   (a) project rows are soft-deletable only, and `ensureProjectRow` treats a
        //       soft-deleted slug as PERMANENTLY skipped, so an Alpha→Beta→Alpha oscillation
        //       would make the retry unable to restore a project the owner now wants; and
        //   (b) project ids are SHARED + deterministic across users, so soft-deleting "my"
        //       created row by id could delete a project another user concurrently adopted.
        // The residual — a stray live `projects` row for a project dropped in a sub-ms window
        // — is BENIGN (the owner can delete it; no corruption, no wrong completion) and
        // IRREDUCIBLE without transactional materialization across the DB + filesystem +
        // cross-user shared rows. It also requires a durable drop in the exact instant
        // finalize is completing, which doesn't occur in real onboarding (curation precedes
        // finalize; the interview is over by the trigger). Tracked: [[f8-finalize-cas-followup]].
        log('info', 'finalize: state moved in the materialize→complete window; deferring', {
          user_id: input.user_id,
        })
        return false
      }

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
      return true // the atomic CAS completed the row
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
 * How many of the resolved projects can actually LAND, for the STARTING message's
 * "do not promise projects that aren't coming" gate.
 *
 * Applies the same two reductions `materializeProjects` does before it ever calls
 * `ensureProjectRow`: dedupe by slug (two names can normalize to one project_id),
 * and drop any slug already held by a SOFT-DELETED `projects` row (the owner
 * deleted that project; `ensureProjectRow` reports it `skipped` and never
 * resurrects it — `gateway/wiring/project-create.ts`, the `deleted_at IS NOT NULL`
 * probe). Read-only and best-effort: a query failure counts the project as
 * materializable, which degrades to the pre-existing behaviour rather than
 * silently suppressing the owner's progress message.
 */
function countMaterializableProjects(
  deps: OnboardingFinalizeDeps,
  state: OnboardingState,
  import_result: ImportResult | null,
): number {
  const seen = new Set<string>()
  let count = 0
  for (const project of resolveProjects(state, import_result)) {
    const slug = slugifyProjectId(project.name)
    if (seen.has(slug)) continue
    seen.add(slug)
    try {
      const deleted = deps.db.get<{ id: string }, [string]>(
        `SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL`,
        [slug],
      )
      if (deleted !== null && deleted !== undefined) continue
    } catch {
      // Fall through — count it; the message is best-effort, the probe is an
      // honesty refinement, not a gate we should fail closed on.
    }
    count += 1
  }
  return count
}

/**
 * Compose + emit the per-project opening message for each materialized project.
 * Reuses the SAME deterministic opening composer + doc reader the legacy
 * phase-machine handoff (`build-onboarding-handoff.ts`) used, so Path-1 and the
 * legacy path produce identical opening prose. Each project is isolated; a doc-
 * read or emit failure for one project is logged and skipped.
 *
 * CONCURRENCY (2026-07-18): projects are composed through a bounded worker pool
 * rather than one strictly-serial `await` per project. Each opening is an LLM
 * compose (the agentic kickoff), so with 9 projects the serial loop kept the owner
 * waiting SEVERAL MINUTES for the closing handoff that follows it. The openings are
 * mutually independent — each targets its OWN project topic (`project_id`), reads
 * only its own on-disk docs, and shares no mutable state — so ordering across
 * projects carries no meaning and interleaving changes no observable outcome.
 * Per-project LLM COMPOSE ISOLATION (ISSUES #378, 2026-07-20): the kickoff-doc
 * (and opening-message) composers now dispatch over each project's OWN warm
 * `cc-agent-*` session, keyed by `metering_context.project_id` per dispatch, so
 * two concurrent composes in this pool land on DISTINCT warm REPLs and one
 * project's LLM transcript can never condition another's. The prior shared
 * `cc-llm` REPL accumulated ONE transcript across every project, so project N was
 * conditioned on 1..N-1 and emitted their content (the live cross-project bleed).
 * Error isolation is UNCHANGED: the per-project try/catch still wraps one project's
 * whole compose+emit, so a failure is logged and never blocks its siblings or the
 * closing. The pool is BOUNDED (not an unbounded Promise.all) so a large import
 * cannot fan N simultaneous substrate sessions at the CC substrate.
 */
const OPENING_COMPOSE_CONCURRENCY = 3

async function emitProjectOpenings(
  deps: OnboardingFinalizeDeps,
  user_id: string,
  materialized: MaterializedProject[],
  import_result: ImportResult | null,
  log: NonNullable<OnboardingFinalizeDeps['log']>,
): Promise<void> {
  if (materialized.length === 0 || deps.emitChatMessage === undefined) return
  // Bind the narrowed seam once: the per-project closure below can't carry the
  // `!== undefined` narrowing of a mutable `deps` property across a callback.
  const emitChatMessage = deps.emitChatMessage
  const readProjectDoc = buildProjectDocReader({ owner_home: deps.owner_home })
  const proposedByName = indexProposedProjects(import_result)
  const emitOneOpening = async (project: MaterializedProject): Promise<void> => {
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
      if (body.trim().length === 0) return
      // SAME dedupe key as the deterministic opening: the agentic kickoff fills
      // the ONE per-project opening slot, so it is one-time by construction and
      // the on-connect opening recovery (open/composer.ts ensureProjectOpeningOnEntry)
      // collapses onto the same durable row instead of double-posting.
      await emitChatMessage({
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

  // Bounded worker pool: `OPENING_COMPOSE_CONCURRENCY` workers pull from one
  // shared cursor until the list is drained. `emitOneOpening` never rejects (it
  // owns the per-project try/catch), so no worker can die and strand the queue,
  // and awaiting all workers still means EVERY opening has settled before the
  // closing message is emitted.
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const project = materialized[index]
      if (project === undefined) return
      await emitOneOpening(project)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(OPENING_COMPOSE_CONCURRENCY, materialized.length) }, worker),
  )
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
/**
 * Canonical, order-independent serialization of an onboarding row's `phase_state`, used to
 * detect whether the row held STILL across two consecutive reads before finalize takes any
 * side effects. Object keys are sorted recursively so key-order can't false-trigger; array
 * order is preserved (a reordered primary_projects list IS a real change). String equality.
 */
function phaseStateKey(state: OnboardingState): string {
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
    const obj = v as Record<string, unknown>
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(obj[k]))
        .join(',') +
      '}'
    )
  }
  return canon(state.phase_state)
}

/**
 * The ONLY phases the Path-1 finalizer may legitimately complete FROM — the two
 * conversational markers at which every required field has been gathered and the wow /
 * import-consumed flows converge:
 *   - `persona_reviewed` — the wow-moment path (persona synthesized + reviewed).
 *   - `work_interview_gap_fill` — the import-consumed / field-complete path.
 * This is an explicit ALLOWLIST (not a denylist): a row in any EARLY phase (`signup`,
 * `identity_oauth`, `instance_provisioned`, `ai_substrate_offered`, …) has no legal edge
 * to `completed` and must never be finalized — nor a terminal row, nor a live-import phase
 * (that would finalize on top of an in-flight import). The caller validates the initial
 * phase, finalize re-checks after every mid-run re-read, and the terminal CAS pins the
 * exact phase, so completion can only ever land from an allowlisted phase (Codex F8 r12).
 */
const FINALIZABLE_PHASES = new Set<string>(['persona_reviewed', 'work_interview_gap_fill'])
function isFinalizablePhase(phase: string): boolean {
  return FINALIZABLE_PHASES.has(phase)
}

async function commitPersona(
  deps: OnboardingFinalizeDeps,
  state: OnboardingState,
  log: NonNullable<OnboardingFinalizeDeps['log']>,
): Promise<boolean> {
  try {
    const composer = deps.personaComposer ?? buildDefaultPersonaComposer(deps.owner_home)
    const composeInput = buildComposeInput(deps.owner_slug, state)
    const draft = await composer.compose(composeInput)
    await composer.commit(draft)
    deps.personaLoader.invalidate()
    log('info', 'persona committed + loader invalidated', {})
    return true
  } catch (err) {
    log('warn', 'persona compose/commit failed; continuing', { err: errStr(err) })
    return false
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
  // (`project-create.ts`). One materialization code path. C8: injected by the
  // composition root (`buildScaffoldMaterializer(deps)`) so this product module
  // does not import composition.
  const materializer = deps.materializer

  // Dedup by slug — two names can normalize to the same project_id, and we
  // must not double-create a row or double-materialize a folder.
  const seenSlugs = new Set<string>()
  for (const project of projects) {
    const slug = slugifyProjectId(project.name)
    if (seenSlugs.has(slug)) continue
    seenSlugs.add(slug)
    try {
      const { outcome, bind_id } = await deps.ensureProjectRow(
        deps.db,
        deps.owner_slug,
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
