/**
 * repl-detectors.ts — the output-scan detector set every REPL session carries.
 *
 * LIFTED OUT OF `spawn.ts` UNCHANGED (#539) because a session can now be built by two
 * routes and both need the same detectors. A re-adopted REPL with no detectors is
 * worse than one that was never adopted: it is a live `claude` that will sit forever
 * behind the first interactive prompt it renders — a trust dialog, an org-cap picker,
 * a wedged `AskUserQuestion` — with nothing watching to clear it, and the gateway will
 * report it as healthy because its dev-channel answers.
 *
 * Each detector's reasoning is its own comment and travels with it; nothing here is
 * new, and nothing was reworded on the way. The one thing that IS new lives elsewhere:
 * an adopted session PRIMES these latches against its first screen before any of them
 * may act (`OutputScanner.primeLatches`), because a pane that existed before this
 * process did shows "present" for things that did not just appear.
 */

import { createAuthFailureDetector } from './auth-failure-signature.ts'
import { createWedgedPromptDetector } from './interactive-prompt-deadlock-detector.ts'
import { RATE_LIMIT_BANNER_SEVERITIES, createRateLimitBannerDetector } from './rate-limit-banner.ts'
import type { ReplSession } from './repl-session.ts'
import { createResumePickerDetector } from './resume-picker-detector.ts'
import {
  COMPACT_RESUME_FULL_RE,
  COMPACT_RESUME_SUMMARY_RE,
  DEV_CHANNEL_DISCLAIMER_RE,
  DISCLAIMER_BOTTOM_N,
  RATE_LIMIT_OPTIONS_BOTTOM_N,
  RATE_LIMIT_OPTIONS_DEBOUNCE_MS,
  RATE_LIMIT_OPTIONS_RE,
  RATE_LIMIT_STOP_RE,
  TOOL_USE_QUESTION_RE,
  TOOL_USE_SELECTOR_RE,
} from './signatures.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'

/** Register every detector on `session`'s scanner. Called once per session, by
 *  whichever route built it. */
export function registerReplDetectors(
  session: ReplSession,
  options: PersistentReplSubstrateOptions,
): void {
  // F3 output-scan tick: the `--dangerously-load-development-channels` flag
  // renders a first-run disclaimer ("…using this for local development?") that
  // has NO config seed (unlike trust + bypass) and BLOCKS MCP-server loading
  // until dismissed; its default-selected option IS the accept, so a single
  // Enter clears it. We GENERALIZE that one-off check into a registered detector
  // on the session's `OutputScanner` (F3) rather than a competing scan loop —
  // the P0/P1 recovery detectors register the same way in follow-on PRs. Without
  // this dismiss the spawn wedges `no-channel-ready` forever.
  session.scanner.register({
    id: 'dev-channel-disclaimer',
    bottomN: DISCLAIMER_BOTTOM_N,
    present: (ctx) => DEV_CHANNEL_DISCLAIMER_RE.test(ctx.normalized),
    keys: ['enter'],
  })
  // P0 wedged-interactive-prompt detect+recover (master-table row #1). An
  // `AskUserQuestion` / arrow-menu rendered mid-turn deadlocks the REPL with no
  // keystroke path from chat; rather than let the inactivity watchdog KILL the
  // agent, this detector (footer + live `^❯` cursor + 2-tick stability + the
  // framework's doc-quote guard) trips the bounded escape→escape→ctrl-c recovery
  // ladder in `runOutputScan` (it carries no `keys` — recovery is a verify
  // ladder, never an auto-pick).
  session.scanner.register(createWedgedPromptDetector())
  // P1: auto-approve CC's tool-use permission prompt. BOTH cues required
  // (question + `❯ 1. Yes` selector) — single-cue matching false-fires on
  // scrollback. `1`+`enter` selects "Yes". The framework stamps the latch +
  // 5s debounce BEFORE returning the fired detection, so this keystroke is
  // fire-once per rising edge — a transport failure can NOT retry and risk a
  // DOUBLE-Enter onto the approval (output-scan.ts invariant §4).
  //
  // KNOWN LIMITATION (substrate-level, not specific to this detector): the F1
  // ring is an append-only byte log, so a just-approved prompt's text lingers
  // in the bottom-N window until enough new output scrolls it out. If a second
  // prompt renders with < bottomN lines of intervening output the latch may
  // still be up, so it won't see a fresh rising edge until the prior signature
  // clears. We deliberately do NOT mitigate in-detector: a tighter positional
  // window would MISS live prompts (the `❯ 1. Yes` selector sits ABOVE its
  // 2./3. option lines — the widened-window Wordsmith lesson), and a timed
  // re-fire would inject a stray `1`+enter into a live session. The proper fix
  // is substrate-level (a rendered-screen ring or latch-clear-on-fresh-data);
  // the P0 wedge-recovery detector (#1) is the backstop for a genuinely-stuck
  // prompt. Flagged by Codex cross-model review; tracked for the broader port.
  //
  // TASK 6 (T5 write-containment) — GATE this ONE detector behind
  // `disableToolUseAutoApprove`. A ritual write-containment REPL pairs
  // `skip_permissions: false` + a `permissions.deny` rule; leaving the
  // auto-approver ON would make the deny THEATER (CC renders the approval prompt,
  // this detector presses "Yes", the write succeeds). Disabling it makes the deny
  // load-bearing — the prompt (if any) is left for the WEDGED-PROMPT recovery
  // ladder (#1, registered above, ALWAYS on) so a genuine deadlock still
  // self-clears. Every OTHER detector stays unconditionally registered.
  if (options.disableToolUseAutoApprove !== true) {
    session.scanner.register({
      id: 'tool-use-approve',
      debounceMs: 5000,
      present: (ctx) =>
        TOOL_USE_QUESTION_RE.test(ctx.normalized) && TOOL_USE_SELECTOR_RE.test(ctx.normalized),
      keys: ['1', 'enter'],
    })
  }
  // P1: /rate-limit-options org-cap auto-stop (master-table row #4). When the
  // Claude org hits its monthly usage cap, CC injects an interactive picker that
  // blocks the REPL until an option is chosen. Ryan 2026-05-23 directive: "I need
  // you to handle when this pane appears. Just select stop and wait for limit to
  // reset." Option 3 = "Stop and wait for limit to reset", so `3`+`enter` selects
  // it (position-independent — pressing `3` highlights option 3 regardless of the
  // cursor's resting row).
  //
  // The positional bottom-30 guard (`RATE_LIMIT_OPTIONS_BOTTOM_N`) is LOAD-
  // BEARING and unique to this detector: pressing `3` STOPS CC, so NO new output
  // scrolls the picker text away afterward — it just sits in the ring until the
  // monthly cap resets. Without the bottom-N window the stale picker text would
  // satisfy `present` on every later tick and `select-stop` would re-inject
  // `3`+Enter into the dead input for days (the legacy harness PR #132 r1). Once CC has
  // stopped, idle whitespace / a shell prompt pushes the picker text up past the
  // bottom-30 threshold, which lets the detector correctly STOP firing. The
  // framework's bottom-N windowing (`buildDetectorContext`) provides this guard;
  // the latch + debounce-before-await make the `3`+enter fire-once per rising
  // edge (invariant §4) so a transport failure can't double-send.
  //
  // The the legacy harness "cheap viewport pre-check gates the recapture" lesson (Argus PR
  // #132 r3 BLOCKER — an unconditional `tmux capture-pane -S -100` was ~120 extra
  // captures/min) is architecturally obviated here: Neutron's ring is an
  // in-memory byte log, so the bottom-N read (`bottomNLines`) is already the
  // cheap viewport check — there is no separate scrollback recapture to gate.
  session.scanner.register({
    id: 'rate-limit-options-stop',
    bottomN: RATE_LIMIT_OPTIONS_BOTTOM_N,
    debounceMs: RATE_LIMIT_OPTIONS_DEBOUNCE_MS,
    present: (ctx) =>
      RATE_LIMIT_OPTIONS_RE.test(ctx.normalized) && RATE_LIMIT_STOP_RE.test(ctx.normalized),
    keys: ['3', 'enter'],
  })
  // P1: clear CC's compact-resume picker (the summary-vs-full menu shown when
  // resuming an auto-compacted session). EXACT-STRING match on one of the two
  // literal option labels — NOTHING broader. A prior broad
  // `summary+full+numbered` match fired on NORMAL conversation and injected
  // `2<Enter>` into live panes; the picker is ARROW-driven, not number-key, so
  // the action is `down`+`enter` (select "Resume full session as-is"), never a
  // digit. The framework stamps the latch + 5s debounce BEFORE returning the
  // fired detection, so this is fire-once per rising edge (invariant §4). The
  // append-only-ring back-to-back limitation noted on `tool-use-approve` applies
  // here too; the P0 wedge-recovery detector is the backstop.
  session.scanner.register({
    id: 'compact-resume-picker',
    debounceMs: 5000,
    present: (ctx) =>
      COMPACT_RESUME_SUMMARY_RE.test(ctx.normalized) || COMPACT_RESUME_FULL_RE.test(ctx.normalized),
    keys: ['down', 'enter'],
  })
  // P2: resume-session-failure picker safety net (master-table row #7). When
  // `--resume <stale-id>` is started against a session id that no longer exists,
  // CC drops into an interactive "Resume Session" picker that BLOCKS the REPL.
  // The hard-won lesson is ESCAPE-THEN-RECOVER, never BLIND-ANSWER: a stale
  // cached session_id must NOT silently spawn a fresh (empty-context) session
  // without a disk-recovery attempt + a user-visible "session lost" notice. This
  // detector carries NO `keys` (recovery is the escape-then-disk-scan ladder in
  // `dispatchResumePickerRecovery`, not a fire-once keystroke); it anchors on the
  // distinctive `Resume Session` title + the `Esc to clear` footer (which
  // distinguishes it from the AskUserQuestion `esc to cancel` menu detector #1
  // handles, so the two never collide). LARGELY OBVIATED by Neutron's JSONL-first
  // resume (`session-respawn.ts`/`session-validation.ts`), which avoids the picker
  // in the normal path — this is a pure safety net for if it ever appears.
  session.scanner.register(createResumePickerDetector())
  // P2: rate-limit / overload BANNER alert (master-table row #10). DISTINCT from
  // the `rate-limit-options-stop` detector above — that PRESSES `3` on the
  // interactive ORG-CAP picker; THIS passively notices the temporary / usage-cap
  // BANNER CC prints and edge-fires a NOTIFY-ONLY alert (no keystroke, no
  // auto-retry — those are row #4's job). One detector per severity, so the
  // framework's per-detector edge-latch IS the the legacy harness `${threadId}::${severity}`
  // latch: fire on absent→present, clear ONLY on present→absent. THIS is the fix
  // for the bug a pure time-dedupe caused — re-firing the alert HOURLY FOREVER on a
  // stale banner sitting in an idle pane. Guards: the framework's doc-quote strip +
  // bottom-30 window, plus the detector's own not-at-idle-prompt walk (which skips
  // bypass-permissions / "new task?" / box-drawing chrome so a retired 429 above
  // the chrome doesn't false-fire — book topic, 4 alerts 2026-05-15). Carries NO
  // `keys`; `runOutputScan` routes a fired banner to `dispatchRateLimitBannerNotice`.
  for (const severity of RATE_LIMIT_BANNER_SEVERITIES) {
    session.scanner.register(createRateLimitBannerDetector(severity))
  }
  // CLI AUTH-FAILURE signature (2026-07-24 dogfood). DISTINCT from the rate-limit
  // banner: that surfaces a transient/usage-cap LIMIT; this notices an INVALID /
  // EXPIRED CREDENTIAL (`OAuth access token is invalid` / `Please run /login` / a
  // 401·403 `API Error`) the `claude` child prints before going silent headless.
  // NOTIFY-ONLY (no `keys` — there is nothing to press): `runOutputScan` routes a
  // fire to `dispatchAuthFailureNotice`, which records the session's auth-invalid
  // state so the driver's timeout watchdog fails the turn as `auth_invalid` (a
  // reconnect prompt) instead of the useless generic freeze-timeout.
  // Scope the auth detector to the CURRENT turn's output (codex r3 BLOCKER fix): it
  // matches ONLY within `ring.textSince(turnOutputMark)` — the PTY text produced
  // since this turn's start — so a stale credential banner from a prior (recovered)
  // turn still sitting in the bottom-N window can't re-arm the latch + re-stamp
  // `authFailureAt` on a turn that froze for an unrelated reason. `turnOutputMark` is
  // undefined between turns → the closure returns '' → the detector is inert then.
  session.scanner.register(
    createAuthFailureDetector(() =>
      session.turnOutputMark === undefined ? '' : session.ring.textSince(session.turnOutputMark),
    ),
  )
}
