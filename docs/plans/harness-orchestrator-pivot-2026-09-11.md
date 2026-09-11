---
type: plan
title: "The harness-orchestrator pivot — cutover definition, locked design, ordered steps"
created: 2026-09-11
status: locked (design) · not started (build)
decision_home: SPEC.md § Decisions Log 2026-09-11
---

# The harness-orchestrator pivot

This is the consolidated record of the 2026-09-11 strategy session in which the owner
redefined what Neutron is, locked the design of the rebuilt build system, defined the
cutover, and moved the build home to a herdr session on the VPS against this checkout.
Every design point is the owner's; every measurement names its instrument. Harness facts
are dated and rot monthly — re-verify before building on any of them.

**The decision home is `SPEC.md` § Decisions Log 2026-09-11.** This document owns the
detail — the interview record, the evidence, the ordered steps — and never restates a
decision as its own.

---

## 1. What Neutron is

The owner, verbatim:

> "I really see Neutron as a harness orchestrator. So it's for people who run harnesses
> like Claude Code, Codex, Open Code, Pi, etc. … and Neutron is a layer that sits above
> that, providing memory, providing crumbs, providing document grouping, projects,
> application specific cores, all that stuff. It's a way of interacting with harnesses
> more efficiently, or maybe more beautifully than just SSHing in and working in the
> harness directly."

And the governing constraint on how it is built:

> "I don't want any kind of not-invented-here syndrome. I want the best of the best …
> standardise as much as possible on what the community is already building and using
> rather than trying to reinvent the wheel."

Applied both ways. Where the community does a thing better, adopt it. Where it does not,
Neutron owns it — and the 2026-09-11 measurement of the herdr plugin ecosystem says the
memory/crons/orchestration layer is exactly that: 1,112 `herdr-plugin` repos, 78% under
5★; memory has 17 keyword hits, mostly RAM monitors, and the one real one (3★) ships with
its recall hook disabled; crons are sixteen separately re-invented `setsid`+`flock`
daemons because herdr has no clock; orchestration is one 5★ repo with the right shape and
no release. The ecosystem is *eyes*, not *memory*. That is a strong position for Neutron
to occupy. (Source: `search/repositories?q=topic:herdr-plugin`, control `topic:rust`
123,541 — recorded in the Managed repo's
`docs/research/harness-strategy-paths-2026-09-11.md`.)

**Neutron and herdr:** Neutron is the layer above. Herdr is a substrate Neutron hosts
sessions under — not the reverse. The owner must always be able to `herdr session attach`
and move seamlessly between working in herdr directly and working in Neutron. Listing
Neutron on the herdr plugins page is promotion, not architecture.

## 2. The cutover definition

> "Live means I'm using Neutron instead of the legacy system every day for everything, on my phone
> and on my computer via the web app … it's really difficult to have these two places
> that I talk, and two sets of contexts accumulating."

What stands between the owner and that, in his words, 2026-09-11:

1. **Trident works.** "One of my primary use cases is building. So I can't cutover."
   Hard blocker.
2. **Herdr is the REPL container; the PTY host is gone.** "I don't want to cutover until
   we've pivoted to using herdr as the underlying REPL container instead of this opaque
   PTY thing." Hard gate.
3. **The migration runs.** The private one-time migration tooling is single-use — "expected to
   be deleted after the cutover" — and was last pushed 2026-08-07. Five weeks of Open drift to
   re-verify every lane against before `--apply`.
4. **Web/mobile rough edges — post-cutover**, "AS LONG AS TRIDENT WORKS." The one
   exception is the model-switch affordance (§ 3.6), which is daily-use the moment the
   orchestrator exists.

Nothing else in the vision blocks the cutover. **Pre-cutover harness scope: Claude Code
and Codex as the project REPL.** Pi next, later. All incremental.

## 3. The locked design

### 3.1 The project REPL is the orchestrator

One REPL per project, long-lived, model-switchable in place. It holds the conversation,
it runs the build, and it is the **only** thing that ever asks the owner a question — in
the chat, as part of the conversation the owner is already in.

This supersedes the shared-launcher-REPL model, in which one warm interactive session
hosted every run's workflows in-process. That design's failure is #8 below.

### 3.2 Bounded work splits on MODEL, not on kind

> "If it's same-model (e.g. claude REPL running a bounded claude task, or codex REPL
> running a bounded codex task) they should be dispatched as subagents. Only cross-model
> bounded tasks (different model provider than the repl) should be run as new headless
> harnesses."

- **Same model as the REPL → a subagent inside it.** Warm cache, shared MCP connections,
  no new process. The cost of the alternative is measured: each headless `claude -p` job
  on 2026-09-11 paid 23,799 / 23,799 / 27,603 `cache_read_input_tokens` just to warm up.
- **Different model → a headless worker of the other harness.** A bounded function: input
  in, result back to the orchestrator. **It never talks to the owner.** If it cannot
  proceed it returns "blocked on X" to the orchestrator, which decides whether that is
  worth the owner's attention.
- Both harnesses have first-class subagents: Claude Code's `Agent` tool; Codex
  multi-agent v2 — TOML-defined agents, `spawn_agent` with named tasks, path addressing
  (`/root/researcher/summarizer`), `send_message` / `followup_task`, each in its own
  context window and sandbox, with a per-session concurrency cap.

### 3.3 Persistent-per-harness vs one-shot headless: a spike decides

For recurring cross-model work in a multi-day build (test agents on codex, say), one
persistent codex REPL beside the Claude one would give codex work warm cache and its own
subagents. The owner's criterion, verbatim:

> "This depends on how difficult it is to build this persistent codex and get it to
> actually work. If it's going to be riddled with bugs and all fucked up like our trident
> workflow so far, then we should just one-shot headless each time. If it can be built
> EASILY and will be robust, then the shared repl is better for cost reasons."

**The spike:** a persistent codex session on the ChatGPT subscription — `codex app-server`
or a codex TUI under herdr — that must (a) accept follow-up turns reliably, (b) survive a
gateway restart and resume, (c) complete an approval round-trip. All three with no
fragility → one active REPL per harness the project uses. Otherwise headless per call.
About two hours; its result shapes one adapter; nothing else waits on it.

### 3.4 Owner questions flow from exactly one place

The orchestrator, in chat. A subagent returns its need; the REPL asks the owner in the
conversation. There is **no** emit/checkpoint/resume protocol between a headless stage
and the owner's surface. That protocol was proposed on 2026-09-11 and withdrawn the same
day: it solved a problem created by the (wrong) assumption that every stage is headless.

### 3.5 Planning is a conversation that writes a spec

> "Its just a fucking conversation that writes a spec. We don't need to invent shit like
> 'planning mode'."

"Go" is the same REPL starting to orchestrate against that document. The planning
conversation runs on a high-reasoning model (§ 3.6) and switches down to orchestrate.

### 3.6 Harness capabilities: narrow, via pass-through — the first is model switching

Do **not** abstract goals / loops / heartbeats / compaction into a common seam. Two of
fifteen harnesses have a `/goal` and they mean different things; the result would be a
lowest common denominator. The owner's own reframe: Neutron owns the loop, the harness
owns the turn, and harness-native features reach the owner by **pass-through** when the
harness has them ("e.g. when on claude or codex be able to pass through a /goal command").

**The first concrete pass-through is in-place model switching**, because the planning
conversation needs Fable 5.1 / Astra and the orchestration does not:

> "I need to be able to switch the conversation REPL to Fable 5.1 or Astra (depending on
> whether I'm in claude or codex etc), do that planning conversation, then switch back to
> a cheaper model for the actual build orchestration."

> "I'm going to need a UX affordance in the neutron web and mobile app to know what model
> we are currently using, and easily switch. This might require some custom per-harness
> code."

So: a narrow per-harness capability — *current model · available models · switch* — with
harness-specific implementations behind it, surfaced in web and mobile. Verified
2026-09-11 (all from docs; the codex facts from the Codex Knowledge Base):

| | Claude Code | Codex |
|---|---|---|
| In-place switch | `/model`, immediate, **context preserved** | `/model`, **context preserved**, since v0.117.0 (local 0.153.4) |
| Cost nuance | prompt caches are model-scoped → the switch back re-processes the accumulated context once. Mitigation: write the spec to disk, `/compact`, then switch down | reasoning effort, fast mode and service tier are independently switchable in-session |
| High-reasoning target | Fable 5.1 on the owner's Max — confirmed (the strategy session ran on it) | **Astra = `gpt-6-astra`**, `/model`-selectable since 0.153.1; **Trusted-Access-gated and API-metered ($10/M in, $50/M out) as of 2026-09-10** — the owner checks his own access and pool |

**Today Neutron has no slash-command pass-through at all** — measured: nothing in the
Claude Code adapter (`runtime/adapters/claude-code/`) or the live-turn path handles a
leading `/`; chat text is injected as a *message* via the dev-channel MCP, so `/model`
typed in Neutron chat reaches the model as prose. Green field.

### 3.7 Herdr is the REPL container; the PTY host goes

The owner's hard gate (§ 2). What herdr gives, verified from source at `herdrdev/herdr`
(37.7k★, branch `master`, read 2026-09-11):

- **Durability across detach:** the background server keeps terminals running when the
  client closes or the SSH connection drops (README). The REPL does not die in the common
  case.
- **Resume across a herdr session restore:** supported agent panes are re-launched into
  their native conversation sessions. `src/agent_resume.rs` `pub fn plan(...)` at `:136`
  builds the per-agent argv — claude `--resume` `:145`, `codex resume <id>` `:150`,
  copilot `:153`, devin `:156`, droid `:159`, omp `:175`; 25 agent-name literals. Gated
  by `resume_agents_on_restore`, **on by default**: `src/config/model.rs:270`
  (doc comment "Default: true"), `impl Default` `:276`, asserted by the test at `:1392`;
  applied in `src/persist/restore.rs:788` with a duplicate-session guard at `:810`.
- **The regression it repairs:** with the legacy system the owner attached to tmux; the PTY pivot
  removed that. This repo's own words — `activity-inspector.ts:4-7`: "In the legacy system the escape
  hatch was attaching to tmux; Neutron's sessions are server-side, so there is no
  equivalent at all."

Environment: herdr 0.8.2 is installed for the owner's service user on the VPS and its server is
running; 0.8.2 is also on the owner's Mac.

Honest read, recorded so nobody re-litigates it: herdr is an excellent terminal
substrate, funded days ago, bus factor 1, pre-1.0 with no compatibility promise on its
socket API. Its socket is process control plus a five-state overlay — no methods for
goals/loops/heartbeats/compaction, and its `blocked` state for Claude Code is screen
regex. That is fine for what Neutron asks of it (host, attach, resume, status). It would
not be fine as the orchestration layer, which is why Neutron is the layer above.

### 3.8 Why the old shape failed, and what #501 fixed

Trident never merged a PR autonomously. Measured 2026-09-11 against the live instance's
`code_trident_runs`: **291 runs → 208 failed, 74 stopped, 9 done.** The 9 all opened PRs
and all 9 merged — **by hand** (`gh pr view … mergedBy` = the owner on every one; the last
40 merged PRs on `rjunee/neutron` show no automation login). Five of the nine were
mechanical "rebase X on Y" PRs. All within 2026-08-15 → 18; none since. The owner's own
definition of flowing, `docs/getting-to-flow.md`: *"A card is dispatched, and reaches
merged with no human touching it."* That number has always been 0.

Failure taxonomy (`failure_reason`, top of 291): 38 "no progress for 90 min — suspected
agent hang", 26 "fire turn did not settle within the budget", 74 cancelled, 21 rolled back
at round 1, 13 rebase conflicts. Root cause, diagnosed with forensic proof on 2026-09-03
(`docs/plans/root-cause-found-fable-5-1-high-confidence-abandon-poison-ev-p5m2r3.md`):
control flow lived inside an LLM turn on **one shared launcher REPL** hosting every run's
workflows in-process. One run's fire turn overran the 3-minute settle budget →
`inner-loop.ts` cancelled it → the session was marked poisoned → the next run to fire
evicted it with SIGKILL → every workflow inside died (the Argus panel at
`inner-workflow.mjs:5995`, the arbiter, cleanup). 23 of 25 hang-reaps were preceded by an
eviction. Only the codex build was detached (`inner-workflow.mjs:1878`, `nohup setsid`)
and therefore survived.

**#501** (merged 2026-09-11) stops that chain while the shared REPL exists. **One
orchestrator per project ends it structurally:** evicting a project's REPL kills that
project's build, which is correct, not fratricide.

**The premise that produced the shared REPL was measured false the same day.** Headless
`claude -p` on the owner's Max OAuth draws from the subscription's 5h/7d windows: three
bounded jobs, ~51k output tokens, 5h window 0.82 → 0.86, 7d 0.64 → 0.65, rises aligned on
job boundaries against +0.01 background drift; no `ANTHROPIC_API_KEY` anywhere on the box
(unit, login env, gateway environ all checked); extra-usage off. Instrument:
`auth/credential-usage-probe.ts` → `usage_pool_samples`, one row per minute. The
announced June-15 metering that justified interactive-only was paused and never took
effect. Full record: Managed Decisions Log 2026-09-11.

**Keep the gates, replace the loop.** The leak preflight, pinned merge, cross-model gate,
seat rotation, mutation prover and the arbiter rule are ahead of every shipped system
surveyed and stay. The loop — control flow in a turn, session-bound workflows,
model-transcribed checkpoints, liveness only at phase boundaries — is what goes.

## 4. The steps, dependency-ordered

Each is its own PR; each lands **wired + served + verified on this instance** before the
next starts. "Merged" is not done.

1. **#501 — landed** (merged 2026-09-11, 17/17 CI green). It stops today's bleeding so
   nothing dies while the rest is built. Verified on `main` after merge: the
   timeout-path cancel (the poison source) is gone; the one `handle.cancel()` that
   remains, `inner-loop.ts:983`, is the `ev.kind === 'error'` path and is meant to stay;
   `DEFAULT_SETTLE_TIMEOUT_MS` is 8 min. No residual.
2. **Herdr as the host.** Replace the PTY host (`runtime/adapters/claude-code/persistent/`,
   the `--bg-pty-host` / rendezvous-socket machinery) with a herdr-backed host over its
   socket API. Acceptance: the owner can `herdr session attach` to any project REPL from
   SSH, and a gateway restart brings every project REPL back with its conversation.
   Prototype cost estimated at ~1 day in the strategy research (spike #7 there).
3. **The orchestrator.** Project REPL as orchestrator on the herdr host; bounded work
   split on model (§ 3.2); questions only via the REPL in chat (§ 3.4). The trident core,
   rebuilt — gates kept, loop replaced. Acceptance: a card is dispatched and reaches
   **merged** with no human touching it.
4. **The codex persistence spike** (§ 3.3). Its result shapes one adapter.
5. **Migration.** The private one-time migration tooling, overlay pattern: `export NEUTRON_OPEN=<this
   checkout>`; `bash scripts/overlay.sh install`; `bun run open/import-the legacy system-cli.ts all`
   (**dry run is the default everywhere**) — review — `all --apply`; `bash
   scripts/overlay.sh remove`. Re-verify every lane against current Open first.
6. **Cutover.** Then web/mobile polish, with trident working.

Post-cutover increments, not blockers: pi; further harnesses; the full per-harness
switching surface beyond the model affordance.

## 5. Build home

A herdr session on the VPS, as the owner's service user, against this checkout
(`Projects/neutron-open/code`). Reasons: it is engine work and lands in Open regardless;
building the new orchestrator *inside* the old trident is bootstrapping on the thing
being replaced (the owner's 2026-09-01 plan already avoided this — "a Fable agent
orchestrates these changesets directly, not through trident dispatch"); herdr is already
there. The Telegram strategy topic no longer dispatches builds. Two parallel workstreams
was the confusion; this is the consolidation.

## 6. The interview record

Answers the owner gave on 2026-09-11 that shaped the above, kept because a future reader
should see the reasoning, not just the conclusions.

- **"Live" =** complete cutover, phone + web, every day, everything. Not a feature
  milestone.
- **Server or client?** Both: Neutron is the layer above herdr owning memory / graph /
  crons / comms with the apps; the app is the primary interface; SSH-to-herdr must always
  work and the two must move seamlessly.
- **Switch harness anytime, not only at project creation** — accepting that a switch
  clears the session context. Counter-argument offered and accepted as the real
  constraint: context portability is cheap; *capability asymmetry* is the hard part, so
  switching is cheap for a conversational project and impossible mid-build (the receiving
  harness may have no equivalent of the loop the work lives inside).
- **Trident's vision, verbatim:** plan and spec up front in conversation → "go" → break
  into tasks → build agents → adversarial review → cross-model review → auto-escalate
  disputes to a higher-reasoning model → run the suite → find and fix bugs → only
  occasionally surface a question that genuinely needs the owner, in a simple clear
  interface. Never seen working. Of its eight steps, the 2026-09-11 research found 2/6/7
  solved everywhere (and trident failed at them anyway), 3/4/8 partial, and step 5 —
  escalate disputes to a stronger model — shipped by nobody.
- **Cores** are a differentiator, not the only product: deterministic scaffolding around
  the model for recurring tasks ("an on-the-fly app" — running marketing, daily pool
  chemistry, workouts). Priority: the owner can create one quickly → other users can →
  a marketplace. Selling them is the least of it. No ecosystem covers scheduled
  scaffolding + state + UI + marketplace as one unit; adopt `SKILL.md` +
  agent-plugins.org + MCP Apps as the *format*, keep the runtime.
- **Phone pain:** none specific beyond the cutover itself — "I want to use Neutron."

## 7. What this does not decide

- The internal stages of the rebuilt trident beyond the model-split rule.
- Per-project harness *switching* mechanics (as distinct from per-project *pinning*).
- Whether the eval harness (Managed dispatch queue #28) becomes the cutover's acceptance
  instrument.
- Anything about Managed hosting; this is all engine.
