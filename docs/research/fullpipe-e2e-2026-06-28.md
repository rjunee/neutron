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

## STAGE 3 — Claude-export IMPORT materializes? → **VERIFIED-WORKS** ✅ (real flow) + 1 NEEDS-DECISION

Driven on a 2nd fresh isolated instance (:7816) with the REAL export
(`~/Downloads/Claude Data Batch (1).zip`, 14MB `conversations.json`, 184 conversations).

### Trigger + ingestion → VERIFIED
- `nd2-real-export-path1-import-runs.test.ts` PASSES on the fixed #94 routing: real
  export → **184 conversations parsed** → import job started (17 assertions, no
  `no_active_prompt`).
- Live: drove onboarding to `work_interview_gap_fill` (affordance present, accepts `.zip`),
  POSTed the real export to `/api/upload/claude` → `import_jobs` row
  `synth-259d97b92e50e28c`, `claude-zip`, 8 chunks; onboarding advanced to `import_running`.

### Synthesis → VERIFIED
- Real Max synthesis ran: pass1 0→8/8 chunks over ~8 min (~75s/chunk, real LLM calls) →
  `status=completed`.

### Materialization (docs + DB + memory) → VERIFIED (real flow)
After the import analysis was presented (**"9 proposed projects"** from the real export) and
onboarding was driven to completion (`phase=completed`, `completed_at` set, tab bar painted):
- **DOCUMENTS:** 10 real project repos on disk (193 files) — e.g. `Projects/ostro/docs/history.md`
  is a genuine synthesized summary ("Agentic AI operating system for life sciences/pharma,
  preparing VC pitch + SAFE fundraising") with Overview / Open threads / Source conversations,
  plus real verbatim `research/transcripts/*.md` slices from Ryan's actual chats.
- **PROJECTS DB TABLE:** 9 rows (`amascence, ostro, pristine, quintessential-ventures,
  quintessential-ventures-studio, dtc-ecommerce-playbook, info-product-business,
  mystical-design-objects-brand, tabs`) → the Documents tab surfaces them.
- **MEMORY:** 12 entity files (`entities/projects/*` + `entities/concepts/{ostro,amascence,
  pristine}`) and 9 pages in `gbrain list`. The import populated durable memory.

### NEEDS-DECISION (P2, latent robustness) — `pollImportRunningTick` wedges without `signup_via`
The DB project-registration + memory population happen at onboarding FINALIZE (wow-moment
materializer, which defers to the import's disk seeds). Getting there requires the engine to
advance OUT of `import_running` when the job completes — done by `pollImportRunningTick`
(`engine.ts:2200`), driven by the 5s import-running cron. That tick HARD-REQUIRES
`signup_via ∈ {telegram,web}` in `phase_state` (`engine.ts:2219-2226`); if it's absent it
returns `missing_channel_context` EVERY tick and the instance is **stranded at
`import_running` forever** — onboarding never finishes, projects never register, memory never
populates.

In a first test run onboarding wedged exactly this way. Root cause: `signup_via` is written
only on the engine-driven onboarding path (`engine.ts:1257,1314`); the Open Path-1 app-ws
post-turn-extractor never sets it. My freeform-only test drive reproduced the gap. Injecting
`signup_via='web'` (what the real button-driven flow sets — Ryan's live install HAS it)
**immediately unblocked it**: the cron advanced within ~20s, presented the 9-project analysis,
and onboarding completed + materialized (the VERIFIED evidence above). So this does NOT
reproduce in the normal button-driven flow, but it IS a real latent fragility: in single-owner
Open the channel is ALWAYS app-socket, so a missing/garbled `signup_via` should never strand a
paying user mid-import. **Recommendation:** make `pollImportRunningTick` default `channel_kind`
to `app-socket` when `signup_via` is absent but `topic_id` is present (and/or have the Path-1
onboarding state-writer stamp `signup_via='web'` on creation). Not fixed here — it touches the
import↔onboarding state machine and warrants its own focused PR + the full ~8-min real-import
re-verification. Flagging rather than guessing.

(Separately: the synthesis runner's completed-job `result` is attached from an IN-PROCESS map
(`build-synthesis-import-runner.ts:306`), so a server restart between import-complete and
phase-advance loses the result — a second restart-resilience edge worth noting in the same
follow-up.)

---

## Summary table

| Stage | Verdict | Evidence |
|-------|---------|----------|
| 1. Onboarding completes | **VERIFIED-WORKS** | `completed_at` set, tab bar, plain-chat drop |
| 2. Scribe→gbrain recall | **BROKEN → FIXED** | app-ws receiver never scribed; fix wires it; gbrain 0.9932 + cross-restart recall |
| 3. Export import materializes | **VERIFIED-WORKS** (+1 NEEDS-DECISION) | real flow: 9 projects → docs + DB table + 12 entities/9 gbrain pages; `signup_via` wedge flagged |

## KEY ANSWERS (for the brief)

1. **Does onboarding COMPLETE cleanly on the fixed build?** **YES.** Fresh onboarding driven
   through the real UI → `onboarding_state.completed_at` SET, `phase=completed`, dropped to
   plain chat (tab bar + normal reply). Ryan's live stall was 1/5 fields ever collected (he
   chose "skip" then stopped), not a finalize bug.
2. **Does post-onboarding scribe→gbrain recall WORK?** **NO on shipped main (P1 bug) → YES
   after the fix.** main `05619fe`: the entity scribe was never wired into the `/ws/app/chat`
   receiver, so gbrain stayed empty (`gbrain search "Alex Petrov"` → No results). After the
   fix: scribe writes `entities/people/alex-petrov.md` + gbrain (search = 0.9932), and a recall
   turn AFTER a full server restart returns "Alex Petrov — pulled straight from memory" (durable
   gbrain recall, not context).
3. **Does the real-export import MATERIALIZE?** **YES** (real button-driven flow): the 14MB /
   184-conversation export synthesized into 9 real projects materialized as on-disk repos +
   `projects` DB rows + 12 memory entities / 9 gbrain pages. One latent robustness gap
   (`signup_via`-dependent `import_running` advancement) flagged as NEEDS-DECISION.

## NEEDS-DECISION summary
- **ND-A (P2):** `pollImportRunningTick` strands onboarding at `import_running` forever when
  `phase_state.signup_via` is absent (Open Path-1 never sets it). Doesn't hit the normal
  button-driven flow but is a real latent wedge. Rec: default `channel_kind='app-socket'` when
  `signup_via` missing + `topic_id` present. (Details in Stage 3.)
- **ND-B (product):** a COMPLETED onboarding can't start a later import — a post-completion
  upload is `noop_terminal` by design. Should a finished user be able to import history later?
- **ND-C (minor):** the entity extractor occasionally mis-types (e.g. inferred "Alex Petrov
  works at orca-9931", treating a launch codeword as a company) — extraction-quality, not
  wiring.
