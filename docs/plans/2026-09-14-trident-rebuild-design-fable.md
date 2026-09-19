---
type: plan
title: "Trident rebuild — ground-up design pass against the locked pivot"
created: 2026-09-14
status: proposed (design) · not started (build)
decision_home: SPEC.md § Decisions Log 2026-09-11 (the pivot) — this document proposes; it decides nothing
supersedes: nothing. Refines docs/trident-routing-gap.md § 5 step 3 into an implementable shape.
---

# Trident rebuild — design pass, 2026-09-14

Every claim about this tree below carries a `file:line` read in this checkout at
`37f095a2` (branch `fix/the-launcher-may-actually-run-the-workflow`, which is `main`
plus one commit). Every claim about an external harness is dated and marked
**verified from docs** or **unverified**; harness facts rot monthly. Anything that
disagrees with a locked decision is marked **PROPOSED CHANGE** and argued with
evidence; nothing locked is silently replaced.

Read first, in this order, before touching any step: the pivot
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md`), the multi-substrate arbiter pass
(`docs/plans/2026-08-09-multi-substrate-build-agent.md`), the gates inventory
(`docs/trident-gates-inventory.md`), the routing audit (`docs/trident-routing-gap.md`),
the acceptance spec item (`docs/spec-items/the-orchestrator-owns-the-build-loop.md`), and
the codex thread contract
(`docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md`).

---

## A. Verdict: the locked design holds. The code has not made it false. The code has never implemented it.

**Short form.** Every design point in the pivot §3 still stands. Nothing shipped since
2026-09-11 contradicts one; three things shipped that *narrow* one and are already
recorded in the Decisions Log (herdr host retained alongside the PTY host, 2026-09-12; REPL
host selected once per process, 2026-09-14; headless-per-call codex, 2026-09-12). The
reason progress feels random is not that the design is wrong. It is that **every line of
trident work since the pivot has landed on the loop the pivot deletes**, and the only
thing the tree hard-codes about Claude is the one thing the pivot says to remove.

Stop second-guessing §3.1–§3.4. Build them.

### A.1 What the code has made stale (anchors), not false (decisions)

| Locked text | What the tree says now | Class |
|---|---|---|
| Pivot §3.8: "the Argus panel at `inner-workflow.mjs:5995`", "codex build … `inner-workflow.mjs:1878`" | `#845` moved 2,980 lines of comment into `trident/inner-workflow-rationale.md`; the file is **6,944** lines (`wc -l`), not 9,339. The panel dispatch is now at `trident/inner-workflow.mjs:5126-5256`; the codex build bridge at `:1729-1794`. Token stream unchanged (`.trident/as-built/fix/828-workflow-script-fits-the-limit.md`, "streams were identical"). | stale anchor |
| Pivot §4 step 1: "the one `handle.cancel()` that remains, `inner-loop.ts:983`" | It is at `trident/inner-loop.ts:1114`, on the `ev.kind === 'error'` path as described. | stale anchor |
| `docs/trident-gates-inventory.md:5` baseline "9,315 / 6,316 / 1,167"; every `inner-workflow.mjs:NNNN` anchor in G020–G078, G124–G127, G132–G140, G159–G165 | All pre-`#845`. The gate IDs, tests and classifications hold; the line numbers do not. The routing audit's own measurement (9,339 at `ccb4f315`) is also pre-`#845`. | stale anchor |
| `docs/spec-items/the-orchestrator-owns-the-build-loop.md:20` "16,798 lines, intact" | 6,944 + 6,363 + 1,203 = **14,510**. Intact in every sense that matters: 229 declarations before and after (`#828` as-built). | stale measurement |
| Pivot §3.8 and SPEC.md:489 cite `docs/getting-to-flow.md` for the definition of flowing | The file is **absent from this tree**: `find . -name 'getting-to-flow*'` (node_modules excluded) returns nothing; `grep -rl getting-to-flow --include=*.md` finds only `SPEC.md` and the pivot. The definition survives verbatim at `SPEC.md:489` and `docs/spec-items/the-orchestrator-owns-the-build-loop.md:65`. | dangling citation |
| Pivot §3.7 "the PTY host goes" | Superseded 2026-09-12 (Decisions Log: "THE REPL SUBSTRATE BECOMES SELECTABLE"), owner-directed; `NEUTRON_REPL_HOST=herdr\|bun` since 2026-09-14. Already recorded; not relitigated here. | recorded supersession |

### A.2 The one hard-coded Claude dependency, named

`runtime/adapters/select-substrate.ts:22-26`:

> TRIDENT NOTE: this selector is for CONVERSATIONAL / utility LLM turns ONLY. Trident's
> autonomous build loop drives the native `Workflow` tool, which has NO OpenAI analogue —
> trident's fire substrate stays the Claude-Code warm-fire singleton regardless of a
> project's conversational provider.

and its capability table, `select-substrate.ts:91-102`: `detachedWorkflows: true` for
`anthropic`, `false` for both others. Everything downstream inherits it:

- `open/wiring/substrates.ts:545-580` builds one `cc-trident-fire-*` warm Claude REPL per
  repo cwd with `PROFILE_WARM_FIRE`;
- `gateway/composition/build-core-modules.ts:641` hands `buildWorkflowFirer` to the
  orchestrator; `trident/inner-loop.ts:968-1203` fires a Claude turn whose entire job is one
  `Workflow` tool call;
- `trident/inner-workflow.mjs` is a **Claude Code Dynamic Workflow function body** — its
  `agent()/parallel()/phase()/budget/log` are injected by that runtime and the file ends in a
  top-level `return` (`trident/testing/load-escalation-gate.ts:6-8`), which is why it
  cannot be imported and why 52 test files (50,110 lines) reach its functions by brace-
  matching text and `new Function` (`load-escalation-gate.ts:6-12`).

That is the whole of "hardcoding claude shit". It is one seam, one file, one profile, and
one 6,944-line script that only that runtime can execute. Below the script, the tree is
already substrate-shaped: `codex-build.sh` runs `codex exec` (`trident/codex-build.sh:1446`),
`codex-review.sh` likewise (`:534`), tiers carry a `transport` and an executor `group`
(`trident/model-tiers.ts:42-70`), phases declare which groups they can dispatch on
(`trident/phase-models.ts:123-126`), and the 28 `agent(` call sites in the workflow
(`grep -n '\bagent(' trident/inner-workflow.mjs`, comment lines excluded) already branch on
`route.transport` (`:1717`, `:5175`, `:5221`).

### A.3 Why today's five repairs confirm the design rather than the loop

Today's fixes (branch commit `37f095a2`; `#845`; `#862`; `#863`; the failed-fire cause at
`trident/inner-loop.ts:1114-1137`) are all the same defect class the pivot §3.8 names:
**the build's control flow lives inside an LLM turn, and the turn's tool/permission/size
envelope is the build's failure envelope.** The launcher had `Workflow` in `--tools` and
not in `--allowedTools` (commit message of `37f095a2`); the script exceeded the tool's
512 KiB cap (`#845`); the arbiter's reply was denied by permission mode (`#862`). None of
these can exist in a design where the loop is host code and a harness turn is one bounded
worker. The repairs were necessary to stop bleeding; they are not progress toward §3.1,
and the pivot §5 already says why: "the old trident is not used to build its own
replacement."

### A.4 What the pivot asserts about other harnesses, re-verified 2026-09-14

- **Codex multi-agent v2** (pivot §3.2): **verified from docs** (Codex Knowledge Base,
  "Multi-Agent Orchestration v2", updated 2026-09-14): enabled by `[features]
  multi_agent_v2 = true`; six tools `spawn_agent`, `send_message`, `followup_task`,
  `wait_agent`, `list_agents`, `close_agent`; per-role `.codex/agents/<role>.md` with
  sandbox and model; `agent_max_depth` (default 3); "a subagent cannot escalate beyond the
  parent's sandbox level". **Unverified:** whether `spawn_agent` is available under
  `codex exec` (non-interactive) and under a ChatGPT-subscription account — a filed
  upstream issue (`openai/codex#27331`) reports `spawn_agent` failing with a 400 on a
  ChatGPT account at 0.137.0. This must be a startup probe, exactly as the `resume`
  subcommand is (spec item contract 7).
- **pi** (pivot §1, "Pi next, later"): **verified from pi.dev, read 2026-09-14**: print mode
  `pi -p "…"`, `--mode json` event stream, an RPC mode (JSON over stdin/stdout), an SDK;
  and, in its own words, **"No sub-agents"** first-party — "spawn Pi instances via tmux, or
  build your own with extensions". Extensions are TypeScript modules that can add tools.
  A third-party `pi-subagents` extension exists. Post-cutover scope stands.
- **Claude Code**: the `Agent` tool is model-invoked only; there is no host-invocable
  "spawn a subagent" primitive outside a turn. Headless is `claude -p`, billed to the
  subscription (pivot §3.8 measurement). The project REPL's tool surface today is
  `LIVE_AGENT_TOOL_NAMES` (`gateway/wiring/build-live-agent-turn.ts:341-352`): Read, Glob,
  Grep, Write, Edit, Bash, Skill, Workflow, WebSearch, WebFetch — **no `Task`/`Agent`**
  (`grep -n "'Task'\|'Agent'"` over that file: none; positive control
  `trident/inner-loop.ts:567`). The project REPL cannot spawn a subagent today. §3.2's
  same-model branch has no mechanism yet.

---

## B. The substrate-agnostic architecture

### B.0 The reconciliation that makes §3.1 and §3.8 the same sentence

§3.1 says the project REPL "runs the build". §3.8 says "control flow in a turn … is what
goes". §3.6 has the owner's own reframe: **"Neutron owns the loop, the harness owns the
turn."** Read together:

- **The loop is host code.** A deterministic TypeScript state machine in the gateway
  process owns every transition build → publish → CI → review → synthesis → fix →
  proof → merge, every gate, every checkpoint write, every worktree, every git and
  GitHub operation, every budget. It runs whether or not any model turn is alive. This is
  what `trident/orchestrator.ts` already is for publish/merge/recovery (`publishBuiltCommit`
  `:2520`, `rebaseOntoObservedBase` `:1531`, `applyResult` `:4949`, `stepCore` `:5484`);
  the rebuild extends it *down* through the phases the workflow currently owns.
- **The project REPL is the seat of judgment and the only voice.** It is where planning
  is a conversation that writes a spec (§3.5), where "go" admits a card, where terminal
  decisions are taken (`gateway/proactive/terminal-build-wake.ts:96-140`, already the shape:
  one acting turn on the project conversation via
  `gateway/wiring/build-live-agent-turn.ts:1065`), and the only thing that asks the owner
  (§3.4; `#796`). It is also, per §3.2, the *process* same-provider bounded work runs
  inside — as its subagents.
- **A bounded worker is one harness turn** with a brief in and a result out. It never
  holds the loop. Its lifetime is one phase step. When it needs something it returns
  `blocked`; the host, and then the REPL, decide.

The seam between the two is the contract in B.1. There is exactly one of it, it is
TypeScript, it is imported — not injected — and every provider implements it or says
which parts it cannot.

### B.1 The contract — `runtime/bounded-work.ts`

Today these are ambient CC Workflow globals (`agent`, `parallel`, `phase`, `budget`,
`log`), which is precisely why there is one implementation. The replacement is an
explicit interface with **two halves that must not be confused**: what the *host* owns
(provider-independent, deterministic) and what a *provider runner* owns (one turn).

```ts
// ── Host-owned. One implementation. Deterministic. Never a model. ──────────────
interface BuildHost {
  // The run state machine. Every transition is a store write in this process.
  advance(run_id: string): Promise<AdvanceOutcome>          // replaces orchestrator.step()
  checkpoint(run_id, name, head: Oid, findings: Finding[]): Promise<void>  // replaces checkpoint.sh-via-agent
  // Workspace: the host cuts, pins and cleans worktrees. A worker is HANDED a cwd.
  cutWorktree(run_id, branch, base: Oid): Promise<{cwd}>     // build-workspace.ts, host-side
  cleanupWorktree(run_id, mode): Promise<CleanupOutcome>     // worktree-cleanup.sh, host-invoked
  // Measurements a worker may claim but never establishes:
  readHead(cwd, branch): Promise<Oid | 'absent' | 'unreadable'>   // G032/G033/G038
  materializeDiff(base: Oid, head: Oid): Promise<DiffArtifact>    // G035/G040/G102
  ciReadiness(pr): Promise<CiReadiness>                           // G044–G056, host TS
  publish / mergeApproved / proveMutation / leakPreflight         // unchanged, orchestrator.ts + merge.ts + mutation-prover.ts
  // Fan-out is host code: Promise.all over runners, with the seat retry policy (G059).
}

// ── Provider-owned. One per harness. One turn each. ────────────────────────────
interface WorkerRunner {
  readonly provider: 'anthropic' | 'openai-codex' | 'pi'
  // Answered BEFORE admission, from a static table + a startup probe; never at dispatch.
  supports(role: WorkerRole, placement: Placement): Supported | Unsupported
  run(req: BoundedWorkRequest, placement: Placement, signal: AbortSignal): Promise<BoundedWorkOutcome>
  liveness(handle: WorkerHandle): Promise<'activity' | 'nothing' | 'unknown'>   // run-evidence.ts vocabulary
}

type Placement = 'in-repl' | 'headless'   // decided by the host: provider === project REPL provider ? 'in-repl' : 'headless'

interface BoundedWorkRequest {
  run_id: string; step_id: string           // durable identity; the idempotency key for retries
  role: 'plan' | 'build' | 'fix' | 'review' | 'synthesis' | 'replan' | 'probe' | 'resolve' | 'arbitrate' | 'fix-leak'
  model_id: string; effort: Effort | null   // resolved from model-tiers.ts; the RESOLVED id is what is logged (multi-substrate plan §F)
  cwd: string; writable: boolean; network: boolean
  tools: ToolGrant                          // a named surface; 'none' for judges (arbiter stays toolless, Decisions Log 2026-09-12)
  brief: { path: string; integrity: string } // on disk, never argv (brief-parts.ts; MAX_ARG_STRLEN)
  result: { schema: JsonSchema; path: string }   // the TRAILER: host-chosen path the worker's harness writes
  thread: { id: string } | null             // §3.3: other-provider continuity; one owner per id
  budget: { wall_ms: number }
  needs_approval_decision: false            // literally the type `false`: true is refused at input (spec item contract 6)
}

type BoundedWorkOutcome =
  | { kind: 'completed'; result: unknown; usage: Usage; model_reported: string; thread_id: string | null }
  | { kind: 'blocked'; on: string }                       // §3.2: "blocked on X"; the worker NEVER asks the owner
  | { kind: 'refused'; reason: 'provider-not-connected' | 'capability-unsupported' | 'approval-needed' | 'cli-contract' | 'placement-unavailable' }
  | { kind: 'failed'; class: 'infra' | 'timeout' | 'killed'; detail: string }
  | { kind: 'unknown'; detail: string }                   // "could not find out" is not "failed" (memory: false and unknown must not share a branch)
```

Three rules that make the contract worth having:

1. **The trailer is a file the harness writes, not text a model relays.** This is
   `codex-build.sh`'s own design (`:191-198`, "WHY THE TRAILER IS A FILE AND NOT THE TAIL
   OF STDOUT"; atomic rename) generalised to every worker. The host reads `result.path`,
   validates against `result.schema` (the `VERDICT_SCHEMA` / `FORGE_SCHEMA` / `PLAN_SCHEMA`
   shapes at `trident/inner-workflow.mjs:753-970` survive as TS types), and then **re-measures**
   every claim it can (head, diff, PR) before believing it — the G032/G033/G100 rule,
   now the only path.
2. **`supports()` is consulted at card admission**, not at the phase. A project whose
   REPL provider cannot host a phase in the placement the phase resolves to is refused
   at `dispatchBoardBoundBuild` (`trident/board-dispatch.ts:591`) with a typed reason,
   the card is left un-dispatched, and the project conversation says so. Never at minute
   90 of a build.
3. **Every outcome kind joins the existing vocabulary** (routing audit §4.3): `refused`
   and `blocked` map onto the inner block-kind vocabulary at `trident/inner-loop.ts:266-289`
   (`infra-only` / `missing-dependency`), `unknown` onto the three-valued liveness model,
   and none of them is ever a `code` rejection.

### B.2 How each provider satisfies it — and what each cannot do

| | Claude Code | Codex | pi |
|---|---|---|---|
| **headless** (`Placement = 'headless'`, other-provider work) | `claude -p --model <id> --output-format json --allowedTools … --permission-mode …`, cwd = the handed worktree, `--resume <session>` for `thread.id`. Brief on stdin. Measured cost: ~24k cache-read tokens per job to warm (pivot §3.2). Runner = a TS module; the Kimi seat becomes this runner pointed at the Anthropic-compatible endpoint with the key inline on the child env only (`trident/kimi-key.ts:80-90` discipline; multi-substrate plan §C verified K3 drives the CC harness). | `codex exec … -` first turn; `codex exec resume <thread_id> …` after, sandbox by `-c sandbox_mode=`, cwd by process cwd (spec item contracts 1–2). Wrappers exist (`trident/codex-build.sh:1446`, `trident/codex-review.sh:534`) and **do not implement resume** (routing audit E5). Startup probe for the `resume` subcommand and every `-c` key with a trailing sentinel (contract 7). `runtime/adapters/codex-cli/exec.ts:122` still emits the dead `--resume` flag; it is repaired to the subcommand or deleted. | `pi -p --mode json` with the brief on stdin; result via trailer. Session continuity flag **unverified** (pi has tree-structured sessions; the resume argv must be probed like codex's). |
| **in-repl** (`Placement = 'in-repl'`, same provider as the project REPL) | One acting turn on the project conversation (`composeActingTurn`, `gateway/wiring/build-live-agent-turn.ts:1065`) whose whole instruction is: invoke `Agent` with subagent type `trident-<role>`, prompt = the brief path, run in the background, reply with the agent id. Role definitions `.claude/agents/trident-<role>.md` are **generated by the host** into the project repo with an explicit `tools:` allowlist per role. `Agent` must be added to the REPL's `--tools` AND `--allowedTools` (the `37f095a2` lesson). Parallel N = N `Agent` calls in one turn. Completion is observed by the host from the trailer + liveness probes, never from the REPL's later notification. | `spawn_agent` (multi_agent_v2) from a **persistent codex project REPL** with host-generated `.codex/agents/trident-<role>.md` (sandbox + model per role; "cannot escalate beyond the parent's sandbox"). **That REPL does not exist in this tree**: `runtime/adapters/codex-cli/index.ts:1-16` is one-shot exec, no persistent host, no herdr argv for codex (`grep -n codex runtime/adapters/claude-code/persistent/build-repl-argv.ts`: none). Herdr itself resumes `codex resume <id>` (pivot §3.7). Building the codex REPL host is a prerequisite of codex-as-orchestrator, not part of trident. | **No first-party subagents.** Two honest options: (a) a Neutron-shipped pi extension exposing `dispatch_bounded_work` as a *tool that calls the host* — which would be the only harness where in-repl placement needs no model transcription at all; (b) run same-provider work headless and record `placement_degraded`. Post-cutover either way. |
| **What it CANNOT do** | No host-invocable subagent: in-repl dispatch is a model turn that must call one tool. A subagent inherits the REPL's grant unless its agent definition restricts it — a **security regression** versus today's `PROFILE_EPHEMERAL` (`gateway/wiring/substrate-profiles.ts:331`) if not closed (routing audit §4.2 warned this; `open/wiring/substrates.ts:284` enables the bridge on the parent). No exit code or stdout from an in-repl subagent to the host: the trailer is the only channel. | Headless codex cannot ask Neutron for an approval; `approval_policy=on-request` alone refuses the escalation at exit 0 with no event (spec item contract 6) → `needs_approval_decision: true` is refused at input. `spawn_agent` under `codex exec`, and on a ChatGPT-subscription account, **unverified** (upstream issue `#27331`). The build wrapper runs `--sandbox danger-full-access` on record (`trident/codex-build.sh:1446`; rationale `:201-289`); a headless codex worker is unconfined and that is stated, not hidden (spec item contract 5). | No subagents, no Neutron REPL host, RPC/SDK surfaces unverified against this tree. |

### B.3 When a project's substrate cannot satisfy a phase: refuse, at admission, loudly

**Decision (mine, internal to the repo): refuse. Never fall back to a different provider.**
This is the rule the tree already enforces at every existing seam and it is kept:

- `forgeAgent` throws rather than falling back when codex is not connected —
  `trident/inner-workflow.mjs:1787-1794`: "The alternative is to fall back to Claude, which
  would spend exactly the quota the owner moved this phase to protect and would do it
  invisibly. Stop instead."
- `normalizeProvider` throws on an unknown provider rather than coercing to Claude —
  `runtime/adapters/select-substrate.ts:127-136`.
- `parsePhaseModelConfig` rejects a tier a phase's dispatch cannot reach at the settings
  write — `trident/phase-models.ts:601-606`.

The new shape moves the refusal **earlier**: at `dispatchBoardBoundBuild`
(`trident/board-dispatch.ts:591`), the host resolves every phase's `(provider, placement)`
from the project's REPL provider and the tier registry, asks each runner `supports()`, and
refuses the dispatch with `code: 'phase_unsupported'` naming the phase, the tier, the
provider and the missing capability. The card stays where it was. The refusal reaches the
owner the one sanctioned way — the project conversation, which is already the surface
`work_board_dispatch_build` answers on (`trident/work-board-build-tool.ts:214`).

**PROPOSED REFINEMENT to §3.2, not a change to it — same-provider placement may degrade
to headless, and only ever same-provider.** §3.2 splits on *model*; it chooses the
subagent placement for *cost* (warm cache, shared MCP). If the in-repl dispatch turn fails
for a mechanical reason (the tool is not granted, the REPL is fenced, the turn is refused
by the pool), the honest options are (a) fail the run, or (b) run the same model as a
headless worker of the same harness — no model changes, no quota moves to another
vendor, ~24k tokens of warm-up are paid, and a `placement_degraded` outcome is written on
the run row, shown in the project chat, and counted. I recommend (b) with the counter,
because a run that dies because a *dispatch* turn wedged is exactly the class of death we
are removing, and because the count is the kill criterion: if degraded placements
dominate, the in-repl path is the thing to fix, not the fallback to widen. What is **not**
allowed, anywhere: a fallback that changes the provider. That is the failure mode the
owner named and the contract makes it unrepresentable — `Placement` is data on a request
whose `provider` is fixed.

### B.4 The security boundary for in-repl workers, stated as a requirement

Today's build workers run under `PROFILE_EPHEMERAL` (`--restricted`, `acceptEdits`, no
tool bridge; Decisions Log 2026-09-14). Today's project REPL runs under `PROFILE_WARM_CHAT`
with the tool bridge enabled (`open/wiring/substrates.ts:274-284`). A subagent of the
project REPL therefore starts *wider* than a build worker today. The rebuild must close
that before any `build`/`fix` role runs in-repl:

- Claude Code: the generated `.claude/agents/trident-<role>.md` carries an explicit `tools:`
  list; the review/probe/synthesis roles get read-only tools; `build`/`fix` get
  Read/Glob/Grep/Write/Edit/Bash. Whether an agent definition can also **withhold the
  parent's MCP servers** (the Neutron tool bridge) must be measured in step 4 below. If it
  cannot, `build`/`fix` are **headless-only on Claude** and the in-repl placement is
  limited to read-only roles. That decision is made on the measurement, in the step's
  as-built, and it is a narrowing of §3.2's cost optimisation, not of its model rule.
- Codex: per-role sandbox in the agent file; a subagent cannot exceed the parent's
  sandbox (verified from docs). The parent REPL's sandbox is therefore the ceiling.
- The worker's `cwd` is a host-cut worktree. The REPL is spawned with `cwd: owner_home`
  (`open/wiring/substrates.ts:270`); under `--restricted` a subagent's file tools are
  confined to cwd + `--add-dir`. The worktree must be reachable from the REPL's grant:
  cut it under the project repo, and the project repo must be under the REPL's cwd or
  in its `--add-dir`. This is a measurement for step 4, not an assumption.

---

## C. Keep and delete, by file and by gate

"Keep the gates, replace the loop" (SPEC.md:489). The tree measures as **56,932 lines of
trident production code and 108,738 lines of trident tests** (134 test files). The loop
is about a sixth of the production code and about half of the test surface.

### C.1 DELETE — the loop and everything that exists only because of its shape

| File / symbol | Lines | Why it goes |
|---|---:|---|
| `trident/inner-workflow.mjs` | 6,944 | The CC Dynamic Workflow. Control flow in a turn. |
| `trident/inner-workflow-rationale.md` | 2,980 | Its externalised comments (`#845`). Each rationale block is read once when its gate is re-homed and the reasoning moves with the gate; then the file goes. |
| `trident/inner-workflow-size.test.ts` | 22 | Guards a tool cap that no longer applies. |
| `trident/testing/load-escalation-gate.ts` | 165 | Text extractor; exists only because the `.mjs` cannot be imported (`:6-8`). |
| `trident/inner-loop-sim.ts` | 231 | Simulator of the fire seam. |
| `trident/inner-loop.ts` — `WORKFLOW_FIRE_TOOL_NAMES` `:559-569`, `buildWorkflowArgs` `:576-…`, `buildFireWorkflowPrompt` `:790-813`, `buildWorkflowFirer` `:976-1010`, `buildSubstrateWorkflowFire` `:1039-1203`, `FireOutcome`/`unconfirmed` machinery | ~700 of 1,203 | The launcher. What survives of this file is the result contract (B.1 rule 3): `parseInnerResult` `:844`, the verdict/block-kind decoders through `:975`, `TERMINAL_CAUSE_MAX` `:819` — renamed `trident/result-contract.ts`. |
| `gateway/wiring/substrate-profiles.ts` — `PROFILE_WARM_FIRE` `:489-503` | 15 | The launcher's profile; the `allowed_tools: ['Workflow']` fixed today dies with it. |
| `open/wiring/substrates.ts` — `makeWarmFireSubstrate`, `fireSubstrateByCwd`, the eviction guard `:545-580+` | ~80 | One warm Claude REPL per repo. §3.1 ends it. |
| `open/wiring/trident-child-crash-sink.ts`, `open/wiring/trident-launcher-liveness.ts` | 256 | "A dead launcher is not a dead build" — true, and moot once there is no launcher. |
| `trident/fire-evidence.ts`, `trident/fire-evidence-probes.ts` | 845 | Evidence that a fire happened despite the launcher timing out. No fire, no evidence. |
| `trident/checkpoint.sh`, `trident/stage-stamp.sh` | 1,183 | SQL writers an *agent* invokes (`checkpoint()` at `inner-workflow.mjs:2154` and `writeTerminalResult()` at `:2185` each spend a model seat — `:2171`, `:2228` — to run one bash line). The host writes the store directly; the "REQUEST_CHANGES needs findings" rule already exists in-process (`trident/store.ts`, `TridentEmptyFindingsRejectionError`, as-built `1-measured-cost-97-of-160-rejection.md`). The SQL twin of it dies with the script. |
| `runtime/adapters/select-substrate.ts` — the TRIDENT NOTE `:22-26`, `detachedWorkflows` `:91-102` | ~20 | The hard-coding. |
| `gateway/composition/build-core-modules.ts:636-641` and every `fire_workflow` thread through `buildTridentOrchestrator` | — | Composition of the launcher. |
| `trident/orchestrator.ts` — `launch()`'s fire path (`:3742-4861`, minus the `bound_pr` review executor, which is re-pointed at the new panel), `decideSettleTimeoutByEvidence` `:3564`, `unconfirmedFires`, the `fired`/`redispatched` in-memory sets (`docs/INVARIANTS.md:223`) | ~1,200 | The other half of fire-and-settle. |
| `trident/kimi-review.ts`, `trident/kimi-review-cli.ts` (text-API executor) | — | Replaced by the Claude headless runner against the Anthropic-compatible endpoint (B.2). One fewer executor shape. The key discipline (`trident/kimi-key.ts`) is kept and reused. |
| Tests that exist only for the above: `abandon-poison-e2e`, `launcher-crash-precedence`, `liveness-death-e2e`, `crash-before-launch-save`, `launch-throw-bounded`, `fire-evidence*`, `tick-liveness` (launcher half), `inner-workflow-size`, `codex-build-arrival` (bridge-agent wait) | ~8,000 | Their *assertions* about run identity, crash recovery and one-owner-per-branch migrate to the new state machine's tests (C.3); their launcher fixtures do not. |

### C.2 KEEP — host-owned, transport-independent already

Verbatim, with their tests: `trident/merge.ts` (4,075), `trident/mutation-prover.ts` (4,723),
`trident/mutation-claim-artifact.ts`, `trident/leak-preflight.ts`, `trident/leak-fixer.ts`,
`trident/conflict-resolver.ts`, `trident/arbiter.ts` + `arbiter-prompt.ts`,
`trident/worktree-cleanup.sh` + `worktree-reaper.ts`, `trident/build-workspace.ts`,
`trident/git-mode.ts`, `trident/wrong-base-remedy.ts`, `trident/board-dispatch.ts`,
`trident/board-reconcile.ts`, `trident/delivery.ts`, `trident/escalation-block.ts`,
`trident/escalation-evidence.ts`, `trident/terminal-cause.ts`, `trident/store.ts`,
`trident/state-machine.ts`, `trident/phase-models.ts`, `trident/model-tiers.ts`,
`trident/codex-credential.ts` / `codex-rotation*.ts` / `codex-auth.ts`,
`trident/run-evidence.ts` + `run-evidence-probes.ts`, `trident/test-strategy.ts`,
`trident/brief-parts.ts`, `trident/gh-authed.ts`, `trident/review-run.ts` (re-pointed),
`trident/tick.ts` (as the liveness/fencing ticker, not a second decision maker),
`gateway/proactive/terminal-build-wake.ts` (the seed of the REPL-decides shape),
`trident/orchestrator.ts`'s publish / replay / recovery / harvest half (`:1005-2337`,
`:2520-3563`, `:4949-6363`).

Kept and **refactored, not rewritten**: `trident/codex-build.sh` and `trident/codex-review.sh`
become the shell of the codex `WorkerRunner` — they gain `exec resume <thread_id>`, drop
the bridge-agent trailer-wait protocol (the host waits), and keep every credential-scrub
and integrity rule their 3,051- and 1,000-line test files pin.

### C.3 The 165 gates, by fate

Counted from `docs/trident-gates-inventory.md` rows (IDs, not stale anchors):

| Fate | IDs | Count | What happens |
|---|---|---:|---|
| **Keep in place** (host-owned, transport-independent) | G007–G019 except G013–G019's launch-time reads which move with `launch()`; G079–G131 except those below; G141–G158, G161–G164 | ~85 | No change to enforcement or pin. Anchors re-measured after the cutover; the inventory's line numbers are already stale (A.1). |
| **Re-home** (entangled with the CC runtime: the enforcement is a function inside the `.mjs`) | G020–G078 (planner, builder, resume, CI readiness, panel, verdict, escalation, budgets), G124–G127 (throw/cleanup in `finally`), G132–G138 (prompt rules), G159, G160, G165 | ~72 | Each becomes an exported TS function in a named module: `plan-continuation.ts` (G025–G029), `resume-classifier.ts` (G038–G041), `built-head.ts` (G032–G035, G042–G043), `ci-readiness.ts` (G044–G056 — today 25 functions, ~740 lines, of model-relayed `gh` probes at `inner-workflow.mjs:4382-5125`; becomes a host read through `gh-authed`), `review-panel.ts` (G057–G059), `verdict-synthesis.ts` (G060–G067, G160), `escalation-gate.ts` (G068–G078 — the eight functions and three consts `load-escalation-gate.ts:11` already names, imported instead of extracted), `worker-briefs.ts` (G132–G138 as constants). The 52 text-extracting test files switch to imports **with their assertions unchanged**; a migrated test that has to weaken an assertion to compile is a red flag, not a fix. |
| **Enforce, not just prompt** | G132 (never ask), G136 (Forge stops after commit) | 2 | The runner grants no ask tool and the outcome vocabulary has `blocked`; the build role is granted no `gh` and no push credential (the publish boundary `codex-build.sh:1380-1390` becomes universal). Prompt-only becomes host-enforced. |
| **Delete with the mechanism** | G002, G003, G004, G116, G117, G119 | 6 | They guard fire-and-settle: a launcher stream, an unconfirmed fire, a shared launcher's liveness. Deleted **with their tests**, and the as-built says so by ID. G120's run-evidence half stays (it is G118's). |
| **Pin first** (the inventory's NO TEST set) | G001, G018, G083, G085, G089, G094, G097, G111, G132, G133, G140 | 11 | Routing audit step 1. Nothing in C.1 is deleted before these have a red/green pin at a reachable boundary. |

Sum: 85 + 72 + 2 (subset of the 72) + 6 + 11 (subset of 85/72) ≈ 165, with the overlaps
noted. The exact per-ID assignment is written into the inventory as a new column in step 1
and updated at each step that re-homes a row — the inventory is the ledger, this table is
the policy.

---

## D. Implementation sequence

Dependency-ordered. Each step is one PR (or a short serial lane), lands **wired, served
and verified on the live instance** before the next starts, and states its acceptance as
an observable fact. "Merged" is not done (pivot §4). No feature flags; no dual paths;
step 5 is the one atomic cutover and it deletes.

**Step 0 — stop spending on the launcher (in force now).** The repairs merged today keep
old trident alive for the *owner's* use while this is built. No further launcher work is
dispatched: a launcher defect found from here on is recorded, not fixed (pivot §5).
*Acceptance:* zero PRs touching `trident/inner-loop.ts:968-1203` or
`PROFILE_WARM_FIRE` merge after this document's date, other than step 5's deletion.

**Step 1 — pin the eleven, and turn the extractor tests into behaviour tests.**
Routing audit step 1, unchanged. Add the "fate" column to the inventory (C.3).
*Acceptance:* `grep -c 'NO TEST' docs/trident-gates-inventory.md` = 0 with a positive
control that the grep finds the phrase in this document; each new pin has a printed
mutation red/green in its as-built; `trident/escalation-block.test.ts` unmodified.
*Cost:* 3–4 days.

**Step 2 — `runtime/bounded-work.ts` + two headless runners (Claude, Codex), no caller.**
The contract in B.1; `claude -p` runner; codex runner over the refactored wrappers with
`exec resume`, the startup probe, the thread queue, and the credential scrub — i.e. the
ten criteria of `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md`
become this step's tests. Kimi = the Claude runner pointed at the compatible endpoint.
`runtime/adapters/codex-cli/exec.ts:122`'s `--resume` flag is repaired to the subcommand.
*Acceptance:* on the live instance, a maintenance command runs one `review` request
against a real PR diff on each provider and writes a schema-valid trailer; the second codex
call's argv is `exec resume <the recorded id>` with a decoy thread present; the cgroup
holds no process after return; a request with `needs_approval_decision: true` spawns
nothing and returns `refused: approval-needed`.
*Cost:* 4–6 days. The codex spec item's criteria are exacting by design.

**Step 3 — host-owned CI readiness and host-written checkpoints.**
`trident/ci-readiness.ts` re-homes G044–G056 as a deterministic `gh` read via
`gh-authed`; `BuildHost.checkpoint()` writes `code_trident_runs` directly (the
`checkpoint.sh` SQL rule is already in `store.ts`). Library modules, no production caller
yet — a module with no caller is not a second path.
*Acceptance:* every fixture in `trident/__tests__/ci-gate.test.ts` (G044–G056, G160) passes
against the TS module with the same inputs and expected verdicts; the five readiness
mutations from the inventory go red on the new module.
*Cost:* 3 days.

**Step 4 — the in-repl runner for Claude, and the security measurement.**
Host-generated `.claude/agents/trident-<role>.md`; `Agent` added to the project REPL's
`--tools` and `--allowedTools`; dispatch via `composeActingTurn`; background subagent;
trailer; liveness via `run-evidence-probes`. **Measure** whether an agent definition can
withhold the parent's MCP bridge and whether a host-cut worktree is inside the REPL's
`--restricted` grant. Decide, in the as-built, which roles run in-repl on Claude.
*Acceptance (both directions, spec item criterion 2):* from a Claude project, one bounded
`probe` request in-repl produces a trailer and **zero** new `claude` processes (cgroup
instrument); the same request with `provider: 'openai-codex'` produces exactly one
`codex exec` and no `Agent` call; a `build`-role subagent attempting a Neutron bridge tool
gets a refusal that is asserted, or the as-built records that `build` is headless-only
on Claude and why.
*Cost:* 4–6 days; **3x trigger** if the bridge cannot be withheld (see E.2).

**Step 5 — `trident/build-run.ts`: one card, fresh build, PR mode, end to end. Atomic cutover.**
The state machine: admit → cut worktree → `plan` → `build` → measure head/diff → publish
(existing) → CI readiness (step 3) → `review` × N in parallel (runners) → `synthesis` →
escalation gate → `fix` loop under the round cap → mutation proof (existing) → merge
(existing) → cleanup (host-invoked). Ralph, waves and mid-loop resume are **out** of this
step (they are step 6); a run that would need them is refused at admission with
`phase_unsupported` until step 6 lands — which is a refusal, not a flag. In the same change:
everything in C.1 is deleted; `tick.ts` keeps liveness and fencing; the `bound_pr` review
executor calls the panel directly.
*Acceptance:* **a card dispatched from the project chat reaches MERGED with no human
touching it** on the live instance (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:65`);
the run row's every checkpoint was written by `BuildHost` (no `checkpoint.sh` in any
worker transcript — grep with `worktree-cleanup.sh` as the positive control for a script
that *is* still invoked); `rg -n 'inner-workflow\.mjs|buildWorkflowFirer|makeWarmFireSubstrate|PROFILE_WARM_FIRE|detachedWorkflows' --glob '*.ts' --glob '*.mjs' --glob '!*.test.ts'`
returns nothing under `trident/ gateway/ open/ runtime/` (positive control: the
`build-run` import at `gateway/composition/build-core-modules.ts`); kill the gateway
mid-review — the run holds, the ticker fences, no second worker starts on the branch
(G122), and the run finishes after restart; `trident/escalation-block.test.ts` passes
unmodified.
*Cost:* 12–18 days. This is the rebuild. About 3–4k lines of new TS against ~9.5k deleted,
plus migrating ~25 of the 52 extracting test files. It is the step most likely to 3x.

**Step 6 — Ralph continuation, waves, and mid-loop resume on the new shape.**
`plan-continuation.ts` (G025–G029), `resume-classifier.ts` (G036–G041), wave members
(G001, G024, G034), crash recovery re-pointed at `build-run`.
*Acceptance:* a Ralph card with three tasks reaches merged with the cheap continuation
planner used on tasks 2 and 3 (logged with the committed-plan checksum, G028); a gateway
kill between fix-round 2 and its review resumes at `fix-round-2` **without rebuilding**
(the assertions of `retry-resumes-checkpoint.test.ts`, migrated); a run whose live head
cannot be read stops with `resume-head-unreadable`, never rebuilds (G015/G038).
*Cost:* 5–7 days.

**Step 7 — Codex as the project REPL (pre-cutover scope, pivot §2).**
Prerequisite that is not trident: a persistent codex REPL host under herdr (herdr's
restore already knows `codex resume <id>`, pivot §3.7), the model-switch pass-through
(§3.6), and the startup probe for `[features] multi_agent_v2` + `spawn_agent` on the
configured account. Then the codex in-repl runner with generated `.codex/agents/`.
*Acceptance:* a project pinned to codex dispatches a card; `plan`/`build`/`review` run as
codex subagents with **zero** `claude` processes for same-provider steps (cgroup); a
Claude-tier review seat runs as exactly one `claude -p`; the card reaches merged. If
`spawn_agent` is unavailable on the account, the probe refuses in-repl placement at boot
with a typed outcome and the project chat says so — and the degraded headless path
(B.3) is what runs, counted.
*Cost:* 10+ days, dominated by the REPL host. **Unknown-heavy.**

**Step 8 — pi, post-cutover.** Headless runner first (`pi -p --mode json`); the in-repl
placement via a Neutron pi extension. *Acceptance for the headless half only:* one
`review` request produces a schema-valid trailer from `pi -p`.

Through step 5 — a Claude project merging a card unattended — the honest range is
**26–37 working days of agent lanes**, serial where the ordering says serial.

---

## E. The honest risk list — what 3x's this, and what we would find out too late

1. **The in-repl dispatch turn is still a model in the dispatch path.** It must call one
   tool (`Agent` / `spawn_agent`). The launcher wedged five distinct ways today doing
   exactly "call one tool". Mitigations that are structural, not hopeful: the run does not
   depend on the turn's *reply* (trailer + host measurement); the turn returns after
   spawning, never waits (the pool's 45-minute absolute ceiling, `runtime/substrate.ts`,
   would otherwise kill a two-hour build); and the same-provider degraded placement
   (B.3) turns a wedged dispatch into a counted cost rather than a dead run. What we would
   find too late: that herdr's screen-scrape detectors (`blocked-is-not-slow`,
   `tool-use-approve`; Decisions Log 2026-09-14 "named residual") misread a background
   subagent's output on the owner's pane. Found in step 4, or not at all.

2. **Subagents of the trusted REPL inherit the owner's tool bridge.** If Claude Code agent
   definitions cannot withhold the parent's MCP servers, every in-repl worker has the
   owner's Cores, memory and board tools — wider than any build worker today, and
   `trident/escalation-block.test.ts`'s "the run cannot reorder the board" becomes a
   property of prompt obedience. Then `build`/`fix` go headless-only on Claude and §3.2's
   cost saving is confined to read-only roles. 3x trigger for step 4; a cost, not a stop.

3. **Codex as orchestrator is two unknowns deep.** There is no persistent codex REPL in
   this tree; `spawn_agent` under a ChatGPT account and under non-interactive execution is
   unverified (upstream `#27331`); the CLI moved 0.147 → 0.154 in five weeks and its
   flags have already broken one adapter here (`exec.ts:122`). Step 7 is scoped
   pre-cutover by the pivot; if it 3x's, the pivot's own ordering (§2: "All incremental")
   says ship Claude-as-orchestrator to the cutover and codex-as-orchestrator after. That
   is a scope decision for the owner (product direction) and should be put to him only
   when step 7's probe says no — not now.

4. **The tests are the cost, not the code.** 52 files / 50,110 lines reach the workflow by
   text. Migrating them honestly — same assertions, real imports — is the single largest
   line item in step 5, and the temptation to "just port the happy path" is exactly how
   156 Silent gates get lost (inventory §"Dangerous set"). What we would find too late: a
   migrated test that is green against a module that no longer enforces the rule.
   Countermeasure: every re-homed gate lands with a printed mutation red, per the tree's
   standing rule (memory: mutation catches what reading misses).

5. **Concurrency on the owner's conversation.** In-repl placement puts N parallel review
   subagents and a build inside the REPL the owner is chatting in. The turn queue
   (`composeActingTurn` enqueues per topic, `build-live-agent-turn.ts:1065-1067`) serialises
   *dispatch* turns behind the owner's messages; a busy owner delays a dispatch, and a
   long-running background agent may compete for the pane. Measured, not assumed, in
   step 4; if it is bad, the answer is one dispatch turn per phase (batching), not a
   second REPL.

6. **Worktree reachability under `--restricted`.** The project REPL runs at
   `cwd: owner_home` (`open/wiring/substrates.ts:270`). If host-cut worktrees are not
   under the REPL's grant, in-repl workers cannot edit them at all and the first build
   fails instantly, as the 2026-07-02 launcher did when its workers "only had reply and
   send_typing" (`trident/inner-loop.ts:548-556`). Step 4's acceptance catches it.

7. **The credential story changes shape.** Today every trident seat draws from
   `llmPool` on a dedicated warm REPL (`open/wiring/substrates.ts:545-580`); in-repl work draws
   from the *conversational* REPL's credential and headless work from a pool. Seat
   rotation (a kept gate) applies to headless codex only. Usage accounting per phase
   (`#867`, merged today) must attribute in-repl subagent usage to the run, not the chat.
   Not a blocker; a thing step 5's as-built must show numbers for.

8. **"Restart" — the plain answer.** Is this a restart? For the loop, **yes**: ~9,500 lines
   (`inner-workflow.mjs`, its rationale, the launcher, fire evidence, the SQL seats) are
   deleted and ~3–4k lines of TS replace them. For the factory floor, **no**: merge,
   mutation proof, leak preflight, replay, recovery, board, delivery, credentials — some
   45k lines and their tests — are kept as they are, because they were never Claude-shaped.
   Throwing those away would cost months and buy nothing the owner asked for. The thing
   that has been a dead end is the *shape* of the loop, and that shape is what steps 5–6
   delete. Nothing above proposes to keep it under a flag.

---

## F. What this document does not decide

- Which roles run in-repl on Claude — step 4's measurement decides (B.4).
- Whether the same-provider degraded placement (B.3) is adopted — it is proposed, marked,
  and reversible; the counter it carries is its own kill criterion.
- Anything about pi beyond the headless runner.
- Product scope questions that step 7's probe may raise (E.3). They are not raised now.

---

## G. Re-cost, 2026-09-14 (later the same day): no production users, tests are disposable, 6–10 parallel lanes, speed is the objective

The owner's constraints, verbatim in the coordinator's message: no one is on the system;
delete and rewrite tests if faster; delegate hard parts to parallel lanes; speed subject to
working. Sections A–F stand as analysis. This section replaces D's *sequence and cost*.

### G.0 Reconciliation with the second reader (Astra)

| Astra's finding | Verdict | Evidence |
|---|---|---|
| Execution layer is 6,944 + 1,203 + 6,363 = 14,510 lines | Agree on the numbers (A.1). **Disagree that all 14,510 is "the loop".** `orchestrator.ts` is two things: the fire/launch half (`launch()` `:3742-4861`, `decideSettleTimeoutByEvidence` `:3564`, the unconfirmed-fire and crashed-launcher branches of `stepCore` `:5484-6300`) which goes, and the publish/replay/merge/proof/recovery half (`rebaseOntoObservedBase` `:1531`, `publishBuiltCommit` `:2520`, `reconcile_stranded` `:3423`, `applyResult`'s merge path `:4949-5483`) which is G083–G131 and stays. Deleting the file wholesale re-creates ~50 gates from scratch, which is slower, not faster. | `docs/trident-gates-inventory.md` rows G083–G131 anchor on `orchestrator.ts` |
| Unpinned gates are 11, not 18 | **Astra is right; the routing audit is stale.** `docs/trident-gates-inventory.md:41` lists 11 IDs. `docs/trident-routing-gap.md:133` says 18 because it adds G021–G024, G031, G034, G075 — which the inventory's own header (`:3`) says `#745` and `#738` mutation-certified after the routing audit's baseline. This document already uses 11 (C.3). | inventory `:3`, `:41`; routing audit `:133` |
| 155 Silent / 10 Loud, not 156 | **Astra is right by enumeration.** The Loud rows are G002, G007, G031, G083, G089, G091, G096, G101, G135, G153 = 10, so Silent = 155; the inventory's headline at `:3` is off by one. Immaterial to the plan. | inventory rows |
| The August sandbox recommendation never shipped; `codex-build.sh:1446` runs `danger-full-access` | Agree — and it is half-shipped, which matters for speed. The *sandbox* half (workspace-write) was rejected on record at `:201-289`; the *publish-boundary* half (the build commits, the host pushes and opens the PR, no `gh`/GitHub credential in the worker) **did** ship at `:290-310` and `:1380-1382`. The rebuild keeps the shipped half and does not revisit the sandbox before cutover (G.4). | `trident/codex-build.sh:201`, `:290`, `:1381`, `:1446` |
| Kimi is a text-API request, not a harness-driving builder | Agree (B.2, C.1). Under the new constraints it is **cut**, not replaced (G.4). | `trident/kimi-review.ts:207`, `:225` |
| "Delete the PTY host" is superseded; both hosts implemented at `configured-pty-host.ts:11` | Agree (A.1 last row). No trident consequence. | `SPEC.md` Decisions Log 2026-09-12, 2026-09-14 |

### G.1 The re-costed critical path

Target: **a card dispatched from project chat reaches MERGED with no human.**

**Wall-clock: 9–12 working days with 6–10 lanes. Not under one week; under two.** The
range is set by two things no lane count shortens:

- **The driver** (`trident/build-run.ts`, lane L5): one mind, one file, 4–6 days. It is
  the sequence plan → build → measure → publish → CI → review → synthesis → fix → proof →
  merge as *host code* with a fake runner, ported from `inner-workflow.mjs:5589-6904` with
  everything in G.4 cut. Splitting it across two lanes produces two half-drivers that
  disagree at the seam; the seam is the whole difficulty.
- **Live cycles** (lane L8): a real card takes 1–2 hours to build and review; the first
  four or five will fail for reasons only a live run reveals (today's five launcher
  defects are the precedent — each found in one live cycle, none by tests). 3–4 days of
  cycles after integration, and each cycle that needs a deploy is serialised on whoever
  approves deploys.

Everything else is parallel and lands by day 4–5. Day 0 is a half-day of mine: write the
one-page `WorkerRunner`/`BoundedWorkRequest`/`BoundedWorkOutcome` contract (B.1) as a
`.ts` file with a fake implementation, so L5 and L1/L2 code against the same types from
hour one. That file is the only thing every lane waits on.

### G.2 What is genuinely serial

True dependency edges — everything not listed here was serial in D by habit:

1. **Contract file → every lane.** Types first, half a day.
2. **Driver (L5) → composition/deletion (L6).** L6 wires `build-run` into
   `gateway/composition/build-core-modules.ts` and deletes the launcher; it needs the
   driver's exported shape, not its correctness. One day, started when L5's signature is
   stable (day 3), finished when L5 is (day 6).
3. **Composition (L6) → live cycles (L8).** Nothing live runs before the cutover lands.
4. **Runner implementations (L1, L2) → live cycles.** Not → driver: the driver develops
   against the fake; the real runners plug in at L6.

Not serial: CI readiness (L3), pure-gate extraction (L4a/L4b), the codex runner (L2), the
inventory ledger (L7), each other, and the driver. D's steps 1–3 were sequenced as
"prove before delete"; with no users, deletion and proof happen in the same change.

### G.3 The lane plan — file territories, no two lanes share a file

| Lane | Owns (creates or is the sole editor of) | Delivers | Days |
|---|---|---|---|
| **L0 (me)** | `runtime/bounded-work.ts` (contract + fake runner) | Day 0 types; then integration review | 0.5 |
| **L1** Claude headless runner | `runtime/workers/claude-headless.ts` (+ test) | `claude -p` runner: brief on stdin, `--model`, `--allowedTools`, `--permission-mode`, trailer written by a wrapper script `runtime/workers/claude-headless.sh`, `--resume` for thread reuse. **Day-1 probe on the live box**: does `claude -p` on this install honour `--allowedTools` for Write/Edit/Bash in a worktree, and which `--permission-mode` is needed — the exact gate class that wedged the launcher today. | 2–3 |
| **L2** Codex headless runner | `runtime/workers/codex-headless.ts`, `trident/codex-build.sh`, `trident/codex-review.sh`, their tests | `exec` / `exec resume <thread_id>`, startup probe with trailing sentinel, credential scrub kept; the bridge-agent trailer-wait protocol removed (the host waits on the process). The spec item's ten criteria are the tests; do the four cheapest first (argv `exec resume`, scrub at the spawn boundary, no long-lived process, refusal on `needs_approval_decision`) and file the rest. | 3–4 |
| **L3** CI readiness | `trident/ci-readiness.ts` (+ test), sole editor of `trident/__tests__/ci-gate.test.ts` | Port `probeCi`/`probeCiBase` and the readiness wait (`inner-workflow.mjs:4382-5125`) as host `gh` reads via `gh-authed`. Minimal per G.4 item 8. Retarget `ci-gate.test.ts`'s extractor to import (G.5). | 2–3 |
| **L4a** Pure gates I | `trident/escalation-gate.ts`, `trident/verdict-synthesis.ts`, sole editor of `trident/__tests__/escalation-gate.test.ts`, `escalation-e2e.test.ts`, `severity-gate.test.ts`, `synthesis-unavailable.test.ts`, `trident/testing/load-escalation-gate.ts` | Paste the eight functions and three consts (`load-escalation-gate.ts:11`) and the severity/advisory arithmetic (G061–G067) into TS; the extractor becomes a re-export shim so the four test files pass unmodified, then the shim is deleted and the imports made direct. | 1–2 |
| **L4b** Pure gates II | `trident/built-head.ts`, `trident/worker-briefs.ts`, `trident/result-contract.ts` (the parsers from `inner-loop.ts:844-975`), sole editor of `inner-workflow-built-head.test.ts`, `inner-loop.test.ts`, `prompts-disk-source.test.ts` | Same paste-and-retarget for G032–G035, G042–G043; the `ARGUS_RUBRIC`, `NO_INTERACTIVE_RULE`, `REDIRECT_RULE`, `NO_PATTERN_KILL_RULE`, Forge contract and codex coda as exported constants (G132–G138). | 1–2 |
| **L5** The driver | `trident/build-run.ts` (+ `build-run.test.ts` against the fake runner) | The state machine, fresh build, PR mode only. Uses L4a/L4b modules by name from day 1 (stub-import against the contract if they are not landed yet — same names, agreed day 0). | 4–6 |
| **L6** Composition and deletion | `gateway/composition/build-core-modules.ts`, `open/wiring/substrates.ts`, `gateway/wiring/substrate-profiles.ts`, `runtime/adapters/select-substrate.ts`, `trident/inner-loop.ts`, `trident/orchestrator.ts`, `trident/tick.ts`, `trident/index.ts`, `trident/review-run.ts`, and every file in C.1's delete list plus its tests | Wire `build-run` as `orchestrator.step`'s replacement for non-terminal runs; delete the launcher, `PROFILE_WARM_FIRE`, `makeWarmFireSubstrate`, fire-evidence, crash-sink, launcher-liveness, `checkpoint.sh`, `stage-stamp.sh`, `inner-workflow.mjs` and its rationale, the extractor, and the 20-odd test files in G.5's "delete" class. Refuse `bound_pr`, Ralph and wave dispatches at admission (`phase_unsupported`). | 1–2 (day 3→6) |
| **L7** Ledger | `docs/trident-gates-inventory.md`, `docs/trident-routing-gap.md`, the as-built | Fate column per gate ID (C.3), the 155/10 correction, stale-anchor note, and the "deleted with the mechanism" list by ID. | 1 |
| **L8** Live cycles | Nothing in-tree except fixes routed back to the owning lane | Dispatch real cards on the instance from day 6; triage each failure to a lane; the merge is the acceptance. | 3–4 |

Eight lanes; L4a/L4b/L7 finish early and their agents pick up L8 triage. Shared files
that must never be touched by two lanes: `build-core-modules.ts`, `substrates.ts`,
`orchestrator.ts`, `inner-loop.ts`, `tick.ts` — all L6's.

### G.4 What I would cut now that no one is on the system

Everything below is cut *before cutover* and re-added after the first unattended merge, in
the order the owner feels their absence. "Breaks" says what stops working; "matters" says
whether it matters with one user who is waiting.

1. **In-repl placement (§3.2's subagent branch) — deferred, every worker headless.**
   **PROPOSED CHANGE to the *order* of §3.2, not to §3.2**: the design says same-model
   work runs as a subagent for cost (~24k cache-read tokens per headless job, pivot §3.2).
   Shipping headless-only first removes lane L4 of section D entirely (agent-definition
   generation, `Agent` in the REPL's tool grants, the bridge-inheritance security
   measurement, worktree reachability under `--restricted`) — the step I rated most likely
   to 3x. The runner contract is unchanged, so adding in-repl later is one more `Placement`
   implementation, not a rewrite. Breaks: nothing; costs tokens. Matters: no.
2. **Ralph, waves, the cheap continuation planner, mid-loop resume** (G001, G020–G029,
   G036–G041, G124's resume half). Breaks: multi-task cards build only their first task;
   a gateway restart mid-build fails the run and a re-dispatch rebuilds from scratch
   (~2 h). Matters: only if we deploy mid-build; do not.
3. **Kimi** — the seat, `kimi-review.ts`, `kimi-review-cli.ts`, `kimi-usage-probe.ts`,
   `k3` tier greyed by `phase-models.ts`. Breaks: a third reviewer. Matters: no; the panel
   is cross-family with codex.
4. **`bound_pr` review-only runs** (`review-run.ts`'s use of the firer). Refused at
   admission. Breaks: "review PR #N" from chat. Matters: no.
5. **The codex bridge protocol** — trailer probe / wait-more / collect prompts
   (`inner-workflow.mjs:1729-1785`), brief chunking through an agent prompt
   (`brief-parts.ts`'s chunked fallback). The host hands the wrapper a file path and waits
   on a pid. Breaks: nothing.
6. **Crash recovery and orphan redispatch** (`orchestrator.ts:5484-6300`'s crashed-launcher,
   unconfirmed-fire and redispatch branches; G111–G123 except the hang watchdog G118 and
   the inflight ceiling G123). With no launcher there is no "crashed launcher"; a dead
   worker is a failed run. Breaks: a run does not survive a gateway restart (same as 2).
7. **The sandbox question** (`danger-full-access`, G.0): not touched before cutover. The
   publish boundary already keeps GitHub credentials out of the worker. Breaks: nothing
   that is not already the case.
8. **CI readiness reduced to its core** (keep G044 unknown-config-defers, G047 mergeable,
   G049 all-settled, G053 budget, G054/G055 red-is-a-finding; cut the ruleset/app-identity/
   configuration-fault inference G045, G046, G048, G050, G051). Breaks: a misconfigured
   required check waits out the 15-minute budget instead of being diagnosed. Matters: no.
9. **Mutation proof stays but its *nomination* becomes optional pre-cutover**: G105/G106
   require a nomination in the reviewed commit or an exemption; a build worker that omits
   one blocks merge. Pre-cutover, a missing nomination is an *advisory* finding and the
   prover runs when one exists. Breaks: the gate is weaker for a week. Matters: it is the
   one cut I would revert first after the first merge — say so in the as-built.
10. **Per-phase settings, model-switch pass-through, usage attribution polish** — none is
    on the path to a merge.

Not cut, because each is host code that already works and costs nothing to keep: publish
with lease and witness (G098–G099), replay with the resolver and the one-arbitration
arbiter, leak preflight and fixer, the merge with the reviewed-head pin (G107–G108),
worktree cleanup that preserves dirty trees, the board-reorder prohibition
(`escalation-block.test.ts`), terminal delivery and the project-conversation decision turn.

### G.5 Tests: migrate or rewrite, per gate class — answered concretely

The 52 files reaching `inner-workflow.mjs` by text split into four classes with different
answers. The deciding fact: **the workflow's gate functions are plain JavaScript**; pasted
into a `.ts` module they compile, and every test that extracts one by name can be
retargeted by changing the *extractor*, not the test.

| Class | Files (examples) | Faster path | Why |
|---|---|---|---|
| **Pure functions** — escalation gate, severity/advisory arithmetic, resume classifier, planner-continuation checks, built-head/claim matching, delta classifier, cleanup classification | `__tests__/escalation-gate`, `escalation-e2e`, `severity-gate`, `synthesis-unavailable`, `delta-classifier`, `inner-workflow-built-head`, `round-landed`, `review-round-cap` (~14 files) | **MIGRATE by retargeting.** Paste the function into its new module; make `load-escalation-gate.ts` (and the per-file copies of its brace-matcher) re-export from the module. Half a day per module; the assertions — which are the gate's definition — are untouched. | Rewriting would re-derive the same fixtures from the same definitions and lose the mutation certifications `#745`/`#738` recorded. |
| **Whole-workflow drives** — tests that run the `.mjs` body with a fake `agent()` global and assert a terminal result (G020–G024, G031–G037, G042–G043, G124–G127) | `inner-workflow-gates`, `inner-workflow`, `inner-workflow-assembly`, `inner-workflow-plan-next`, `inner-workflow-resume`, `inner-workflow-terminal-cause`, `inner-workflow-ralph-refire`, `inner-workflow-publish-handoff`, `inner-workflow-mutation-claim`, `__tests__/cross-model-*`, `dead-core-seat-e2e`, `dying-reviewer-e2e` (~16 files, ~20k lines) | **DELETE and REWRITE against `build-run.ts` with the fake runner.** Half of these rows are cut in G.4 (Ralph, resume, waves) and need no test yet; the rest (null build, unverified head, no-diff fix, cleanup on every path, terminal cause) are ~12 driver tests written from the gate's one-sentence definition in the inventory. | Their harness is the old shape (an injected `agent` global driving a 6,944-line body); porting the harness is the migration cost D warned about. Rewriting 12 tests against a 2k-line driver is a day. |
| **CI readiness** (G044–G056, G160) | `__tests__/ci-gate` (one file, ~3,100 lines) | **MIGRATE by retargeting** for the rows kept in G.4 item 8; delete the assertions for the rows cut. | The fixtures are fake `gh` outputs; the ported functions take the same inputs. |
| **Launcher / fire / crashed-launcher** (G002–G004, G116–G117, G119, plus liveness-death, abandon-poison, launch-throw, crash-before-launch-save, fire-evidence, tick-liveness's launcher half) | ~10 files | **DELETE.** The mechanism is gone. | Nothing to migrate to. |
| **Host-owned gates** (G079–G131 except the deleted, G141–G165) | `merge*`, `mutation-prover*`, `worktree-cleanup-sh`, `publish-rebase-realgit`, `stranded-salvage-realgit`, `arbiter-wiring`, `escalation-block`, `board-*`, `delivery`, `store`, `orchestrator.test.ts`'s publish/merge/recovery describes | **UNTOUCHED**, except `orchestrator.test.ts`, where the launch/fire/crash describes are deleted with their code (L6). | Not Claude-shaped; never were. |

Net: ~24 files retargeted, ~26 deleted, ~12 driver tests written. The rewrite class is the
*only* place "delete and rewrite" is faster, and it is faster there by a wide margin.

### G.6 Irreducible risks — what bites regardless of lanes

1. **Headless `claude -p` on this install.** Tool grants, permission mode and restricted
   confinement for a non-interactive turn are the exact gate class that wedged the launcher
   five ways today. L1's day-1 live probe is the cheapest experiment in the plan and the
   one whose wrong answer costs the most days; it runs before anything else in L1.
2. **The merge path has never merged autonomously.** 0 of 291 (pivot §3.8). `merge.ts`'s
   pinned merge (G107), branch drift (G108), the mutation prover (G105) and the leak
   preflight (G139) have each been exercised only up to the point where a human merged.
   The first unattended merge will find at least one refusal in that chain, and each
   finding costs a live cycle (1–2 h) plus a fix.
3. **The driver is one lane, one mind.** If the L5 agent produces a driver that mirrors
   the workflow's shape instead of the state machine in B.0 (control flow that waits on a
   model turn), the integration fails and the lane restarts. Mitigation: L0 reviews L5's
   skeleton at day 2, before any phase body is written.
4. **Deploys serialise live cycles.** If each cutover deploy needs the owner's approval, the
   3–4 days of L8 stretch to his availability. Batch fixes; deploy once per day at most.
5. **Lane collisions on shared files.** Only L6 edits the composition and the old loop.
   A lane that "just fixes" `orchestrator.ts` costs a merge conflict and a day.
6. **Codex lane capacity limits** mid-change (memory: "at capacity" kills a lane on any
   model). Every lane commits early and often; a lane's territory is re-dispatchable from
   its last commit.
7. **The one cut that weakens a gate** (G.4 item 9, mutation nomination advisory) is the
   one to revert first; a wrong call there is a merged regression, not a lost day.

If the owner wants a number: **plan for 10 working days, budget 12, and the first
unattended merge on day 8 is the observable that says the plan is on track.**

---

## H. Correction, 2026-09-14 (third pass): in-repl is the default; the board-mutation rule was invented

Two premises in G were wrong and the owner has ruled on both. **§3.2 stands exactly as
written** — same-model work is a subagent inside the project REPL; only cross-model work is
headless; the measurement is the owner's own (23,799 / 23,799 / 27,603 cache-read tokens per
headless warm-up). G.4 item 1 (all-headless) is **withdrawn**. And "the run cannot mutate the
Work Board" is not a requirement: it appears in no owner document; its only home is
`docs/spec-items/the-orchestrator-owns-the-build-loop.md:61-63`, an agent-written box, and
the owner has rejected it. Nothing is built to serve it.

### H.A The re-costed critical path — one number

**Plan 10 working days, budget 12.** The number does not move, because the two corrected
premises were never on the critical path: the security measurement was a parallel lane, and
placement does not change the driver or the live cycles, which are the whole critical path
(G.1). What changes is that the largest 3x trigger (E.2) is gone, and one new day-1 probe
joins L1 (H.D.1).

The in-repl gap, costed without inflation: `LIVE_AGENT_TOOL_NAMES`
(`gateway/wiring/build-live-agent-turn.ts:341-352`) gains the subagent tool name; the REPL's
profile is `skip_permissions: true` (`gateway/wiring/substrate-profiles.ts:259`), so there is
no `--allowedTools` gate behind it — the launcher's defect class does not apply. Which name
the installed CLI uses (`Task` at `trident/inner-loop.ts:567`; `Agent` in current CLI tool
lists) is settled by a five-minute probe, not by reading. Then the dispatch turn: one acting
turn (`composeActingTurn`, `build-live-agent-turn.ts:1065`) that invokes the subagent tool
with `model` set explicitly per role, the brief path, the worktree cwd and the trailer path,
in the background, and replies with one line. **1–2 lane-days, inside L1, off the critical
path.**

### H.B The corrected lane plan

| Lane | Change from G.3 |
|---|---|
| **L1 — in-repl Claude runner** (was: Claude headless) | Owns the tool-surface edit at `build-live-agent-turn.ts:341-352`, the dispatch-turn prompt, the trailer read, and **proving a subagent actually dispatches from the project REPL on the live box on day 1** — including the idle-gate probe in H.D.1. A headless Claude runner is **not built** now; it is needed only for a codex-REPL project's Claude seats (step 7, after the first merge). 2 days. |
| **L2 — codex headless runner** | Unchanged: the cross-model review seat is the only headless worker in the first merge. |
| **L3, L4a, L4b, L5, L7, L8** | Unchanged in territory. L5's driver calls the runner through the same contract; `Placement` is resolved by the host from the project REPL's provider (B.1). L7 additionally removes the board-mutation box from the spec item at `:61-63` and records why. |
| **L6 — composition and deletion** | Additionally deletes nothing new — the list in C.1 stands. `trident/escalation-block.test.ts` is existing code and is left alone; it is no longer an acceptance criterion of anything. |

### H.C Cut: everything that existed only to serve the invented requirement

- **B.4 in its entirety** — the agent-definition tool allowlists, the "can a subagent be
  denied the parent's bridge" question, and the worktree-reachability bullet. The last is
  moot on its own evidence: restricted mode "narrows only Trident-family profiles; trusted
  conversational profiles retain their existing policy" (`SPEC.md:333`), and the project REPL
  is `PROFILE_WARM_CHAT` (`open/wiring/substrates.ts:277`), which is not restricted.
- **D step 4's measurement and its acceptance clause** ("a `build`-role subagent attempting
  a Neutron bridge tool gets a refusal…"). Deleted, not shrunk.
- **E.2 and E.6.** Deleted.
- **Host-generated `.claude/agents/trident-<role>.md` role files** (B.2, D step 4). They
  existed to carry per-role tool allowlists. Per-role *model* goes on the subagent call;
  read-only-ness of reviewers stays what it is today — a prompt rule (G132–G138). Codex's
  `.codex/agents/<role>.md` files stay for step 7 only because that harness requires them to
  set per-role sandbox and model, not for confinement.
- **B.3's "degraded placement" refinement** — over-cut, as asked. A failed in-repl dispatch
  turn is a failed *step*, retried once by the host (the seat-retry rule, G059), then a
  failed run with a typed reason. No second placement for same-provider work.
- **`supports()` as a capability table** beyond two entries (Claude in-repl, codex headless).
  Anything else is refused at admission with `phase_unsupported` until step 7.
- **"`trident/escalation-block.test.ts` passes unmodified"** as an acceptance clause in
  D step 5 and G.3. It is an existing test; it passes or it goes with L6's deletions.

### H.D What is riskier with in-repl as the default — with numbers

1. **The idle gate versus background subagents.** Every inject into the REPL first waits for
   900 ms of pane quiet (`DEFAULT_IDLE_QUIET_MS`, `runtime/adapters/claude-code/persistent/signatures.ts:108`,
   run by `waitForReplIdle` before each inject — herdr spec item, `spawn.ts:1128-1134`). If
   the CLI's background-task indicator repaints with *changing* content more often than
   every 900 ms while a subagent runs, **no turn can be injected for the duration of a
   build** — the owner's chat is dead for two hours and the driver's next dispatch turn
   queues behind it. Under herdr an unchanged repaint collapses; a spinner does not. This
   is L1's day-1 probe, before anything else, because its failure changes the dispatch
   design (the fix would be in `pty-noise.ts`'s classification, one lane-day — but only if
   known on day 1, not day 8).
2. **Context pressure on the owner's conversation.** Each dispatch turn adds its
   instruction, the tool result and the completion notification to the REPL transcript.
   Unconstrained, that is 2–4k tokens per pair; a build with three fix rounds is roughly
   6 + 5×3 = 21 pairs → **40–80k tokens per build into the planning conversation**, and
   three concurrent builds exceed a 200k window in one day, so autocompact
   (`autocompact-support.ts`, `session-size-watchdog.ts`) fires mid-planning. Designed
   to instead: subagents reply with one line (the trailer path), dispatch turns reply with
   one line, instructions ≤300 tokens → ~1k per pair → **~20k per build**. That is the
   number L5 designs to and L8 measures on the first live build; if the measured figure
   is over 30k, the fix is prompt discipline, not architecture.
3. **A REPL respawn now kills every in-flight build in the project.** §3.8 calls this
   correct, not fratricide, and it is — but the persistent host has sixteen modules that
   can end or respawn the REPL (`dead-repl-detector`, `session-size-watchdog`,
   `model-update-watchdog`, `cwd-drift-watchdog`, `heartbeat-watchdog`,
   `interactive-prompt-deadlock-detector`, `channel-unbound-respawn`, `session-respawn`,
   `pending-respawn*`, `admin-respawn-session`, `dead-repl-respawn-dispatch`,
   `respawn-strategy`, `rate-limit-options-detector`, `resume-picker-detector`,
   `repl-detectors` — `ls runtime/adapters/claude-code/persistent/`). **The number that
   matters is respawns per day on the live instance**, readable from the gateway journal
   and not from this tree. It must be measured before day 8. If it is above roughly one
   per day, crash-resume (cut in G.4 item 2) is the first thing to bring back, because a
   two-hour build has a two-hour exposure window.
4. **No concurrency cap exists.** `grep` over `trident/tick.ts`, `trident/store.ts`,
   `trident/dispatch-holds.ts` finds no per-project cap (the only `concurrency` hits are
   `test-strategy.ts`'s test-job budget, `:270-479`). With in-repl placement, N builds are
   N Forge subagents plus up to three reviewers each inside one CLI process and one
   conversation. Decision (internal, mine): **admission refuses a third concurrent build
   per project** pre-cutover, derived from H.D.2's context arithmetic (two builds ≈ 40k
   tokens of transcript per day at the designed rate). Raised after measurement.
5. **Turn-queue interleaving.** `composeActingTurn` enqueues per `project:topic`
   (`build-live-agent-turn.ts:1066`), so a dispatch turn waits behind an owner planning
   turn (minutes, on a high-reasoning model) and vice versa (seconds). Acceptable; the
   design note for L5 is that queue wait must not count against a step's wall budget.
6. **Model inheritance.** The REPL carries `frontier_model_floor: true`
   (`substrate-profiles.ts:266`) and may be on the planning model when a build dispatches.
   The floor still governs fresh chats; an explicit session-only owner switch under
   the 2026-09-11 harness pivot survives only that conversation's resume.
   A subagent call that omits `model` inherits it — a Forge build on the planning tier. Every
   dispatch sets `model` explicitly from `model-tiers.ts`; L5's fake-runner test asserts no
   request leaves without one.
7. **Not riskier, stated so it is not re-argued:** RAM and CPU. Subagents are threads of
   one process, not processes; the owner's objection to all-headless was exactly this and
   it is the reason in-repl is the default.
