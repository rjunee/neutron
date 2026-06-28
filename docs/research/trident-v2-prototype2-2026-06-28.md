---
title: "Trident v2 Prototype-2 — de-risking the CC Dynamic Workflows cutover (findings)"
type: research
status: complete
date: 2026-06-28
author: Forge (fleet, Opus 4.8, CC 2.1.195)
plan: neutron-managed/docs/plans/2026-06-28-001-feat-trident-v2-dynamic-workflows-auto-mode-plan.md
specs:
  - /Users/ryan/vajra/docs/specs/trident-v2-dynamic-workflows.md
  - /Users/ryan/vajra/docs/specs/trident-auto-mode.md
verdict: GO-WITH-CHANGES
---

# Trident v2 Prototype-2 — findings

**This is Phase 1 (prototype + findings), NOT the cutover.** No real trident inner
loop was converted; no live wedge/dev-channel code was touched. The deliverable is
this doc + the reference seed script
(`docs/research/trident-v2-proto2-workflow.prototype.mjs`).

Every claim below is backed by a **real CC Dynamic Workflow run** in this repo
(CC **2.1.195**, native `Workflow` tool), not docs inference. Run IDs are cited so
the runs are auditable in the session transcript dir.

## TL;DR — `PROTO2_VERDICT = GO-WITH-CHANGES`

The native `agent()`/`parallel()` orchestration primitive is solid: all three
gating unknowns resolved favorably, and the deepened plan's corrections (C1–C8,
D-1) held up under real runs. The cutover is safe to commit to **with two
implementation requirements baked in** (both already implied by the plan; the
prototype makes them load-bearing and concrete):

1. **Worktree cleanup MUST be explicit on every path** — the harness auto-removes
   a worktree only if it is *unchanged*; a Forge agent always changes its
   worktree, so it is orphaned unless trident removes it. (This is exactly D-1.)
2. **Long/verbose command output MUST be redirected to a file** inside agent
   prompts; agents read only the summary tail. This is what let one agent run the
   full 8638-test suite without overflowing its context.

Everything else (permission inheritance, budget, parallel review, checkpointing,
same-session resume) works as the plan assumed.

## Evidence runs

| Run | Run ID | Agents | Wall | Subagent tokens | What it proved |
|---|---|---|---|---|---|
| Probe | `wf_37445a37-975` | 1 | 36s | 22.7k | Q2 permission inheritance, Q3 budget |
| Main pipeline | `wf_13f3e3c8-726` | 4 | 365s | 97k | Q1 long-build, worktree D-1, parallel review, checkpoint |
| Resume | `wf_37445a37-975` (resumed) | 0 (cached) | 8ms | 0 | same-session `resumeFromRunId` |

---

## Q1 — LONG BUILD (the #1 risk): **YES, it completes. → GO**

A single workflow `agent()` ran the **full real Neutron test suite** end-to-end:

- **822 files / 8638 pass / 0 fail**, wall-clock **281s (~4.7 min)**, via the
  repo's partitioned bounded-memory runner (`bash scripts/run-tests.sh`: 9 general
  chunks ≤100 files + a serial 10-file PGLite lane).
- **No timeout. No per-agent token cap hit. No context overflow. No OOM/killed/RSS
  warning** anywhere in the log.

**The mechanism that made it work (the mitigation, now a requirement):** the agent
redirected the ~4800-line / 351 KB verbose output to a log file
(`bun run test > …/proto2-fulltest.log 2>&1`) and read **only the summary tail**.
Its own context never ingested the bulk output, so there was nothing to overflow or
truncate. Without this, a very verbose build *could* blow an agent's context.

**Extrapolation to a true 20min–2hr build:** the binding constraints for a long
build are NOT agent-context (mitigated by redirect-to-file, which is independent of
duration) — they are process-level wall-clock and the build streaming output. An
`agent()` has full tool access and no hard wall-clock cap was observed at ~5 min.
Recommendation: the inlined Forge prompt must MANDATE output-redirection for any
long command (baked into the seed script's `REDIRECT_RULE`). If a future build is
pathologically long, the existing partition/chunk pattern (`run-tests.sh`) is the
ready mitigation — split the heavy step across chunked agent() calls.

> Q1 answer: **a single workflow agent() runs the full real suite cleanly; the only
> requirement is redirect-verbose-output-to-file.** GO.

---

## Q2 — PERMISSION INHERITANCE (the C5 conflict): **INHERITED from the launcher**

Resolves the open C5 conflict (one research agent said subagents inherit the
launcher mode; the other said `agent()` subagents always run acceptEdits+allowlist).
**Empirically: they inherit the launcher's mode.**

A probe agent attempted six ops and reported the literal result:

| Op | Category | Outcome |
|---|---|---|
| `git status --short` | allowlisted | executed |
| `cat package.json` | allowlisted | executed |
| `uname -a` | non-allowlisted | **executed** |
| `whoami` | non-allowlisted | **executed** |
| `printf x > .git/PROTO2_PROBE_DELETE_ME` (protected path) | denied-by-rule | **executed** (file created, then cleaned up) |
| `git push --force --dry-run …` | denied-by-rule | **executed** (only git's own refspec error) |

Every category auto-executed with **no prompt and no denial**. Crucially, an
`acceptEdits`+allowlist subagent would have *blocked* the `.git/` write and would
not auto-run arbitrary `uname`/`whoami` — so the subagent was **not** hard-pinned to
acceptEdits+allowlist. It ran under the parent session's mode (this fleet Forge
launched with `--dangerously-skip-permissions`).

**Implication for Phase 3 (auto-mode):** set the permission mode **once at the
workflow launcher** (`dontAsk` + complete allowlist + PreToolUse deny hook); every
Forge/Argus subagent inherits it. The subagents' safety rests entirely on the
launcher's policy, exactly as `trident-auto-mode.md §4` predicts.

**Caveat (one residual gate):** this confirmed the *inheritance mechanism* under a
**bypass** launcher (everything executed). It did NOT exercise the `dontAsk`
auto-deny path. Phase 3 must still validate that launching from a `dontAsk` session
(a) auto-denies a non-allowlisted op without hanging and (b) the agent continues.
The inheritance direction is settled; the deny-behavior under `dontAsk` is the
remaining empirical check (it is the never-stuck checklist item, not a new unknown).

---

## Q3 — BUDGET primitive: **PRESENT & FUNCTIONAL in 2.1.195**

The `budget` global exists and reports correctly:

- `budget.spent()` tracked real cumulative output tokens across agents (probe:
  18,436 mid-run, matching the 22,730 reported subagent usage; pipeline climbed to
  45,537).
- `budget.total` and `budget.remaining()` were `null` because **no `+Nk` turn-level
  target was set** on this fleet run.
- **Doc drift note:** `workflows.md` says `remaining()` returns `Infinity` with no
  target; in 2.1.195 it returns `null`. A budget gate written as
  `while (budget.total && budget.remaining() > X)` still works correctly (`null` is
  falsy), so the documented loop-until-budget pattern is safe.

**Enforcement** (the hard throw when `spent() >= total`) is gated on a non-null
`total`, which requires a turn-level `+Nk` directive — not present on this run, so I
verified **reporting + the gate code path**, not the throw. For trident-v2 cost
control, pass a budget target at launch; reporting/gating logic is confirmed
available now.

---

## D-1 WORKTREE (now allowed) — cleanup is REAL WORK, and it's EXPLICIT

**The decisive finding.** The Forge agent ran with `isolation:'worktree'`, which
created a fresh worktree at `.claude/worktrees/wf_13f3e3c8-726-1` (naming:
`.claude/worktrees/<runId>-<n>`), on branch `proto2-throwaway-build`. It built two
files, ran the test (3 pass), and committed (`4a0b37a`).

**After the workflow returned, the worktree was STILL ON DISK** — orphaned, with the
commit and branch intact. The harness did **not** remove it.

This is the tool's documented `"auto-cleaned if unchanged"` semantics meeting
reality: a Forge agent **always changes** its worktree (it commits), so the
worktree is **never** in the auto-clean-eligible "unchanged" state. **Left to the
harness, every trident-v2 build orphans a worktree** — precisely the
worktree/node_modules cruft accumulation that drove the June fseventsd CPU-peg
wedge.

**Cleanup is achievable and clean — but trident must do it explicitly.** Verified:

```
git worktree remove --force .claude/worktrees/wf_13f3e3c8-726-1   # OK
git branch -D proto2-throwaway-build                               # OK
git worktree prune                                                 # OK
```

→ worktree count returned to the pre-create baseline (72), the on-disk dir was
gone, the branch was gone. **`git worktree list` shows NO orphan.**

- **Isolation worked:** the main checkout (`/Users/ryan/repos/neutron-open`) stayed
  clean — no `trident/proto2-demo.ts` leaked into main. Concurrent file-mutating
  agents each get their own worktree (this is why D-1 dissolves the C3 builder-lock
  requirement).
- **Setup cost:** the worktree was present within seconds of launch (locked during
  the run, unlocked on completion). Cheap relative to the ~5-min build.
- **`worktree-cleanup-confirmed = YES`**, with the load-bearing condition that it
  must be **explicit on ALL paths** (success / REQUEST_CHANGES / throw / abort /
  crash). The seed script wraps the whole inner loop in a `finally` that removes the
  worktree+branch after the branch is pushed (so nothing is lost). The
  `merge.ts:15-18` "NO `git worktree remove`" comment must flip to *enforce*
  removal, as D-1 already states.

> Note: a separate forced-failure run is unnecessary — the **success** path already
> orphaned the worktree, which is the stronger result: cleanup is needed on *every*
> path, not just failures.

---

## Same-session resume (`resumeFromRunId`): **CONFIRMED (in-session only)**

Re-invoking the probe with `resumeFromRunId: wf_37445a37-975` returned in **8ms**
(vs 35,892ms originally) with **0 subagent_tokens / 0 tool_uses** — the completed
agent's result came entirely from cache. This is exactly the in-session behavior the
SQLite outer loop wraps. Consistent with deepen **C1**: cross-session resume does
NOT exist (exit CC → the workflow is gone), so the durable outer loop
(`TridentTickLoop` + `code_trident_runs`) remains required, and crash-recovery is
"relaunch a fresh workflow that reads the checkpoint and skips completed phases."

---

## Parallel adversarial review (`parallel()`): **CONFIRMED, no collision**

Two independent Argus `agent()`s read the *same* diff file concurrently:
`readOk=true` for both, no lock/collision error. They did genuine trident-grade
adversarial work on the throwaway `clampRound` helper:

- Both flagged the **name/behavior mismatch** (`clampRound` does no rounding).
- ARGUS-2 found a real **NaN-passthrough bug** (`clampRound(NaN,5) → NaN`) and the
  **`max < 0` invariant violation**, and issued `REQUEST_CHANGES`.
- Both flagged the **untested boundary equality** (`n===0`, `n===max`).

This validates spec §4c: the parallel-verifier pattern is strictly better than v1's
single Argus pass, and it produces evidence-backed findings — the basis for the
Phase 5 asymmetric-gating / minority-veto synthesis (encoded in the seed script).

---

## Checkpointing feasibility (C1): **CONFIRMED**

Mid-workflow, the Forge agent's Bash step wrote a checkpoint **two ways** and
verified both: (a) sqlite — `CREATE TABLE … INSERT('build','done')` then
`SELECT count(*) = 1` readback; (b) a file append. This proves the mechanism the
outer loop will use to checkpoint phase transitions to `code_trident_runs`
(migration 0077) from inside the workflow — a workflow `agent()` Bash step can
persist to sqlite/file mid-run. (Quick proof, not the full outer-loop integration.)

---

## Code reconciliation confirmed (verify-before-assert)

- `trident/merge.ts:15-18` — verbatim *"Ryan-locked: NO `git worktree remove`. Open
  uses plain branches, not Vajra's per-run worktrees…"*. This is the comment D-1
  requires flipping to **enforce** cleanup. **Confirmed.**
- **No `git worktree add` anywhere** in `trident/` or
  `runtime/adapters/claude-code/` → trident today uses **plain branches, zero
  worktrees**. Adopting `isolation:'worktree'` is genuinely net-new behavior.
  **Confirmed.**
- `build-repl-argv.ts:89` (`--dangerously-load-development-channels`) and `:107`
  (`--dangerously-skip-permissions`) — the dev-channel + reckless-permission lines
  the plan targets. **Confirmed.**

---

## GO / NO-GO recommendation: **GO-WITH-CHANGES**

The orchestration foundation is proven; commit to the Phase 2 hard cutover (D-2),
with these requirements folded in (none contradict the plan — they make C1/D-1
concrete and add one new rule):

1. **Explicit worktree cleanup on ALL paths** (D-1). Wrap every
   `isolation:'worktree'` agent so the worktree+branch are removed in a `finally`
   after the branch is pushed. Flip `merge.ts:15-18`. Gate: `git worktree list` is
   clean after success, REQUEST_CHANGES, throw, and crash-restart.
2. **Redirect long/verbose command output to a file** in every agent prompt; read
   only summary tails (NEW requirement surfaced by Q1). Without it, a verbose build
   risks agent-context overflow.
3. **Set permission mode once at the launcher** (`dontAsk` + allowlist + PreToolUse
   deny hook); subagents inherit it (Q2). **Still gate** the `dontAsk` auto-deny
   path on a real dontAsk-launched run in Phase 3 (I validated inheritance under
   bypass, not the deny path).
4. **Keep the durable outer loop + per-phase SQLite checkpointing** (C1) — workflows
   are session-bound; `resumeFromRunId` is same-session only. Checkpoint mechanism
   is confirmed feasible from an agent() Bash step.
5. **Budget**: pass a `+Nk` target at launch for hard cost enforcement; reporting
   works today. Treat `remaining()===null` (no target) as "unbounded".

**Plan corrections surfaced:** (a) add the output-redirection requirement to the
Phase 2 inlined Forge/Argus prompts; (b) the C5 conflict is RESOLVED (inherit), so
the plan can drop the "two agents disagree" hedge; (c) D-1 cleanup is not just
"ensure bulletproof" — it is *mandatory on the success path too*, because the
harness never cleans a changed worktree. No NO-GO blockers found.

## Cross-model review (Codex) — applied

A Codex (GPT) review of this PR caught **one real design flaw in the seed script**
(and it's a good dogfood signal for the Phase 5 panel): the original `finally`
cleanup read `forge.worktreePath`/`forge.branch`, so if Forge mutated its worktree
then **failed before returning** (tests fail, `gh pr create` fails, agent throws →
`agent()` returns null), cleanup was skipped — leaving exactly the orphan the
prototype prevents, breaking the "all paths" guarantee. **Fixed:** Forge now builds
on a deterministic branch `trident/<slug>`, and the cleanup step scans
`git worktree list` for that branch and removes it independent of Forge's return
value. Codex also noted top-level `return` fails `node --check`; that is the
Workflow runtime's documented result API (the real proto-2 runs used it
successfully) — annotated in the script rather than changed.

## Reproduce

The reference seed workflow is `docs/research/trident-v2-proto2-workflow.prototype.mjs`
(PROTOTYPE — not wired into the build). Run it via the CC `Workflow` tool with
`scriptPath` pointing at it. The probe + pipeline scripts from this run are persisted
under the session's `workflows/scripts/` dir (run IDs above).
