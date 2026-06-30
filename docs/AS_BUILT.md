# AS_BUILT

Running log of what shipped, newest first. One entry per merged change.

## 2026-06-29 — M1 CRITICAL: open-mode history import wouldn't START (#130 regression) — upload right after the name now seeds the row + starts the job

**Symptom.** On a fresh Open install, the reworked onboarding (#130) offers
history import right after the name. The owner uploads their ChatGPT/Claude
export and the server returns `job_id: null`; the client shows "Couldn't start
the import — no import job started." The import never runs (`import_jobs` empty,
`in_flight_imports=0` forever) behind a false success.

**Root cause.** `InterviewEngine.notifyImportUpload`
(`onboarding/interview/engine.ts`) reads the onboarding_state row and short-
circuits with `noop_no_state` when it's absent — **before** the open-mode
import-start gate. The open-mode live-agent onboarding never calls
`engine.start()` (managed mode's row-seeding entry); the row is created
**lazily + asynchronously** by the fire-and-forget post-turn extractor
(`post-turn-extractor.ts`), a multi-second background LLM call that only upserts
once it extracts a field. #130 moved the import offer to right after the name —
**earlier than the background extractor can create the row** — so the upload
races ahead of the row and lands at `state === null`.

**Fix (no flags, tenant-silent).** In `notifyImportUpload`'s `state === null`
branch, when the upload is a SOLICITED open-mode Path-1 upload (the SAME signal
the non-null gate uses: `deploymentMode === 'open'` AND `importAffordanceOffered`,
the exact condition the live-agent seam renders the 📎 affordance under), seed
the onboarding_state row at the `work_interview_gap_fill` conversational marker —
stamping `signup_via` so the import-running cron's channel-context invariant holds
on disk — then start the import via the existing
`startImportAndAdvanceToRunning`. A STRAY upload (affordance not offered, e.g. no
synthesis substrate) and managed mode both still `noop_no_state`. The #130
offer-first / live-progress / ordering / curation-context handoff are untouched.

**Test (forbidden-pattern fixed).** The passing acceptance test
`tests/integration/nd2-real-export-path1-import-runs.test.ts` SQL-SEEDED an
onboarding_state row before uploading — manufacturing the precondition the live
flow never creates, so it could never catch this. It now seeds NO row and drives
the real no-state upload (verified end-to-end with Ryan's real 3.6MB / 184-convo
Claude export → job started). Added two engine-level repros in
`onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts`
(no-state solicited → seeds row + starts; no-state affordance-off / managed →
no-op, no row manufactured). Negative control: reverting the engine fix fails
exactly these no-state tests.

## 2026-06-29 — M1: onboarding import flow rework — offered FIRST + live progress + curation handoff + ordering

This is one coherent import-onboarding rework (PR #130). Two further bugs were
folded in after the initial offer-first + progress pass:

**Bug 3 — analysis → curation handoff was BROKEN (the killer).** The import-
analysis result (proposed-projects list) reached the client but was NOT in the
live-agent's conversation context. So when the owner replied to curate ("drop
the Family Home project, keep the rest"), the agent had no record of proposing
anything and answered "this is our first conversation, I haven't proposed any
projects" — the import was visible but un-actionable.

- Root cause: the analysis "wow moment" is delivered OUT OF BAND (ephemeral
  app-ws `agent_message`, never in the warm REPL transcript), and the onboarding
  `systemPreamble` is a static string spliced ONLY on the cold first turn — so a
  warm session post-import had no grounding on what it proposed.
- Fix (1) — context threading: new optional seam method
  `LiveAgentOnboardingSeam.onboardingContext(user_id)` (`build-live-agent-turn.ts`)
  re-injected on EVERY onboarding turn (warm AND cold), mirroring the Work Board
  block. `open/composer.ts` implements it: reads durable `phase_state.import_result`
  + `primary_projects` and calls the new `buildImportAnalysisContextFragment`
  (`onboarding-preamble.ts`) → an `<import_analysis>` block listing the proposed
  projects (with rationale + which were dropped) and telling the agent it already
  presented them + how to handle keep/drop/edit/add.
- Fix (2) — drop propagation: the Path-1 post-turn extractor never implemented the
  `removed_projects` channel that `ExtractedFields` has documented since GAP1
  (2026-06-09) and the legacy engine honors. Ported it: `parseExtractedFields`
  parses `removed_projects`; the extraction prompt asks for explicit drops;
  `buildPhaseStatePatch` subtracts them from the merged `primary_projects` AND
  accumulates them under `phase_state.dropped_projects`. `build-onboarding-finalize.ts`
  `resolveProjects` excludes `dropped_projects` from BOTH union sources (the import
  side re-pulls `proposed_projects`, so the `primary_projects` subtraction alone
  wasn't enough). Mirrors the legacy engine's `(prior ∪ adds) MINUS removals`. So
  a dropped project is never materialized; persona-gen (reads `primary_projects`)
  agrees. The additive no-narrowing rule is intact for non-removal turns.

**Bug 4 — import-delivered messages mis-ordered.** New user messages rendered
ABOVE the import-delivered analysis instead of newest-at-bottom. The successful
`import_analysis_presented` body was fanned via the ephemeral `emitOnboardingPrompt`
(no chat_log `seq`), and chat-core's `compareForDisplay` pins seq-less messages to
the tail — so a later real-seq user message sorted above it (and it vanished on
resume). Fix: that specific buttonless "wow moment" now persists through the
durable app-ws adapter (`open/composer.ts` button-prompt router → `adapter.send`
→ chat_log → monotonic `seq`, replayable). Every OTHER onboarding prompt (failure
/ rate-limit / resume — real buttons) stays ephemeral. Safe from double-render:
`on_session_open` never re-sends the body and the watcher resolves the phase so
the reconnect re-emit won't re-fire it.

Tests added: `onboarding-preamble.test.ts` (context fragment — lists proposed,
marks dropped, case-insensitive); `post-turn-extractor-removed-projects.test.ts`
(parse + subtract + accumulate `dropped_projects`, additive when no removals);
`build-onboarding-finalize.test.ts` (a dropped project is not materialized even
from the import union). tsc clean; leak-gate SILENT; onboarding-interview (957),
realmode-composer (379), app-ws (107), Open import/boot suites all green.

---

## 2026-06-29 — M1: onboarding import offered FIRST + real live import progress

**Problem (two live-test bugs).** Ryan hit two issues on a fresh M1 install:
1. The ChatGPT/Claude history import was **not offered early/explicitly**. After
   the #126 fix removed a premature always-on hint, the offer swung too far the
   other way — the agent only mentioned import after probing the user's work, so
   it felt buried. The intent (and the onboarding-experience spec) is: offer the
   import as the EXPLICIT first step right after the name, so the rest of the
   interview is informed by the analysis.
2. There was **no real import-progress indicator**. A large import (~8 min for
   173 conversations) showed only a one-shot "Export received — reading through
   your history now." line and then looked dead for minutes.

**Root cause.**
- Bug 1: Path-1 (Open) onboarding is prompt-driven — the engine runs only the
  import subsystem, so onboarding ordering lives entirely in the `<onboarding>`
  preamble (`onboarding/interview/onboarding-preamble.ts`). The import block sat
  after all five learning goals + was gated "after you have their name AND a
  sense of their work", biasing the model to defer it past the work-interview.
- Bug 2: the engine's `import-running-cron` already emits an `import_progress`
  event every ~5s and `buildRoutedSendImportProgress` already routes `app:<user>`
  topics to a composer holder — but that holder's `.send` was a documented NO-OP
  (`open/composer.ts`), so every progress frame was dropped. The React client
  (`controller.ts`) already consumed `import_progress` and rendered a spinner +
  per-pass line (`ChatApp.tsx` `ImportStatus`); only the server-side app-ws emit
  was missing.

**Fix (no flags, Option A in-chat for Bug 1).**
- `onboarding/interview/onboarding-preamble.ts` — moved the import-offer block to
  between goal #1 (name) and goal #2 (work) and reworded it to an EXPLICIT,
  prominent ask made RIGHT AFTER the name and BEFORE the work questions (mentions
  the drag-and-drop/📎 affordance + that it runs in the background with live
  progress; "only ask this once"). No new phase/modal — a pure preamble
  reposition. The managed-mode phase machine already routes import right after
  name, so it was untouched.
- `channels/adapters/app-ws/envelope.ts` — new `AppWsOutboundImportProgress`
  envelope (`{v,type:'import_progress',job_id,status,pass,pct,chunks_total_known,
  body?,ts}`) added to the `AppWsOutbound` union; mirrors `agent_typing` /
  `work_board_changed` (ephemeral, UI-only, not persisted, never replayed).
- `open/composer.ts` — filled the no-op `appWsImportProgressRouter.send` to fan
  the new frame via `appWsRegistry.send(app:<user>, env)` (best-effort; terminal
  frames clear the client spinner defensively, the analysis body still lands via
  the button-prompt path). Engine, cron, routing, and client render were already
  built.
- Tests: `onboarding/interview/__tests__/onboarding-preamble.test.ts` (pins the
  import offer present + positioned name→import→work, absent when not offered,
  asked once); `channels/adapters/app-ws/__tests__/import-progress.test.ts`
  (envelope is a union member, body optional, fans through `registry.send`).
- Docs: `docs/SYSTEM-OVERVIEW.md` updated (onboarding import-offer-first note +
  app-ws frame `#7 live import progress`).

**Why it's safe.** Additive: a server-only union member (the Expo subset union +
parity test are untouched and still green). The #126 fixes (import RESULT renders,
centered column, no reactions) are unaffected — the analysis body still lands via
the existing path; this only un-drops the intermediate progress frames. tsc clean
(root + chat-react leaf); app-ws (107) + onboarding-interview (912) suites green.

## 2026-06-29 — M1: stale-client-store auto-reset on server reinstall

**Problem.** A fresh Neutron Open server reinstall showed a STALE chat: the web
client's offline local store (`@neutron/chat-core` OPFS snapshot, origin-scoped
`neutron-chat-core.json`) — and the mobile op-sqlite store (`neutron-chat.db`) —
survive a server uninstall+reinstall behind the same origin/device. The server's
per-topic `seq` counter restarts at 1 on a fresh install, but the client resumed
forward from its OLD high local cursor (`resume after_seq=<high>`), so the
server's `replayAfter` returned nothing and the dead server's transcript
rendered forever. `session_ready.last_seen_seq` already carried the server's
high-water seq but NO client code read it.

**Fix (seq-regression reset detection, no flags).**
- `chat-core/types.ts` — new `parseSessionReadyMaxSeq(frame)`: extracts
  `last_seen_seq` from a `session_ready` frame, `null` when absent/malformed.
- `chat-core/sync-engine.ts` — new `SyncEngine.reconcileServerReset(topic, serverMaxSeq)`:
  when the server's reported seq is a known number **strictly lower** than a
  **non-zero** local cursor, the server regressed (was wiped/reinstalled) →
  `store.clear(topic)` so the following `resume` re-syncs from `after_seq=0`.
  Conservative: no-op when seq is absent (`null`), when server seq ≥ local
  cursor (normal reconnect/cold-open/first-connect), or when the local cursor
  is 0 (nothing cached).
- `chat-core/web-session.ts` + `app/lib/chat-core/mobile-session.ts` — both
  `session_ready` handlers call `reconcileServerReset(frame)` BEFORE
  `resumeAndFlush()`, and emit a UI change on a real reset so the stale messages
  drop immediately (before the replay lands). The detection lives in the SHARED
  `SyncEngine`, so web (OPFS) and mobile (op-sqlite) both benefit.
- `app/lib/ws-envelope.ts` — added `last_seen_seq?` to `AppWsOutboundSessionReady`
  for type parity with the server envelope (`channels/adapters/app-ws/envelope.ts`).

**Server change (Codex P1a).** `gateway/http/app-ws-surface.ts` now ALWAYS sends
`session_ready.last_seen_seq` when a durable log is wired, **including 0**.
Previously it omitted the field on 0, so a freshly reinstalled server whose log
was still empty at connect time (the welcome messages persist AFTER
`session_ready`) sent no signal → the stale client never reset on its first
post-reinstall load. A present `0` is now an affirmative "this server has nothing
for the topic" signal; the field stays ABSENT only when there is no durable log
at all (where `null` → never clear, protecting the only copy). `open/composer.ts`
wires the durable `AppChatStore` chat_log, so Open always reports the real value.

**No-data-loss on reset (Codex P1b + P2).** Added a `Store.clearAckedTranscript(topic)`
primitive (InMemory + OPFS + Sqlite) that drops only the ACKED (server-sequenced)
transcript in a SINGLE atomic store operation, preserving un-acked local sends
(status `queued`/`sent`, no server seq). `reconcileServerReset` calls it instead
of a read-clear-reinsert cycle, so a send that races the reset can't be lost in a
snapshot→clear window (it's either an already-kept non-acked row or arrives
after). The preserved sends are re-driven against the fresh server by the
following resume/flush (idempotent on `client_msg_id`).

**Not changed.** No new local-store namespace keyed on a server instance id (the
frame exposes no per-install id today; the seq-regression heuristic is the
pragmatic detector per the bug note).

**Tests.** `chat-core/__tests__/session-ready.test.ts` (parser edge cases),
`chat-core/__tests__/sync-engine.test.ts` (reconcile: clears on regression;
no-op on ≥, null, cursor-0, un-sequenced optimistic sends),
`chat-core/__tests__/web-session.test.ts` + `app/__tests__/chat-core-mobile-session.test.ts`
(end-to-end: stale transcript cleared + `resume after_seq=0` + fresh replay
renders clean; normal reconnect preserves; absent `last_seen_seq` never wipes).
