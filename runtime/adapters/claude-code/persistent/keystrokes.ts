/**
 * keystrokes.ts — F2: structured keystroke encoding for the PTY write seam.
 *
 * § Terminal-detection port, prereq F2 (docs/research/vajra-terminal-detection-
 * keystroke-port-2026-06-25.md). Today the only write path is raw
 * `child.write('\r')` (the disclaimer Enter) — there is NO way to navigate Ink
 * arrow-driven pickers (compact-resume, AskUserQuestion menus) or send Escape /
 * Ctrl-C for bounded recovery. F2 adds a named-key vocabulary that encodes the
 * exact terminal bytes a real keypress produces, so the P0/P1 recovery detectors
 * (next PRs) can express `writeKey('escape')` / `writeKeys(['down','enter'])`
 * instead of hand-rolling escape sequences at every call site.
 *
 * Byte encodings (xterm / VT100, what `claude`'s Ink TUI reads):
 *   enter   → \r        (0x0d)   — submit / select default
 *   escape  → \x1b      (0x1b)   — cancel / dismiss
 *   ctrl-c  → \x03      (0x03)   — interrupt
 *   tab     → \t        (0x09)
 *   up      → \x1b[A             — picker navigate up
 *   down    → \x1b[B             — picker navigate down
 *   right   → \x1b[C
 *   left    → \x1b[D
 *   <digit> → the literal '0'–'9' character (numbered menu option)
 *
 * Pure + side-effect-free so the encoding is unit-testable without a PTY; the
 * host backends (`bun-terminal-host.ts`) wire `writeKey`/`writeKeys` to
 * `child.write(encodeKey(...))`.
 */

/** A single named key. A bare digit string `'0'`–`'9'` selects a numbered menu
 *  option (sent as its literal character). */
export type NamedKey = 'enter' | 'escape' | 'ctrl-c' | 'tab' | 'up' | 'down' | 'left' | 'right'
export type DigitKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
export type Key = NamedKey | DigitKey

const NAMED_BYTES: Record<NamedKey, string> = {
  enter: '\r',
  escape: '\x1b',
  'ctrl-c': '\x03',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
}

function isDigitKey(key: string): key is DigitKey {
  return key.length === 1 && key >= '0' && key <= '9'
}

/** The exact terminal bytes for one key. Throws on an unknown key so a typo in
 *  a detector's action surfaces immediately rather than silently writing junk. */
export function encodeKey(key: Key): string {
  if (isDigitKey(key)) return key
  const bytes = NAMED_BYTES[key as NamedKey]
  if (bytes === undefined) {
    throw new Error(`keystrokes: unknown key '${String(key)}'`)
  }
  return bytes
}

/** Concatenated bytes for a multi-key sequence (e.g. `['down','enter']` to pick
 *  the second option of an arrow-driven picker). Empty array → ''. */
export function encodeKeys(keys: readonly Key[]): string {
  let out = ''
  for (const k of keys) out += encodeKey(k)
  return out
}
