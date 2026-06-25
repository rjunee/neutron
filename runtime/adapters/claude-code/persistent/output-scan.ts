/**
 * output-scan.ts — F3: the output-scan tick / detector-registration framework.
 *
 * § Terminal-detection port, prereq F3 (docs/research/vajra-terminal-detection-
 * keystroke-port-2026-06-25.md). This is Neutron's analog of Vajra's
 * `pane-scan-watchdog.ts`: a single pass that runs registered detectors against
 * the PTY ring and reports which ones FIRED this tick. It is invoked from the
 * substrate's existing `onData` callback (we GENERALIZE the inline disclaimer
 * detector that already lives there — we do NOT add a competing scan loop).
 *
 * The Vajra invariants are BAKED IN — each encodes a paid-for production
 * incident, carried verbatim (cross-cutting invariants §1–§4):
 *
 *   1. EDGE-TRIGGERED LATCHED alerting. A per-detector latch flips on
 *      absent→present and clears ONLY on present→absent. We fire on the rising
 *      edge only. (Pure time-dedupe re-fired hourly forever on a stale banner in
 *      an idle pane — the latch is the fix.)
 *   2. DOC-QUOTE GUARDS on every content match. Signatures inside inline
 *      backticks, fenced blocks, markdown bullets, or `+`/`-`/`>`-led diff lines
 *      are rejected (`stripDocQuotes`) so quoted menu/doc text never false-fires.
 *   3. BOTTOM-N POSITIONAL GUARDS. Detectors match only within the bottom N
 *      lines of the viewport (default 24 — widened from 8 after the 2026-06-16
 *      Robobuddha status-panel-below-footer miss).
 *   4. PER-DETECTOR DEBOUNCE STAMPED BEFORE THE AWAIT. `scan()` stamps the fire
 *      timestamp (and sets the latch) BEFORE it returns, so the caller's
 *      keystroke write happens AFTER the state is already recorded. A
 *      transport-level write failure therefore can NOT retry next tick and
 *      double-send a keystroke onto an approval prompt. In Neutron terms:
 *      mutating `writeKey` is fire-once per rising edge.
 *
 * The framework is PURE w.r.t. side effects: `scan()` decides which detectors
 * fire and returns their actions; the CALLER performs the `writeKey`. That keeps
 * the edge-latch + debounce logic unit-testable without a PTY, and keeps the
 * blocking write off this O(ring) decision path (invariant §9, bounded
 * single-threaded processing).
 */

import { normalizePtyText } from './pty-text.ts'
import { bottomNLines } from './pty-ring.ts'
import type { Key } from './keystrokes.ts'

/** Default bottom-N window. Widened 8→24 after the 2026-06-16 Robobuddha miss
 *  (a status panel rendered BELOW the footer). */
export const DEFAULT_BOTTOM_N = 24

/** What a detector sees: the doc-quote-stripped bottom-N lines plus their
 *  normalized concatenation (for contiguous-signature regexes). */
export interface DetectorContext {
  /** Bottom-N lines with doc-quoted lines removed (fence/diff/bullet-aware) and
   *  inline-backtick spans blanked. Live terminal chrome only. */
  readonly lines: readonly string[]
  /** `normalizePtyText(lines.join('\n'))` — ANSI + whitespace stripped, for a
   *  contiguous-phrase `signature.test(...)`. */
  readonly normalized: string
  /** Tick timestamp (ms). Passed in so the module stays deterministic/testable
   *  (no `Date.now()` inside). */
  readonly now: number
}

/** A registered detector. `present` decides if the signature is up RIGHT NOW;
 *  the framework handles the edge-latch, debounce, and bottom-N/doc-quote
 *  windowing so each detector only expresses its signature + its action. */
export interface DetectorSpec {
  /** Stable id (latch + debounce are keyed on this). */
  readonly id: string
  /** Bottom-N window for THIS detector. Default {@link DEFAULT_BOTTOM_N}. */
  readonly bottomN?: number
  /** Minimum ms between fires (a time floor on top of the edge-latch, for
   *  detectors that legitimately re-arm). Default 0 (latch is the only gate). */
  readonly debounceMs?: number
  /** True iff the signature is present in this context. */
  readonly present: (ctx: DetectorContext) => boolean
  /** Keystrokes to send on the rising edge (e.g. `['enter']`, `['down','enter']`,
   *  `['3','enter']`). Omit for notify-only alert detectors. */
  readonly keys?: readonly Key[]
}

/** A detector that fired this tick — the caller executes `keys` (if any). */
export interface FiredDetection {
  readonly id: string
  readonly keys?: readonly Key[]
}

interface DetectorState {
  /** Latched present (set on rising edge, cleared on falling edge). */
  latched: boolean
  /** Last fire timestamp for the debounce floor (-Infinity = never). */
  lastFireAt: number
}

/**
 * Strip doc-quoted lines so a signature match can only come from LIVE terminal
 * chrome, never from quoted documentation/menus the agent printed:
 *   • lines inside (or delimiting) a ``` / ~~~ fenced block
 *   • lines whose trimmed start is a diff/quote/bullet marker: `+ `/`- `/`> `/
 *     `* `, or a leading `+`/`>` diff marker
 *   • inline-backtick spans are blanked out, so a backtick-wrapped signature on
 *     an otherwise-live line still can't match
 * (cross-cutting invariant §2.) Lines that survive are returned verbatim
 * (minus blanked backtick spans).
 */
export function stripDocQuotes(lines: readonly string[]): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trimStart()
    // Fence delimiters toggle the block and are themselves skipped.
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // Diff / blockquote / bullet markers (a quoted menu, not live chrome).
    if (/^([+>]|[-*]\s)/.test(trimmed)) continue
    // Blank inline-backtick spans so a backtick-wrapped signature can't match.
    out.push(line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)))
  }
  return out
}

/** Build the {@link DetectorContext} for one detector's bottom-N window. */
function buildContext(rawRing: string, bottomN: number, now: number): DetectorContext {
  const windowText = bottomNLines(rawRing, bottomN)
  const lines = stripDocQuotes(windowText.length > 0 ? windowText.split('\n') : [])
  return { lines, normalized: normalizePtyText(lines.join('\n')), now }
}

/**
 * The output-scan tick. Registers signature+action detectors and, each `scan()`,
 * reports the ones that crossed the rising edge (present, not already latched,
 * past their debounce floor). State (latch + last-fire) is mutated and stamped
 * BEFORE `scan()` returns, so the caller's keystroke write is fire-once even if
 * the transport throws (invariant §4).
 */
export class OutputScanner {
  private readonly detectors: DetectorSpec[] = []
  private readonly state = new Map<string, DetectorState>()

  /** Register a detector. Throws on a duplicate id (a wiring bug). */
  register(spec: DetectorSpec): void {
    if (this.state.has(spec.id)) {
      throw new Error(`output-scan: duplicate detector id '${spec.id}'`)
    }
    this.detectors.push(spec)
    this.state.set(spec.id, { latched: false, lastFireAt: -Infinity })
  }

  /** Number of registered detectors (test/introspection helper). */
  get size(): number {
    return this.detectors.length
  }

  /**
   * Run every detector against the current raw ring text and return those that
   * fired on this tick's rising edge. Side-effect-free w.r.t. the PTY: the
   * caller performs each fired detection's `keys` write.
   */
  scan(rawRing: string, now: number): FiredDetection[] {
    const fired: FiredDetection[] = []
    for (const det of this.detectors) {
      const st = this.state.get(det.id)
      if (st === undefined) continue // unreachable (register seeds it)
      const ctx = buildContext(rawRing, det.bottomN ?? DEFAULT_BOTTOM_N, now)
      const present = det.present(ctx)
      if (!present) {
        // Falling edge: clear the latch so a fresh present→ can fire again.
        st.latched = false
        continue
      }
      // Present. Fire only on the rising edge AND past the debounce floor.
      const debounceOk = now - st.lastFireAt >= (det.debounceMs ?? 0)
      if (!st.latched && debounceOk) {
        // STAMP BEFORE THE (caller's) AWAIT — fire-once even if the write fails.
        st.latched = true
        st.lastFireAt = now
        fired.push(det.keys !== undefined ? { id: det.id, keys: det.keys } : { id: det.id })
      } else {
        // Already latched (or debounced): hold the latch up while still present.
        st.latched = true
      }
    }
    return fired
  }
}
