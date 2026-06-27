# Onboarding-as-CC-session — Path 1 implementation design (2026-06-27)

Supersedes `docs/research/p2-v3-conversational-onboarding-design.md` and the
"BUG 0 deferred" conclusion of `onboarding-cc-session-feasibility-2026-06-27.md`.
Path 1 = **no new MCP/tool infra**: the onboarding interview runs in the SAME live
Claude Code session as steady-state chat, with a fire-and-forget post-turn
extractor as the scribe. Ryan-locked: NO FLAGS, NO DUAL PATHS, DONE = real browser.

## The one decision that resolves everything

The brief mandates deleting the `isOnboardingActive() → engine.advance` branches in
**both** the text handler (`composer.ts:1640`) and `on_button_choice`
(`composer.ts:1726`). That means **no onboarding turn — typed OR tapped — may route
through `engine.advance`.** Consequence: the history-import's `import_analysis_presented
→ user taps "accept" → wow-dispatcher → materializer` gate cannot survive, because the
accept tap is a button choice that would now hit the live agent. Therefore the import
must **auto-materialize** on synthesis completion. This is brief-mandated, not a
preference, and it is also what makes the path truly single.

## What the engine is STILL used for (cited, genuinely reused)

Path 1 retires the engine from the **conversational** path but keeps it as the
**import subsystem** owner — it was already decoupled from `engine.advance`:

- `engine.notifyImportUpload(...)` (`engine.ts:2296`) — the import TRIGGER. Needs an
  `onboarding_state` row at `import_upload_pending`.
- `engine-import-routing.ts` synthesis orchestration + the 5s `import-running-cron.ts`
  (`pollImportRunningTick`, `engine.ts:2181`) — progress + terminal detection. Turn-
  independent already.
- `onboarding/synthesis/*` — `runImportSynthesis` writes per-project DOCUMENTS via
  `seed-writer.ts` (`<owner_home>/Projects/<slug>/{STATUS.md,docs/history.md,research/...}`).
  This happens DURING synthesis, not at accept — preserved as-is.
- The wow-moment project-materializer + `GBrainSyncHook` (MEMORY/gbrain) — invoked
  AUTOMATICALLY on synthesis terminal (replacing the accept button), see §Import.
- `engine.start()` initial-state seed is NO LONGER used on the live path (auto-start
  seeds via the live session instead). The engine row is created by the extractor / the
  import trigger.

## What is REMOVED from the live path

- `composer.ts`: the `isOnboardingActive → advanceOnboardingText/Choice` branches in the
  app-ws text receiver and `on_button_choice`; `engine.start()` in `on_session_open`
  (replaced by a seeded live-session first turn).
- `onboarding/interview/llm-router.ts` is NEVER consulted on the live path (it only fires
  inside `engine.advance`, which the conversation no longer calls). The 6s Haiku classify
  that produced "I didn't quite catch that" is gone by construction.
- `runtime/onboarding-conversational-flag.ts` (`NEUTRON_ONBOARDING_CONVERSATIONAL`)
  collapsed to one path: `engine.shouldConsultRouter` (`engine.ts:2891`) no longer reads
  the flag; the platform-adapter accessors become constant. (The router still exists for
  the engine's own internal use / tests, but is dead on the live conversational path.)

## The new conversational flow (steps 1–6)

### Routing (composer.ts)
- Text receiver + `on_button_choice`: drop the onboarding branch. ALL turns →
  `appWsChatTurn` (live session). A button tap becomes `user_text = freeform_text ||
  choice_value` (already the steady-state behaviour).
- `on_session_open`: when `!onboarded`, seed the FIRST agent turn through `appWsChatTurn`
  with a synthetic system-origin user_text (`__onboarding_begin__`) so Claude opens with
  the first question under the client's auto-start loader (loader already wired from
  `window.__neutron_onboarding_active`, cleared by the first `agent_message`).

### Onboarding system preamble (build-live-agent-turn.ts)
- Add an optional `onboardingPreamble?: () => Promise<string | null>` (or an
  `onboardingMode` resolver) to `BuildLiveAgentTurnInput`. On the FIRST turn for a topic
  while `!onboarded`, splice an `<onboarding>` preamble fragment into the assembled
  system prompt (persona stack via `PersonaPromptLoader` + the preamble). The preamble
  instructs Claude to run the interview conversationally: get the user's name, what they
  work on (≥3 primary projects), non-work interests, the agent's personality + name, and
  to OFFER importing old ChatGPT/Claude history. Claude itself decides what's answered and
  what to ask next — no per-turn router.
- The warm REPL keeps the preamble in its own transcript for the rest of the session, so
  the same session conducts the whole interview and then naturally continues as the
  assistant once fields are collected (completion flips future cold sessions to plain).

### Fire-and-forget post-turn extractor (NEW module: `onboarding/interview/post-turn-extractor.ts`)
- Reuses the substrate-backed `onboardingAnthropicClient` (`composer.ts:732`,
  `buildGatewayAnthropicMessagesClient({ substrate: llmCallSubstrate })`) — the SAME warm
  `cc-llm` Max-OAuth path. NO new API-billed client (billing constraint).
- After each onboarding turn, async (non-blocking): given the recent exchange, extract
  `{ user_first_name, primary_projects[], non_work_interests[], agent_personality,
  agent_name }` (the 5 `required-fields-audit.ts` fields). Reuse the pure helpers
  `extractAgentNameFromFreeform` + `sanitizeUserFirstName`; LLM-extract the rest.
- Persist via `stateStore.upsert({ project_slug, user_id, phase: 'work_interview_gap_fill',
  phase_state_patch: {...} })`. Array fields read-modify-write (shallow-merge replaces
  arrays). Creating the row here is what flips `window.__neutron_onboarding_active` logic
  to "active until completed".
- Completion: when `auditRequiredFields(phase_state).next_to_collect === null` AND the
  phase is not import-active (`import_running`/`import_upload_pending`):
  1. `buildComposeInput(project_slug, state)` (`engine-internals.ts:1849`) →
     `personaComposer.compose(input)` → `personaComposer.commit(draft)` writes
     `<owner_home>/persona/{SOUL,USER,priority-map}.md`.
  2. `personaLoader.invalidate()` so the next turn loads the real persona.
  3. `onboardingHandoff.emitProjectSeeds(...)` (per-project topic seeds) — TBD from recon.
  4. `stateStore.upsert({ phase: 'completed', completed_at, wow_fired: true })`.
  After this `isOnboardingActive` is false → next turn's first-turn prompt is plain chat
  (persona only, no preamble), SAME warm session/socket.

### Resting phase model
- `work_interview_gap_fill` = the "conversational onboarding in progress" marker (non-
  terminal → `isOnboardingActive` true). Import temporarily moves the phase to
  `import_upload_pending`/`import_running`; on synthesis terminal it returns to
  `work_interview_gap_fill` (or straight to `completed` if all fields already collected).

## Import (step 7) — full fidelity, auto-materialized

- Upload affordance: onboarding `agent_message`s carry `upload_affordance` so the client
  shows the 📎 ZIP attach + accepts `.zip` (client gates a zip → `importHistoryZip` on an
  active affordance). Source (chatgpt|claude) resolved by sniffing the zip server-side if
  the affordance source is ambiguous (import handler already writes `<source>.zip`).
- POST `/api/upload/<source>` → `handleImportUpload` → `engine.notifyImportUpload`. Before
  notify, ensure the row is at `import_upload_pending`.
- Synthesis runs in background (DOCUMENTS written by seed-writer); cron emits progress +
  detects terminal.
- On terminal (replace the `import_analysis_presented` accept gate): AUTO-invoke the
  project materializer + `GBrainSyncHook` (MEMORY/gbrain) + project-seed, then return the
  phase to the conversational marker. The live session narrates results (it can Read the
  freshly materialized `Projects/<slug>/` docs). Exact materializer API: pending recon
  agent `a44b270f162cda9d6`.

## Real-browser verification (the gate)
Extend `tests/e2e-browser/onboarding_walkthrough.py` to assert (0) auto-start loader →
first question with no user msg; (1) ≥3 freeform answers each advance, never "I didn't
quite catch that", and `grep -c '\[llm-router\].*timed out' server.log == 0` during the
run; (2) name+persona persisted (persona/SOUL.md exists + contains the name); (3) zip
import full-fidelity (POST a fixture export → progress → project docs + gbrain entities
land); (4) completes → plain chat in the same session; (5) the 6 UI fixes hold.

## Out-of-scope / explicitly preserved
- #85 wiring: `projects_changed` app-ws emit (`emitProjectsChangedIfChanged`) — re-wire
  into the new flow (snapshot-diff after the extractor/import creates projects). Single-
  use `?start=` token (`claimStartTokenJti`) untouched.
</content>
</invoke>
