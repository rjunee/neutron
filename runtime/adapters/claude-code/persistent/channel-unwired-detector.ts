/**
 * channel-unwired-detector.ts — P1: channel-MCP-unwired wedge signature (port row #6).
 *
 * § Terminal-detection port, master-table row #6 (docs/research/vajra-terminal-
 * detection-keystroke-port-2026-06-25.md). Ports Vajra's
 * `fleet-spawn-core.ts isChannelMcpUnwired` onto the F1/F3 substrate
 * (`pty-ring.ts` / `output-scan.ts`).
 *
 * THE PROBLEM (2026-06-20 fleet incident): after the dev-channel confirm is
 * answered and the TUI is up, the REPL sometimes NEVER binds the channel MCP.
 * `/health` still returns 200 — so the spawn LOOKS alive — but the agent can
 * never `reply()`; every reply attempt prints "no MCP server configured with
 * that name". On 2026-06-20, 17/23 wedged forge/argus spawns showed that exact
 * line as their last frame. Root cause = memory/CPU pressure at spawn, NOT a
 * timeout that's too short — so the fix is an explicit signature + FAST-FAIL,
 * not a longer wait.
 *
 * This module is the pure SIGNATURE half (detection only — no keystroke, ever).
 * The fast-fail + bounded respawn live in `post-spawn-assertion.ts`
 * (`channel-wedged` reason, re-read-AFTER-health ordering) and
 * `channel-wedge-respawn.ts` (cap-2 bounded respawn).
 *
 * DOC-QUOTE GUARD (invariant §2): the match runs through the F3
 * `buildDetectorContext`, which strips fenced / diff / bullet lines and blanks
 * inline-backtick spans BEFORE the signature test — so prose or a backtick-
 * wrapped quotation of "no MCP server configured with that name" (e.g. in this
 * very file's own scrollback) can NOT trip the wedge.
 */

import { buildDetectorContext, type DetectorContext } from './output-scan.ts'

/** Stable detector id (kept symmetric with the other ported detectors even
 *  though this one drives a spawn-assertion gate, not the OutputScanner). */
export const CHANNEL_UNWIRED_DETECTOR_ID = 'channel-mcp-unwired'

/** Bottom-N ring window the signature is matched within. The error renders as a
 *  recent tool-call result line, so the default 24 is ample. */
export const CHANNEL_UNWIRED_BOTTOM_N = 24

/**
 * The wedge signature, matched against WHITESPACE-STRIPPED text. The interactive
 * `claude` TUI positions each word with cursor-move escapes, so the phrase is
 * never contiguous with its spaces intact in the raw PTY stream — match the
 * normalized form (`normalizePtyText` collapses ANSI + whitespace). This is the
 * Vajra `isChannelMcpUnwired` string, carried verbatim.
 */
const CHANNEL_UNWIRED_RE = /noMCPserverconfiguredwiththatname/i

/**
 * Pure predicate over a {@link DetectorContext} whose `lines` are already
 * bottom-N sliced + doc-quote stripped by the F3 framework. True iff the
 * channel-MCP-unwired signature is present in LIVE terminal chrome.
 */
export function isChannelMcpUnwired(ctx: DetectorContext): boolean {
  return CHANNEL_UNWIRED_RE.test(ctx.normalized)
}

/**
 * Convenience: is the wedge signature present in a freshly-read RAW ring RIGHT
 * NOW? Applies the identical bottom-N + doc-quote windowing the live scanner
 * uses (so the doc-quote guard holds), then the normalized signature test. Used
 * by the post-spawn assertion's Stage-4 re-read-after-health gate.
 */
export function channelUnwiredSignaturePresent(rawRing: string, now = 0): boolean {
  return isChannelMcpUnwired(buildDetectorContext(rawRing, CHANNEL_UNWIRED_BOTTOM_N, now))
}
