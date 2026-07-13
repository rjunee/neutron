/**
 * @neutronai/open — import-upload / import-resume wiring (C3b, carve #4).
 *
 * Behavior-preserving extraction of the import-upload surface of
 * `createOpenComposition` (old `open/composer.ts` lines 1026-1125): the bare
 * single-shot `import_upload_handler` (`buildImportUploadHandler`), the chunked
 * resumable `chunked_upload_handler` (`buildChunkedUploadHandler` +
 * `SqliteUploadSessionStore` + the `ChunkedUploadSweeper` start/stop), and the
 * `import_resume_handler` (`buildImportResumeHandler`, mounted off
 * `landing.importJobRunner` / `importPayloadResolver` / `stateStore`). These use
 * dynamic `await import(...)`, so the wiring fn is async.
 *
 * CARE — invariants that MUST survive (pinned by
 * `open/__tests__/open-wiring-uploads.test.ts`):
 *   - The Path-1 late-bound `importWatchHolder` pattern is preserved EXACTLY:
 *     the holder is CREATED BY THE COMPOSER (its `.watch` setter lives deep in
 *     the composer, far from this carve) and passed in as a dep. This wiring is
 *     the READER — it builds the `engineForUpload.notifyImportUpload` wrapper
 *     that fires `importWatchHolder.watch?.(input.user_id)` after the engine
 *     advance. Reader and setter close over the SAME holder reference. (NOT a
 *     `late<T>` seam — that is C3d's job.)
 *   - The sweeper cleanup is collected into the returned `cleanups` array (NOT
 *     pushed onto `realmodeCleanups` here); the composer pushes it at the carve
 *     site so it lands at the SAME point in the cleanup sequence.
 *   - `TOPIC_ID_HEADER` / `TOPIC_ID_FALLBACK` fallback `console.warn` messages
 *     are verbatim.
 *   - The `import_resume_handler` null-guards
 *     (`resumeRunner !== null && resumePayloadResolver !== null`) are preserved,
 *     including the not-mounted `console.warn`.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { LoopRegistry } from '@neutronai/loop'
import type { CompositionInput } from '@neutronai/gateway/composition.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import type { OpenWiringContext } from './context.ts'

/**
 * The composed dependencies the upload surface reads that the narrow wiring
 * context does NOT carry: the landing stack (for `engine.notifyImportUpload` +
 * the import runner / payload-resolver / state-store), the single-owner POSIX
 * uid/gid, and the composer-owned late-bound import-watch holder.
 */
export interface WireUploadsDeps {
  /** The landing stack — supplies the engine + import runner / resolver / store. */
  landing: LandingStackWithEngine
  /** Single-owner POSIX uid the owner process runs as (`process.getuid?.() ?? 0`). */
  uploadUid: number
  /** Single-owner POSIX gid the owner process runs as (`process.getgid?.() ?? 0`). */
  uploadGid: number
  /**
   * The Path-1 late-bound import-completion watcher holder — CREATED BY THE
   * COMPOSER and passed here so this READER and the composer-side `.watch`
   * SETTER share one reference. Its `.watch` is filled long after composition.
   */
  importWatchHolder: { watch?: (user_id: string) => void }
  /**
   * §F2 — the shared loop inventory. This wiring starts the `ChunkedUploadSweeper`
   * (a long-lived loop) OUTSIDE `composeProductionGraph`, so it registers the
   * sweeper's live descriptor here; the composer threads the SAME registry into
   * `CompositionInput.loop_registry` so the gateway boot line inventories it too.
   */
  loopRegistry: LoopRegistry
}

export interface WiredUploads {
  /** Bare single-shot `POST /api/upload/<source>` handler (always built). */
  import_upload_handler: NonNullable<CompositionInput['import_upload_handler']>
  /** Chunked resumable upload handler (`/start`, `PATCH`, `HEAD`; always built). */
  chunked_upload_handler: NonNullable<CompositionInput['chunked_upload_handler']>
  /** Import-resume route handler; undefined when the engine built no runner. */
  import_resume_handler: CompositionInput['import_resume_handler']
  /** Teardown hooks (upload sweeper stop) in registration order. The sweeper's
   *  `stop()` is async (quiescing), so a hook may return a Promise the gateway
   *  shutdown runner awaits before `db.close()` (§F1). */
  cleanups: Array<() => void | Promise<void>>
}

/**
 * Construct the Open composition's import-upload / import-resume surface from the
 * wiring context plus the composed `deps`. The composer appends the returned
 * `cleanups` onto its `realmodeCleanups` at the carve site.
 */
export async function wireUploads(
  ctx: OpenWiringContext,
  deps: WireUploadsDeps,
): Promise<WiredUploads> {
  const { db, owner_home, project_slug } = ctx
  const { landing, uploadUid, uploadGid, importWatchHolder, loopRegistry } = deps
  const cleanups: Array<() => void | Promise<void>> = []

  // Path 1 — the upload handler still drives the engine's import pipeline
  // (synthesis + cron write the project DOCUMENTS), but Path 1 has no accept
  // BUTTON: when the import lands at `import_analysis_presented` an
  // import-completion watcher transitions the row back to the conversational
  // marker so the live session continues + the post-turn extractor can finish
  // onboarding (which materializes the imported projects). The watcher is
  // late-bound (it needs onboarding state wired further below) via this holder.
  const engineForUpload: Pick<typeof landing.engine, 'notifyImportUpload'> = {
    notifyImportUpload: async (input) => {
      const result = await landing.engine.notifyImportUpload(input)
      importWatchHolder.watch?.(input.user_id)
      return result
    },
  }

  const { buildImportUploadHandler, TOPIC_ID_FALLBACK, TOPIC_ID_HEADER } =
    await import('@neutronai/gateway/upload/import-upload-handler.ts')
  // Bare single-shot `POST /api/upload/<source>` handler. Writes the export
  // ZIP to `<owner_home>/imports/<source>.zip` then notifies the engine.
  const import_upload_handler = buildImportUploadHandler({
    owner_home,
    uid: uploadUid,
    gid: uploadGid,
    project_slug,
    engine: engineForUpload,
    onTopicIdMissing: () => {
      console.warn(
        `[upload] open ${TOPIC_ID_HEADER} missing — falling back to topic_id=${TOPIC_ID_FALLBACK}. The engine's post-upload button emit is dropped unless a sender is registered for ${TOPIC_ID_FALLBACK}.`,
      )
    },
  })

  // Chunked resumable upload handler — owns
  // `POST /api/upload/<source>/start`,
  // `PATCH /api/upload/<source>/<upload_id>`, and
  // `HEAD /api/upload/<source>/<upload_id>`. Shares the engine + owner_home +
  // uid/gid + `notifyImportUpload` bridge with the bare handler so the
  // post-upload advance fires identically. Per-upload session state persists
  // in `upload_sessions` (migration 0048) on the single-owner project.db; a
  // long-lived sweeper marks expired sessions + unlinks partial files and is
  // torn down via `realmode_cleanups` on shutdown.
  const { buildChunkedUploadHandler } = await import(
    '@neutronai/gateway/upload/chunked-upload-handler.ts'
  )
  const { SqliteUploadSessionStore } = await import(
    '@neutronai/gateway/upload/upload-session-store.ts'
  )
  const { ChunkedUploadSweeper } = await import(
    '@neutronai/gateway/upload/chunked-upload-sweeper.ts'
  )
  const uploadSessionStore = new SqliteUploadSessionStore(db)
  const chunked_upload_handler = buildChunkedUploadHandler({
    owner_home,
    uid: uploadUid,
    gid: uploadGid,
    project_slug,
    engine: engineForUpload,
    store: uploadSessionStore,
    onTopicIdMissing: () => {
      console.warn(
        `[chunked-upload] open ${TOPIC_ID_HEADER} missing — falling back to topic_id=${TOPIC_ID_FALLBACK}.`,
      )
    },
  })
  const uploadSweeper = new ChunkedUploadSweeper({
    store: uploadSessionStore,
    owner_home,
    project_slug,
  })
  uploadSweeper.start()
  // §F2 — register the running sweeper into the shared boot inventory.
  loopRegistry.register(uploadSweeper.describe())
  cleanups.push(async () => {
    // §F1 — quiescing stop: the gateway shutdown runner awaits this before
    // `db.close()`, so an in-flight sweep fully drains first. `stop()` never
    // rejects, but keep the guard defensive.
    try {
      await uploadSweeper.stop()
    } catch {
      // best-effort shutdown cleanup
    }
  })

  // Import-resume route (`POST /api/import/<job_id>/resume`) — mounted
  // against the SAME runner / payload-resolver / state-store the engine
  // drives so tapping the chat `resume_import` button after a parse failure
  // doesn't 404. `buildLandingStack` surfaces all three on the engine return
  // shape; they are non-null whenever the engine built a default runner.
  let import_resume_handler: CompositionInput['import_resume_handler']
  const resumeRunner = landing.importJobRunner
  const resumePayloadResolver = landing.importPayloadResolver
  const resumeStateStore = landing.stateStore
  if (resumeRunner !== null && resumePayloadResolver !== null) {
    const { buildImportResumeHandler } = await import(
      '@neutronai/gateway/upload/import-resume-handler.ts'
    )
    import_resume_handler = buildImportResumeHandler({
      db,
      project_slug,
      owner_home,
      runner: resumeRunner,
      payloadResolver: resumePayloadResolver,
      stateStore: resumeStateStore,
    })
  } else {
    console.warn(
      `[composer] open import-resume handler NOT mounted — runner=${resumeRunner !== null} resolver=${resumePayloadResolver !== null}. resume_import button in chat will 404 if tapped.`,
    )
  }

  return {
    import_upload_handler,
    chunked_upload_handler,
    import_resume_handler,
    cleanups,
  }
}
