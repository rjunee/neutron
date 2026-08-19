# IMPLEMENTATION_PLAN — Ralph plans become a DAG; the re-fire launches WAVES

CARD: an N-task plan runs N strictly-serial rounds (~30–50 min each) even when most tasks
are independent. Give the plan format dependency edges + declared file surfaces, make the
re-fire launch every dependency-satisfied, surface-disjoint task CONCURRENTLY (one worktree
per task), and join each wave before the next one plans. Expected: 11 rounds → ~3 waves.

FORMAT (frozen by T1, dogfooded below):
`- [ ] T<n>: <title> | requires: none|T<i>, T<j> | surface: <path>, <path>`
— ABSENT `requires` = independent (the default is NEVER "depends on the previous line").
— ABSENT `surface` = undeclared → that task can never share a wave (conservative size-1).
— Legacy plain `- [ ]` lines parse as independent + surface-undeclared → exactly today's
  serial behaviour. Cyclic `requires` are REFUSED loudly at parse, never flattened.

DESIGN LOCK (decided round 1; later iterations execute, they do not re-litigate):
- Wave members are CHILD RUNS in `code_trident_runs` (`parent_run_id` + `wave_task_id`
  columns), so the EXISTING tick/step/checkpoint/liveness/crash machinery drives them
  unchanged. No second table, no second workflow engine.
- Children get distinct slugs (`<slug>--w<taskId>`) — the live-slug UNIQUE constraint
  (migration 0120) forbids sharing the parent's — and a UNIQUE(parent_run_id, wave_task_id)
  index makes wave spawn idempotent across crashes. Children never appear on the board.
- Each member builds in its OWN worktree on its OWN member branch `<runBranch>--w<taskId>`
  cut at the run-branch head (git forbids one branch checked out in two worktrees — "same
  branch" means the run branch they join, not a shared checkout). Members never write the
  plan file (it is a shared surface), never open PRs, never run Argus, never re-fire:
  a member's terminal is done-after-built.
- The JOIN is parent-side deterministic TS: integrate member branches onto the run branch
  in wave (document) order — disjoint surfaces make it conflict-free by construction; a
  conflict is a LOUD run failure naming the member and the surface declaration that lied.
  Successful members are checked off (one plan commit) BEFORE a failed member fails the
  run, so built work is preserved and a re-dispatch resumes with only the failure left.
- Wave size 1 takes the byte-exact existing reset path (legacy plans and undeclared
  surfaces degrade to today's behaviour). MAX_WAVE_SIZE is a small constant (3). The
  global lane cap is NOT touched. `ralph_round` counts WAVES. The parent's wave-wait
  state rides `inner_checkpoint='wave-wait:<ids>'` (no new phase enum), and the waiting
  parent must keep `last_advanced_at` fresh so the hang reaper never reaps it.
- The outer re-fire reads the committed plan via `run_host` from the SAME ref authority
  the plan probe uses (`origin/<branch>` in pr mode, local ref in local mode), parses it
  with `plan-graph.ts`, and refuses a cyclic/incoherent plan before anything launches.
- ORDINAL DRIFT NOTE (round 2): the branch now carries migrations up to 0136, so T2's
  migration takes 0137 — never renumber an applied file, never fill the historical gaps
  (0128/0129/0133); a gap ordinal applies out of order on live databases.

- [x] T1: plan-graph leaf — new pure module `trident/plan-graph.ts` (+ tests): parse the DAG checklist grammar above, refuse cycles/unknown/duplicate ids loudly at parse time, compute surface-disjoint waves with the undeclared-surface⇒size-1 rule, render check-offs byte-precisely | requires: none | surface: trident/plan-graph.ts, trident/plan-graph.test.ts
- [x] T2: store wave-child rows — migration 0137 (next free ordinal this round; regenerate migrations/expected-schema.txt) adding `parent_run_id`, `wave_task_id` + partial UNIQUE(parent_run_id, wave_task_id) to `code_trident_runs`; `TridentRunStore` create/COLS/rowToRun support with the both-or-neither pairing rule, `listChildren(parentId)`, exported `waveChildSlug` helper (`<slug>--w<taskId>`), `latestByProjectScope` excludes children; fixture defaults | requires: none | surface: trident/store.ts, trident/store.test.ts, trident/testing/make-trident-run.ts, migrations
- [x] T3: member-mode inner iteration — `buildWorkflowArgs`/`inner-workflow.mjs` accept a PINNED task (id + member branch): plan seat writes the exec spec for THAT task only (verbatim body, no re-selection), forge builds on the member branch, skips the plan-file write, skips Argus, reports built-terminal with commitSha; `applyResult` treats a child run's built result as terminal done (no merge, no re-fire, no review gate, no owner delivery — children carry chat_id null) | requires: T2 | surface: trident/inner-loop.ts, trident/inner-workflow.mjs, trident/inner-workflow.test.ts, trident/orchestrator.ts, trident/orchestrator.test.ts
- [ ] T4: wave-selecting re-fire — `refireNextRalphTask` reads + parses the committed plan (plan-graph), REFUSES cycles loudly (run fails naming the cycle, nothing launches), computes the wave; size ≤1 → byte-exact existing reset; size >1 → cut member branches at run-branch head, idempotently spawn child rows, parent → `wave-wait:<ids>`; MAX_WAVE_SIZE=3; ralph_round counts waves; children deliberately count toward the existing active-build gate (the lane cap is NOT raised) | requires: T1, T3 | surface: trident/orchestrator.ts, trident/orchestrator.test.ts
- [ ] T5: the join barrier — `step(parent)` in wave-wait: keep last_advanced_at fresh; when ALL children terminal, integrate member branches onto the run branch in wave order (realgit test), commit one plan check-off via renderCheckedOff, delete member branches, push (pr mode), release wave state into the normal re-fire/review path; conflict or failed member → loud named failure AFTER successful members are checked off; falsification tests: two independent tasks ⇒ two CONCURRENT child fires for one run (remove wave selection → red), `B requires A` ⇒ B never fires before A's result is harvested | requires: T4 | surface: trident/orchestrator.ts, trident/orchestrator.test.ts, trident/wave-join-realgit.test.ts
- [ ] T6: planner prompts + record — `planFablePrompt`/`planNextPrompt`/PLAN_SCHEMA teach the DAG grammar (ids mandatory, `requires: none` stated explicitly, surfaces = files the task will touch, omit surface when unsure ⇒ serial); docs/AS_BUILT.md entry quoting wall clock before (tonight's measured 11-task ≈ 5.5–9 h serial) vs after (critical-path × round time, measured via the harness sim where a live run is unavailable, labelled as such); verify `tools/lane_review.sh` exits 0 on the branch | requires: T1, T3 | surface: trident/inner-workflow.mjs, docs/AS_BUILT.md

VERIFICATION MAP (card falsification criteria → tasks): (1) concurrent-wave test → T5;
(2) chain ordering → T1 unit + T5 integration; (3) loud cycle refusal → T1 parse + T4
re-fire; (4) default-independence → T1; (5) wall-clock quote → T6; (6) production callers
(orchestrator imports plan-graph at T4) + lane_review exit 0 → T4/T6.

## Do not (copied verbatim from the card's plan doc)

_Source: `docs/plans/c-ralph-plans-are-a-flat-checklist-with-no-dependency-edges-gtc68g.md`. Do not paraphrase this section._

- Do not fan out a wave onto the SAME FILES. Two concurrent tasks editing one file is the
  collision this board already carries three cards about. Wave membership must additionally
  require disjoint declared surfaces — and if the planner cannot declare surfaces, the wave
  is size 1 and that is the correct conservative answer.
- Do not raise the global lane cap to accommodate waves.
- SURFACE: `trident/orchestrator.ts` (`refireNextRalphTask`), the plan parser, the planner
  prompt. COLLIDES with cards `01M09HZBTPR`, `01M09GDR0S`, `01M09EW0Y3`.
</spec>
<parameter name="status">upcoming
