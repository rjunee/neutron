## 2026-09-17 — the round-two trailer slot, and taking a step exactly once

### What was wrong

Run `67e8230e` reached further than any project build before it: plan worker
completed, build worker completed (`build.result`, `kind: completed`), commit
`d9e415d9`, `build-driver-settled {"kind":"continued"}`. It then went terminal
with `project driver settled without determining the outcome: Trailer step_id
missing or mismatched.`

The result slot is keyed by **role** and the step filling it by role **and
round**:

- `open/wiring/project-build.ts:366` — `path: join(state, ROLE + '.result')`,
  composed once at prepare time. The file's own comment at `:344` states that
  `step_id` is per role AND round and so cannot be baked in there.
- `trident/build-run.ts:319` — `step_id` carries `:<role>:<round>`.

Nothing removed the file between rounds. `grep -rn "unlink" trident/ runtime/
open/` finds no result-file removal (positive control: it does find
`trident/worktree-reaper.ts:1607` and `runtime/atomic-write.ts:36`).

Round two of a role therefore dispatched against round one's trailer, and two
readers took it for this round's answer:

1. `runtime/workers/project-runners.ts:50` — the exact terminal string above.
2. `runtime/workers/claude-acting-turn.ts:200-202` — returns `turn-ended` the
   instant the path exists, which on round two is true before the dispatch is
   even submitted. No worker of that round had run.

Same defect class as #1111: an outcome judged on history rather than on what
arrived after the dispatch.

### What was built

`runtime/workers/trailer-slot.ts` — `reserveTrailerSlot`, used by all four
runners (`claude-in-repl`, `codex-in-repl`, `pi-in-repl`, `codex-headless`),
replacing four hand-rolled copies of the reservation.

The clear is part of taking ownership, because neither ordering works alone:
reserve-then-clear leaves a restart window that reads the previous round's
trailer; clear-then-reserve destroys a genuine resume's own completed receipt.
The exclusive `wx` create is the only thing that confers ownership. The winner
clears the slot, arms the reservation, then submits the work, so an ARMED
reservation proves the slot was already cleared for this step.

An existing but UNARMED reservation is **not** taken over. A second caller cannot
tell a dead owner from one a millisecond short of arming, and guessing dispatches
the bounded task twice against one shared trailer. It reports `unknown`, which
matches the standing contract that an uncertain dispatch is never replayed — and
it still never reads the stale slot as an answer.

### What review caught that I did not

Three adversarial rounds, three real defects in my own work:

1. The headless runner cleared on **every** run — it had no reservation of its
   own — destroying a resumed step's completed receipt and dispatching it twice.
   Reproduced: `first: "completed"`, `second.kind: "unknown"`, `dispatches: 2`.
2. The reservation was written **before** the clear, so a replacement arriving in
   that window called the step a resume, skipped the clear and read round one's
   trailer. The original defect through a narrower door.
3. The takeover added to fix (2) was **not exclusive**: two concurrent callers
   holding the same identity both returned `dispatch`. Independently reproduced
   here at 50/50 before the fix and 0/50 after.

### Mutations

Each applied alone, compiled, ran, and produced a wrong answer — not a crash.

| Guard | Landed mutation | Observed red | Restored |
| --- | --- | --- | --- |
| slot clear in the three in-repl runners | `const cleared = { ok: true as const, detail: '' }` | round-two test returned `unknown / "Trailer could not be read or validated."` where `blocked` is correct; `slotAtDispatch` read `{"step_id":"build-0",...}` instead of `ENOENT` | Green |
| headless reservation gate | `if (dispatch) {` to `if (true) {` | `a resumed step keeps its own receipt instead of re-dispatching` returned `unknown` where `completed` is correct | Green |
| arming distinction | restore the pre-arming rule: any pre-existing reservation is a resume | reds exactly the three restart-window tests and nothing else | Green |
| exclusivity | allow an unarmed holder to be adopted | `exactly one of many concurrent callers may dispatch a step` reds with two dispatches | Green |

### Verification

- `bun test runtime/workers/` — **251 pass, 0 fail**
- `tsc --noEmit`: 3 errors with and without this change, none in the touched
  files (pre-existing, in `whisper-install` and `fire-and-forget`).

### Tests changed rather than added

Four tests pre-seeded the slot before `run()` — the exact pattern this change
forbids. They now seed through the dispatch turn, which is what a real worker
does. `an unreadable trailer is unknown` now asserts the refusal happens *before*
dispatch: a path that is a directory can never hold a trailer, so no worker is
spawned for it, and the detail names the slot.

### Checked and found clean

The review panel does **not** share this defect: `trident/project-review-source.ts:77`
gives every seat dispatch a fresh `mkdtemp` directory, so its `result.json` is
already per-attempt. A negative result, recorded as one.
