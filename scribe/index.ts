/**
 * @neutronai/scribe — chat-time knowledge extraction → GBrain (phase 1).
 *
 * Closes ISSUES #101 Gap 2: before this module the ONLY production `writeEntity`
 * caller was the onboarding history-import populator, so ongoing chat extracted
 * nothing. Scribe phase 1 adds the chat-time extract→GBrain path:
 *
 *   chat turn → budget gate → LLM extract (CC-spawn substrate, Opus default)
 *             → entity pages + typed edges written to GBrain via the per-project
 *               GBrainSyncHook → budget release.
 *
 * Phase 2 (built) reconciles scribe with the Calendar/Email Managed Cores: the
 * Cores' connectors become extract-sources on TOP of the Cores (no new pollers).
 * `extractFromCoresSource` is the phase-2 entry: it flattens an already-fetched
 * Core row and delegates to the extract→GBrain path. (The old content-sync
 * foreign-origin quarantine pre-filter was removed with the Connect mesh,
 * connect-spec §2.1 — a single-hosted shared project has no foreign content to
 * refuse; scribe stamps own-origin author attribution via `write-to-gbrain.ts`'s
 * `ownSlug`.) The fan-out is decorated onto the Cores' existing scheduler `fire`
 * callbacks at `gateway/cores/calendar-wiring.ts` +
 * `gateway/cores/email-managed-wiring.ts`. `meeting` stays a reserved trigger
 * (no meeting Core to ride).
 *
 * Wiring (live, not built-but-unwired): `createScribe(...)` is constructed at
 * composer boot with the per-instance LLM-call substrate + GBrain sync hook +
 * instance data dir + budget state. `handleUserTurn` is threaded into the
 * chat-bridge's `scribeOnUserTurn` hook (fired after `engine.advance` on every
 * real user message); `extractFromCoresSource` is threaded into the Calendar +
 * Email Cores' fire callbacks. See `gateway/index.ts` + `gateway/http/chat-bridge.ts`.
 */

import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { writeEntity as defaultWriteEntity } from '@neutronai/runtime/entity-writer.ts'
import { runExtraction } from './extract.ts'
import {
  writeExtractionToGBrain,
  type WriteEntityFn,
  type WriteExtractionReport,
} from './write-to-gbrain.ts'
import {
  type BudgetState,
  type ScribeTrigger,
  tryAcquire,
  release,
  persistDaily,
  SCRIBE_WATCHDOG_MS,
  SCRIBE_MIN_CHARS,
} from './scribe-budget.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
export const __MODULE__ = '@neutronai/scribe' as const

export * from './scribe-budget.ts'
export {
  runExtraction,
  parseExtraction,
  composeExtractionPrompt,
  SCRIBE_EXTRACTION_PROMPT,
  type ScribeExtraction,
  type ExtractedEntity,
  type ExtractedRelation,
} from './extract.ts'
export {
  writeExtractionToGBrain,
  slugify,
  type WriteEntityFn,
  type WriteExtractionReport,
} from './write-to-gbrain.ts'
export {
  composeCalendarPayload,
  composeEmailPayload,
  type CalendarPayloadSource,
  type EmailPayloadSource,
} from './compose-payload.ts'

/** Input the chat-bridge hands scribe after a real user turn. */
export interface UserTurnInput {
  project_slug: string
  user_id: string
  topic_id: string
  text: string
  observed_at: number
  /**
   * Multi-author attribution (connect-spec §4.3 layer 2). The uniform author of
   * this turn — owner = author #0, each collaborator a stable id + display.
   * Threaded into the extraction so memory entries record WHO. Optional: an
   * unattributed caller records the entry without an author dimension.
   */
  author?: { id: string; display: string }
}

export type ScribeOutcome =
  | { ran: true; report: WriteExtractionReport }
  | { ran: false; reason: 'filtered' | 'budget' | 'error' }

/** Cores-source extract input (phase 2). The Core hands an already-fetched row,
 *  flattened to text via `composeCalendarPayload` / `composeEmailPayload`. */
export interface CoresSourceInput {
  /** `'calendar'` | `'email'` — the Managed Core feeding this extract. */
  trigger: ScribeTrigger
  /** Flattened Core row (already budget-agnostic plain text). */
  text: string
  /** Provenance pointer for the timeline entry, e.g. `gcal:<id>` / `email:<id>`. */
  source: string
  observed_at?: number
}

export interface CreateScribeDeps {
  /** The shared CC-spawn LLM-call substrate (per-instance credential pool). */
  substrate: Substrate
  /** Per-instance GBrain sync hook (page store + typed-edge graph). */
  syncHook: SyncHook
  /** Per-instance Zone-B data dir; the entity-writer appends `/entities`. */
  ownerDataDir: string
  /** Instance slug — provenance source pointer for timeline entries. */
  project_slug: string
  /** Per-instance budget governor state (created at composer boot). */
  budget: BudgetState
  /** Model preference. Defaults to Opus (`[BEST_MODEL]`) inside runExtraction. */
  model_preference?: ReadonlyArray<string>
  /** Watchdog timeout (ms). Defaults to SCRIBE_WATCHDOG_MS. */
  watchdog_ms?: number
  /** Min chars before extracting. Defaults to SCRIBE_MIN_CHARS. */
  min_chars?: number
  /** Override the real writeEntity (tests). */
  writeEntity?: WriteEntityFn
  /** Clock injection for determinism. Defaults to Date.now. */
  now?: () => number
  /** Failure log sink. Defaults to console.warn. */
  logFailure?: (msg: string, err: unknown) => void
}

export interface Scribe {
  /**
   * Fire-and-forget hook the chat-bridge calls after each user turn. Returns
   * void synchronously; the extraction runs in the background and never throws
   * into the chat path. Internally delegates to `extractAndWrite`.
   */
  handleUserTurn(input: UserTurnInput): void
  /**
   * Run one extraction end-to-end (budget gate → LLM extract → GBrain write).
   * Awaitable — used directly by tests and by `handleUserTurn` under the hood.
   */
  extractAndWrite(input: {
    text: string
    observed_at?: number
    trigger?: ScribeTrigger
    /** Timeline provenance pointer. Defaults to `chat:<project_slug>`. */
    source?: string
  }): Promise<ScribeOutcome>
  /**
   * Phase-2 Cores-source entry. Flattens an already-fetched Core row to text
   * and delegates to `extractAndWrite` (budget gate → LLM extract → GBrain
   * write). Fire-and-forget callers (the Cores' fire callbacks) ignore the
   * return; tests assert it.
   */
  extractFromCoresSource(input: CoresSourceInput): Promise<ScribeOutcome>
}

export function createScribe(deps: CreateScribeDeps): Scribe {
  const now = deps.now ?? ((): number => Date.now())
  const watchdogMs = deps.watchdog_ms ?? SCRIBE_WATCHDOG_MS
  const minChars = deps.min_chars ?? SCRIBE_MIN_CHARS
  const writeEntityFn: WriteEntityFn =
    deps.writeEntity ?? (defaultWriteEntity as unknown as WriteEntityFn)
  const logFailure =
    deps.logFailure ??
    ((msg: string, err: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn(`[scribe] ${msg}: ${err instanceof Error ? err.message : String(err)}`)
    })

  /** Cheap pre-filters lifted from Nova's `maybeSpawnScribe` (commands, system
   *  sentinels, too-short turns carry no extractable knowledge). */
  function shouldExtract(text: string): boolean {
    const t = text.trim()
    if (t.length < minChars) return false
    if (t.startsWith('/')) return false // slash command
    if (t.startsWith('SYSTEM:')) return false
    return true
  }

  async function extractAndWrite(input: {
    text: string
    observed_at?: number
    trigger?: ScribeTrigger
    source?: string
    author?: { id: string; display: string }
  }): Promise<ScribeOutcome> {
    const trigger: ScribeTrigger = input.trigger ?? 'chat'
    const ts = input.observed_at ?? now()
    const source = input.source ?? `chat:${deps.project_slug}`
    if (!shouldExtract(input.text)) {
      return { ran: false, reason: 'filtered' }
    }

    const acq = tryAcquire(deps.budget, trigger, ts)
    if (!acq.ok) {
      logFailure(`extract rejected trigger=${trigger} reason=${acq.reason}`, acq.reason)
      return { ran: false, reason: 'budget' }
    }

    // Watchdog: abort the in-process substrate call if it overruns. Replaces
    // Nova's detached-pgroup SIGKILL with an AbortSignal wired to the
    // substrate handle's cancel().
    const controller = new AbortController()
    const watchdog = setTimeout(() => controller.abort(), watchdogMs)
    let ok = false
    try {
      const runDeps: Parameters<typeof runExtraction>[0] = { substrate: deps.substrate }
      if (deps.model_preference !== undefined) runDeps.model_preference = deps.model_preference
      const extraction = await runExtraction(runDeps, input.text, controller.signal)
      const report = await writeExtractionToGBrain(
        {
          extraction,
          ownerDataDir: deps.ownerDataDir,
          source,
          ts: new Date(ts).toISOString(),
          // Own-origin author attribution — this node's own slug. (The
          // content-sync foreign-origin path was removed with the mesh,
          // connect-spec §2.1.)
          ownSlug: deps.project_slug,
          // Multi-author attribution (connect-spec §4.3): record WHO the turn
          // came from in the entry's timeline provenance, when known.
          ...(input.author !== undefined ? { author: input.author } : {}),
        },
        {
          writeEntity: writeEntityFn,
          syncHook: deps.syncHook,
        },
      )
      ok = true
      return { ran: true, report }
    } catch (err) {
      logFailure('extract failed', err)
      return { ran: false, reason: 'error' }
    } finally {
      clearTimeout(watchdog)
      release(deps.budget, ok, now())
      // Persist the daily counter off the hot path; failures are non-fatal.
      fireAndForget('index.persistDaily', persistDaily(deps.budget, now()).catch((e) => {
        logFailure('persistDaily failed', e)
        throw e // re-raise so fireAndForget counts it (logFailure only adds context)
      }))
    }
  }

  async function extractFromCoresSource(input: CoresSourceInput): Promise<ScribeOutcome> {
    // Flatten the already-fetched Core row to an extract. The content-sync
    // foreign-origin quarantine pre-filter was removed with the mesh
    // (connect-spec §2.1) — a single-hosted shared project has no foreign
    // content to refuse.
    const ew: Parameters<typeof extractAndWrite>[0] = {
      text: input.text,
      trigger: input.trigger,
      source: input.source,
    }
    if (input.observed_at !== undefined) ew.observed_at = input.observed_at
    return extractAndWrite(ew)
  }

  function handleUserTurn(input: UserTurnInput): void {
    // Fire-and-forget: the chat path must never block on (or be broken by)
    // extraction. `extractAndWrite` swallows its own errors; this catch is the
    // last-resort backstop.
    fireAndForget('index.extractAndWrite', extractAndWrite({
      text: input.text,
      observed_at: input.observed_at,
      trigger: 'chat',
      ...(input.author !== undefined ? { author: input.author } : {}),
    }).catch((e) => {
      logFailure('handleUserTurn', e)
      throw e // re-raise so fireAndForget counts it (extractAndWrite's backstop)
    }))
  }

  return {
    handleUserTurn,
    extractAndWrite,
    extractFromCoresSource,
  }
}
