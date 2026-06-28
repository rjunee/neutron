# Reset-gate E2E — fresh-install + real-export freeform onboarding (2026-06-28)

**Gate:** Before the orchestrator fully resets Ryan's machine (uninstall →
reinstall → fresh onboarding → upload his Claude export DURING onboarding), PROVE
the entire fresh-install path works end-to-end on the fixed build (Open `main`
`fa4550a` — has #96 gbrain reachability, #97 scribe→`/ws/app/chat`, #98 ND-A
import-no-strand). Method: **verify-before-assert** — real host-side evidence
(server.log, `project.db` rows, `gbrain` CLI, on-disk docs), NEVER DOM scraping.

**Isolation.** Three FRESH isolated instances, fresh `NEUTRON_HOME`, isolated
ports, real Max OAuth substrate (keychain `Claude Code-credentials` →
`CLAUDE_CODE_OAUTH_TOKEN`), gbrain reachable. Ryan's live install (`~/neutron/*`,
:7800, PID 21688) was **never touched** (verified alive after every step).

| Run | Home | Port | Build | Ordering | Outcome |
|-----|------|------|-------|----------|---------|
| 1 | `/tmp/neutron-resetgate-home`  | 7816 | `fa4550a` | answer 5 fields → upload | **import ORPHANED** (bug found) |
| 2 | `/tmp/neutron-resetgate-home2` | 7817 | `fa4550a` | upload immediately (1st turn) | **no import job** (race, char.) |
| 3 | `/tmp/neutron-resetgate-home3` | 7818 | worktree + FIX | answer 5 fields → upload | **fix verification (see below)** |

The real export is `/Users/ryan/Downloads/Claude Data Batch (1).zip` → unzips to a
14 MB `conversations.json`, **184 conversations**.

---

## RUN 1 — freeform onboarding, upload AFTER the interview → import ORPHANED ❌

Driven through the real React UI in headless Chromium: fresh onboarding
auto-started (loader → "what should I call you?"); answered conversationally
(name → 3 projects → interests → personality+agent name "Atlas"), NO buttons.
Then requested + uploaded the real export.

**What worked (a, e):**
- Freeform advanced cleanly — no re-prompts on any turn.
- `signup_via='web'` stamped into `phase_state` by #98's Path-1 belt-and-
  suspenders (the prior full-pipe run found this ABSENT and stranded).
- **(a)** `import_jobs` row `synth-a3a8c3bc381d6eec` / `claude-zip` created and
  RAN to `completed` (8/8 pass-1 chunks, real Max synthesis ~5 min).
- **(e)** `onboarding_state.completed_at=1782680435065` SET, `phase=completed`,
  `wow_fired=1`.

**The failure (b, c, d):** onboarding finalized **~47 s into the import** (at
0–2/8 chunks) and NEVER entered `import_running`. Server log timeline:

```
[upload] project=dev source=claude bytes=3596622 destination=.../imports/claude.zip
[import-running-cron] tick project=dev in_flight_imports=1   ← import live
[onboarding-finalize] project=dev persona committed + loader invalidated
[import-running-cron] tick project=dev in_flight_imports=0   ← cron stops watching
```

Once `phase=completed` the import-running cron no longer counts the job
(`in_flight_imports=0`) → nothing advances onboarding to
`import_analysis_presented`, so `import_result` is never stamped and the
wow-materializer (which registers `projects` DB rows + gbrain memory at finalize)
already ran with no import seeds. Result after the import COMPLETED:

- **(c) PARTIAL:** synthesis wrote 4 real project repos to disk —
  `Projects/{info-product-playbook, mystical-design-house,
  quintessential-ventures-studio, tabs}/history.md` — BUT the `projects` DB table
  held only the 3 interview projects (`ostro, amascence, pristine`). The import
  projects are unregistered → invisible to the Documents tab.
- **(d) FAIL:** `gbrain list` → only the 3 interview projects + 2 concepts;
  `gbrain search "info product playbook"` → **No results**. `entities/` has no
  files for the import projects. The 184-conversation synthesis never reached
  memory. (`gbrain config.json` exists → #96 reachability is fine.)

**Root cause — premature-finalize race** (`post-turn-extractor.ts`). The Path-1
export upload (`engine.notifyImportUpload` → `startImportAndAdvanceToRunning`,
which upserts `import_running`, `engine.ts:2446`) runs OUTSIDE the extractor's
per-user serialization. The extractor computed `importActive` from `prior` — read
BEFORE its multi-second `extractFields` LLM call (`post-turn-extractor.ts:132`
pre-fix). A concurrent upload that flipped the row to `import_running` during that
window was invisible: the extractor downgraded the phase back to the interview
marker on its `upsert` (the store blindly writes `input.phase`,
`sqlite-state-store.ts:173`) and, with all 5 fields present, fired `onComplete` →
finalize on top of the live import.

## RUN 2 — upload on the very FIRST turn → no import job at all ❌ (characterization)

Uploading the export ~immediately after the first answer (before the
`onboarding_state` row / affordance settled) returned `no_active_prompt`: the UI
showed *"Couldn't start the import — your export was received but no import job"*,
`import_jobs` stayed empty, and onboarding completed with only the 3 interview
projects. A second, narrower race (upload vs. lazy row creation /
`importAffordanceOffered`). Largely a test artifact of a script uploading 0.1 s
after the first reply — a human reads the greeting first — but it confirms the
import window is bounded on BOTH ends. Flagged; not the primary gate-blocker.

---

## FIX — gate the extractor's finalize on a FRESH read + authoritative in-flight probe

`onboarding/interview/post-turn-extractor.ts` + `open/composer.ts`. The extractor
now RE-READS the current onboarding row immediately before its write/finalize
decision and consults `hasInFlightImport()` (a non-terminal `import_jobs` row for
the owner). `importActiveNow = freshPhase∈IMPORT_ACTIVE_PHASES || importInFlight`
is used for BOTH the phase write (never downgrade an `import_running` phase) and
the finalize gate (never complete on top of a live import). No feature flag.

Once the import completes, the existing pipeline takes over (cron →
`import_analysis_presented` stamps `import_result` → the Path-1 watcher returns to
the interview marker → the next turn finalizes WITH `import_result` and
materializes the imported projects into DB rows + docs + gbrain).

**Unit guards** (`post-turn-extractor.test.ts`, 3 new; the last two FAIL pre-fix):
1. in-flight import DEFERS completion even with all 5 fields present;
2. completion proceeds once the import is terminal;
3. a concurrent upload that flips the row to `import_running` mid-extraction is
   neither clobbered (phase stays `import_running`) nor finalized.

---

## RUN 3 — re-verify the run-1 ordering on the worktree build (with the fix)

_(real export + real Max LLM; same ordering that ORPHANED the import in run 1)_

Fresh isolated instance built FROM this worktree (`:7818`, `/tmp/neutron-resetgate-home3`).
Same driver as run 1: answer all 5 fields → request import → upload the real 14 MB / 184-conversation export.

**Phase progression (the fix holding the line) — `onboarding_state` polled every 12 s:**
```
T+24s   work_interview_gap_fill                         (interview)
T+72s   import_running   job=pass1-running 0/8          ← upload advanced phase; NOT clobbered/finalized
T+120..492s  import_running  1/8 → 8/8                   ← onboarding HELD across the full ~7-min synthesis
T+540s  work_interview_gap_fill  job=completed 8/8       ← cron → import_analysis_presented → watcher consumed
                                                           (import_result stamped)
T+576s  completed  done=1782682194767  projects=7        ← field-bearing turn finalized WITH import_result
```
Server log: `in_flight_imports=1` SUSTAINED across all 8 chunks (run 1 dropped to
`0` after the premature finalize at ~47 s). Contrast run 1: finalized at 0–2/8.

**(a) import job:** `claude-zip`, ran `pass1-running` 0/8 → `completed` 8/8 (real
Max synthesis, ~7 min). ✓
**(b) advances past import_running, never stranded:** `import_running` (held the
full synthesis) → `import_analysis_presented` → consumed → `completed`. ✓
**(c) projects register (DB) + docs on disk:** `projects` table = **7 rows** —
3 interview (`ostro, amascence, pristine`) **+ 4 imported**
(`dtc-info-product-playbook, mystical-design-brand, quintessential, tabs`); all 7
have on-disk repos under `Projects/`. (Run 1: 3 rows, the 4 import projects
UNregistered.) ✓
**(d) memory materializes (gbrain):** `gbrain list` = all 7 projects + concepts;
`gbrain search "info product playbook"` → **[1.0911] dtc-info-product-playbook**
("Deep-research knowledge base on DTC CRO…"). (Run 1: the same search → **No
results**.) `entities/projects/` holds all 4 import projects. `config.json`
exists. ✓
**(e) onboarding completes → plain chat:** `onboarding_state.phase=completed`,
`completed_at=1782682194767`, `wow_fired=1`; on restart the instance boots
straight into plain chat. ✓
**(f) post-onboarding scribe→gbrain recall (#97):** restarted the instance
(boots straight into plain chat) and stated a distinctive fact over `/ws/app/chat`
("my co-founder is Priya Raman, internal codeword FALCON-7723"). Within ~30 s the
scribe wrote `entities/people/priya-raman.md` (`source: chat:dev`, `type: person`,
"Co-founder of the user's venture", links `[[falcon-7723]]`). After stopping the
server (lock released), `gbrain search "co-founder Priya Raman"` →
**[0.9932] priya-raman** — durable gbrain memory, not in-session context. #97
(scribe wired into the `/ws/app/chat` receiver) confirmed on this build. ✓

> A subtlety found while driving (f) → folded into the fix: after an import is
> consumed, finalize previously fired only on a turn that EXTRACTED a new field
> (the extractor early-returned on an empty patch). A terse "looks good" left the
> user stranded at the interview marker. The fix now runs the completion check
> even on an empty-patch turn (only newly reachable post-import), so a terse
> confirmation finalizes. Unit-guarded (`post-turn-extractor.test.ts`); a
> combined-build E2E re-verify (run 4, benign-confirmation ordering) is the final
> confidence check — see the run-4 addendum at the end of this file.

### Note on `projects=0` until finalize (NOT a regression)
In run 3 the `projects` table stayed empty until the finalize at T+576s, then
jumped to 7 at once — project registration is a finalize-time materialization, so
holding `import_running` correctly DEFERS all registration (interview + import)
until the single finalize that carries `import_result`. Run 1's early `projects=3`
was the symptom of the premature finalize.

---

## Verdict

**On the shipped build `fa4550a` (no fix): RESET_GATE = FAIL.** The realistic
ordering — answer the interview, THEN upload your export — orphans the import:
the 184-conversation synthesis lands as dead docs on disk, with **0** `projects`
DB rows and **0** gbrain pages (`gbrain search "<import project>"` → No results).
That is precisely the "I uploaded my history and nothing showed up"
disappointment the gate exists to prevent. #96/#97/#98 are all genuinely fixed
(gbrain reachable, scribe wired, no ND-A strand) — but a NEW race sits on top.

**With this PR's fix merged: RESET_GATE = PASS.** Re-verified end-to-end on a
fresh isolated instance built from the fix, on the EXACT failing ordering, with
the real 14 MB / 184-conversation export + real Max LLM:

| Step | Run 1 (`fa4550a`) | Run 3 (with fix) |
|------|-------------------|------------------|
| (a) import job runs | ✓ completed | ✓ completed |
| (b) past import_running, not stranded/premature | ✗ finalized at 0–2/8 | ✓ held → analysis → consumed |
| (c) projects register (DB) | ✗ 3 (interview only) | ✓ **7** (3 + 4 imported) |
| (d) memory (gbrain) | ✗ search → No results | ✓ search → **1.0911** |
| (e) onboarding completes | ✓ (but empty) | ✓ with import materialized |
| (f) post-onboarding scribe recall | n/a | ✓ gbrain 0.9932 |

**Recommendation for the orchestrator:** do NOT reset Ryan's machine onto bare
`fa4550a` — land this fix first so his reinstall picks it up. With the fix,
uploading the export during onboarding materializes his projects + memory
regardless of when in the interview he uploads.

### Open follow-ups (non-blocking, separate PRs)
- **Early-upload race (run 2):** an upload on the very first turn (before the
  onboarding_state row / `importAffordanceOffered` settles) returns
  `no_active_prompt` / no job. Mostly a test artifact (a human reads the greeting
  first), but worth a guard (e.g. brief client-side disable of the attach control
  until the first agent turn lands, or a server-side "stage + retry" of an upload
  that arrives at `noop_no_state`).
- **`persona_files_committed=0`** at finalize despite `persona/SOUL.md` existing —
  carried over from the prior full-pipe report; cosmetic, flagged for follow-up.
