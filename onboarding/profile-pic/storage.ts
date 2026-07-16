/**
 * @neutronai/onboarding/profile-pic — Sprint 28 storage + persistence.
 *
 * Per Sprint 28 deliverable #3 (the `storage.ts` module the spec calls
 * out as missing). The pipeline (`pipeline.ts`) already lands candidate
 * PNGs and copies the chosen bytes to
 * `<owner_home>/persona/profile-pic.png`; this module is the
 * cross-component glue that connects:
 *
 *   1. The pipeline's canonical-path output
 *   2. The platform registry pointer (`agent_avatar_path` —
 *      added in the Managed provisioning migration 0005_agent_avatar_path.sql)
 *   3. The per-instance Telegram bot's profile photo
 *      (Managed per-instance bot manager: setBotAvatar)
 *
 * The flow is "single canonical source on disk; everything else is a
 * pointer to it":
 *
 *   pipeline.pick(...)              → bytes land at <home>/persona/profile-pic.png
 *   storage.persistChosenAvatar(...) → registry.setAgentAvatarPath(canonical)
 *                                      + best-effort setBotAvatar(...) push
 *
 * `persistChosenAvatar` is intentionally idempotent — re-running it
 * after a transient failure (registry RW unavailable, Telegram rate
 * limited) keeps the durable disk state in place + retries the
 * cross-component pushes without duplicating writes.
 *
 * Failure semantics:
 *   - canonical-disk-write missing → throw `ProfilePicStorageError({code:'canonical_missing'})`
 *   - registry pointer write fails → log + throw `ProfilePicStorageError({code:'registry_failed'})`
 *   - Telegram bot avatar fails    → log warning, return ok with `bot_avatar_pushed=false`
 *
 * Only the registry-write failure is fatal. The bot avatar is polish;
 * onboarding does NOT block on it. The per-instance `/avatar.png` route
 * (added in the same sprint) reads from the canonical disk path so the
 * web/app surface picks up the new portrait the moment the pipeline's
 * `pick(...)` returns, regardless of whether the bot push succeeded.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createLogger } from '@neutronai/logger'
import { join } from 'node:path'
import type {
  ProfilePicEngineHook,
  ProfilePicHookCommitOutcome,
  ProfilePicHookEnsureOutcome,
} from '../interview/engine.ts'
import type { ProfilePicPipeline } from './pipeline.ts'
import type { ProfilePicPendingStore } from './pending-call-store.ts'
import { DEFAULT_PENDING_FRESH_WINDOW_MS } from './restart-resume.ts'

const log = createLogger('profile-pic-storage')

/** Structural mirror of the Managed bot-avatar pusher's input
 *  (Managed per-instance bot manager: SetBotAvatarInput).
 *  Defined locally since C2 closed the open-not-to-managed boundary —
 *  Managed composers inject the real `setBotAvatar`; Open deployments
 *  have no per-instance bot fleet and leave it unwired (push skipped). */
export interface SetBotAvatarInput {
  bot_token: string
  /** Raw PNG bytes. The canonical path is the source-of-truth. */
  png_bytes: Buffer
  /** Optional Bot API base URL override. Tests inject a fake. */
  base_url?: string
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch
}

/** Structural mirror of the Managed pusher's result. */
export interface SetBotAvatarResult {
  /** Telegram's confirmation that the photo was applied. */
  ok: true
}

/** The canonical filename within `<owner_home>/persona/`. */
export const CANONICAL_AVATAR_FILENAME = 'profile-pic.png'

export type ProfilePicStorageErrorCode =
  | 'canonical_missing'
  | 'registry_failed'
  | 'bot_avatar_failed'

export class ProfilePicStorageError extends Error {
  override readonly name = 'ProfilePicStorageError'
  constructor(
    readonly code: ProfilePicStorageErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/**
 * The two cross-component sinks `persistChosenAvatar` writes to. Both
 * are optional — production wires the registry sink (so cross-project
 * lookups can find the avatar without grepping disk) and the bot-avatar
 * sink (so DMs surface the portrait); tests + dev runs leave them off
 * and the pipeline still completes.
 */
export interface ProfilePicStorageDeps {
  /**
   * Registry pointer setter. Production wires
   * `(handle, path) => registry.setAgentAvatarPath(handle, path)` against
   * the platform registry.
   *
   * Returns:
   *   - `true`  → the UPDATE landed; the column was present + writable.
   *   - `false` → soft-failed (migration 0005 not yet applied); the
   *               canonical bytes are still on disk + the call is
   *               logged but `registry_updated` reports false.
   *   - `void`  → legacy stubs that don't surface the hint; the call
   *               site treats `void` as "wrote successfully" for
   *               backward compat.
   *
   * Throws on real DB failures (caller wraps in ProfilePicStorageError).
   */
  setAgentAvatarPath?: (
    owner_handle: string,
    agent_avatar_path: string | null,
  ) => Promise<boolean | void>
  /**
   * Bot avatar pusher. Production wires the per-instance Telegram bot
   * client (the one provisioned via `getManagedBotToken`). Tests inject
   * a stub. Optional — when absent, `persistChosenAvatar` skips the bot
   * push entirely + reports `bot_avatar_pushed: false`.
   */
  setBotAvatar?: (input: SetBotAvatarInput) => Promise<SetBotAvatarResult>
  /** Override fetch for the bot-avatar push (test seam). */
  fetcher?: typeof fetch
}

export interface PersistChosenAvatarInput {
  /** Frozen registry handle (`t-<8 hex>`). NULL skips the registry write. */
  owner_handle: string | null
  /** Per-instance data dir. Pipeline + storage agree on this layout. */
  owner_home: string
  /**
   * Per-instance Telegram bot token. NULL skips the bot push (e.g. web-only
   * instance, or operator-time secret seeding hasn't fired yet).
   */
  bot_token: string | null
}

export interface PersistChosenAvatarResult {
  /** Absolute path to `<owner_home>/persona/profile-pic.png`. */
  canonical_path: string
  /** True iff the registry pointer was successfully updated. */
  registry_updated: boolean
  /** True iff the per-instance bot's profile photo push succeeded. */
  bot_avatar_pushed: boolean
  /** When the bot push failed, the human-readable reason (logged). */
  bot_avatar_error?: string
}

/**
 * Persist a freshly-picked avatar across the registry + Telegram bot.
 *
 * Pre-condition: `pipeline.pick(...)` has already copied the chosen
 * bytes to `<owner_home>/persona/profile-pic.png`. This function
 * verifies that path, then drives the cross-component pushes.
 *
 * Sequence:
 *   1. Verify canonical disk path exists; throw `canonical_missing` if not.
 *   2. If `setAgentAvatarPath` wired AND `owner_handle` non-null:
 *      update the registry pointer; throw `registry_failed` on error.
 *   3. If `setBotAvatar` wired AND `bot_token` non-null: read the
 *      canonical bytes + push to Telegram. Failures here log + report
 *      `bot_avatar_pushed: false` instead of throwing — bot avatar is
 *      polish, not load-bearing.
 *
 * Idempotent: re-calling with the same inputs is a no-op on disk and
 * retries the registry + bot pushes (which are themselves idempotent).
 */
export async function persistChosenAvatar(
  input: PersistChosenAvatarInput,
  deps: ProfilePicStorageDeps,
): Promise<PersistChosenAvatarResult> {
  const canonical_path = join(
    input.owner_home,
    'persona',
    CANONICAL_AVATAR_FILENAME,
  )
  if (!existsSync(canonical_path)) {
    throw new ProfilePicStorageError(
      'canonical_missing',
      `expected canonical avatar at ${canonical_path} (pipeline.pick must run first)`,
    )
  }

  let registry_updated = false
  if (
    deps.setAgentAvatarPath !== undefined &&
    typeof input.owner_handle === 'string' &&
    input.owner_handle.length > 0
  ) {
    try {
      const r = await deps.setAgentAvatarPath(input.owner_handle, canonical_path)
      // Codex r4 P2 — honor the soft-fail signal. `false` means the
      // setter ran but didn't actually update (e.g. migration 0005
      // missing). Treat as not-updated so the commit transcript +
      // outcome accurately reflect on-disk state.
      registry_updated = r !== false
    } catch (err) {
      throw new ProfilePicStorageError(
        'registry_failed',
        `setAgentAvatarPath failed for handle=${input.owner_handle}`,
        err,
      )
    }
  }

  let bot_avatar_pushed = false
  let bot_avatar_error: string | undefined
  if (
    deps.setBotAvatar !== undefined &&
    typeof input.bot_token === 'string' &&
    input.bot_token.length > 0
  ) {
    let png_bytes: Buffer
    try {
      png_bytes = readFileSync(canonical_path)
    } catch (err) {
      bot_avatar_error = `read canonical bytes failed: ${err instanceof Error ? err.message : String(err)}`
      log.warn('persist_chosen_avatar_failed', { error: bot_avatar_error })
      const result: PersistChosenAvatarResult = {
        canonical_path,
        registry_updated,
        bot_avatar_pushed,
        bot_avatar_error,
      }
      return result
    }
    try {
      const callInput: SetBotAvatarInput = {
        bot_token: input.bot_token,
        png_bytes,
      }
      if (deps.fetcher !== undefined) callInput.fetcher = deps.fetcher
      await deps.setBotAvatar(callInput)
      bot_avatar_pushed = true
    } catch (err) {
      bot_avatar_error = err instanceof Error ? err.message : String(err)
      log.warn('bot_avatar_push_failed', { error: bot_avatar_error })
    }
  }

  const result: PersistChosenAvatarResult = {
    canonical_path,
    registry_updated,
    bot_avatar_pushed,
  }
  if (bot_avatar_error !== undefined) result.bot_avatar_error = bot_avatar_error
  return result
}

/**
 * Sprint 28 — production `ProfilePicEngineHook` factory. Wraps a real
 * `ProfilePicPipeline` so the engine can drive ensure / commit /
 * regenerate without knowing about Gemini, the fallback gallery, or
 * the registry / bot avatar fan-out.
 *
 * The factory is a thin adapter — the pipeline is the source-of-truth
 * for state transitions; this just translates the engine's typed
 * outcome shape onto the pipeline's one. Production composers wire:
 *
 *   - `pipeline` — `new ProfilePicPipeline({ db, owner_home, gemini })`
 *   - `owner_handle` — frozen registry handle for THIS instance
 *   - `owner_home` — same as the pipeline's
 *   - `setAgentAvatarPath` — `(h, p) => registry.setAgentAvatarPath(h, p)`
 *     against an RW registry handle opened from `NEUTRON_REGISTRY_DB_PATH`
 *   - `getBotToken` — `() => secrets.read('telegram_bot_token')`
 *   - `imageUrlBuilder` — `(c) => '/profile-pic/candidate/' + c.candidate_id + '.png'`
 *
 * Tests that need this can pass stubs for every leg.
 */
export interface BuildProfilePicEngineHookInput {
  pipeline: ProfilePicPipeline
  /** Frozen registry handle. Threaded into `persistChosenAvatar`. */
  owner_handle: string | null
  /** Per-instance data dir. */
  owner_home: string
  /** Registry pointer setter (RW). Optional — when absent, the registry
   *  pointer write is skipped. */
  setAgentAvatarPath?: ProfilePicStorageDeps['setAgentAvatarPath']
  /** Bot avatar pusher. Optional — the Managed composer injects the
   *  per-instance bot pusher; when absent the push is skipped (Open
   *  self-host / tests). */
  setBotAvatar?: ProfilePicStorageDeps['setBotAvatar']
  /** Bot-token resolver — production wires
   *  `async () => (await secrets.get({...})) ?? null`. Returns null when
   *  the per-instance bot is not yet provisioned (the bot avatar push
   *  is best-effort; null skips it cleanly). */
  getBotToken: () => string | null | Promise<string | null>
  /** Build the per-candidate image URL the channel adapter resolves to
   *  bytes. Production uses `(c) => '/profile-pic/candidate/' + c.id + '.png'`. */
  imageUrlBuilder: (input: { candidate_id: string }) => string
  /** The Gemini prompt template — production wires the real archetype-
   *  composed prompt; tests pass a fixed string. */
  buildPromptForCandidates: (input: {
    agent_name: string | null
    archetype_hint: string | null
  }) => string
  /**
   * Codex r1 P1 — when true, `ensureCandidates` blocks on the full
   * `pipeline.awaitJob(job_id)` before returning. Default: `false`.
   * Tests + the integration test that needs deterministic candidates
   * opt in with `wait_for_candidates: true`.
   */
  wait_for_candidates?: boolean
  /**
   * Codex r2 P1 — soft timeout (ms) for `ensureCandidates`. The
   * factory races `pipeline.awaitJob(...)` against a sleep of this
   * duration: if the pipeline lands within the timeout, we return
   * `kind: 'ready'` and the user sees the picker on the same turn;
   * otherwise we return `kind: 'pending'` so the engine can emit the
   * "Wait / Skip" placeholder rather than block the inbound turn for
   * the full ~30s Gemini round trip. Default: `5000` (5 sec).
   * Setting this to `0` disables the race entirely (returns immediately
   * with whatever status the pipeline has on first peek).
   */
  await_timeout_ms?: number
  /**
   * Durable pending-call store (migration 0046). When provided, the
   * engine hook peeks this store on phase-enter to surface "previous
   * attempt timed out / failed" outcomes to the user without starting
   * a fresh pipeline run that would lose the prior context. Production
   * wires `pipeline.pendingCallStore()`. Tests can omit (the engine
   * keeps its existing pipeline-only path).
   *
   * Behavior on phase-enter (no `prior_job_id`):
   *   - Latest row 'pending'    → return `kind: 'pending'` IF the row is
   *                                still inside the freshness window
   *                                (60 s). Older rows are routed to
   *                                expired/failed by the boot hook
   *                                BEFORE the engine ever observes them,
   *                                so this branch normally fires only
   *                                inside the same process.
   *   - Latest row 'expired'    → `kind: 'failed'` with reason
   *                                "previous attempt timed out, retry?"
   *   - Latest row 'failed'     → `kind: 'failed'` with reason
   *                                "previous attempt failed, retry?"
   *   - Latest row 'completed' AND job_id non-null (ISSUE #45)
   *                              → `kind: 'ready'` referencing the stored
   *                                job's candidates. The completed row
   *                                most commonly comes from the boot-
   *                                resume auto-retry landing BEFORE the
   *                                user taps Wait; surfacing those
   *                                candidates avoids a duplicate Gemini
   *                                call.
   *   - Latest row 'completed' AND job_id null (legacy / pre-0047)
   *                              → fall through to normal pipeline.start.
   *                                The row has no job reference so we
   *                                can't surface its candidates; preserve
   *                                today's behavior.
   *   - No row                  → fall through to normal pipeline.start
   */
  pendingStore?: ProfilePicPendingStore | null
  /**
   * `user_id` resolver. The engine hook receives `owner_slug` /
   * `topic_id` / `user_id` per call; this hook is for upstream wiring
   * that wants to override (e.g. when the engine hasn't plumbed user_id
   * into the hook input yet). Optional.
   */
  resolveUserId?: (input: { owner_slug: string; user_id: string }) => string | null
  /**
   * ISSUE #43 — fresh-pending detection window. When the latest pending
   * row in `pendingStore` is younger than this, `ensureCandidates`
   * returns `kind: 'pending'` instead of firing a duplicate
   * `pipeline.start(...)`. Defaults to the same 60 s window the boot-
   * resume hook uses (`DEFAULT_PENDING_FRESH_WINDOW_MS`). Tests override
   * to fast-forward or extend the window.
   */
  fresh_window_ms?: number
  /**
   * Time source (test seam) for the fresh-window comparison above.
   * Defaults to `Date.now()`. Tests inject a fixed clock so they can
   * seed `started_at` deterministically.
   */
  now?: () => number
}

export function buildProfilePicEngineHook(
  input: BuildProfilePicEngineHookInput,
): ProfilePicEngineHook {
  // C2 open-not-to-managed boundary — no Managed default here anymore.
  // The Managed production composer (wiring.ts, loaded via
  // the NEUTRON_GRAPH_COMPOSER_MODULE env seam — it no longer lives in
  // gateway/index.ts) injects the real per-instance bot pusher; when
  // unwired (Open self-host, tests) the bot avatar push is skipped
  // (bot_token is null there anyway — the push was already a no-op on
  // those paths).
  const fanOutDeps: ProfilePicStorageDeps = {}
  if (input.setBotAvatar !== undefined) {
    fanOutDeps.setBotAvatar = input.setBotAvatar
  }
  if (input.setAgentAvatarPath !== undefined) {
    fanOutDeps.setAgentAvatarPath = input.setAgentAvatarPath
  }

  const pendingStore = input.pendingStore ?? null
  const freshWindowMs = input.fresh_window_ms ?? DEFAULT_PENDING_FRESH_WINDOW_MS
  const now = input.now ?? ((): number => Date.now())

  return {
    async ensureCandidates(hookInput): Promise<ProfilePicHookEnsureOutcome> {
      // Codex r2 P1 — when re-checking a pending job, skip the
      // `pipeline.start(...)` call and just peek the existing
      // status. Otherwise start a fresh pipeline run.
      let job_id: string
      if (typeof hookInput.prior_job_id === 'string' && hookInput.prior_job_id.length > 0) {
        job_id = hookInput.prior_job_id
      } else {
        // Sprint NEXT (profile-pic process-restart resume) — peek the
        // durable pending-call store BEFORE firing a new pipeline run.
        // The boot hook has already transitioned any stale rows to
        // 'expired' / 'failed'; here we surface the outcome to the user
        // so they get a "previous attempt timed out, retry?" affordance
        // rather than a silent fresh start that throws away the prior
        // context.
        if (pendingStore !== null) {
          const resolvedUserId =
            input.resolveUserId !== undefined
              ? input.resolveUserId({
                  owner_slug: hookInput.owner_slug,
                  user_id: hookInput.user_id,
                })
              : hookInput.user_id
          const latest = await pendingStore.latestForUser(
            hookInput.owner_slug,
            resolvedUserId,
          )
          if (latest !== null) {
            if (latest.status === 'expired') {
              return {
                kind: 'failed',
                reason: 'previous attempt timed out, retry?',
              }
            }
            if (latest.status === 'failed') {
              return {
                kind: 'failed',
                reason: 'previous attempt failed, retry?',
              }
            }
            // ISSUE #43 — fresh-pending dedupe. A 'pending' row younger
            // than `freshWindowMs` (60 s by default, same constant the
            // boot-resume hook uses) means an in-flight Gemini call is
            // already running for THIS (instance, user). Returning
            // `kind: 'pending'` here surfaces the Wait/Skip placeholder
            // for the existing job rather than firing a duplicate
            // `pipeline.start(...)` that would burn another Gemini call
            // and race the original on candidate-row writes.
            //
            // ISSUE #45 — when the row carries a non-null `job_id`
            // (every row written under migration 0047+ does), surface
            // it back to the engine so the Wait poll re-enters
            // `ensureCandidates` with `prior_job_id = latest.job_id`
            // and gets a proper `pipeline.status(...)` peek instead of
            // re-consulting the store. The empty-string fallback is
            // kept for legacy / pre-0047 rows.
            //
            // 'pending' OLDER than the fresh window falls through to
            // the new pipeline.start call below: the original call is
            // presumed dead (gateway restart that pre-dated the boot
            // hook running, or Gemini > 60 s without completing — both
            // cases the brief calls "presumed dead").
            if (latest.status === 'pending') {
              const age = now() - latest.started_at
              if (age < freshWindowMs) {
                return { kind: 'pending', job_id: latest.job_id ?? '' }
              }
            }
            // ISSUE #45 — completed-after-Wait race.
            //
            // When the boot-resume auto-retry's `markCompleted` lands
            // BEFORE the user re-enters the phase (e.g. user enters phase
            // immediately after a deploy that restarted the gateway
            // mid-Gemini-call), the pending row's status is 'completed'
            // by the time we peek it. If the row carries a non-null
            // `job_id` (every row written under migration 0047+ does),
            // surface THAT job's candidates rather than firing a fresh
            // `pipeline.start`. The boot retry already paid the Gemini
            // call cost and the bytes are on disk under the retry job's
            // candidate ids; re-running the pipeline would burn a second
            // Gemini call AND throw away the user's chance to see the
            // candidates the retry actually produced.
            //
            // Legacy fall-through (`job_id === null`): rows written
            // before migration 0047 have no job reference. The engine
            // hook can't surface candidates without that reference, so
            // we fall through to a fresh `pipeline.start` — preserving
            // today's behavior for any in-flight row that survives the
            // schema upgrade.
            if (latest.status === 'completed' && latest.job_id !== null) {
              const completedStatus = await input.pipeline.status(latest.job_id)
              if (
                completedStatus !== null &&
                completedStatus.candidates.length > 0 &&
                completedStatus.status !== 'failed'
              ) {
                const trimmed = completedStatus.candidates.slice(0, 4)
                return {
                  kind: 'ready',
                  job_id: latest.job_id,
                  candidates: trimmed.map((c) => ({
                    candidate_id: c.id,
                    image_url: input.imageUrlBuilder({ candidate_id: c.id }),
                  })),
                  from_fallback: completedStatus.fallback_used,
                }
              }
              // job_id resolves to no job / no candidates / failed —
              // fall through to the normal `pipeline.start` path below.
              // Defensive: this branch should not fire in production
              // (the pipeline only `markCompleted`s a pending row after
              // landing at least one candidate row), but the legacy /
              // disk-corruption path needs the escape hatch.
            }
            // 'pending' older than the freshness window / 'completed'
            // without job_id fall through to the normal pipeline.start
            // path. Pre-migration-0047 legacy rows keep working that way.
          }
        }
        const startInput: Parameters<typeof input.pipeline.start>[0] = {
          owner_slug: hookInput.owner_slug,
          prompt: input.buildPromptForCandidates({
            agent_name: hookInput.agent_name,
            archetype_hint: hookInput.archetype_hint,
          }),
        }
        if (hookInput.archetype_hint !== null) {
          startInput.archetype_hint = hookInput.archetype_hint
        }
        if (typeof hookInput.user_id === 'string' && hookInput.user_id.length > 0) {
          startInput.user_id = hookInput.user_id
        }
        try {
          const r = await input.pipeline.start(startInput)
          job_id = r.job_id
        } catch (err) {
          return {
            kind: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          }
        }
      }
      // Codex r2 P1 — race awaitJob against a soft timeout. If the
      // pipeline lands within the timeout, the user gets the picker
      // on the same turn; otherwise we return `pending` so the engine
      // emits the Wait/Skip placeholder rather than blocking the
      // inbound for the full ~30s Gemini round trip. The `wait_for_
      // candidates` flag is the test seam — when set, we block for
      // the full pipeline run regardless of timeout (production never
      // sets this).
      const awaitTimeoutMs = input.await_timeout_ms ?? 5000
      if (input.wait_for_candidates === true) {
        try {
          await input.pipeline.awaitJob(job_id)
        } catch (err) {
          return {
            kind: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          }
        }
      } else if (awaitTimeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            input.pipeline.awaitJob(job_id),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, awaitTimeoutMs)
            }),
          ])
        } catch (err) {
          if (timer !== undefined) clearTimeout(timer)
          return {
            kind: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          }
        }
        if (timer !== undefined) clearTimeout(timer)
      }
      const status = await input.pipeline.status(job_id)
      if (status === null) {
        return { kind: 'failed', reason: 'no status row' }
      }
      // Pipeline statuses: 'queued' / 'generating' map to pending;
      // 'ready' / 'fallback' / 'user_uploaded' map to ready (the row
      // has at least one candidate to surface); 'failed' (gallery
      // missing) maps to failed.
      if (status.status === 'failed') {
        return { kind: 'failed', reason: 'pipeline failed (gallery_missing)' }
      }
      if (status.candidates.length === 0) {
        return { kind: 'pending', job_id }
      }
      const isFallback = status.fallback_used
      // Cap at 4 so the engine's image-gallery picker stays in A-D
      // labels; the pipeline default is 3 candidates per call so this
      // is a defensive backstop.
      const trimmed = status.candidates.slice(0, 4)
      return {
        kind: 'ready',
        job_id,
        candidates: trimmed.map((c) => ({
          candidate_id: c.id,
          image_url: input.imageUrlBuilder({ candidate_id: c.id }),
        })),
        from_fallback: isFallback,
      }
    },

    async commitPick(hookInput): Promise<ProfilePicHookCommitOutcome> {
      try {
        await input.pipeline.pick(hookInput.job_id, hookInput.candidate_id)
      } catch (err) {
        return {
          kind: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
      let result: PersistChosenAvatarResult
      try {
        const bot_token = await Promise.resolve(input.getBotToken())
        result = await persistChosenAvatar(
          {
            owner_handle: input.owner_handle,
            owner_home: input.owner_home,
            bot_token: bot_token ?? null,
          },
          fanOutDeps,
        )
      } catch (err) {
        return {
          kind: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
      return {
        kind: 'committed',
        canonical_path: result.canonical_path,
        registry_updated: result.registry_updated,
        bot_avatar_pushed: result.bot_avatar_pushed,
      }
    },

    async regenerate(hookInput): Promise<ProfilePicHookEnsureOutcome> {
      // Re-run ensureCandidates against the same pipeline. The pipeline
      // creates a fresh job_id internally so candidates don't collide
      // with the prior set on disk.
      return await this.ensureCandidates({
        owner_slug: hookInput.owner_slug,
        topic_id: hookInput.topic_id,
        user_id: hookInput.user_id,
        agent_name: hookInput.agent_name,
        archetype_hint: hookInput.archetype_hint,
      })
    },
  }
}

/**
 * Per-instance `/avatar.png` HTTP handler factory. The per-instance gateway
 * mounts this route (Sprint 21 added a stub; Sprint 28 finalizes) so
 * `https://<your-instance-host>/avatar.png` serves the canonical
 * portrait. The handler:
 *
 *   - reads `<owner_home>/persona/profile-pic.png` lazily on each
 *     request (no in-memory cache: the file is small + the request
 *     volume is low + the fs cache is the right cache here);
 *   - 404s when the user hasn't picked a portrait yet (no fallback to
 *     the gallery — the picker UX is supposed to land BEFORE any UI
 *     consumer asks for /avatar.png);
 *   - emits `Cache-Control: public, max-age=300` so the Caddy upstream
 *     + browsers re-fetch on a 5-minute window. Long-lived cache would
 *     fight rebrands; no-cache would hammer the per-instance gateway on
 *     every chat-header render.
 *
 * The Caddy proxy chain at `<your-instance-host>` already routes
 * `/avatar.png` to this gateway (Sprint 21); this handler closes the
 * other side of that route.
 */
export interface AvatarRouteOptions {
  owner_home: string
}

export function buildAvatarRouteHandler(
  opts: AvatarRouteOptions,
): (req: Request) => Response {
  const path = join(opts.owner_home, 'persona', CANONICAL_AVATAR_FILENAME)
  return (_req: Request): Response => {
    if (!existsSync(path)) {
      return new Response('avatar not yet chosen', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      })
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch (err) {
      // Disk-level failure (perm flip, fs unmount). Log + 500 rather
      // than serving a stale cached buffer.
      log.error('avatar_route_read_failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
      return new Response('avatar read failed', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=300',
        'content-length': String(bytes.length),
      },
    })
  }
}

/**
 * Sprint 28 Codex r2 P2 — `GET /profile-pic/candidate/<id>.png` route
 * handler. The dynamic image-gallery picker carries per-option
 * `image_url` of shape `/profile-pic/candidate/<candidate_id>.png` so
 * the channel adapter can render thumbnails. The pipeline writes
 * candidate bytes to `<owner_home>/persona/profile-pic-candidates/
 * <candidate_id>.png`; this handler serves them.
 *
 * Path-traversal defense: the matched `<id>` is sanitised to
 * `[A-Za-z0-9_-]+` (the pipeline emits UUIDs + hex). A request that
 * doesn't match the regex returns 404.
 */
const CANDIDATE_PATH_PREFIX = '/profile-pic/candidate/'
const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]+$/

export function buildCandidateRouteHandler(
  opts: AvatarRouteOptions,
): (req: Request) => Response | Promise<Response> {
  return (req: Request): Response => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith(CANDIDATE_PATH_PREFIX)) {
      return new Response('not found', { status: 404 })
    }
    const tail = url.pathname.slice(CANDIDATE_PATH_PREFIX.length)
    if (!tail.endsWith('.png')) {
      return new Response('not found', { status: 404 })
    }
    const id = tail.slice(0, -'.png'.length)
    if (!CANDIDATE_ID_RE.test(id)) {
      return new Response('not found', { status: 404 })
    }
    const path = join(opts.owner_home, 'persona', 'profile-pic-candidates', `${id}.png`)
    if (!existsSync(path)) {
      return new Response('candidate not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      })
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch (err) {
      log.error('candidate_route_read_failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
      return new Response('candidate read failed', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        // Candidates are immutable per id (the pipeline only writes once);
        // 1-hour cache is safe + lets browser back-button render fast.
        'cache-control': 'public, max-age=3600, immutable',
        'content-length': String(bytes.length),
      },
    })
  }
}

export const CANDIDATE_ROUTE_PATH_PREFIX = CANDIDATE_PATH_PREFIX
