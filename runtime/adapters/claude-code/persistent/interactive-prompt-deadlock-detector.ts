/**
 * interactive-prompt-deadlock-detector.ts — P0: WEDGED-INTERACTIVE-PROMPT detect + recover.
 *
 * § Terminal-detection port, master-table row #1 (docs/research/vajra-terminal-
 * detection-keystroke-port-2026-06-25.md), the dispatch-locked flagship. Ports
 * Vajra's `pane-scan-watchdog.ts isWedgedInteractivePrompt` / `runWedgedRecovery`
 * onto the F1/F2/F3 substrate (`pty-ring.ts` / `keystrokes.ts` / `output-scan.ts`).
 *
 * THE PROBLEM (Ryan 2026-06-25 SPEC Decisions Log — detect+RECOVER, not kill):
 * an `AskUserQuestion` / arrow-menu that `claude` renders mid-turn has NO
 * keystroke path from the chat surface, so the REPL DEADLOCKS — and today the
 * only thing that notices is the 5-min inactivity watchdog, which KILLS the
 * agent. We instead RECOGNISE the wedged prompt and CLEAR it with a bounded
 * escape→escape→ctrl-c ladder, surfacing the question to the chat surface only
 * if the ladder fails. We NEVER auto-pick a menu option.
 *
 * DETECT — all gates, ported verbatim (each a paid-for incident):
 *   (0) NOT the normal idle/working chrome: reject if `⏵⏵` / `bypass permissions`
 *       / `esc to interrupt` / `? for shortcuts` is present (that's a LIVE,
 *       non-wedged prompt, not a selection menu).
 *   (a) a footer in the bottom-24 lines carrying ALL of `enter to select` +
 *       `to navigate` + `esc to cancel` (the AskUserQuestion / arrow-menu footer).
 *   (b) a LIVE cursor `/^❯\s*\d+\./` in the ~30 lines ABOVE that footer.
 *   (c) a `seenLastTick` STABILITY gate — the signature must persist across two
 *       consecutive scan ticks before we act (a half-rendered menu mustn't fire).
 *   + doc-quote guard: the `output-scan` framework already strips fenced / diff /
 *     bullet / inline-backtick lines, and the `^❯` LINE anchor rejects a quoted
 *     or diff-prefixed menu line — a documentation example of a menu can't fire.
 *
 * LESSONS carried verbatim:
 *   • AskUserQuestion TUI deadlocks with no keystroke path from chat (2026-06-06
 *     Neutron incident) — the reason this detector exists at all.
 *   • Bottom-N widened 8→24 after the 2026-06-16 Robobuddha miss (a status panel
 *     rendered BELOW the footer) — the footer-window guard is bottom-24.
 *   • The `^❯` anchor rejects quoted / diff menu lines (a `>`/`+`/`-`-prefixed or
 *     backtick-wrapped `❯ 1.` is NOT a live cursor).
 *   • A FAILED re-capture (`null`) counts as NOT-cleared, so the escape/ctrl-c
 *     ladder keeps escalating rather than assuming success.
 */

import { stripAnsi } from './pty-text.ts'
import { buildDetectorContext, type DetectorContext, type DetectorSpec } from './output-scan.ts'
import type { Key } from './keystrokes.ts'

/** Stable detector id (the scanner latch + the substrate's recovery dispatch key
 *  both reference this). */
export const WEDGED_PROMPT_DETECTOR_ID = 'wedged-interactive-prompt'

/**
 * Bottom-N line window this detector reads. Wider than the default-24 because the
 * footer must land in the bottom-24 AND a live cursor must be visible up to ~30
 * lines ABOVE it: 24 (footer window) + 30 (cursor look-back) = 54.
 */
export const WEDGE_BOTTOM_N = 54

/** The footer window the footer signature must appear within (bottom-24 — widened
 *  8→24 after the 2026-06-16 Robobuddha status-panel-below-footer miss). */
export const FOOTER_WINDOW = 24

/** How many lines ABOVE the footer the live cursor may appear in. */
export const CURSOR_LOOKBACK = 30

// Footer phrases, matched against WHITESPACE-STRIPPED text (the Ink TUI positions
// each word with cursor-move escapes, so the phrase is never contiguous with its
// spaces intact — match the normalized form).
const FOOTER_SELECT = /entertoselect/i
const FOOTER_NAVIGATE = /tonavigate/i
const FOOTER_CANCEL = /esctocancel/i

/** gate (0): the normal LIVE/working chrome. Its presence means this is NOT a
 *  wedged selection menu (matched on whitespace-stripped text). */
const NORMAL_PROMPT_CHROME = /⏵⏵|bypasspermissions|esctointerrupt|\?forshortcuts/i

/** The live-cursor anchor: `❯ 1.` at the (whitespace-trimmed) START of a line.
 *  Anchoring at line start is what rejects an inline / quoted `… ❯ 1.` (the
 *  doc-quote guard drops `>`/`+`/`-`/`*`-prefixed lines; this anchor handles the
 *  rest). */
const CURSOR_ANCHOR = /^❯\s*\d+\./

/** Whitespace-stripped form of one rendered line (ANSI gone, spaces gone) — for
 *  the contiguous footer-phrase checks. */
function normLine(line: string): string {
  return stripAnsi(line).replace(/\s+/g, '')
}

/** True iff `line` is a live menu-cursor line (`^❯ <n>.`), ANSI-stripped and
 *  leading-whitespace tolerant but otherwise line-anchored. */
function isCursorLine(line: string): boolean {
  return CURSOR_ANCHOR.test(stripAnsi(line).trimStart())
}

/**
 * The pure wedged-prompt predicate (gates 0/a/b + doc-quote, NOT the stability
 * gate — that's layered on in {@link createWedgedPromptDetector}). Operates on a
 * {@link DetectorContext} whose `lines` are already bottom-N sliced + doc-quote
 * stripped by the scanner framework.
 */
export function isWedgedInteractivePrompt(ctx: DetectorContext): boolean {
  const lines = ctx.lines
  if (lines.length === 0) return false

  // gate (0): a normal live/working prompt is NOT a wedged selection menu.
  if (NORMAL_PROMPT_CHROME.test(ctx.normalized)) return false

  // gate (a): footer with all three phrases, located within the bottom-24.
  // Find the footer anchor line (the one carrying `esc to cancel`) scanning from
  // the bottom, and require it inside the bottom-FOOTER_WINDOW lines.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_CANCEL.test(normLine(lines[i] ?? ''))) {
      footerIdx = i
      break
    }
  }
  if (footerIdx === -1) return false
  if (lines.length - footerIdx > FOOTER_WINDOW) return false
  // The three footer phrases may span the footer line + an adjacent wrapped line;
  // require all three within the bottom-FOOTER_WINDOW block.
  const footerBlock = normLine(lines.slice(-FOOTER_WINDOW).join('\n'))
  if (!FOOTER_SELECT.test(footerBlock)) return false
  if (!FOOTER_NAVIGATE.test(footerBlock)) return false
  if (!FOOTER_CANCEL.test(footerBlock)) return false

  // gate (b): a live cursor `^❯ <n>.` in the ~30 lines ABOVE the footer.
  const from = Math.max(0, footerIdx - CURSOR_LOOKBACK)
  for (let i = from; i < footerIdx; i++) {
    if (isCursorLine(lines[i] ?? '')) return true
  }
  return false
}

/**
 * The registered {@link DetectorSpec} for the scanner. Layers the `seenLastTick`
 * STABILITY gate (gate c) over {@link isWedgedInteractivePrompt}: `present`
 * returns true only when the raw signature is up NOW *and* was up on the previous
 * scan — so a half-rendered menu (present for a single tick) never fires. The
 * spec carries NO `keys`: recovery is a multi-step verify ladder the substrate
 * runs via {@link runWedgedRecovery}, not a fire-once keystroke.
 */
export function createWedgedPromptDetector(): DetectorSpec {
  let seenLastTick = false
  return {
    id: WEDGED_PROMPT_DETECTOR_ID,
    bottomN: WEDGE_BOTTOM_N,
    present: (ctx) => {
      const sigUp = isWedgedInteractivePrompt(ctx)
      const stable = sigUp && seenLastTick
      seenLastTick = sigUp
      return stable
    },
  }
}

/** Convenience: is the wedge signature present in a freshly-read raw ring RIGHT
 *  NOW (no stability gate)? Used by the recovery ladder to VERIFY a keystroke
 *  cleared the menu. */
export function wedgeSignaturePresent(rawRing: string, now = 0): boolean {
  return isWedgedInteractivePrompt(buildDetectorContext(rawRing, WEDGE_BOTTOM_N, now))
}

/** The bounded recovery ladder, in order. Escape twice (dismiss the menu), then
 *  Ctrl-C (interrupt the turn) — and NOTHING that could auto-pick an option
 *  (never a digit, never Enter). */
export const RECOVERY_LADDER: readonly Key[] = ['escape', 'escape', 'ctrl-c']

/** Injected effects for {@link runWedgedRecovery} — keeps the ladder logic pure
 *  + unit-testable without a PTY. */
export interface WedgeRecoveryDeps {
  /** Send one structured key to the PTY (F2 `writeKey`). */
  writeKey: (key: Key) => void
  /** Re-capture the ring AFTER a keystroke. Returning `null` models a FAILED
   *  re-capture, which counts as NOT-cleared so the ladder keeps escalating. */
  readRing: () => string | null
  /** Await between a keystroke and its verify re-read (the TUI needs a beat to
   *  re-render). */
  delay: (ms: number) => Promise<void>
  /** Surface the still-wedged question to the chat surface (dev-channel) when the
   *  whole ladder fails to clear it. Receives the captured menu text. */
  surface: (questionText: string) => void
  /** One operator alert on a persistent block. */
  alert: (text: string) => void
  /** Monotonic clock for the verify `wedgeSignaturePresent` calls. */
  now: () => number
  /** ms to wait after each keystroke before verifying. Default 400. */
  verifyDelayMs?: number
}

export type WedgeRecoveryOutcome = 'cleared' | 'blocked'

export interface WedgeRecoveryResult {
  outcome: WedgeRecoveryOutcome
  /** The key whose verify pass found the menu cleared (when `cleared`). */
  clearedBy?: Key
  /** Every key actually sent, in order — asserted by tests to NEVER contain a
   *  digit or Enter (the no-auto-pick invariant). */
  keysSent: Key[]
}

/** Pull a human-readable snapshot of the wedged menu (ANSI-stripped, last
 *  non-empty lines) to attach when surfacing the block to chat. */
export function extractWedgeQuestion(rawRing: string): string {
  return buildDetectorContext(rawRing, WEDGE_BOTTOM_N, 0)
    .lines.map((l) => stripAnsi(l).replace(/\s+$/g, ''))
    .filter((l) => l.trim().length > 0)
    .slice(-FOOTER_WINDOW)
    .join('\n')
}

/**
 * Run the bounded escape→escape→ctrl-c recovery ladder on a wedged interactive
 * prompt. After EACH keystroke it waits then RE-READS the ring and re-checks the
 * wedge signature: a cleared menu returns `{ outcome: 'cleared', clearedBy }`
 * immediately; a `null` re-capture counts as NOT-cleared so it escalates. If the
 * whole ladder leaves the menu up, it surfaces the question to chat + fires ONE
 * operator alert and returns `{ outcome: 'blocked' }`. It NEVER sends a digit or
 * Enter, so it can never auto-pick a menu option.
 */
export async function runWedgedRecovery(deps: WedgeRecoveryDeps): Promise<WedgeRecoveryResult> {
  const verifyDelayMs = deps.verifyDelayMs ?? 400
  const keysSent: Key[] = []
  for (const key of RECOVERY_LADDER) {
    deps.writeKey(key)
    keysSent.push(key)
    await deps.delay(verifyDelayMs)
    const ring = deps.readRing()
    // A failed re-capture (null) counts as NOT-cleared → keep escalating.
    if (ring !== null && !wedgeSignaturePresent(ring, deps.now())) {
      return { outcome: 'cleared', clearedBy: key, keysSent }
    }
  }
  // Persistent block after the full ladder: surface to chat + ONE operator alert.
  const lastRing = deps.readRing()
  deps.surface(lastRing !== null ? extractWedgeQuestion(lastRing) : '(menu capture unavailable)')
  deps.alert(
    `wedged-interactive-prompt: escape→escape→ctrl-c ladder did NOT clear the menu; ` +
      `surfaced the question to chat. Manual intervention may be needed.`,
  )
  return { outcome: 'blocked', keysSent }
}
