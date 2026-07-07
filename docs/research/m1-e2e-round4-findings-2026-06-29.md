# M1 Adversarial E2E — Round 4 (overnight convergence) — Findings

Date: 2026-06-29 · Base: `main` @ 0c73117 · Method: 4 parallel adversarial
code-path hunters across the truly-unexercised surfaces (deep onboarding
synthesis + full history-import; memory recall + multi-project; tab/settings/
integrations UI + mobile; concurrency + error-paths), each finding
re-verified by hand against `file:line` before assertion. Every prior fix
confirmed present; the round-3 triaged cluster acknowledged and NOT re-filed.

## Verdict: BUGS_FOUND → 3 NEW PRs (no merge)

| # | NEW bug (severity) | Root cause | PR |
| - | ------------------ | ---------- | -- |
| B | History import that completes AFTER the owner answered every required field never finalizes if the owner goes idle → permanent un-onboarded wedge (generic persona, no project DB rows/topics/gbrain pages, no error). The headline large-import path. (MED-HIGH, silent) | `finalize` was only called from the post-turn extractor's `onComplete` (user-turn-only, gated during import); `watchImportCompletion` consumed the import but never finalized; `on_session_open` only re-armed the watcher. `open/composer.ts:1845`, `:2150` | #113 |
| A | Mobile "Connect Google" shows stale "Not connected" after a SUCCESSFUL OAuth grant; no way to refresh without leaving the screen → owner thinks it failed, re-taps / gives up. (MED) | `Connect` hands off to the system browser via `Linking.openURL`, which backgrounds the app without unmounting the screen, so the mount-time fetch never re-runs and there is no `AppState`/focus/refresh path. `app/app/integrations.tsx:96`, `app/app/cores/[slug].tsx:98` | #114 |
| E | Deleting a project hides it from the rail + `list_projects` but `doc_search` keeps returning its docs → "I deleted it but the agent still knows it." (MED, correctness/privacy) | `delete_project` is a metadata-only soft delete (`projects.deleted_at`) that never removes the on-disk folder; the doc-search indexer enumerates by a bare disk scan with no `deleted_at` awareness. `cores/free/agent-settings/src/backend.ts:347`, `doc-search/projects.ts:18`, `doc-search/indexer.ts:64` | #115 |

Each PR ships a regression test that fails pre-fix / passes post-fix (B: two
real-composition reconnect scenarios; A: the foreground-refetch predicate, repo
render-free convention; E: real DocSearchRuntime+indexer+store, incl. a CONTROL
reproducing the bug) and a CLEAN Codex cross-model review. `tsc --noEmit` clean;
adjacent suites green (B import/onboarding 11/11 incl. #107; E doc-search 42/42).

## Prior 8 fixes — confirmed present in main + no regressions
#105/#106 (reminder + project-reminder app-ws live-delivery), #107 (import-watch
re-arm on reconnect — its regression test still green under B's change), #108
(finalize unions chat-named projects with import), #109 (whitespace-only trim
parity), #110 (chat_command_result/error frame render), #111 (recurring
reminders recurrence wiring), #112 (OpenAI-key reject at setup-token). The
hunters re-verified each area intact.

## Triaged cluster (round 3) — acknowledged, NOT re-filed
The app-ws `chat_log`-unwired architectural cluster (inert double-dispatch guard;
reconnect-mid-turn orphan reply; inert resume/receipt/reaction/edit frames);
timezone handling; cred-pool eviction on key disconnect; the full
OpenAI-embeddings-key capture→consumer wiring; 80-char scribe floor; no
boot-time gbrain backfill; gbrain_search prompt-steering; import source clobber;
synthesis-import restart race; non-atomic credential writes; oversize-WS
diagnostics; two-device doc-link scheme; bare-500 surface throws. All confirmed
still present; none re-filed (awaiting Ryan's design decisions per round 3).

## NEW observations — documented, NO PR (for Ryan's triage)

### Chat transport / UX
- **No agent-activity indicator on app-ws WARM turns (MED, UX).** The Expo chat
  screen shows no typing/streaming/progress affordance for the entire agent turn
  (5–60s, up to the 240s timeout) on every turn after the first cold one. The
  server emits `agent_typing_start/end` only on the legacy `web:` path
  (`build-phase-spec-resolver.ts:514,526`); the app-ws reply translator drops
  every non-`agent_message` frame (`open/composer.ts:1935`), and no
  `agent_message_partial` is streamed. The cold-start one-off ack
  (`build-live-agent-turn.ts:121`) covers only the first turn. *Not a broken
  function (the reply does arrive); a "feels hung" gap.* Cheapest fix: a
  client-side optimistic "replying…" indicator armed on send, cleared on the
  next `agent_message`. **Left as a design call (streaming vs optimistic).**
- **HTTP `/api/app/chat/send` blocks its response on the whole agent turn
  (LOW-MED).** `app-ws-surface.ts:759` awaits `dispatchInbound` (the full turn,
  up to 240s) before responding, so on the WS→HTTP fallback the optimistic
  bubble can't be confirmed and a proxy/RN timeout flips it to `failed` → retry
  re-runs the turn. This is the concrete trigger of the already-triaged
  double-dispatch consequence; fix = fire-and-forget dispatch + return the echo
  immediately (reply already fans over WS). **Entangled with the triaged
  `chat_log` cluster — folded into that decision, not separately filed.**

### Settings (agent-settings Core)
- **`update_agent_name` / `update_personality` are dead in Open and return
  "Settings backend unavailable — please report this" (MED, broken promise).**
  Onboarding's handoff promises "switch personality / update my name later — just
  ask," but Open never threads an `AgentProfileBackend`
  (`gateway/cores/mount-open-cores.ts` / `boot-helpers.ts:1168`), so both tools
  short-circuit on `profile.available === false`
  (`cores/free/agent-settings/src/backend.ts:422,466`). The honest-failure is
  intentional (Argus r5), but in Open it ALWAYS fires and tells the user to file
  a bug for expected behavior. **Fix is a design call** — either thread an
  Open-appropriate profile writer (persist agent name/personality to
  `persona/SOUL.md` / `NEUTRON_AGENT_NAME` that the `PersonaPromptLoader` reads,
  making the capability actually work) OR, minimum, change the Open-path copy to
  "not supported on this deployment" and soften the onboarding promise. Did not
  guess the implementation blind. **Recommend: wire it (it's a core
  personal-product expectation).**

### Lower-confidence (not filed)
- Failed-import retry/skip buttons are emitted but inert in Path-1 (taps route to
  the live session, not the engine) — auto-advance into gap-fill appears
  intentional; `resume_import` has its own HTTP handler. Flagged, unverified.
- `merge_projects` orphans project-scoped data — already KNOWN (ISSUES #87).

## Verified-CLEAN areas (no manufactured bugs)
Persona-gen is genuinely invoked end-to-end (not a placeholder); ChatGPT +
Claude export parsers + synthesis prepass + seed→materialize slug alignment;
per-project warm-session/persona/turn-topic isolation; entity merge/append
(append-only timeline preserved); turn serialization (`turnChains`); server-side
error-path messaging (LLM/timeout/empty-reply all ship a `FAILURE_BODY`
`agent_message`; structured WS error frames; client renders `error` frames);
envelope decode/trim parity; web Integrations/Tasks tabs (loading/error/empty/
optimistic states); mobile tab resolution; project materialization already
honors soft-deletes (`ensureProjectRow` skips a deleted slug).
