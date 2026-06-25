/**
 * resume-picker-detector.ts — P2: RESUME-SESSION-FAILURE picker safety net.
 *
 * § Terminal-detection port, master-table row #7 (docs/research/vajra-terminal-
 * detection-keystroke-port-2026-06-25.md). Ports Vajra's `index.ts:1865`
 * resume-session-failure handler onto the F1/F2/F3 substrate (`pty-ring.ts` /
 * `keystrokes.ts` / `output-scan.ts`).
 *
 * THE PROBLEM: when `claude --resume <session-id>` is started against a session
 * id that no longer exists, CC drops into an interactive "Resume Session" picker
 * that BLOCKS the REPL. The hard-won lesson (Vajra) is ESCAPE-THEN-RECOVER, never
 * BLIND-ANSWER: a stale cached `session_id` must NOT silently spawn a fresh
 * (empty-context) session without a disk-recovery attempt + a user-visible
 * "session lost" notice. Blind-picking an option here throws away the user's
 * context silently.
 *
 * SCOPE — this is a SAFETY NET. Neutron's normal resume path is JSONL-first
 * (`session-respawn.ts` / `session-validation.ts` / `session-capture.ts` resume
 * from disk JSONL, never the interactive picker), so this picker should rarely if
 * ever appear. We detect it and recover IF it does. EXPLICITLY OUT OF SCOPE:
 * changing the JSONL-first resume path; auto-picking any picker option.
 *
 * SPEC-CONFORMANCE NOTE: SPEC row #7 describes the signature loosely as
 * `Resume Session` || `Enter to select` || `Esc to clear`. A bare OR over those
 * single phrases would false-fire (`Enter to select` is shared with the ordinary
 * AskUserQuestion footer that detector #1 handles). We therefore anchor on the
 * DISTINCTIVE `Resume Session` title AND require the DISTINCTIVE `Esc to clear`
 * footer — NOT the shared `Enter to select`. The AskUserQuestion menu's footer is
 * `Esc to cancel`, so requiring `Esc to clear` keeps the two detectors strictly
 * disjoint even for a live question whose text happens to contain "Resume
 * Session" (Codex P2).
 *
 * DETECT (gates):
 *   • the `Resume Session` title (the distinctive picker header), AND
 *   • the distinctive `Esc to clear` footer cue.
 *   + doc-quote guard: the `output-scan` framework strips fenced / diff / bullet /
 *     inline-backtick lines, so prose quoting "Resume Session" can't fire.
 *   + edge-latch (framework): fire on absent→present, clear on present→absent.
 *
 * RECOVER (escape-then-recover ladder — never blind-answer):
 *   1. writeKey('escape') — dismiss the picker (never a digit / Enter).
 *   2. findLatestSession() — scan disk JSONL for the most recent real session.
 *   3a. found    → surface a "session recovered" notice + requestResume(id).
 *   3b. none     → surface a "session lost — starting fresh" notice.
 */

import { stripAnsi } from './pty-text.ts'
import { buildDetectorContext, type DetectorContext, type DetectorSpec } from './output-scan.ts'
import type { Key } from './keystrokes.ts'

/** Stable detector id (the scanner latch + the substrate's recovery dispatch key
 *  both reference this). */
export const RESUME_PICKER_DETECTOR_ID = 'resume-session-picker'

/** Bottom-N line window this detector reads. The picker renders the title + a
 *  short list of recent sessions + the footer as one compact box; 40 lines
 *  comfortably covers it while still excluding unbounded scrollback. */
export const RESUME_PICKER_BOTTOM_N = 40

// Signature phrases, matched against WHITESPACE-STRIPPED text (the Ink TUI
// positions each word with cursor-move escapes, so a phrase is never contiguous
// with its spaces intact — match the normalized form).
/** The distinctive picker title — the strong anchor. */
const RESUME_TITLE = /resumesession/i
/** The picker footer's clear cue — the DISTINCTIVE footer that distinguishes this
 *  picker from the AskUserQuestion menu (which uses `esc to cancel`, handled by
 *  detector #1). REQUIRED by the predicate; the loose-spec `Enter to select` cue
 *  is deliberately NOT gated on because it is shared with that menu (Codex P2). */
const FOOTER_CLEAR = /esctoclear/i

/**
 * The pure resume-session-picker predicate. Operates on a {@link DetectorContext}
 * whose `lines` are already bottom-N sliced + doc-quote stripped by the scanner
 * framework, so a quoted/fenced/diff mention of "Resume Session" can't reach here.
 */
export function isResumeSessionPicker(ctx: DetectorContext): boolean {
  if (ctx.lines.length === 0) return false
  const norm = ctx.normalized
  // BOTH cues are REQUIRED, and the footer cue is the DISTINCTIVE `Esc to clear`
  // — NOT the shared `Enter to select`. A live AskUserQuestion menu whose text
  // happens to contain "Resume Session" renders with the footer `Enter to select
  // · Esc to cancel`; gating on `Enter to select` would let that menu satisfy
  // this predicate and send Escape into a normal user-choice prompt that detector
  // #1 should handle (Codex P2). `Esc to clear` is unique to the resume picker
  // (the AskUserQuestion footer is `esc to cancel`), so requiring it keeps the two
  // detectors strictly disjoint.
  return RESUME_TITLE.test(norm) && FOOTER_CLEAR.test(norm)
}

/**
 * The registered {@link DetectorSpec} for the scanner. Carries NO `keys`:
 * recovery is the escape-then-recover ladder the substrate runs via
 * {@link runResumePickerRecovery} (a single Escape followed by a disk scan +
 * notice), NOT a fire-once keystroke. The framework's edge-latch makes it fire
 * exactly once per absent→present transition and re-arm on present→absent.
 */
export function createResumePickerDetector(): DetectorSpec {
  return {
    id: RESUME_PICKER_DETECTOR_ID,
    bottomN: RESUME_PICKER_BOTTOM_N,
    present: isResumeSessionPicker,
  }
}

/** Convenience: is the picker signature present in a freshly-read raw ring RIGHT
 *  NOW (no edge-latch)? Used by tests / verification. */
export function resumePickerPresent(rawRing: string, now = 0): boolean {
  return isResumeSessionPicker(buildDetectorContext(rawRing, RESUME_PICKER_BOTTOM_N, now))
}

/** Injected effects for {@link runResumePickerRecovery} — keeps the ladder logic
 *  pure + unit-testable without a PTY. */
export interface ResumePickerRecoveryDeps {
  /** Send one structured key to the PTY (F2 `writeKey`). The recovery sends ONLY
   *  Escape — never a digit or Enter (the no-blind-answer invariant). */
  writeKey: (key: Key) => void
  /** Scan disk JSONL for the latest resumable session for this cwd/topic, or
   *  `null` when none exists. Wraps `findLatestResumableSession` in prod. */
  findLatestSession: () => string | null
  /** Surface a user-visible notice (recovered vs lost) to the chat surface
   *  (dev-channel). */
  surface: (text: string) => void
  /** Re-resume the recovered session (optional). In prod the substrate wires this
   *  to mark the recovered session id resumable for the next respawn — the
   *  existing Neutron registry/resume mechanism, NOT a change to the JSONL-first
   *  path. Omitted ⇒ notice-only. */
  requestResume?: (sessionId: string) => void
  /** One operator alert (optional) — e.g. when no session could be recovered. */
  alert?: (text: string) => void
  /** Await between the Escape and the disk scan (the TUI needs a beat to dismiss
   *  the picker). Optional in tests. */
  delay?: (ms: number) => Promise<void>
  /** ms to wait after Escape before the disk scan. Default 400. */
  escapeSettleMs?: number
}

export interface ResumePickerRecoveryResult {
  /** True iff a real session was recovered from disk. */
  recovered: boolean
  /** The recovered session UUID (when `recovered`). */
  sessionId?: string
  /** Every key actually sent, in order — asserted by tests to be EXACTLY
   *  `['escape']` (the no-blind-answer invariant: never a digit / Enter). */
  keysSent: Key[]
}

/**
 * Run the escape-then-recover ladder on the resume-session-failure picker. NEVER
 * blind-answers: it sends a single Escape to dismiss the picker, then scans disk
 * JSONL for the user's most-recent real session. On a hit it surfaces a "session
 * recovered" notice and (if wired) requests a resume of that session; on a miss
 * it surfaces a "session lost — starting fresh" notice. The only key it can ever
 * send is Escape, so it can never silently pick a stale option.
 */
export async function runResumePickerRecovery(
  deps: ResumePickerRecoveryDeps,
): Promise<ResumePickerRecoveryResult> {
  // ESCAPE-THEN-RECOVER, never blind-answer (the load-bearing lesson). The
  // scanner already stamped the latch BEFORE handing this detection to the
  // caller, so this Escape is fire-once per rising edge even if the write throws
  // (output-scan.ts invariant §4) — a transport failure must not double-send.
  deps.writeKey('escape')
  const keysSent: Key[] = ['escape']

  if (deps.delay !== undefined) await deps.delay(deps.escapeSettleMs ?? 400)

  // JSONL/disk is the source of truth for recovery (invariant §5).
  const recoveredId = deps.findLatestSession()
  if (recoveredId !== null && recoveredId.length > 0) {
    deps.requestResume?.(recoveredId)
    deps.surface(
      `🔁 Resume picker appeared (cached session was stale). Escaped out and recovered ` +
        `your most recent session \`${recoveredId.slice(0, 8)}\` from disk — it will be ` +
        `active from your next message.`,
    )
    return { recovered: true, sessionId: recoveredId, keysSent }
  }

  // No recoverable session on disk: do NOT silently pretend nothing happened —
  // surface that context was lost so the fresh session isn't a silent surprise.
  deps.surface(
    `⚠️ Resume picker appeared (cached session was stale) and no prior session was ` +
      `found on disk to recover. Escaped out and started a fresh session — earlier ` +
      `context from the missing session is lost.`,
  )
  deps.alert?.('resume-session-picker: escaped the picker but no disk session was recoverable; started fresh.')
  return { recovered: false, keysSent }
}

/** Pull a human-readable snapshot of the picker (ANSI-stripped, last non-empty
 *  lines) — handy for logging / surfacing the exact picker the agent escaped. */
export function extractResumePicker(rawRing: string): string {
  return buildDetectorContext(rawRing, RESUME_PICKER_BOTTOM_N, 0)
    .lines.map((l) => stripAnsi(l).replace(/\s+$/g, ''))
    .filter((l) => l.trim().length > 0)
    .slice(-RESUME_PICKER_BOTTOM_N)
    .join('\n')
}
