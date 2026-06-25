# AS-BUILT

Running log of what shipped, newest-first. One entry per delivered PR.

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
- **Surface + retry (actually moves the REPL onto the recovered session — Codex P1).**
  A hit records the recovered id on `session.pendingResumeSessionId` and **poisons**
  the warm child that just escaped the picker (it is contextless). `getOrSpawnSession`
  does NOT re-read `resolveResumeDirective` while an unpoisoned warm child is alive,
  so merely patching the registry would leave subsequent turns on the fresh REPL
  despite the notice; the poison makes the next turn evict + respawn, and
  `pendingResumeSessionId` is carried as the `forceResume` directive (a new
  `evictedResume` capture in `getOrSpawnSession`, hoisted ABOVE the alive/exited
  branch split so it also covers a poisoned child that exited before the next
  dispatch — Codex P2) so that respawn `--resume`s the recovered transcript —
  bypassing the stale-id registry and sidestepping a race with this spawn's own
  registry write. The current in-flight turn finishes on the fresh
  child; the notice tells the user the recovered context is **active from their next
  message**. A **miss** (nothing on disk) surfaces a "session lost — starting fresh"
  notice + one operator alert AND fires `onNoRecovery`, which sets
  `session.forceFreshRespawn` + poisons: the stale `--resume` id `spawnSession` wrote
  as `has_session: true` would otherwise reopen the picker on a later crash/watchdog
  respawn, so the next turn evicts + respawns with resume FORCED OFF (a new
  `evictedForceFresh` branch), and that fresh spawn rewrites the registry
  `has_session: false` — breaking the stale-resume loop (Codex P2). Spawn-time
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
