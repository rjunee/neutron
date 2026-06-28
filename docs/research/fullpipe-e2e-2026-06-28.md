# Full-Pipeline E2E — fresh isolated instance (2026-06-28)

**Goal:** Prove the COMPLETE memory pipeline works on a clean install, adversarially,
evidence-gated, on the FIXED build (Open `main` `05619fe`, post-#96 gbrain reachability
fix). Three stages: (1) onboarding COMPLETES, (2) post-onboarding scribe→gbrain RECALL,
(3) Claude-export IMPORT materializes.

**Isolation:** Fresh `NEUTRON_HOME=/tmp/neutron-e2e-home`, port `7815`, owner Max-OAuth
token (from keychain `Claude Code-credentials`), real Max LLM via the `claude` substrate.
Ryan's live install (`~/neutron/core|data`, PID 51810 on :7800) was **never touched**.
Isolated server: PID 55393 on :7815.

Method: real headless Chromium (system Playwright) driving the actual React chat UI +
host-side evidence (server.log markers, project.db rows, `gbrain list/search`, config.json,
filesystem). VERIFY-BEFORE-ASSERT: no "works" without real evidence.

---

## STAGE 1 — Does onboarding COMPLETE? → **VERIFIED-WORKS** ✅

**Evidence (`tests/e2e-browser/onboarding_walkthrough.py` vs :7815, full PASS):**
- A fresh onboarding auto-started (loader → first agent prompt with empty composer),
  was driven to completion by real freeform answers in the real React composer, and the
  project tab bar (`Chat / Documents / Tasks / Admin`) painted — the deterministic
  completion signal.
- **`project.db` `onboarding_state`: `phase=completed`, `completed_at=1782672568575`
  (SET), `wow_fired=1`.**
- Dropped to plain chat: a steady-state message got a normal agent reply that was NOT an
  onboarding re-prompt (`step4_plain_chat=true`).
- `persona/SOUL.md` materialized (non-empty).
- No `[llm-router] … timed out` in the server log during the run.
- All 18 walkthrough checks `PASS`.

**Completion path (code):** `onboarding/interview/post-turn-extractor.ts:163-175` fires
`onComplete` once `auditRequiredFields` reports all 5 required fields present
(`user_first_name`, `primary_projects` ≥3, `non_work_interests` ≥1, `agent_personality`,
`agent_name`) AND no import is mid-flight → `build-onboarding-finalize.ts:170-176` upserts
`phase='completed'`, `completed_at=now()`, `wow_fired=true`.

**Re: Ryan's live stall** (`phase=work_interview_gap_fill`, `completed_at=NULL`): his live
`phase_state_json` contained ONLY `user_first_name="Ryan"` (1 of 5 required fields); he
chose "skip" then stopped engaging after ~4.5 min (started 09:33:47, last advanced
09:38:13). This is "the other 4 fields were never collected," **not** a finalize bug — a
fully-answering fresh run completes (proven above). See NEEDS-DECISION below re: whether a
user who abandons mid-interview should get a nudge / be able to finish later.

**Minor observation (non-blocking):** finalize set `wow_fired=1` but
`persona_files_committed=0`, even though `persona/SOUL.md` exists on disk. Flagged for a
follow-up look; does not affect completion or plain-chat drop.

---

## STAGE 2 — Post-onboarding scribe→gbrain RECALL? → **BROKEN → FIXED** ✅ (P1)

### The bug (root cause, file:line)
The chat-time **entity scribe** (`scribeOnUserTurn` → extract facts → GBrain memory)
was wired ONLY into the legacy web `chat-bridge.handleInbound` (the old `/ws/chat`
path: `gateway/http/chat-bridge.ts:1739,1802,1887,1940`). The React client connects to
the UNIFIED `/ws/app/chat` socket (`gateway/http/app-ws-surface.ts:197`), which
dispatches `AppWsAdapter.dispatchInbound` (`channels/adapters/app-ws/adapter.ts:224`) →
`this.receiver.receive(...)` → the composer's `appWsReceiver.receive`
(`open/composer.ts:1882-1951`). That receiver ran the live-agent turn (`appWsChatTurn`)
but **never called `scribeOnUserTurn`**. So NO post-onboarding chat turn over the only
surface the owner uses ever extracted facts to gbrain. `build-live-agent-turn.ts`'s
`onTurnComplete` (line 553) is the *onboarding PROFILE* extractor (the 5 fields), a
distinct layer — not the general entity scribe.

**Severity: P1.** This is almost certainly why the owner's live memory feels dead: even
a fully-completed install never scribes chat facts to gbrain; recall only ever worked
from in-session CC context.

### Evidence of BROKEN (pre-fix, main 05619fe)
Stated a distinctive fact ("co-founder Alex Petrov; deploy Tuesdays; codeword ORCA-9931"),
waited 4 min, then forensic `gbrain list` → store had ONLY the 3 onboarding projects, NO
Petrov. `gbrain search "Alex Petrov"` → **No results.** Zero `[scribe]` log lines (the
scribe logs loudly on every non-filtered path). The agent's "recall" in the same session
succeeded purely from in-session CC context, NOT durable memory.

### The fix
`open/composer.ts` — `appWsReceiver.receive` now fans every real user turn into
`scribeOnUserTurn` (fire-and-forget + guarded, at parity with the chat-bridge). Omitted on
LLM-less boxes (no extractor) → no-ops, chat path unaffected. NO feature flag.
Regression guard: `open/__tests__/open-app-ws-scribe-wiring.test.ts` boots the real Open
composition over `Bun.serve`, drives a turn through a live `/ws/app/chat` socket, and
asserts the scribe's extraction prompt reaches the (mocked) substrate. Verified it FAILS
without the fix (waitFor timeout) and PASSES with it.

### Evidence of FIXED (re-verified on the isolated instance, worktree build)
- Scribe wrote entity files to disk: `entities/people/alex-petrov.md` (frontmatter
  `type: person`, source `chat:owner`, timeline entry), `entities/concepts/orca-9931.md`,
  `entities/concepts/tuesday-production-deploys.md`.
- `gbrain list` now shows `alex-petrov` (person), `orca-9931`, `tuesday-production-deploys`
  + the 3 projects. `gbrain search "Alex Petrov co-founder"` → `alex-petrov` @ **0.9932**.
- **Durable cross-session RECALL:** after a full server RESTART (every in-process CC
  session wiped — the fact is no longer in any context window), a fresh recall turn
  answered *"Your co-founder is Alex Petrov — pulled straight from memory."* The only
  source is gbrain. PROVEN.

Minor (not the wiring bug, not fixed here): the extractor inferred "Alex Petrov works at
[[orca-9931]]" — treating the launch codeword as a company — an LLM extraction-quality
nit, noted for follow-up.

## STAGE 3 — Claude-export IMPORT materializes? → _(in progress)_

---

## Summary table

| Stage | Verdict | Evidence |
|-------|---------|----------|
| 1. Onboarding completes | **VERIFIED-WORKS** | `completed_at` set, tab bar, plain-chat drop |
| 2. Scribe→gbrain recall | **BROKEN → FIXED** | app-ws receiver never scribed; fix wires it; gbrain 0.9932 + cross-restart recall |
| 3. Export import materializes | _pending_ | — |
