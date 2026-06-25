# Plan — Port Vajra #11: Per-turn API-5xx dead-turn notifier (JSONL watcher)

**Date:** 2026-06-25 · **Branch:** `forge/pty-api5xx-dead-turn-notifier` · **Builds on:** #54 (F1/F2/F3), #57 (stuck-turn JSONL watcher)

## SPEC-conformance diff (required first)

- **SPEC § row #11 says:** detect a mid-turn 5xx in the turn JSONL (on `result` / `system` / `error`
  lines ONLY) that left the turn dead with no `reply()`, and edge-fire a "resend your last message"
  notice + retry affordance through the dev-channel surface.
- **CURRENT WIRING does:** nothing for this case. The wedge-detector keys off process
  liveness / HTTP `/health`; the #57 stuck-turn watcher keys off an *unanswered real-user turn going
  stale in the JSONL*; the output-scan detectors (#56/#55/#58) key off PTY-ring TUI signatures.
  None of them recognises a turn that the model *started* but a 5xx aborted before any reply.
- **GAP:** the 5xx-abort-before-reply case is undetected — the user sees nothing (Ryan 2026-06-16).
- **THIS BUILD FIXES:** a JSONL `fs.watch` watcher matching
  `/Overloaded|overloaded_error|rate_limit_error|internal_server_error/` on `result` / `system` /
  `error` records ONLY, edge-latched, surfacing a "resend your last message" retry notice through an
  injected notice sink (the dev-channel / gateway delivery seam — mirrors `onRecoveredReply`).
- **EXPLICITLY OUT OF SCOPE:** the ring/pane-based scan (we use the JSONL — cleaner; the brief
  forbids re-using the output-scan ring path here); auto-resend of the stored message (notify +
  affordance only this pass).

## Invariants carried verbatim (hard-won)

1. **Edge-triggered latch** — fire on absent→present, clear only on present→absent. NEVER
   time-dedupe (a stale error line must not re-fire forever). Implemented as: a matching error
   record on the rising edge fires once and latches; a subsequent *healthy* considered-record
   (clean `result`/`system`/`error`) clears the latch so a later error can fire again.
2. **JSONL / disk is the source of truth.**
3. **Allowlist match on `result` / `system` / `error` records ONLY.** `type:"user"` and
   `tool_result` records are ignored entirely (neither fire nor clear) — tool output legitimately
   echoes the word "overloaded" and must not trip the detector.
4. **Reassemble records split across `fs.watch` callbacks** — a single JSONL record can land in
   fragments; the watcher buffers a trailing partial line until its newline arrives.

## Mechanism

- **Reuse** the #57 JSONL byte-range read primitive (`runtime/subagent/turn-progress.ts` pattern:
  `openSync`/`readSync` from an offset, never-throws) and the `<projectsDir>/<dashifyCwd(cwd)>/<sessionId>.jsonl`
  layout (`session-validation.ts`). Do NOT duplicate that machinery.
- **New module** `runtime/adapters/claude-code/persistent/api5xx-dead-turn-watcher.ts`:
  - `classifyApi5xxRecord(line)` → `'fire' | 'clear' | 'ignore'` (pure; the allowlist + regex).
  - `Api5xxDeadTurnCore` — stateful: `feed(chunk)` appends to a pending buffer, splits complete
    lines (reassembly), classifies each, applies the edge-latch, returns notices fired this feed.
  - `startApi5xxDeadTurnWatcher({ jsonlPath, notify, ...injectable fs })` — `fs.watch`-on-directory
    driver (survives the file not existing yet / rotation); each change pumps new bytes → `feed`
    → `notify`. `pump()` exposed for deterministic tests; `stop()` closes the watcher.

## Wiring (NO feature flag — ON by default)

- Start the watcher per session right after the child spawns in `persistent-repl-substrate.ts`
  (sessionId + cwd are both known at spawn → JSONL path is resolvable immediately). Stop it in the
  `child.exited` teardown. The notice sink is a new injected option `onDeadTurnNotice` (gateway DI
  seam, mirrors `onRecoveredReply`/`postWedgeAlert`), defaulting to a structured stderr notice — no
  env toggle, no dual code path.

## Tests (all required by the brief, explicit assertions)

1. a `result` record with `overloaded_error` FIRES.
2. a `type:"user"` record containing `overloaded` does NOT fire.
3. a `tool_result` echoing `overloaded` does NOT fire.
4. a record split across two `fs.watch` callbacks is reassembled and matched.
5. edge-latch: fires once on the rising edge, does not re-fire while present, clears on absent.

## Docs

- `docs/SYSTEM-OVERVIEW.md` — note the API-5xx JSONL watcher in the watchdog/liveness section; mark
  research-table row #11 closed.
- `docs/AS-BUILT.md` — full as-built entry.
