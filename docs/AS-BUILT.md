# AS-BUILT

Running log of what shipped, newest-first. One entry per delivered PR.

## PTY terminal-detection P2 — rate-limit / overload banner alert (notify-only, port row #10)

**What shipped.** A new module `runtime/adapters/claude-code/persistent/rate-limit-banner.ts`
+ two output-scan detectors (`id: 'rate-limit-banner-temporary'` /
`'rate-limit-banner-usage-cap'`) registered on every session's `OutputScanner` in
`persistent-repl-substrate.ts`, plus a `dispatchRateLimitBannerNotice` surface and an
`onRateLimitBanner` DI seam on `PersistentReplSubstrateOptions`. Ports Vajra's
`pane-scan-watchdog.ts decideRateLimitAlert` + `rate-limit-patterns.ts` (research
row #10) onto the F1/F3 substrate. **No feature flag — ON by default.**

**Spec-conformance.** SPEC row #10 = ring-detect the temporary/usage-cap banners
with doc-quote + bottom-30 + not-idle-prompt guards, EDGE-TRIGGERED per
`threadId::severity`, notify via the chat surface, carrying the idle-prompt
chrome-skip list. CURRENT wiring already handles the *interactive* org-cap picker
(`rate-limit-options-stop`, row #4, presses `3`) but nothing surfaced the *passive*
banner — the gap this closes. Distinct mechanism: this one is NOTIFY-ONLY, no
keystroke. **Out of scope (unchanged):** any keystroke / auto-action (row #4) and
auto-retry.

- **Patterns.** `temporary` (`Server is temporarily limiting requests`+`API Error`,
  `Overloaded`+`API Error`, `502 Bad Gateway`+`api.anthropic.com`) and `usage-cap`
  (`Claude usage limit reached`, `5-hour rate limit reached`, `usage limit. Please
  try again at`). All cues required on one line — bare "Rate limited"/"Overloaded"
  noise and an unrelated-host 502 do NOT match.
- **Edge-latch invariant.** The framework's per-detector edge-latch IS the Vajra
  `${threadId}::${severity}` latch — one detector per severity, fires absent→present,
  clears only present→absent. NEVER time-dedupe (the hourly-re-fire-on-stale-banner
  bug). Verified by a present→present→absent→present test (fire, hold across a
  simulated +1h tick, clear, re-fire).
- **Guards.** doc-quote (framework `stripDocQuotes`), bottom-30
  (`RATE_LIMIT_BANNER_BOTTOM_N`), and a box-border-tolerant not-at-idle-prompt walk
  that SKIPS bypass-permissions / "new task?" / `ctrl+…` / box-drawing chrome
  (book-topic false-alert, 2026-05-15). The `IDLE_PROMPT_PATTERN` is widened
  (`(?:\s|$)`) so a trailing-space-trimmed bare caret still reads as idle, and an
  `unboxLine` step tolerates the Ink TUI's `│ … │` box wrapping (◆
  ADAPTED-AT-BOUNDARY vs Vajra's tmux capture).
- **Surface.** NOTIFY-ONLY (no `keys`). `runOutputScan` routes a fired banner to
  `dispatchRateLimitBannerNotice` → active-turn channel push (if a turn is live) +
  stderr + the injected `onRateLimitBanner` seam (gateway wires real chat delivery;
  default = structured stderr notice).
- **Tests.** `rate-limit-banner.test.ts` (27): each temporary + usage-cap pattern
  fires once on the rising edge (via the REAL `OutputScanner`); cue-framing
  negatives; doc-quote (inline-backtick / fenced / diff-line) → no fire;
  edge-latch fire/hold/clear/re-fire; bottom-30 in/out of window; chrome-skip
  not-at-idle-prompt (retired-banner-above-idle-prompt → no fire, active-banner+chrome
  → fires); severity independence; notify-only (no `keys`); id⇄severity mapping. New
  suite green; full `persistent/` suite **462 pass / 0 fail** (with `runtime/node_modules`
  resolvable). `tsc -p runtime/tsconfig.json --noEmit` clean for the changed files
  (the only errors are pre-existing missing-dep resolutions in `dev-channel.ts` /
  `jwt-validator`, unrelated to this change).

## PTY terminal-detection P2 — resume-session-failure picker safety net (port row #7)

**What shipped.** On the merged F1/F2/F3 substrate (#54), a new output-scan
detector (`id: 'resume-session-picker'`) registered on every session's
`OutputScanner` in `persistent-repl-substrate.ts`, plus two new modules:
`resume-picker-detector.ts` (signature + escape-then-recover ladder) and
`session-disk-recovery.ts` (`findLatestResumableSession` — the Neutron analog of
Vajra's `findLatestSessionForTopic`). Closes master-table **row #7** (Vajra
`index.ts:1865` resume-session-failure handler).

**Why.** When `claude --resume <stale-id>` is started against a session id that no
longer exists, CC drops into an interactive **"Resume Session"** picker that
blocks the REPL. The hard-won lesson is **ESCAPE-THEN-RECOVER, never blind-answer**:
a stale cached `session_id` must NOT silently spawn a fresh, empty-context session
without a disk-recovery attempt + a user-visible "session lost" notice — blind-
picking an option throws away the user's context silently. This is **largely
obviated** by Neutron's JSONL-first resume (`session-respawn.ts` /
`session-validation.ts` / `session-capture.ts`), which avoids the picker in the
normal path; it ships as a **pure safety net** for if the picker ever appears.

**Spec-conformance diff.** SPEC row #7 describes the signature loosely as
`Resume Session` || `Enter to select` || `Esc to clear`. A bare OR over those
single phrases would false-fire (`Enter to select` is shared with the ordinary
AskUserQuestion footer that detector #1 handles). The shipped detector therefore
anchors on the **distinctive `Resume Session` title AND requires the distinctive
`Esc to clear` footer** — NOT the shared `Enter to select`. The AskUserQuestion
menu's footer is `Esc to cancel`, so requiring `Esc to clear` keeps the two
detectors strictly disjoint even for a live question whose title contains "Resume
Session" (Codex P2). CURRENT WIRING before this PR: JSONL-first resume
avoided the picker; nothing handled it if it DID appear (an unhandled picker would
wedge the REPL). THIS PR FIXES that gap. **Out of scope (by design):** changing
the JSONL-first resume path; auto-picking any picker option.

**How (escape-then-recover; invariants carried verbatim):**
- **Detect (`isResumeSessionPicker`).** Over the F3-windowed (bottom-40, doc-quote-
  stripped) normalized ring: require the `Resume Session` title (`/resumesession/i`)
  AND the **distinctive** `Esc to clear` footer (`/esctoclear/i`) — **NOT** the
  shared `Enter to select` (the AskUserQuestion footer carries that too). Requiring
  `Esc to clear` (the AskUserQuestion footer is `esc to cancel`) keeps the two
  detectors strictly disjoint even for a live question whose title contains "Resume
  Session" (Codex P2). The framework's **doc-quote guard** keeps a fenced /
  `>`-quoted / inline-backtick mention of "Resume Session" from firing.
- **Edge-latch (invariant §1).** The detector carries **no `keys`** (recovery is the
  multi-step ladder, not a fire-once keystroke); the framework fires it once per
  absent→present transition and re-arms on present→absent.
- **Recover (`runResumePickerRecovery`, dispatched by `dispatchResumePickerRecovery`,
  guarded by `session.resumePickerRecovering`).** Sends a **single `Escape`** (never a
  digit / Enter — the no-blind-answer invariant, asserted by tests), then scans disk
  via `findLatestResumableSession(cwd, projectsDir, { excludeSessionId })`. The scan
  reads `<projectsDir>/<dashifyCwd(cwd)>/*.jsonl` and returns the most-recently-
  modified transcript with ≥1 non-empty line (**JSONL-is-truth, invariant §5**;
  mirrors `validateAndPersistSessionId`'s ghost guard). The stale id this REPL was
  spawned under is excluded so it can't "recover" itself.
- **Surface + retry (actually moves the REPL onto the recovered session, durably — Codex P1/P2).**
  A hit uses TWO mechanisms. **(in-memory)** records the recovered id on
  `session.pendingResumeSessionId` and **poisons** the warm child that just escaped
  the picker (it is contextless); `getOrSpawnSession` does NOT re-read
  `resolveResumeDirective` while an unpoisoned warm child is alive, so the poison
  makes the next turn evict + respawn with `pendingResumeSessionId` carried as the
  `forceResume` directive (a new `evictedResume` capture, hoisted ABOVE the
  alive/exited branch split so it also covers a poisoned child that exited before the
  next dispatch). **(durable)** also `patchRecord`s the registry to the recovered id
  — the in-memory flags are LOST if this child exits before the next dispatch (the
  pool drops the session on `child.exited`), so the crash/watchdog respawn, which
  reads the registry not the session, must see the recovered id or it re-`--resume`s
  the stale id and reopens the picker (Codex P2). `spawnSession`'s own flag-aware
  registry write covers the reverse ordering (recovery finishing before that write);
  together every ordering converges on the recovered id. The current in-flight turn
  finishes on the fresh child; the notice tells the user the recovered context is
  **active from their next message**. A **miss** (nothing on disk) surfaces a
  "session lost — starting fresh" notice + one operator alert AND fires
  `onNoRecovery`, which (in-memory) sets `session.forceFreshRespawn` + poisons so the
  next turn evicts + respawns with resume FORCED OFF (a new `evictedForceFresh`
  branch) AND (durable) `patchRecord`s the registry `has_session: false` now — the
  stale `--resume` id `spawnSession` persisted would otherwise reopen the picker on a
  later crash/watchdog respawn even if this child exited first. Breaking the
  stale-resume loop both live and across a crash (Codex P2). Spawn-time
  notices route through `ReplSession.pushNotice` (buffered until the
  first live turn, since the picker fires before `start()` assigns `activeTurn`) and
  drained by `flushPendingNotices` — Codex P2: a direct `activeTurn?.channel.push`
  would have silently dropped the notice. Transcript root is resolved by the shared
  `resolveTranscriptProjectsDir` (`projectsDir` → `CLAUDE_CONFIG_DIR/projects` →
  `~/.claude/projects`) so an isolated-config session's JSONL is found (Codex P2).
  Debounce/latch stamped before the keystroke write (fire-once, invariant §4).

**Tests.** `__tests__/resume-picker-detector.test.ts` (18) — full-picker fires;
missing title / `Enter to select`-only (no `Esc to clear`) / a live AskUserQuestion
whose TITLE contains "Resume Session" but footer is `esc to cancel` all do NOT fire
(no collision with #1, Codex P2); fenced / `>`-quoted / inline-backtick doc-quote
guards; edge-latch fires-once / holds-while-present / re-arms on absent; recovery
sends EXACTLY `['escape']` (no digit/Enter in any outcome); recovered → notice +
`requestResume` + NO miss callback; none-found → "session lost" notice + alert +
`onNoRecovery`. `__tests__/session-disk-recovery.test.ts` (8) — null on missing dir
/ no transcripts; picks newest mtime; skips empty/whitespace ghosts; ignores
non-jsonl; excludes the stale id; null when only the excluded id remains. Full
`persistent/` suite **381 pass / 0 fail** (38 files; the higher count vs the row-#7
branch base is the rebased-in row-#6 channel-wedge tests). `tsc --noEmit` clean for
the changed files.

**Additive edit.** The registration is purely additive (one new `register` block
after `compact-resume-picker` + one new branch in `runOutputScan`) plus two new
files; the only edits to existing flows are the shared `resolveTranscriptProjectsDir`
helper (also adopted by the API-5xx watcher site), the `pushNotice`/`flushPendingNotices`
buffer, and the `evictedResume`/`evictedForceFresh` resume-resolution branches. All existing `register({})`
blocks left intact with their own closers.

## Per-turn API-5xx dead-turn notifier (JSONL watcher, port row #11)

**What shipped.** A new JSONL watcher,
`runtime/adapters/claude-code/persistent/api5xx-dead-turn-watcher.ts`, that
detects a mid-turn API 5xx aborting the agent's turn before it ever calls
`reply()` and edge-fires a "resend your last message" retry notice. Closes
master-table **row #11** (Vajra `session-error-watcher.ts` +
`pane-scan-watchdog.ts ADDENDUM`). Builds on F1/F2/F3 (#54) and reuses the #57
JSONL byte-range read pattern + the `<projectsDir>/<dashifyCwd(cwd)>/<sessionId>.jsonl`
layout (`session-validation.ts`) rather than duplicating that machinery.

**Why.** A mid-turn `Overloaded` / `internal_server_error` / `rate_limit_error`
aborts the turn BEFORE `reply()`, so the substrate's `completion` never resolves
and the user sees nothing — the turn dies silently (Ryan 2026-06-16). The
PTY-ring detectors key off live TUI signatures, the #57 stuck-turn watcher keys
off an unanswered real-user turn going stale, and the wedge-detector keys off
process liveness / HTTP — none catch a turn the model started but a 5xx killed.

**How (a JSONL watcher, NOT a ring scan — the brief's mandate; disk is the source
of truth, invariant §5):**
- `startApi5xxDeadTurnWatcher` `fs.watch`es the JSONL's **parent directory**
  (survives the file not existing yet / a resume re-creating it); each change
  pumps the bytes appended since the last read into `Api5xxDeadTurnCore`.
- `classifyApi5xxRecord` (pure) tests the verbatim regex
  `/Overloaded|overloaded_error|rate_limit_error|internal_server_error/` ONLY
  against `result` / `system` / `error` records (allowlist, invariant §3) —
  `type:"user"` and `tool_result` records are ignored entirely so a tool echoing
  "overloaded" never trips it.
- `Api5xxDeadTurnCore.feed` buffers a trailing partial line until its newline
  lands, so a record split across two `fs.watch` callbacks is reassembled
  (invariant §4).
- Edge-latch (invariant §1): fires ONCE on the rising edge, does NOT re-fire
  while latched, clears on a later healthy considered-record; the latch is
  stamped before the notify side-effect so notify is fire-once even if it throws.
- **Surface / wiring (ON by default, NO feature flag):** the rising edge calls the
  injected `onDeadTurnNotice` sink (runtime→gateway DI seam mirroring
  `onRecoveredReply` / `postWedgeAlert`), defaulting to a structured stderr notice.
  The watcher is started per session right after the child spawns
  (`persistent-repl-substrate.ts` — sessionId + cwd known → path resolves) and
  stopped on child death. **Out of scope:** auto-resend of the stored message.

**Tests.** `__tests__/api5xx-dead-turn-watcher.test.ts` (26 tests): the five
brief-mandated assertions (result+overloaded_error FIRES; `type:"user"`+overloaded
does NOT; tool_result echo does NOT; record split across two callbacks
reassembled+matched; edge-latch fires-once / no-re-fire-while-present / clears on
absent) plus classify, the `fs.watch` driver (injected fs), rotation/truncation,
a throwing-sink case, `realReadFrom` offset reads, and a real-fs end-to-end. New
file suite green; full `persistent/` suite 335 pass (the one
`dev-channel-exit-on-close` failure is a pre-existing, change-independent
subprocess-exit timing flake on origin/main — confirmed failing with this PR's
changes stashed). `tsc --noEmit` clean for the changed files.
## PTY terminal-detection P2 — session-size watchdog + compact affordance (port row #13)

**What shipped.** `runtime/adapters/claude-code/persistent/session-size-watchdog.ts`
— a warm/persistent session-size watchdog that measures the **post-compact**
transcript-JSONL size on a 5-min cadence and surfaces a Reset/Compact affordance
before the session grows large enough to block `claude --resume`. Port of Vajra's
`session-size-watchdog.ts` (research row #13). Closes the gap that
`reset_context_per_turn` (`/clear`) only caps growth on the import path — a
conversational REPL had **no** size monitor and could grow until `--resume` is
refused and the session falls into an infinite restart loop (Vajra 2026-04-16:
the "tax topic" hit 11.8 MB).

- **THE LOAD-BEARING LESSON — POST-COMPACT size, never raw `stat.size`.**
  `measurePostCompactBytes(buf)` returns the bytes **after the last record
  carrying `"isCompactSummary":true"`** — a byte-accurate `Buffer.lastIndexOf`
  scan (operates on a `Buffer`, not a decoded string, so it's correct across
  multi-byte UTF-8 and never decodes a multi-MB file). `/compact` does NOT shrink
  the file on disk (CC appends a summary record and keeps writing), so a raw-size
  watchdog would warn → user compacts → raw size barely moves → warn re-fires
  forever ("Compact does nothing"). The post-compact region is the only signal
  that drops when a compaction actually helps. (The merged stuck-turn reader's
  256 KB tail reader is unsuitable here: the marker can sit megabytes before the
  tail — that distance IS the warn condition — so a full-file marker scan is
  required, not a duplicate of the tail helper.)
- **PreCompact lock.** A compaction in flight momentarily looks huge (the
  pre-summary turn is appended before the marker lands). The watchdog holds a
  mid-compact lock from when **it** actuates a compaction until the post-compact
  size drops below the warn band (the summary landed), and **skips all alerting**
  while held — no spurious per-compaction warn.
- **Codex review fix (P2) — the lock can never permanently silence the watchdog.**
  Codex flagged that clearing the lock ONLY on `size < 5 MB` would deadlock the
  watchdog if a post-compaction region legitimately stays ≥5 MB (a genuinely
  large session) or the actuated `/compact` failed: `compacting` would never
  clear, so all future alerts are suppressed and `requestCompact` always returns
  false. Fixed by adding a `compactLockMaxMs` (2 min) timeout completion signal —
  the lock auto-clears past the window even with a huge size, and the latch reset
  re-surfaces the affordance. A second Codex pass noted the timeout was only
  checked in `tick()` (5-min cadence), so a user pressing Compact after the 2-min
  max lock but before the next tick still hit the stale `compacting` guard;
  `requestCompact` now clears a timed-out lock on the press itself so the max-lock
  window actually bounds the affordance lockout. `session-size-watchdog.test.ts`
  (+2, now 23) pins the timeout-clear-then-re-fire path (via tick + via press).
- **Tiered edge-latch** (`SessionSizeTracker`, cross-cutting invariant §1): warn
  fires once entering ≥5 MB, critical once entering ≥10 MB (incl. a warn→critical
  escalation); the latch clears on shrink so re-entry re-fires. Never
  time-dedupe.
- **Compact action** = `writeKey('escape')` THEN `write('/compact\r')`,
  fire-once — the lock + 30s debounce are stamped **before** the writes (invariant
  §4) so a transport failure can't double-`/compact`. It is a **surfaced
  affordance the user presses** (`requestSessionCompact(sessionKey)` → the live
  session's `sizeWatchdog.requestCompact()`), never silent/automatic.
- **Wiring.** `startSessionSizeWatchdog` is started in `getOrSpawnSession` right
  after the post-spawn assertion passes (`session.sizeWatchdog`), reads the size
  via `measurePostCompactSize(sessionJsonlPath(sessionId, cwd, projectsDir))`,
  surfaces via `surfaceSizeAlert` (active turn channel + operator stderr log + the
  injected `options.onSizeAlert` hook), and is stopped on child exit + every
  teardown path (dispose / shutdown / pool-walk). The cadence timer is `unref`'d.
  **No feature flag** — on by default; `sizeCheckIntervalMs` only tunes the
  cadence.
- **Tests.** `session-size-watchdog.test.ts` (21): post-compact measurement
  incl. the huge-raw-file-small-post-compact case, multi-marker, multi-byte
  byte-accuracy, absent-file null; tiered latch (warn once / clears on shrink /
  critical escalation / de-escalation); tick wiring; the escape-then-`/compact\r`
  fire-once + mid-compact-lock + debounce. `session-size-watchdog-wiring.test.ts`
  (3): a real fake-host spawn with a pre-seeded ≥5 MB transcript surfaces a warn
  via `onSizeAlert`, and `requestSessionCompact` actuates escape+`/compact\r`
  fire-once on the live child. Full `runtime/` suite green (965).

## PTY terminal-detection P1 — /rate-limit-options org-cap auto-stop (port row #4)

**What shipped.** On the merged F1/F2/F3 substrate (PR #54), a third output-scan
detector (`id: 'rate-limit-options-stop'`) registered on every session's
`OutputScanner` in `persistent-repl-substrate.ts` auto-stops CC's
`/rate-limit-options` org-monthly-cap picker. Port of Vajra's
`pane-scan-watchdog.ts decideRateLimitOptionsAction` (research row #4). Ryan
2026-05-23 directive: "I need you to handle when this pane appears. Just select
stop and wait for limit to reset."

- **Detect — BOTH cues required, in the bottom-30.** Fires only when the
  normalized (whitespace-stripped) `bottomN: 30` view contains the slash command
  (`/\/rate-limit-options/i`) **AND** option 3's verbatim text
  (`/stopandwaitforlimittoreset/i`). A single cue (a conversational mention or a
  doc quote of the command) must not trip it.
- **Action.** `writeKey('3')` then `writeKey('enter')` (`keys: ['3','enter']`) on
  the rising edge — selects "Stop and wait for limit to reset". `'3'` is
  position-independent: pressing it highlights option 3 regardless of the
  cursor's resting row.
- **Positional bottom-30 guard is LOAD-BEARING.** Pressing `3` STOPS CC, so NO
  new output scrolls the picker text away afterward — it just sits in the ring
  until the cap resets. Without the bottom-N window the stale picker text would
  satisfy `present` on every later tick and `select-stop` would re-inject
  `3`+Enter into dead input for days (Vajra PR #132 r1). Once CC has stopped,
  idle whitespace / a shell prompt pushes the picker text up past the bottom-30
  threshold, which lets the detector correctly STOP firing. The F3 framework's
  `buildDetectorContext` bottom-N windowing provides this guard.
- **Fire-once / no double-press.** `debounceMs: 60_000` floor (Vajra
  `RATE_LIMIT_OPTIONS_DEDUPE_MS`); the F3 framework stamps the latch + last-fire
  BEFORE returning the fired detection, so a transport-failed keystroke write can
  NOT retry next tick and double-send `3`+Enter (cross-cutting invariant §4).
- **Doc-quote guard (free from F3).** `stripDocQuotes` drops fenced/diff/bullet
  lines and blanks inline-backtick spans before `present` runs, so a markdown
  brief or backtick-quoted mention of the command never fires the auto-press.
- **Viewport pre-check lesson — architecturally obviated.** Vajra's Argus PR #132
  r3 BLOCKER added a cheap viewport pre-check to gate an unconditional
  `tmux capture-pane -S -100` (~120 extra captures/min). Neutron's ring is an
  in-memory byte log, so the bottom-N read (`bottomNLines`) IS the cheap viewport
  check — there is no separate scrollback recapture to gate.
- **Tests.** `output-scan.test.ts` (+1, now 17): both-cue bottom-N frame →
  `3`+`enter`; doc-quoted slash (inline-backtick and fenced) does NOT fire;
  single-cue conversational mention does NOT fire; debounce stamped before await
  (same-frame retry does not re-fire; re-arm within 60s suppressed, past 60s
  fires). `tsc` clean — 21 pre-existing repo errors, zero new in touched files
  (verified by applying the diff onto a fully-installed checkout; a bare worktree
  reports inflated counts because workspace `@neutronai/*` packages aren't linked).
- **Additive edit.** The output-scan registration is purely additive (new
  constants + one `register` block) to limit conflict with sibling detector PRs.
- **Codex cross-model review (P2, deliberate tradeoff — NOT mitigated).** Codex
  flagged that the 2-cue predicate could fire on live, non-doc-quoted terminal
  prose that happens to contain BOTH `/rate-limit-options` and the verbatim
  `Stop and wait for limit to reset` within the bottom-30, and suggested
  requiring a menu-selector cue (e.g. `❯ 3.`) like the tool-use detector's
  `❯ 1. Yes`. We deliberately do NOT add that anchor: the tool-use detector can
  require `❯ 1. Yes` because option 1 is ALWAYS the default-highlighted row, but
  the cursor does NOT default to option 3 here (that is exactly why `'3'` is
  pressed position-independently), so an `❯ 3.`-anchored cue would FALSE-NEGATIVE
  whenever the cursor rests on another option — leaving the REPL wedged at the
  org cap, the precise failure this detector exists to prevent. The exact Ink
  picker bytes are also unverified end-to-end in the PTY substrate (research-doc
  caveat), so tightening on an unobserved adjacency trades a vanishingly-rare
  false-positive (verbatim CC option-3 copy in live unquoted prose, debounced
  60s, at worst one stray `3`+enter) for a much costlier false-negative. The
  production-hardened Vajra reference (`decideRateLimitOptionsAction`) made the
  same call: 2 cues + doc-quote + bottom-N, no option-number cue. Honoring the
  spec + Vajra precedent; tracked as a known residual if a live spawn ever
  confirms the picker reliably renders `3.` adjacent to the stop text.
## PTY terminal-detection P1 — compact-resume picker (port row #3)

**What shipped.** On the merged F1/F2/F3 substrate (PR #54), a third output-scan
detector (`id: 'compact-resume-picker'`) registered on every session's
`OutputScanner` in `persistent-repl-substrate.ts` clears CC's compact-resume
picker — the summary-vs-full menu shown when resuming an auto-compacted session.
Port of Vajra's `gateway-core.ts isCompactResumePicker` (research row #3).

- **Detect — EXACT STRING ONLY.** Fires when the normalized bottom-N view
  contains either literal option label: `Resume from summary (recommended)`
  (`/resumefromsummary\(recommended\)/i`) **OR** `Resume full session as-is`
  (`/resumefullsessionas-is/i`), carried in whitespace-free form because Ink
  shreds each word across cursor-move escapes. **No broader match.** The hard-won
  lesson: a prior broad `summary+full+numbered` fallback fired on NORMAL
  conversation and injected `2<Enter>` into live panes. Exact-string only.
- **Action — arrow-driven, NOT number-key.** `writeKey('down')` then
  `writeKey('enter')` (`keys: ['down','enter']`) on the rising edge — the picker
  is arrow-driven, so the spawn-loop path is `Down`+`Enter`, never a digit.
- **Fire-once / no double-keystroke.** `debounceMs: 5000` floor; the F3
  framework stamps the latch + last-fire BEFORE returning the fired detection, so
  a transport-failed write can NOT retry next tick and double-send `down`+`enter`
  (cross-cutting invariant §4).
- **Tests.** `output-scan.test.ts` (+1, now 17): exact-label frame → `down`+`enter`;
  the full-session label alone also fires; NORMAL conversation prose mentioning
  "resume"/"summary"/"full session"/numbered options does NOT fire; debounce
  stamped before await (same-frame retry does not re-fire; re-arm within 5s
  suppressed, past 5s fires). `tsc` clean (no new errors in touched files vs
  baseline).
- **Known limitation (shared substrate).** The append-only-ring back-to-back
  limitation documented on `tool-use-approve` applies here too; the P0
  wedge-recovery detector (#1) is the designed backstop for a genuinely-stuck
  picker.
## PTY terminal-detection P1 — channel-MCP-unwired fast-fail (port row #6)

**What shipped.** A fourth post-spawn-assertion stage that fast-fails a spawn
which came up `/health`-200 but never bound its dev-channel MCP — the
**channel-MCP-unwired wedge**. Port of Vajra's `fleet-spawn-core.ts
isChannelMcpUnwired` onto the F1/F3 substrate (research row #6). On the merged
F1/F2/F3 substrate (PR #54) + post-spawn-assertion path. ON by default — no flag.

- **The wedge.** After the dev-channel confirm is answered and the TUI is up, the
  REPL sometimes never binds the channel MCP under spawn-time memory/CPU pressure;
  `/health` still returns 200 (spawn LOOKS alive) but every `reply()` prints
  **"no MCP server configured with that name"** and the turn never delivers
  (2026-06-20: 17/23 wedged forge/argus spawns showed exactly that as their last
  frame). Root cause = pressure, not timeout tuning → the fix is an explicit
  signature + **fast-fail**, not a longer wait.
- **Detect (`channel-unwired-detector.ts`).** Pure signature
  (`/noMCPserverconfiguredwiththatname/i`, normalized bottom-24) run through the
  F3 `buildDetectorContext`, so the **doc-quote guard** keeps a fenced /
  backtick-wrapped / diff-quoted quotation of the phrase from false-firing. NO
  keystroke — detect → fast-fail → bounded respawn only.
- **Re-read AFTER health-up (invariant §7, load-bearing).** `post-spawn-
  assertion.ts` Stage 4 re-captures the ring **FRESH** strictly after the
  `/health` gate flips (a stale pre-health snapshot could read `!unwired` and let
  a same-tick-unwired channel through). The signature must **persist** across a
  short confirm grace (default 2s — a spawn-path window, not the 60s topic
  readiness grace) before fast-failing `channel-wedged`; a `null`/failed
  re-capture counts as NOT-unwired so a glitch can't fail a healthy spawn. Stage 4
  is skipped when no ring reader is wired (back-compat for the existing tests).
- **Bounded respawn (`channel-wedge-respawn.ts`, invariant §6).** A
  `channel-wedged` assertion throws a typed `ChannelWedgedSpawnError`;
  `getOrSpawnSession` wraps the spawn in `runBoundedChannelWedgeRespawn` — retry up
  to **`MAX_FLEET_RESPAWNS = 2`**, then **one** operator alert (`postWedgeAlert`)
  and give up (no infinite loop). Any OTHER spawn failure propagates on the first
  attempt; the channel-wedged path doesn't `pool.delete` (the wrapper owns the
  pool entry across retries), so a successful retry keeps its warm session.
- **Tests** (`channel-unwired-detector.test.ts` +7, `channel-wedge-respawn.test.ts`
  +5, `post-spawn-assertion.test.ts` +8): unwired signature after health-up →
  `channel-wedged`; same phrase doc-quoted (backtick/fence/diff) → does NOT fire;
  healthy bound channel → does NOT fire; re-read happens only AFTER health
  (ordering); null re-capture + transient-clears-within-grace → ok; respawn capped
  at 2 then alert-only; non-wedged failure propagates with no retry/alert. Full
  persistent suite green (327 pass).
## PTY #20 — disk-JSONL recovery classifier + restart-rate crash-loop guard

**What shipped.** The two remaining pieces of Vajra master-table row #20
(`disk-recovery.ts` + `restart-rate.ts`). The pending-respawns queue
(`pending-respawns-queue.ts`), `registry-lock.ts`, and the `drainPendingRespawns`
boot-drain were already merged (rows #11/#12); this build adds ONLY the two
missing pieces and a focused test pinning the behaviour. Encodes the 2026-05-21
"pristine" incident lesson: **disk JSONL is the source of truth; never rely on a
surviving in-memory timer for recovery.**

- **Verify-first gap analysis.** SPEC row #20 wants (a) classify a failed-probe /
  pending entry resumable from JSONL, and (b) a restart-rate <5min crash-loop
  guard. Read confirmed the queue + boot-drain + flock-lock are PRESENT (the
  boot-drain already recovers a disk-persisted entry with no surviving timer);
  `validateAndPersistSessionId` was only a **binary JSONL-existence gate**, not an
  mtime/last-real-turn classifier; and there was **no** restart-rate guard (the
  per-`sessionKey` `RESPAWN_CAP_MAX` 3/hr cap is a different mechanism). Built the
  two missing pieces; did not rebuild the queue/lock/drain.
- **`disk-recovery.ts` (NEW).** Pure `classifyResumable` over disk metadata →
  `no-jsonl` / `empty` / `no-real-turn` (true ghost) vs `live` (RESUMABLE) vs
  opt-in `stale`; `readSessionJsonlMeta` (fs-injectable) scans the transcript for
  *real* conversational turns (user/assistant `message` lines; summary/system
  meta don't count) + last-turn timestamp + mtime. Wired into
  `drainPendingRespawns`: an unregistered pending entry is now classified from
  disk and the result carries `resumable`, so a recoverable topic is observably
  retained, not silently dropped. No `maxAgeMs` cutoff by default (disk is truth).
- **`restart-rate.ts` (NEW).** Each watchdog boot appends a marker to
  `<home>/.neutron/.restart-markers.json`; two markers <5min apart
  (`CRASH_LOOP_WINDOW_MS`) = crash loop. Pure `evaluateRestartRate` applies an
  **edge latch** (`inCrashLoop`) so the warning fires EXACTLY ONCE on the
  absent→present edge (via `postAlert` or stderr) and re-arms only after a
  normally-spaced restart clears it. Wired into `startReplWatchdog`'s boot path
  next to the boot-drain; best-effort (never blocks startup).
- **Wiring.** `restartMarkersPath` added to `PersistentReplSubstrateOptions` +
  `ReplSupervisionPaths` (`deriveReplSupervisionPaths` →
  `.restart-markers.json`) + threaded in `createClaudeCodeSubstrateAuto`.
- **Tests.** `restart-rate.test.ts` (16) + `disk-recovery.test.ts` (12): the
  three acceptance cases — a disk-persisted entry recovered on a simulated boot
  with NO surviving timer; a failed-probe entry with a live JSONL classified
  resumable; restart markers <5min apart warn exactly once (edge-latched) + the
  latch clears + re-arms. Existing `repl-supervision.test.ts` ghost-skip
  assertion updated for the additive `resumable` field (a no-JSONL ghost →
  `resumable: false`). 336 in-process persistent tests pass; the lone failure
  (`dev-channel-exit-on-close`) is a bare-worktree node_modules-resolution
  artifact that fails identically on unmodified `main` in a worktree and passes
  from the repo root where CI runs.
- **No flags.** Built ON as the default — no toggle, no dual path.

## PTY terminal-detection P1 — auto-approve tool-use prompt (port row #2)

**What shipped.** On the merged F1/F2/F3 substrate (PR #54), a second
output-scan detector (`id: 'tool-use-approve'`) registered on every session's
`OutputScanner` in `persistent-repl-substrate.ts` auto-approves CC's tool-use
permission prompt. Port of Vajra's `gateway-core.ts isToolUsePrompt` +
`pane-scan-watchdog.ts decideAutoApproveAction` (research row #2).

- **Detect — BOTH cues required.** Fires only when the normalized bottom-N view
  contains the question (`/doyouwantto(makethisedit|proceed|runthiscommand|create)/i`,
  the spec regex carried in whitespace-free form because Ink shreds each word
  across cursor-move escapes) **AND** the `❯ 1. Yes` selector (`/❯1\.yes/i`).
  Single-cue matching false-fires on lingering scrollback (a prior approval's
  selector with no live question).
- **Action.** `writeKey('1')` then `writeKey('enter')` (`keys: ['1','enter']`)
  on the rising edge — selects "Yes".
- **Fire-once / no double-Enter.** `debounceMs: 5000` floor; the F3 framework
  stamps the latch + last-fire BEFORE returning the fired detection, so a
  transport-failed keystroke write can NOT retry next tick and DOUBLE-Enter onto
  the approval (cross-cutting invariant §4).
- **Why it's needed.** These prompts render even under
  `--dangerously-skip-permissions` for key-to-kingdom paths (`.git/hooks/*`,
  writes outside the project root), so the substrate must clear them itself.
- **Tests.** `output-scan.test.ts` (+1, now 16): both-cue frame → `1`+`enter`;
  selector-only and question-only do NOT fire; debounce stamped before await
  (same-frame retry does not re-fire; re-arm within 5s suppressed, past 5s
  fires). `tsc` clean (no new errors in touched files vs baseline).
- **Known limitation (Codex cross-model review, tracked).** The F1 ring is an
  append-only byte log, so a just-approved prompt's text lingers in the bottom-N
  window until new output scrolls it out. If a second prompt renders with
  < bottomN lines of intervening output, the latch can stay up and the second
  prompt won't auto-approve until the prior signature clears. This is inherent to
  the F1 raw-ring + F3 edge-latch substrate (#54) — every content detector shares
  it; the disclaimer escapes only by firing once at spawn. Not mitigated
  in-detector on purpose: a tighter positional window would MISS live prompts
  (the `❯ 1. Yes` selector sits above its 2./3. option lines), and a timed
  re-fire would inject a stray `1`+enter into a live session. Proper fix is
  substrate-level (rendered-screen ring or latch-clear-on-fresh-data); the P0
  wedge-recovery detector (#1) is the designed backstop for a genuinely-stuck
  prompt.
## Stuck-turn watchdog keys off JSONL turn-progress, not `last_event_at` (Vajra P1 port)

**What shipped.** The agent-aware watchdog (`runtime/subagent/watchdog.ts`) now
detects the "port probe lied — turn actually wedged" class. Ports the hard-won
lesson from Vajra `stuck-turn-watchdog.ts` (incident 2026-04-21): a CC turn
wedged 3+ min while its `/health` port probe still answered OK, its JSONL
filling with only `system`/`queue-operation` records — *port probes lie; the
transcript JSONL is the source of truth for whether a turn advanced*. Builds on
the merged F1/F2/F3 PTY substrate (#54).

- **The gap.** `runAgentWatchdog` keyed `stuck` off `rec.last_event_at` alone.
  But `registry.update()` refreshes `last_event_at` to `now()` on EVERY patch,
  so any heartbeat / status touch / queue bookkeeping kept it fresh while the
  turn was wedged — a heartbeat could mask a wedge forever. (The spec-conformance
  diff: the watchdog only ever consulted the in-memory clock, never the JSONL.)
- **The fix (`watchdog.ts`).** Added an injectable `turn_progress_at(rec)` probe.
  When wired and reporting a timestamp it is AUTHORITATIVE: `last_event_at` is
  ignored for the staleness calc (so a heartbeat can't keep a wedged turn looking
  alive), `age_ms` reflects true JSONL staleness, and the surfaced event records
  the overriding `turn_progress_at`. Unwired / `null` (no transcript, in-process
  `core` agent) falls back to `last_event_at` — legacy behaviour preserved.
  `process_dead` still takes precedence.
- **The reader (`turn-progress.ts`, new).** Pure + injectable, mirroring Vajra:
  `isRealTurnEvent` (progress = `assistant` output or genuine `user`/`tool_result`
  activity; `system`/`queue-operation`/meta excluded), `parseTailForLastTurnProgress`
  (string→latest progress ms + earliest-event floor, truncated-head safe),
  `realReadJsonlTail` (256 KB tail, never throws), and `makeJsonlTurnProgressProbe`
  (composes them behind a caller-supplied `resolveTranscriptPath`, keeping the
  watchdog free of the cwd/projects-dir knowledge the registry doesn't carry).
  A readable transcript whose tail holds only noise (the real progress record
  scrolled out of the 256 KB window) reports the earliest-event floor, NOT null,
  so a long wedge can't evade detection by ageing its progress out of the tail
  (Codex P2). Production wiring (the gateway's `resolveTranscriptPath`) needs the
  child cwd, which the in-process S3 registry doesn't yet carry — deferred to the
  SQLite-backed S4 registry; the probe already flows through `runLifecycleTick`
  untouched, so it's a config change then, not a watchdog change.
- **Tests.** `watchdog.test.ts` (15, +4): stale-JSONL + heartbeat-fresh
  `last_event_at` + live process → flagged; JSONL-progressing + stale
  `last_event_at` → not flagged; null probe → falls back to `last_event_at`;
  `process_dead` precedence holds when JSONL looks fresh. `turn-progress.test.ts`
  (new, 15): filter rules, wedged-vs-progressing tails, earliest-floor / empty /
  noise-only cases, truncated head, real-fs tail read, probe composition.
  `subagent.test.ts` +1: the probe flows through `runLifecycleTick`. `tsc
  --noEmit` clean; `runtime/subagent` suite green (58).

## GBrain memory auto-upgrade + doctor (the cc-update-doctor analogue)

**What shipped.** `gbrain-memory/gbrain-doctor.ts` — a deterministic, NO-LLM
engine that keeps the GBrain memory binary CURRENT and VERIFIED, modeled on
Vajra's `cc-update-doctor`. Closes the follow-on gap from PR #51: `ensure_gbrain`
pinned an UNPINNED default-branch snapshot with no upgrade path and no health
check.

- **DOCTOR — `neutron doctor`.** Verifies gbrain WORKS, not just exists: binary
  on PATH, `gbrain --version` responds, AND a real memory **round-trip**
  (connect → `put_page` → `list_pages` read-back) through the production
  `GBrainStdioMcpClient` → `GBrainMemoryStore` against an ephemeral throwaway
  brain. Catches the present-but-broken case.
- **AUTO-UPGRADE — `neutron doctor --upgrade`.** `git ls-remote` the upstream
  HEAD, re-install only when it advanced (IDEMPOTENT), pinned to the resolved
  commit (`github:garrytan/gbrain#<sha>`) for reproducibility, then VERIFY and
  ROLL BACK a broken upgrade to the recorded ref. State in
  `<NEUTRON_HOME>/gbrain-doctor.json`.
- **Host-level cadence, never in-process** (preserves the notify-only doctrine
  in `version-notice.ts`): `install.sh` schedules `neutron doctor --upgrade`
  daily via `neutron-service.sh install-doctor` (launchd `StartInterval` /
  systemd `.timer`), opt-out aware (`--no-gbrain`), best-effort. `bin/neutron
  doctor` added to the CLI; `uninstall.sh` tears the schedule down.
- **Tests.** `gbrain-memory/__tests__/gbrain-doctor.test.ts` (24): working-vs-
  broken detection, idempotent upgrade, install-failure preserves old ref,
  broken-upgrade rollback. `tsc` clean; `gbrain-memory` suite green (88).

## Parity gap #1 (P0) — installer self-installs the GBrain memory binary

**What shipped.** `install.sh#ensure_gbrain` provisions Neutron's real memory
substrate so a fresh self-host has knowledge-graph + semantic recall out of the
box. The runtime (`gbrain-memory/`) spawns `gbrain serve` over stdio MCP; before
this change `install.sh` had ZERO gbrain references, so the binary was never on
PATH and memory degraded SILENTLY to on-disk entity pages. Closes gap #1 of the
2026-06-25 Vajra→Neutron parity audit.

- **Default install** in the Dependencies phase: `bun install -g
  github:garrytan/gbrain` (canonical README path; `NEUTRON_GBRAIN_REF` overrides
  the ref). **Idempotent** — an already-present `gbrain` is detected, not
  reinstalled.
- **Non-fatal + LOUD on failure** (the audit's core requirement: never silently
  degrade). A failed/unresolvable install reports the gap — `Memory: DEGRADED`
  in the final banner + the exact `bun install -g …` recovery command — and
  continues; the runtime's graceful-degradation path is preserved.
- **Opt-out** via `--no-gbrain` / `NEUTRON_SKIP_GBRAIN=1`.
- Pure installer + docs + test change; the memory runtime is untouched (its
  degradation logic already existed and was correct).
- **Tests** — `tests/integration/install-gbrain.test.ts`, 7 cases over the new
  `NEUTRON_INSTALL_PRINT_GBRAIN` seam (no network; injected install command).
  7 pass / 0 fail; `install-auth-gate.test.ts` still 8/8.

## WAVE 3 — Email Core: thread read (`email_thread`) + doc reconciliation

**What shipped.** The Email-Managed Core (`cores/free/email/`) gained the
conversation-level READ surface it was missing. The Core already shipped
read (`email_list` / `email_read` / `email_search`), summarize, triage,
draft, and send — but there was no way to read a whole Gmail *thread*. The
WAVE 3 acceptance for the Email Core ("list/search threads, read a message,
thread metadata") needed the thread unit, so this PR adds it.

- **`email_thread` MCP tool** — fetches a whole conversation by thread id
  via Gmail's `users.threads.get?format=full`. Returns every message in
  the thread plus derived thread metadata: `subject` (from the oldest
  message), `message_count`, `last_message_date`, the distinct
  `participants` (From/To/Cc union, first-seen order), the `label_ids`
  union, and the full `messages` array **oldest-first** (conversation
  reading order — the inverse of the newest-first list/search ordering).
  One round-trip for the whole thread (no N+1, unlike list/search).
  Read-capability gated (`read:email_managed_core.messages`).
- **Backend** (`src/backend.ts`) — `GmailThreadFull` / `GmailThreadGetInput`
  types, `ThreadNotFoundError`, and `getThread` on the `GmailClient`
  interface, implemented across both in-memory fakes
  (`buildInMemoryGmailClient`, `buildSeededInMemoryGmailClient`) and the
  production `buildGoogleGmailClient`. A shared pure `assembleThread`
  helper derives the metadata identically across backends.
- **Chat parity** — `/email thread <id>` chat command (agent-native parity:
  the agent's MCP tool and the user's chat command hit the same path).
- **Manifest** — `email_thread` declared in `package.json` `neutron.tools`;
  `TOOL_NAMES` updated to eight tools.
- **Defect fix** — removed the dangling `./mcp-tools-extra` entry from the
  Core's `package.json` `exports` map (the referenced file never existed).
- **Docs reconciliation** — `README.md` was several sprints stale: it
  documented a "Tier 1 no-send guarantee" and a 3-scope grant, but the
  Core had already shipped `email_send` + the `gmail.send` scope (gap-audit
  P0 reversal, 2026-06-20). Rewrote the send section + scope table to match
  the shipped reality and added `email_thread`. Added an Email Core section
  to `docs/SYSTEM-OVERVIEW.md` (previously unmentioned).

**Tests.** `cores/free/email/__tests__/thread.test.ts` (11 new): backend
`getThread` on both in-memory fakes (ordering, participant/label union,
`ThreadNotFoundError`), the production wrapper against a mocked
`users.threads.get` (full-payload mapping + 404 + empty-thread →
`ThreadNotFoundError`), the `email_thread` tool (audit row), and the
`/email thread` command. Full Email Core suite: 159 pass / 0 fail. `tsc`
clean against `cores/free/email/tsconfig.json`.

**Not in scope / follow-ups.** Thread-level *listing* (a "list threads"
surface distinct from per-message `email_list`) — `email_list` already
returns `thread_id` on every row, so callers group client-side; a native
thread-list endpoint is deferred until the surface needs it. Attachment
surfacing and RFC 2047 encoded-word subjects remain follow-ups (unchanged).
