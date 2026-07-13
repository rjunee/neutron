/**
 * @neutronai/reflection — the lightweight reflection + learning layer.
 *
 * Public surface: `createReflection(deps)` returns the runtime the live-agent
 * turn wires in (`gateway/realmode-composer/build-live-agent-turn.ts`):
 *
 *   - `loadContext()` — the `<learned_corrections>` + `<recent_diary>` block to
 *     splice into a topic's FIRST-turn system context (the read path).
 *   - `onTurnComplete({ user_text, agent_text, ... })` — a FIRE-AND-FORGET
 *     post-turn hook (mirrors scribe's `handleUserTurn`): cheap deterministic
 *     pre-gate → LLM correction-judge → on a hit, append to the corrections-log
 *     AND drop a diary breadcrumb. Returns void and swallows its own errors; it
 *     never throws into the chat path.
 *   - `appendDiary()` / `readDiary()` / `readCorrections()` — the programmatic
 *     diary read/write surface (the agent's own journal), re-exported so callers
 *     (and tests) can write + read back without reaching into the stores.
 *
 * When no `substrate` is supplied (LLM-less self-host, exactly like scribe's OFF
 * path) correction DETECTION is disabled — but the diary store and context
 * read-back still work, so the layer degrades gracefully.
 */

import type { Substrate } from '@neutronai/runtime/substrate.ts'

import { appendCorrection, readRecentCorrections } from './corrections-store.ts'
import { appendDiaryEntry, readRecentDiary } from './diary-store.ts'
import {
  detectCorrection,
  looksLikeCorrection,
  type DetectCorrectionDeps,
} from './detector.ts'
import { buildReflectionContext } from './context.ts'
import type { Correction, DiaryEntry } from './types.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

const LOG_TAG = '[reflection]'

/** Default watchdog for one correction-judge dispatch. */
const DEFAULT_WATCHDOG_MS = 60_000

export interface CreateReflectionDeps {
  /** Owner data dir (NEUTRON_HOME) — diary + corrections live under it. */
  ownerDataDir: string
  /**
   * The CC-spawn LLM-call substrate for the correction judge. OMIT it to run
   * the layer DETECTION-OFF (diary + context read-back still work). Use a
   * DEDICATED ephemeral substrate (not the conversational one) so the judge
   * never pollutes the chat transcript — mirrors scribe's `cc-scribe-*`.
   */
  substrate?: Substrate
  /** Model preference for the judge. Defaults to BEST_MODEL inside the detector. */
  model_preference?: ReadonlyArray<string>
  /** Per-judge watchdog timeout. Defaults to 60s. */
  watchdog_ms?: number
  /** Override the wall clock (tests). */
  now?: () => number
}

export interface ReflectionTurn {
  user_text: string
  agent_text: string
  /** Owning topic / session scope, for correction provenance + diary session. */
  scope?: string
  observed_at?: number
}

export interface Reflection {
  /** Read path: the context block to inject into a first-turn system prompt. */
  loadContext(): string | null
  /** Write path (fire-and-forget): detect + log a correction from one exchange. */
  onTurnComplete(turn: ReflectionTurn): void
  /** Programmatic diary write (the agent's own journal). */
  appendDiary(input: { text: string; kind?: string; session?: string | null; observed_at?: number }): DiaryEntry
  /** Programmatic diary read-back, newest-first. */
  readDiary(input?: { days?: number; limit?: number }): DiaryEntry[]
  /** Programmatic corrections read-back, newest-first. */
  readCorrections(input?: { limit?: number }): Correction[]
}

export function createReflection(deps: CreateReflectionDeps): Reflection {
  const now = deps.now ?? ((): number => Date.now())
  const ownerDataDir = deps.ownerDataDir
  const watchdog_ms = deps.watchdog_ms ?? DEFAULT_WATCHDOG_MS

  return {
    loadContext(): string | null {
      try {
        return buildReflectionContext({ ownerDataDir })
      } catch (err) {
        console.warn(`${LOG_TAG} event=load_context_failed err=${errMsg(err)}`)
        return null
      }
    },

    onTurnComplete(turn: ReflectionTurn): void {
      // Detection needs the LLM judge. No substrate → detection is OFF (the
      // diary + read-back still function); mirror scribe's OFF path exactly.
      if (deps.substrate === undefined) return
      // Cheap deterministic gate — skip the LLM call on the overwhelming
      // majority of turns that carry no correction cue.
      if (!looksLikeCorrection(turn.user_text)) return
      const substrate = deps.substrate
      fireAndForget('index.runDetection', runDetection(substrate).catch((err) => {
        console.warn(`${LOG_TAG} event=on_turn_complete_failed err=${errMsg(err)}`)
        throw err // re-raise so fireAndForget counts it (the .catch only adds context)
      }))

      async function runDetection(sub: Substrate): Promise<void> {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), watchdog_ms)
        let judgment
        try {
          const detectDeps: DetectCorrectionDeps = { substrate: sub }
          if (deps.model_preference !== undefined) detectDeps.model_preference = deps.model_preference
          judgment = await detectCorrection(
            detectDeps,
            { user_text: turn.user_text, agent_text: turn.agent_text },
            ac.signal,
          )
        } finally {
          clearTimeout(timer)
        }
        if (!judgment.is_correction) return
        const observed_at = turn.observed_at ?? now()
        const scope = turn.scope ?? 'general'
        const correction = appendCorrection({
          ownerDataDir,
          wrong: judgment.wrong,
          right: judgment.right,
          why: judgment.why,
          scope,
          source: turn.user_text,
          observed_at,
        })
        // Drop a diary breadcrumb so the learning also shows up in the agent's
        // own journal (a second, human-skimmable surface on the same event).
        try {
          appendDiaryEntry({
            ownerDataDir,
            text: `Logged a correction: ${correction.right}`,
            kind: 'correction',
            session: scope,
            observed_at,
          })
        } catch (err) {
          console.warn(`${LOG_TAG} event=diary_breadcrumb_failed err=${errMsg(err)}`)
        }
        console.info(
          `${LOG_TAG} event=correction_logged id=${correction.id} scope=${scope}`,
        )
      }
    },

    appendDiary(input): DiaryEntry {
      return appendDiaryEntry({
        ownerDataDir,
        text: input.text,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.session !== undefined ? { session: input.session } : {}),
        observed_at: input.observed_at ?? now(),
      })
    },

    readDiary(input): DiaryEntry[] {
      return readRecentDiary({
        ownerDataDir,
        // Thread the injected clock so the read window matches the write clock.
        // Without this, reads always used real Date.now() while writes honored
        // the injected `now` — so a test/override clock more than `days` behind
        // wall-clock read an empty window (the 2026-06-21 hardcoded-`now` rot).
        now: now(),
        ...(input?.days !== undefined ? { days: input.days } : {}),
        ...(input?.limit !== undefined ? { limit: input.limit } : {}),
      })
    },

    readCorrections(input): Correction[] {
      return readRecentCorrections({
        ownerDataDir,
        ...(input?.limit !== undefined ? { limit: input.limit } : {}),
      })
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { appendCorrection, readRecentCorrections } from './corrections-store.ts'
export { appendDiaryEntry, readRecentDiary } from './diary-store.ts'
export { buildReflectionContext } from './context.ts'
export {
  detectCorrection,
  looksLikeCorrection,
  parseJudgment,
  composeJudgePrompt,
} from './detector.ts'
export type { Correction, DiaryEntry, CorrectionJudgment } from './types.ts'
