# As-built — #1119: a new round clears its result slot

## What was wrong

Run `67e8230e` reached further than any project build before it: plan worker
completed, build worker completed (`build.result`, `kind: completed`), commit
`d9e415d9`, `build-driver-settled {"kind":"continued"}`. It then went terminal
with `project driver settled without determining the outcome: Trailer step_id
missing or mismatched.`

The result slot is keyed by **role** and the step filling it by role **and
round**:

- `open/wiring/project-build.ts:366` — `path: join(state, `${role}.result`)`,
  composed once at prepare time. The file's own comment at `:344` states that
  `step_id` is per role AND round and so cannot be baked in there.
- `trident/build-run.ts:319` — `step_id = `${run_id}...:${role}:${round}``.

Nothing removed the file between rounds. `grep -rn "unlink" trident/ runtime/
open/` finds no result-file removal (positive control: it does find
`trident/worktree-reaper.ts:1607` and `runtime/atomic-write.ts:36`).

Round two of a role therefore dispatched against round one's trailer, and two
readers took it for this round's answer:

1. `runtime/workers/project-runners.ts:50` — the exact terminal string above.
2. `runtime/workers/claude-acting-turn.ts:200-202` — returns `turn-ended` the
   instant the path exists, which on round two is true before the dispatch is
   even submitted. No worker of that round had run.

This is the same defect class as #1111: an outcome judged on history rather than
on what arrived after the dispatch.

## What was built

`runtime/workers/trailer-slot.ts` — `clearTrailerSlot(path)`, called at **first**
dispatch only, in all four runners (`claude-in-repl`, `codex-in-repl`,
`pi-in-repl`, `codex-headless`). Absence is success; any other failure is
reported as `unknown`, because "there was nothing to clear" and "the earlier
trailer is still there and I could not remove it" must not share a signal.

The headless runner had no reservation of its own and so could not tell a first
dispatch from a resume. It now uses the same sha256 `(run_id, step_id)`
reservation as its siblings. This was found by adversarial review, not by me: the
first version of this change cleared on every headless `run`, which destroyed a
resumed step's completed receipt and dispatched it a second time.

## Mutations

Each applied alone, compiled, ran, and produced a **wrong answer** — not a crash.

| Guard | Landed mutation | Observed red | Restored |
| --- | --- | --- | --- |
| `clearTrailerSlot` call in the three in-repl runners | `const cleared = { ok: true as const, detail: '' }` | `a second round of the same role is not answered by the previous round's trailer` returned `{kind:'unknown', detail:'Trailer could not be read or validated.'}` where `{kind:'blocked', on:'file evidence'}` is correct; `slotAtDispatch` read `{"step_id":"build-0",...}` instead of `ENOENT` | Green |
| `codex-headless` reservation gate | `if (dispatch) {` → `if (true) {` | `a resumed step keeps its own receipt instead of re-dispatching` returned `unknown` where `completed` is correct | Green |

## Verification

- `bun test runtime/workers/` — **242 pass, 0 fail**
- `bun test runtime/workers/ trident/project-build-host.test.ts trident/project-review-source.test.ts` — **272 pass, 0 fail**
- `tsc --noEmit`: 3 errors with and without this change, none in the touched files
  (pre-existing, in `whisper-install` and `fire-and-forget`).

## Tests changed rather than added

Four tests pre-seeded the slot before `run()` — the exact pattern this change
forbids. They now seed through the dispatch turn, which is what a real worker
does. `an unreadable trailer is unknown` now asserts the refusal happens *before*
dispatch: a path that is a directory can never hold a trailer, so no worker is
spawned for it, and the detail names the slot.
