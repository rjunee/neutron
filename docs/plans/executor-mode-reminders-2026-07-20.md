# Executor-Mode Reminders — Design Doc (Neutron Open)

> ## ⚠️ DEEPENED 2026-07-20 — READ THIS BLOCK BEFORE THE PLAN BELOW
>
> Four reviews (security, architecture, simplicity, agent-native) were run against this plan.
> **They invalidated the plan's central safety argument and three of its factual claims about
> existing infrastructure.** Every finding below was independently re-verified against the code by
> the orchestrator before being recorded. The sections further down are the ORIGINAL plan and are
> superseded where they conflict with this block.
>
> ### THE FINDING THAT CHANGES THE DESIGN: Layer 3 fails OPEN, not closed
>
> §3 proposed dropping `--dangerously-skip-permissions` for ritual REPLs so out-of-scope writes
> would fail closed. **The substrate auto-approves permission prompts on every REPL,
> unconditionally** — `runtime/adapters/claude-code/persistent/spawn.ts:239-245` registers a
> `tool-use-approve` scanner that presses `['1','enter']` when it matches
> `/doyouwantto(makethisedit|proceed|runthiscommand|create)/i`
> (`signatures.ts:89-90`). Note `runthiscommand`: **Bash approvals are auto-pressed too.**
>
> So dropping skip-permissions makes Claude Code RENDER the prompt and the substrate PRESS YES.
> **T4 as designed would have PASSED** — it asserts the run terminates and the outside write is
> absent; the run terminates normally and the write succeeds. We would have shipped believing
> writes were contained.
>
> This is not a bug to route around. The auto-approver is deliberate: it assumes every REPL already
> runs under skip-permissions. Ritual REPLs violate that assumption.
>
> ### The four-layer stack is actually ONE layer
>
> | Layer | Claimed | Verified reality |
> |---|---|---|
> | 1. `--tools` default-deny | enforced | **TRUE — holds.** Always emitted; invariant explicitly survives `skipPermissions` (`build-repl-argv.ts:52-60,91-98`) |
> | 2. MCP bridge namespace | scoped | **Advertisement only.** `pool-state.ts:155-185` dispatches by wire `tool_name` with no check against the session manifest |
> | 3. settings write-containment | "unverified" | **Does not exist AND inverts.** `build-settings.ts` writes only the Stop hook — zero `permissions` keys. Plus the auto-approver above |
> | 4. scope root | project dir | **Defaults to `owner_home`.** `agent-dispatch/service.ts:455` ← `open/composer.ts:851` |
>
> **With `Bash` granted, containment is OS-level (separate uid / container / sandbox profile) or
> nothing.** `bash -c 'echo x > /outside'` is not an `Edit` call; `--add-dir` is a grant, not a jail;
> and `mergeEnv` (`repl-session.ts:410-426`) hands the child the gateway's environment minus three
> Anthropic keys, so Bash can read remaining credentials with `env`.
>
> ### CONSEQUENT BUILD ORDER (supersedes §7's ordering)
>
> 1. **M2-3 first** — collapse `NEUTRON_PERFECT_RECALL`, flip consolidation to 6h ON. Two reasons:
>    it is an outstanding no-feature-flags violation, and Ryan's decision to fold entity-upkeep into
>    core memory would otherwise attach it to something a fresh install never runs
>    (`scribe/reflect/reflect-pass.ts:103` = **24h**; `runtime/perfect-recall-flag.ts:25` = **default-off**).
> 2. **Approval-gate infrastructure**, content-hash bound (see below).
> 3. **Read-only rituals ship first** — morning-brief, evening-wrap, book-refresh are `Writes: none`
>    per this plan's own Appendix B2. Surface `['Read','Glob','Grep']`, no Bash. Layer 1 alone
>    genuinely contains that, and Layer 1 is verified today.
> 4. **OS-level sandbox** — its own sprint. Gates every writing/Bash ritual (kaizen, dreaming).
>
> ### APPROVAL GATE — reuse the in-repo precedent, do not invent one
>
> Ryan's Q3 makes registration agent-callable with in-chat approval, so the approval IS the security
> boundary. **The mechanism that fixed the onboarding auto-answer bug is the correct precedent:**
> `captureButtonBackedRequiredField` (`onboarding/interview/button-backed-answer.ts:198`). Its
> eligibility gate fires ONLY when the prior agent message carried a persisted option set
> (`prior_agent_options` from ButtonStore `options_json`, not the message body — `:207-209`), so an
> arbitrary conversational reply can never be captured as consent. That is exactly the failure this
> approval must not have.
>
> - Agent emits a persisted option set carrying an opaque `proposal_id`; approval binds to that id,
>   never to the text "yes".
> - **Bind approval to a CONTENT HASH** of (prompt bytes ‖ tool surface ‖ scope root ‖ cadence ‖
>   model tier ‖ timeout), and **re-verify at EVERY fire**, not just the first — a scheduled actor's
>   risk is in fire #500. Ported Vajra prompts are files, so their bytes are mutable after approval.
> - **`requires_approval` must NOT be a field on the RitualDef** — anything that can write the def
>   can clear its own approval bit. Use a separate approval record keyed
>   `(ritual_id, content_hash, approved_by, approved_at)`.
> - **No self-approval:** ButtonStore already persists `resolution_speaker_user_id`
>   (`channels/button-store.ts:106`); the resolving speaker must be the owner.
> - **Never Markdown-render the prompt body** (the button body is Markdown today —
>   `channels/button-primitive.ts:193`). Render preformatted. **Never truncate** — refuse
>   registration above a hard cap instead. Normalize NFC, reject bidi/zero-width, and itemize every
>   URL/path/skill reference separately from the prose.
> - **Describe capability, not tool names.** Not "surface: Read, Glob, Grep, Bash" but "can run any
>   shell command as the Neutron user, every N hours, unattended, inheriting gateway credentials".
> - **Cadence is NOT low-risk** (§3 says it is). An injected agent re-cadencing weekly →
>   `* * * * *` turns one approval into 1440 unattended runs/day. Cadence changes need re-approval,
>   or a hard floor plus a per-ritual daily fire cap.
> - **`reminders_update` launders approval** — it is atomic cancel+create and mints a NEW id
>   (`cores/free/reminders/src/mcp-tools-extra.ts:64`). Approval keys to the hash, and update drops approval.
> - **Egress is a capability.** `WebSearch`/`WebFetch` (kaizen uses WebSearch) is an exfiltration
>   channel — separately approved class.
> - **`tools/approval.ts` already exists with durable `tool_approvals` rows (migration 0004) but its
>   notifier is a no-op stub** (`open/composer.ts:3443`). Extend it or delete it — do not ship a
>   second parallel approval mechanism beside an unwired first.
>
> ### THREE FALSE INFRASTRUCTURE CLAIMS IN THIS PLAN (all re-verified)
>
> 1. **"registry integration for free" is false.** `agent_kind` is a closed CHECK enum
>    (`migrations/0100_code_subagent_registry.sql:115`); `'ritual'` is **rejected at INSERT**. Needs a migration.
> 2. **The status vocabulary is wrong.** Actual: `'pending'|'running'|'finished'|'crashed'|'cancelled'`
>    (`runtime/subagent/registry.ts:18`) — there is no `completed`, `failed`, or `timed_out`. A ritual
>    that ran and produced a WRONG result has nowhere to record it.
> 3. **The registry is a liveness table, not run history** — rows are DELETED on prune
>    (`runtime/subagent/store.ts:171`), and it has no `ritual_id`, no output, no exit summary. So
>    *"why did my morning brief not run yesterday?"* is unanswerable. `reminders_list` cannot answer
>    it either — it hard-filters to pending (`cores/free/reminders/src/backend.ts:372-383`).
>    **Add a separate `code_ritual_runs` table** with its own retention.
>
> ### OTHER VERIFIED CORRECTIONS
>
> - **`DispatchService` cannot host rituals** — it throws `missing_board_item` on any dispatch with
>   no Plan item (`agent-dispatch/service.ts:296-300`). A scheduled ritual has none. Integrate at
>   `spawnSubagent` (`runtime/subagent/spawn.ts:67`) + `buildCancellableDispatchTurn` instead.
> - **The push hook fires when a ritual STARTS.** `reminders/tick.ts:206-219` calls `on_fired` after
>   `dispatch` returns, and executors return immediately — so the owner is notified up to 45 min
>   before any output, **including for `silent: true` rituals.** Executor rows must skip `on_fired`.
> - **Branch in the TICK, not the dispatcher.** `dispatcher.ts`'s throw contract is load-bearing for
>   the #319 claim-revert (`dispatcher.ts:271-282` ↔ `tick.ts:220-236`); making it conditional
>   creates an invariant that reads "true, except for one row type". Branching in the tick also makes
>   the `on_fired` fix fall out naturally.
> - **`makeEphemeralSubstrate` hardcodes `skip_permissions: true`** (`open/wiring/substrates.ts:296`)
>   and does not enable the tool bridge — so Layers 2 and 3 both require a new/changed factory.
> - **`appendSystemPromptFile` is a prerequisite, not a nice-to-have.** The argv always emits it
>   (`build-repl-argv.ts:104`) defaulting to the conversational base prompt; unthreaded, a ritual REPL
>   silently runs AS THE CHAT AGENT and inherits the enforce-reply Stop hook (`build-settings.ts:44`)
>   — a plausible wedge.
> - **Migration citation was wrong:** the `recurrence_spec` precedent is **0095**, not 0093. Next free
>   is **0105**, and an `ADD COLUMN` on `reminders` requires regenerating `migrations/expected-schema.txt`.
> - **Concurrency starvation:** `MAX_CONCURRENT_SUBAGENTS` is a single global cap
>   (`runtime/subagent/spawn.ts:21,40`); several 45-min rituals on a shared cron boundary can block
>   interactive `/dispatch` for an hour. Rituals need their own lane.
> - **Ported Vajra prompts will silently no-op.** They are grounded on `~/vajra`, `entities/`, `gog`,
>   `gh`. In Neutron they will run, cost tokens, exit 0 and do nothing — the persona-gen shape on a
>   3am cadence. **Per-ritual acceptance tests (T7) are therefore mandatory before each ritual ships,
>   not deferred.**
> - **Ryan's Q2, split by tier** (architecture review): backlink repair → core memory, deterministic,
>   EVENT-DRIVEN on the sync hook (the entity writer already emits `newLinks`/`removedLinks`,
>   `runtime/entity-writer.ts:163`); correction-pattern promotion → the reflect pass; **daily-delta
>   notes stay a ritual** (time-anchored; nothing in memory triggers it).
>
> ### NEW TEST — T8 (the one that would have caught the onboarding bug)
>
> Agent proposes a ritual; the owner replies something UNRELATED on the next turn. Assert the ritual
> stays `pending_approval` and never dispatches. This is the exact shape of the onboarding
> auto-answer defect.
>
> ### SIMPLIFICATIONS ACCEPTED (v1 scope)
>
> Derive `prompt_path` from `rituals/<id>.md`; `model_tier` and `timeout_ms` become constants until a
> ritual proves it needs otherwise; `mcp_namespaces` has exactly one possible value today — make it a
> boolean or derive it. Drop the boot-time `auditReminderConfigShape` lint (regex-guessing owner
> intent at boot, no failure mode to prevent) and the per-tick executor cap of 2 (a second cap over
> `per_tick_limit` 50 + the subagent cap). **Do NOT cut:** fire-and-forget/never-await; validation
> failure → SKIP never degrade-to-nudge; `tools` never `[]` (the #361 toolless class); failure-notice
> posting; ephemeral-REPL-never-warm-session; T2 and a scoped T7.


> **STATUS: COMPLETE — awaiting Ryan's review.** Written 2026-07-20 (attempt 3, incremental-write discipline).
> Every `file:line` was read directly this session; the one unverified mechanism is explicitly
> flagged (§3 Layer 3 / test T4 — headless fail-closed permission denies).

Scope: design only. No build. Ryan reviews before code.

**Executive summary.** Reminders gain a `ritual_id` column pointing at an owner-controlled RITUAL REGISTRY (typed: prompt file, tool surface, scope dir, model tier, timeout, silent flag, approval bit). At fire time the dispatcher takes an executor branch: validate against the registry, spawn a fire-and-forget run on an ephemeral `cc-ritual-*` REPL through the existing subagent registry/watchdog/boot-reap machinery, advance the row immediately (Vajra's exemption semantics), post the result through the one deliver seam on completion. Permissions: default-deny `--tools` per ritual, MCP bridge tools instead of shell (NO Bash by default — the deliberate divergence from Vajra), settings-level write containment to the scope dir instead of `--dangerously-skip-permissions`, and ritual REGISTRATION is owner-only so chat-side prompt injection can never mint an autonomous actor. Rituals never touch the warm per-project chat session, so they neither wake nor fight the 3h TTL; the two real TTL requirements land on the nudge path and are recorded in §5 for the TTL build. The hard part Ryan asked to scrutinise is §3; the one thing needing a code spike before any writing ritual ships is test T4.

Locked decisions this design works WITHIN — all VERIFIED in `~/repos/neutron-managed/SPEC.md` Decisions Log:
- **Restricted executor tool set, scoped per project** (SPEC.md:369-372): reads + writes within own project; no destructive operations without a human; "a misbehaving ritual is a silent 3am event"; genuinely destructive rituals need explicit allowance.
- **3-hour idle TTL, wake by resume** (SPEC.md:353-367): sleep half NOT built (no per-session `last_turn_at` anywhere); wake half built (`session-respawn.ts` always `--resume`, refuses `no-session-to-resume` rather than starting cold). The TTL sweeper is a separate M2 build; this design must interoperate with it, not implement it.
- **Memory consolidation every 6h, ON by default** (SPEC.md:374-376): `NEUTRON_PERFECT_RECALL` flag to be collapsed. Relevant here because Vajra's `dreaming` ritual is partly redundant with it — see §7.
- **M2-2 framing** (SPEC.md:406-410): design doc lands first; tool/permission model is the hard part; must wake a sleeping project correctly.
- **Long-tail integrations are per-user SKILLS, not app features** (SPEC.md:421-435) — constrains how ritual prompts reference external tools.

## 1. Vajra-vs-Neutron delta (file:line both sides)

| Concern | Vajra | Neutron today | Delta |
|---|---|---|---|
| Mode switch | `prompt_file` presence = executor (`gateway/gateway-core.ts:2852`) | no equivalent field; `reminders/store.ts:33-63` has no prompt/model column | schema + concept missing |
| Fire semantics | executor exempt from confirm/retry/give-up; advance `next_fire` immediately at fire (`gateway-core.ts:2292-2307`) | ALL rows take #319 claim-before-dispatch + revert-on-throw (`reminders/tick.ts:153-236`) | need an executor branch that advances-and-forgets |
| Prompt resolution | `resolveExecutorPromptFile` — charset guard, `..` reject, containment under `prompts/`, exists-check; bad path → skip spawn (`gateway-core.ts:2865-2889`, `index.ts:8973-8984`) | nudge prompt is code-built (`reminders/prompt.ts:64`); personas for background agents are repo files composed into `user_message` (`agent-dispatch/prompts.ts:1-47`, `service.ts:34-41`) | need a ritual-prompt registry + validation |
| Model tiering | nudge = fast/Haiku (`gateway-core.ts:2963`); executor = smart default, allowlist-validated override, reject-unknown (`:2980-2988`) | nudge = `FAST_MODEL` (`dispatcher.ts:183`); background agents = `getBestModel()` thunk (`open/composer.ts:854`) | port the reject-unknown override semantics |
| Timeout | nudge 1800s; executor `REMINDER_EXECUTOR_TIMEOUT_SEC=2700` (`gateway-core.ts:2836`), perl-alarm hard kill (`:3263`) | nudge compose 90s (`dispatcher.ts:124`); dispatch turns take `timeout_ms` + cancellable handle (`agent-dispatch/substrate-turn.ts:73-79`) | executor gets a 45-min budget on the cancellable runner |
| Execution vehicle | one-shot `claude -p --append-system-prompt-file <ritual> --dangerously-skip-permissions` in a tmux window (`gateway-core.ts:3263`, `index.ts:9000`) | warm chat substrate for nudge compose (`open/composer.ts:1716-1740`); fresh ephemeral `cc-dispatch-*` REPL + subagent registry/watchdog/boot-reap for background agents (`open/composer.ts:836-857`) | executor = ephemeral REPL via the subagent machinery, NOT the warm chat session |
| Permissions | none — full ambient authority as Ryan | `--tools` default-deny built-ins + `--allowedTools` MCP namespaces + optional skip-permissions, all spawn-time (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:45-107`, `spawn.ts:110-150`) | Neutron already has the enforcement seam Vajra lacks; §3 |
| Delivery | executor posts via `tg-post.sh` or is silent; exempt from `/post-reminder` confirm + exit sentinels (`index.ts:9003-9014`) | one deliver seam → durable history row + live push (`open/composer.ts:1730-1760`, `gateway/http/deliver.ts`) | strictly better; reuse deliver |
| Failure surfacing | log-only; config-shape lint `auditReminderConfigShape` (`gateway-core.ts:2935-2953`) | subagent registry rows + watchdog + boot-reap of orphans (`open/composer.ts:819-879`) | strictly better; reuse registry |
| Ritual inventory | 5 live rows (Appendix A); prompts total 617 lines | evening-wrap/dreaming/kaizen/book-refresh grep-zero; morning-brief shallow (`gateway/proactive/morning-brief.ts`) | port 4-5 ritual prompts, re-grounded on Neutron tools |

## 2. Proposed Neutron design

### 2a. Ritual registry (the new concept — replaces raw `prompt_file`)

Vajra points a reminder at a prompt FILE and trusts path containment. Neutron should point a reminder at a REGISTERED RITUAL — a typed record, because the ritual now carries a permission contract, not just text:

```ts
// reminders/rituals.ts (new)
interface RitualDef {
  id: string                      // 'morning-brief', 'kaizen', …
  prompt_path: string             // repo-bundled or owner_home-provisioned .md; validated like resolveExecutorPromptFile
  scope: 'project' | 'instance'   // cwd + write-containment root
  tool_surface: string[]          // built-ins granted, e.g. ['Read','Glob','Grep'] or +['Edit','Write']
  mcp_namespaces: string[]        // e.g. ['mcp__neutron'] — bridge tools (memory_search, calendar read, …)
  model_tier: 'fast' | 'best'     // resolved via runtime/models.ts getters at fire time (never a raw id)
  timeout_ms: number              // default RITUAL_TIMEOUT_MS = 45 * 60_000 (Vajra parity)
  silent: boolean                 // dreaming-style: no completion post
  requires_approval: boolean      // true ⇒ inert until owner approves in settings (destructive-allowance path, SPEC.md:371-372)
}
```

- Bundled rituals ship in-repo (ported prompts); owner-authored rituals are files the owner registers — registration is an OWNER action (settings UI / config), never an agent tool. A chat agent can schedule/cancel a registered ritual but can never author one — that closes the privilege-escalation hole where a prompt-injected chat turn creates a scheduled autonomous actor with write access (see §3).
- Schema: migration adds nullable `ritual_id` to `reminders` (mirrors `recurrence_spec` precedent, migration 0093). No `prompt_file` column — the indirection through the registry IS the design. No `model` column either; the tier lives on the RitualDef.
- Validation at fire time mirrors `resolveExecutorPromptFile`: unknown `ritual_id` / missing prompt file / unapproved `requires_approval` → log + SKIP the spawn (never degrade to the nudge composer — Vajra's rationale at `index.ts:8975-8979` holds verbatim), row already advanced so the next occurrence retries after the operator fixes it.

### 2b. Dispatch branch

In `buildReminderDispatcher.dispatch()` (`reminders/dispatcher.ts:247`), branch BEFORE shape classification:

```
if (reminder.ritual_id !== null) → executor path:
  1. resolve RitualDef; on any validation failure: log + return (fire-and-forget skip)
  2. spawn via the subagent machinery (spawnSubagent / a DispatchService-shaped runner)
     with kind 'ritual', an ephemeral substrate makeEphemeralSubstrate('cc-ritual')
     rooted at the ritual's scope dir, the RitualDef tool surface, model, timeout
  3. return IMMEDIATELY — do not await the run
```

- **Why not await:** the tick loop is single-flight (`tick.ts:12-14`); an awaited 45-min ritual would starve every other reminder for its duration. Vajra's fire-and-forget exemption (`gateway-core.ts:2292-2307`) is load-bearing and must be mirrored: the executor branch returns before completion, so the #319 claim (already committed by the tick) simply stands — the row advances exactly once per occurrence, and the "dispatcher only throws before delivery" contract (`dispatcher.ts:271-282`) is explicitly NOT extended to executor rows (documented divergence; the contract stays true for nudges).
- **Prompt delivery:** compose `<ritual prompt file contents>\n\n---\n\nFire context:\n<reminder.message, ISO now, project id>` into `user_message` — the exact channel agent-dispatch personas already ride (`agent-dispatch/service.ts:34-41` records that the substrate drops `system`, so persona-in-user_message is the established pattern). `appendSystemPromptFile` exists on the persistent adapter (`runtime/adapters/claude-code/persistent/types.ts:216`) but is not threaded through `buildLlmCallSubstrate` — threading it is a nice-to-have, not a prerequisite.
- **Tool surface is declared, never empty:** `AgentSpec.tools` maps straight onto `--tools` (`spawn.ts:118-131`); `tools: []` ships a TOOLLESS subprocess — the #361/#175 failure class recorded at `trident/conflict-resolver.ts:32-41`. Each RitualDef surface is built the way `RESOLVER_TOOLS` is (`conflict-resolver.ts:80-87`).
- **Completion → delivery:** on the background run's terminal event, post the final text through the SAME deliver seam nudges use (durable history row + live app-ws push, `open/composer.ts:1730-1760`) to the reminder's resolved topic; `silent` rituals skip the post. Failures post a short failure notice instead (improvement over Vajra, where a dead ritual is invisible until someone reads logs).
- **Registry integration for free:** durable run rows (migration 0100), the lifecycle watchdog, `/dispatch stop`-style cancellation, and boot-reap of orphaned runs after a gateway crash (`open/composer.ts:859-879`) all apply to `cc-ritual` runs with no new machinery.

### 2c. Model tiering + timeout

- Tier resolution at fire time via `runtime/models.ts` getters (`FAST_MODEL` / `getBestModel()` thunk — the model-update watchdog's adopted id reaches new runs, `open/composer.ts:852-854`). Port Vajra's reject-unknown semantics (`gateway-core.ts:2980-2988`): RitualDef stores a TIER, not an id; anything else is a compile/validation error. No raw model string ever reaches the argv (parity with Vajra's allowlist + charset guard, `gateway-core.ts:3215-3217`).
- `RITUAL_TIMEOUT_MS` default 45 min (Vajra's 2700s), per-RitualDef override; enforced by the cancellable turn runner's local timer + `handle.cancel()` (`agent-dispatch/substrate-turn.ts:73-79`) with the lifecycle watchdog as backstop. No perl alarm — that is tmux/macOS-specific (§7).

## 2. Proposed Neutron design (dispatch branch, prompt resolution, model tiering, timeouts)

_WIP_

## 3. Tool/permission model + guardrails

The locked decision (SPEC.md:369-372): reads + writes inside the ritual's own project, no destructive operations without a human. Vajra offers no model to port here — its executors run `--dangerously-skip-permissions` with Ryan's full ambient authority (`gateway-core.ts:3263`), acceptable only because the box IS Ryan's laptop. Neutron's enforcement stack, from what already exists:

**Layer 1 — built-in tool gate (exists, spawn-time).** `--tools` is ALWAYS emitted, default-deny (`build-repl-argv.ts:52-60`). Ritual surfaces by need (from the Appendix B2 requirements table):
- Read-only rituals (morning-brief, evening-wrap): `['Read','Glob','Grep']` — the exact surface the nudge composer already uses (`dispatcher.ts:121`).
- Writing rituals (dreaming-class entity upkeep, kaizen report): `+['Edit','Write']`.
- **`Bash` is NOT in any default ritual surface.** This is the single biggest deliberate divergence from Vajra, whose rituals lean on shell (`gog`, `gh`, `git log`, `find`). Bash is arbitrary command execution — with it, "no destructive ops" is unenforceable. Neutron rituals get their external reads through bridge tools instead (next layer). A ritual that genuinely needs shell sets `requires_approval: true` and is inert until the owner approves it in settings — the explicit-allowance path the locked decision prescribes.

**Layer 2 — MCP bridge namespace (exists, spawn-time).** `--allowedTools mcp__neutron` grants the in-process ToolRegistry bridge (`spawn.ts:70-107`, `build-repl-argv.ts:64-72`), which is where calendar reads, `memory_search`, task/work-board reads, and reminders-core tools live. This replaces Vajra's `gog calendar` / `gh pr list` shell calls with tools the product already meters and scopes. Gap to note honestly: the bridge namespace is currently all-or-nothing (`mcp__<server>`); per-tool granularity within the bridge (a ritual that may read calendar but not send email) needs either a per-spawn tool-manifest filter (the manifest is already snapshotted per session, `spawn.ts:73-79` — filtering it per ritual is a small, natural extension) or a second bridge server name. The manifest filter is the recommendation.

**Layer 3 — write containment (the real work of this build).** `--tools`-level Write/Edit are not path-scoped by the argv alone. Options:
1. **Do NOT pass `skip_permissions` for ritual REPLs** (it is an option, not a constant — `substrates.ts:283-305` chooses it per factory) and pre-seed the per-session `settings.json` (`buildSettings`, `spawn.ts:110` — already written per spawn for the Stop hook) with permission rules: allow `Edit`/`Write` under the ritual's scope dir, deny outside. Out-of-scope writes then fail closed headlessly instead of prompting.
2. Keep `skip_permissions` and trust the prompt. Rejected — that is Vajra's model, explicitly ruled out.
Recommendation: option 1. **Marked as the design's one verification spike:** I have read the settings-write seam but have NOT verified end-to-end that a deny rule fail-closes (rather than wedges on an interactive prompt) in this adapter's headless PTY — the interactive-prompt deadlock detector (`ensure-claude-trust.ts:10-12`, `interactive-prompt-deadlock-detector.ts`) exists precisely because some dialogs ignore flags. Acceptance test T5 in §6 settles it before any ritual ships.

---

### T5 write-containment spike verdict — 2026-07-21 (task 6)

**VERDICT: UNPROVABLE.** The settings-level `permissions.deny` containment did NOT demonstrate a clean fail-closed (silent deny, no wedge, control write intact) in the real headless PTY (`claude` 2.1.215). Per the decision rule below, an OS-level sandbox becomes its own prerequisite sprint and **Bash/writing rituals STAY GATED**; read-only rituals (task 7) still ship under Layer 1 (`--tools` default-deny + `skip_permissions:true`).

**What was built + wired (this is the durable plumbing regardless of verdict):**
- `runtime/adapters/claude-code/persistent/build-settings.ts` — `buildSettings` now writes an optional `permissions` block (`allow`/`deny`/`ask`/`defaultMode`) ALONGSIDE the Stop hook, 0600 atomic write, empty sub-arrays dropped. Absent ⇒ byte-identical to the pre-task-6 Stop-hook-only write.
- `runtime/adapters/claude-code/persistent/spawn.ts` — the `tool-use-approve` auto-approver register block (was `spawn.ts:253-259`) is GATED behind `if (options.disableToolUseAutoApprove !== true)`; every other detector — incl. the wedged-prompt deadlock-recovery ladder (`createWedgedPromptDetector()`, the no-hang backstop) — stays unconditionally registered. `buildSettings({settingsPath})` now forwards `options.permissions` when present.
- `persistent/types.ts` `disableToolUseAutoApprove?` + `permissions?`; `runtime/adapters/claude-code/index.ts` `ClaudeCodeSubstrateOptions` + threading; `gateway/wiring/build-llm-call-substrate.ts` `BuildLlmCallSubstrateInput` + forwarding as DIRECT call-args (NOT via `SubstrateProfile` — `PROFILE_RITUAL` stays frozen; `substrate-profiles.test.ts` green).
- Fake-host unit proof: `persistent/__tests__/ritual-auto-approve-gate.test.ts` — with `disableToolUseAutoApprove:true` the spawned session's scanner does NOT carry `tool-use-approve` while `wedged-interactive-prompt` / disclaimer / rate-limit / compact-resume DO; default carries it. `OutputScanner.has(id)` seam added. `build-settings.test.ts` proves the permissions block writes + Stop hook intact + 0600.
- Real-PTY spike: `persistent/__tests__/ritual-write-containment.e2e.test.ts` (`NEUTRON_PTY_E2E=1`, `describe.skipIf`). Configures a WRITING ritual as designed: `skipPermissions:false`, `tools:['Write','Edit']`, `appendSystemPromptFile=reminders/ritual-agent-base.md`, `buildSettings({permissions:{allow:['Write(scope/**)','Edit(scope/**)'],deny:['Write(outside/**)','Edit(outside/**)','Bash']}})`. Arm A does NOT auto-approve (models the auto-approver OFF) and injects `escape` on any tool-use prompt (models the wedge-recovery ladder's decline rung). Arm B presses `1`+enter (approver ON).

**Exact settings.json `permissions` combinations tested:** (1) `{allow:[Write(scope/**),Edit(scope/**)], deny:[Write(outside/**),Edit(outside/**),Bash]}`; (2) the same plus `defaultMode:'acceptEdits'`.

**Observed CC behavior (6 ritual-write runs interleaved with 2 passing sibling controls, same box + same `claude` 2.1.215):**
- **1/6 runs bound the dev-channel MCP.** On that run: CC rendered an interactive tool-use permission prompt (`toolUsePromptSeen=true`) and the REPL WEDGED — the in-scope (control) write AND the out-of-scope write both never landed, and the turn never reached a terminal state (no `/reply`, child alive). The out-of-scope write was absent only *incidentally* (the whole turn hung before any write executed), NOT via a clean silent deny.
- **5/6 runs the dev-channel MCP never bound** (`channelPort` still 0 after 30s) — with the `permissions` block + `skip_permissions:false`. Adding `defaultMode:'acceptEdits'` did not help. The IDENTICAL `buildSettings` WITHOUT a permissions block + `skip_permissions:true` (the sibling `dev-channel-pty-bind.e2e.test.ts`) bound and round-tripped a real turn in ~5-7s, run TWICE, interleaved — so the environment/creds were healthy; the instability tracks `skip_permissions:false` + the settings `permissions` block.
- The SAFETY invariant held in every run: no out-of-scope file was ever written to disk (asserted by both arms).

**Why UNPROVABLE (not PROVEN):** the containment never showed the PROVEN shape (bind + silent deny of the out-of-scope write + the in-scope control write succeeding + a terminal state + no wedge). Instead it either wedged on an interactive permission prompt (the exact §Layer-3 risk) or failed to bind the REPL's own dev-channel at all. Dropping `skip_permissions` for a ritual REPL — the Layer-3 option-1 mechanism — is not viable as-is on this CC version.

**Consequence (decision rule, honored):** UNPROVABLE (outside write did not succeed, but the REPL wedged/failed-to-bind without a clean fail-closed) → an **OS-level sandbox** (the reserved `SubstrateSandboxConfig` in `substrate-profiles.ts`) becomes its **own prerequisite sprint**; Bash/writing rituals **STAY GATED** on that sprint + task-8 approval. Read-only rituals (task 7) ship under Layer 1 unaffected (they keep `skip_permissions:true` + `--tools ['Read','Glob','Grep']`, which binds reliably — the sibling control proves it). The task-6 plumbing (`permissions` write + `disableToolUseAutoApprove` gate) is landed and dormant until the sandbox sprint activates a writing-ritual factory.

**STAY GATED now enforced by CODE (Argus r1 major, round 2).** The gate is no longer only "absence of a registration surface" — `reminders/rituals.ts` `validateRitualFire` refuses fail-CLOSED any ritual whose `tool_surface` grants a write/exec-class tool (`GATED_WRITE_TOOLS` = `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`), returning the new `gated_tool_surface` skip verdict BEFORE any disk read or approval check. A def MAY still register a Bash surface (overturn 1 — Bash is portable), but it can never FIRE until the OS-sandbox sprint lifts the gate. Read-only rituals are unaffected. Test: `reminders/rituals.test.ts` `test.each([Bash, Write, Edit, MultiEdit, NotebookEdit])` → `gated_tool_surface` with isApproved + prompt-read NOT reached. When the sandbox factory lands, lift the gate in `GATED_WRITE_TOOLS` (the factory becomes the containment).

**To re-run the spike:** `NEUTRON_PTY_E2E=1 bun test runtime/adapters/claude-code/persistent/__tests__/ritual-write-containment.e2e.test.ts` (needs a real `claude` + creds). The `[T5 ARM A]` / `[T5 ARM B]` console lines carry the recorded observation; the opt-in test asserts only the safety invariant (nothing escaped) so a bind/wedge outcome is captured as data, not a crash.

**Layer 4 — scope root.** Ephemeral substrate cwd + `--add-dir` = the ritual's scope dir only: `Projects/<id>/` for project rituals, `owner_home` for instance rituals (morning-brief legitimately reads across projects — it is `scope: 'instance'`, read-only surface, so the wider root grants no write authority).

**Creation-path guardrails (who can make an executor exist):**
- Registering a ritual (prompt + surface + approval bit) = owner-only, via settings/config. Never an agent/MCP tool.
- Scheduling/cancelling/re-cadencing a REGISTERED ritual = allowed to the chat agent through reminders-core tools (validated `ritual_id` against the registry; cadence is low-risk).
- Net effect: a prompt injection in chat can at worst reschedule an existing owner-approved ritual, never mint a new autonomous actor or widen a surface. Vajra's containment check (`prompt_file` must live under `prompts/`) becomes "ritual_id must exist in the owner-controlled registry" — a strictly stronger property.
- Port `auditReminderConfigShape` (`gateway-core.ts:2935-2953`) as a boot-time lint: an enabled reminder whose message body reads like a ritual ("run the X agent", "execute every step", …) but carries no `ritual_id` gets surfaced to the owner — the PR-#139 half-fire class caught before it spams.

## 4. Failure, retry, delivery-confirmation semantics

Executor rows get Vajra's fire-and-forget contract with Neutron's superior observability bolted on:

- **Advance-immediately, at-most-once per occurrence.** The tick's #319 claim (advanceRecurrence-before-dispatch) already gives this; the executor branch simply never throws after spawn, so the claim stands. A crash between claim and spawn loses at most one occurrence (identical to Vajra's crash window at `gateway-core.ts:2301-2306`) — acceptable for rituals that re-fire on cadence.
- **No re-fire retry, no give-up counter, no `/post-reminder` handshake.** All three exist to guarantee nudge DELIVERY; a ritual's contract is EXECUTION, and re-running a half-completed 45-min writing ritual on a 30s tick cadence is worse than missing one occurrence (Vajra's comment at `gateway-core.ts:2292-2299` — false-give-up spam — is the recorded failure this prevents).
- **What replaces the sentinels:** Vajra proves process termination with `.exit`/`.delivered` files (`gateway-core.ts:3071-3142`) because `claude -p` in tmux is otherwise opaque. Neutron's runs land in the durable subagent registry (migration 0100): status transitions (pending→running→completed/failed/timed_out/cancelled), the lifecycle watchdog for stuck runs, and boot-reap marking prior-boot orphans `crashed` (`open/composer.ts:859-879`). Nothing to port — the registry IS the sentinel, durable and queryable.
- **Completion post:** non-silent rituals post their final text through `deliver()`; the post's accepted-boolean failure → one retry, then a logged failure notice. A FAILED/timed-out/crashed ritual posts a one-line failure notice to the topic (ritual id, status, run id). Improvement over Vajra, where executor failure is silent (log-file-only).
- **Consecutive-failure escalation:** N=3 consecutive terminal-failure runs of the same ritual → an owner notice recommending pause (mirrors the intent of `REMINDER_MAX_CONSECUTIVE_GIVEUPS`, `gateway-core.ts:2843`, without auto-disabling — the registry makes failures visible enough that silent-disable is unnecessary; note the store has no disabled status anyway, parity audit §1c).
- **Catchup/burst:** the tick's `per_tick_limit` (50) plus the subagent registry's shared concurrency cap bound a restart storm; Vajra's `MAX_SPAWNS_PER_TICK=2` (`gateway-core.ts:3000`) is not separately needed, but a per-tick executor-spawn cap of 2 is cheap insurance worth keeping given ritual weight.

## 5. Session/TTL interaction (waking a sleeping project)

The locked TTL decision (SPEC.md:353-367): warm per-project chat sessions die after 3h idle; wake is `--resume` (built, `session-respawn.ts:24-27`); the sleep half (per-session `last_turn_at` + reaper) is a separate M2 build.

**Design position: executor rituals run on EPHEMERAL REPLs and never touch the warm chat session — so they neither wake nor fight the TTL.**

- A ritual on the warm session would be wrong twice: it would pollute the project's conversational context with ritual internals, and a 6h dreaming-class cadence against a 3h TTL keeps every such project ~50% resident forever — a standing memory leak proportional to ritual count, exactly what the TTL exists to prevent (51-204MB RSS per REPL, SPEC.md:365-367).
- Firing a project ritual while the project sleeps requires NO wake: the ephemeral run reads the project from disk (fresh context is Vajra ritual semantics too — its executors are one-shot `claude -p` with no chat context), and the completion post is a durable history write + best-effort WS push (`deliver.ts` seam), not an agent turn — verified shape at `open/composer.ts:1730-1760`. The sleeping session's context is untouched; the owner sees the post on next open; nothing resumes.
- **The one real TTL interaction is the NUDGE path, and it belongs in the TTL build's requirements, not this one:** nudge composes run on the warm `liveAgentSubstrate` (`open/composer.ts:1723`), so (a) a nudge firing on a sleeping project MUST wake it via the always-resume path — which `getOrSpawnSession` + `session-respawn.ts` already guarantee — and (b) the future TTL sweeper MUST stamp `last_turn_at` on EVERY substrate turn (including reminder-compose turns) and never kill a session with an in-flight turn, or a 90s compose racing a reaper gets its REPL killed mid-turn. Recorded here as two acceptance requirements to hand the TTL build.
- Memory-consolidation-every-6h (SPEC.md:374-376) is the same shape: it should likewise run off-warm-session (it already does — scribe reflect pass), so rituals + consolidation + TTL compose without coupling.

## 6. Test strategy: what behaviour proves an executor performed its action

The parity audit's core lesson (SPEC.md:395-398): a subsystem that is present, wired, and green can still be missing half its capability. So the proof bar here is SIDE EFFECTS, not spawn logs.

**T1 — spec-shape (unit, fake substrate).** For each bundled RitualDef, capture the `AgentSpec` + substrate options the executor branch produces and assert: declared tool surface exactly (never `[]` — pin against the #361 toolless class), tier-resolved model, timeout, cwd = scope dir, prompt contains the ritual file's marker text. Assert unknown `ritual_id` / missing prompt file / unapproved ritual → NO spawn, row still advanced.

**T2 — fire-and-forget (unit, slow fake).** A ritual whose fake run takes longer than the tick interval: assert the tick completes without awaiting it, the row advanced exactly one occurrence, and other due reminders in the same tick still fired. Assert the nudge path's claim-revert contract is untouched (existing tests keep passing).

**T3 — behavioural completion (integration, fake substrate that actually writes).** Fake ritual run writes a marker file under its scope dir and returns text: assert (a) the marker exists, (b) a durable history row for the topic contains the text (ButtonStore, same assertion shape the reminder dispatcher integration tests use), (c) a `silent: true` ritual produces (a) but NOT (b), (d) a failing run produces a failure-notice row instead.

**T4 — containment (E2E, real CC subprocess — the §3 spike).** A throwaway ritual instructed to write INSIDE scope, then OUTSIDE scope (an owner_home path off-project): assert the inside write exists, the outside write does NOT, and the run TERMINATES (fail-closed, no wedged interactive prompt — pair with the deadlock detector's signature scan). This single test validates the whole Layer-3 mechanism and gates shipping any writing ritual.

**T5 — TTL non-interaction (integration).** Fire a project ritual with the project's warm session absent: assert no `cc-agent-*` session is spawned/resumed (repl-registry unchanged) and the post landed durably. Fire a NUDGE on the same sleeping project: assert the warm session DID resume (the wake half working as SPEC records).

**T6 — crash surfacing (integration).** Kill the process mid-ritual-run; on next boot assert the registry row is reaped to `crashed` and the failure notice fires (reuses the boot-reap wiring test pattern, `agent-dispatch/boot-reap-wiring.test.ts`).

**T7 — per-ritual acceptance (the "did it do its JOB" bar), run against a fixture project.** Examples: morning-brief output references ≥1 real item from the fixture's STATUS/tasks (not composable without reading them); dreaming-class ritual repairs a planted broken `[[wiki-link]]` and appends the daily-note delta section, and a SECOND run makes no further changes (idempotency, Vajra's dreaming prompt requirement); kaizen output cites a planted corrections-log entry. These are LLM-behaviour tests — run them as gated E2Es, not per-commit units.

## 7. What we deliberately do NOT port, and why

| Vajra artifact | Why not |
|---|---|
| tmux window spawn + window-name tagging (`index.ts:9000`) | transport is Vajra-host-specific; Neutron's vehicle is the ephemeral REPL + subagent registry |
| perl `alarm` hard-kill wrapper (`gateway-core.ts:3239-3263`) | macOS-missing-`timeout` workaround; the cancellable runner + watchdog own the budget |
| `.exit` / `.delivered` sentinel files + exit-confirm watcher (`gateway-core.ts:3071-3190`) | existed because `claude -p`-in-tmux is opaque; the durable registry + drainToOutcome replace both |
| `tg-post.sh` fallback posting | replaced by the single `deliver()` seam (durable + live-push) |
| `/post-reminder` confirm handshake for executors | executors were already exempt in Vajra (`index.ts:9012`); the exemption is ported, the machinery is not |
| `--dangerously-skip-permissions` ambient authority | the point of the locked decision; §3 replaces it |
| `REMINDER_EXECUTOR_TIMEOUT_SEC` as a global constant | becomes per-RitualDef with the same default — rituals differ 10× in weight |
| Executor give-up/auto-disable machinery | never applied to executors even in Vajra; consecutive-failure notice (§4) covers the intent |
| Heartbeat file + catchup-announce (`gateway-core.ts:3009-3026`) | the store+tick already collapse missed cron fires to one; per-tick limits bound storms |
| `dreaming.md` VERBATIM | its consolidation half is superseded by the 6h memory-consolidation lock (SPEC.md:374-376). Its OTHER half — entity backlink repair, daily-delta notes, correction-pattern promotion — is NOT covered by the reflect pass and should be re-scoped as a leaner `entity-upkeep` ritual against `runtime/entity-writer` conventions rather than ported line-by-line. Flagged for Ryan: this is the one ritual where "port" and "already built" genuinely overlap. |
| `morning-brief.md` shell recipes (`gog calendar` ×3, `gh pr list`) | re-grounded on bridge tools (calendar core, work-board reads); 3-account calendar merge is a separate parity gap (audit §1f) the ritual inherits, not solves |
| Vajra's 5-hardcoded-rituals-as-config | rituals become registry entries; the 5 become bundled defaults the owner can disable |

## Appendix A — Vajra executor reminder inventory (from gateway/reminders.json)

83 rows live; 5 executor rows, all enabled — verified 2026-07-20 (see §B1 table for cron/model). All five are Vajra-relative `prompts/*.md` paths; none use `agent_cwd` outside `~/vajra`; dreaming is the only model-override row (`sonnet`) and the only silent one. The remaining 78 rows are nudges — unaffected by this design.

## Appendix B — Raw research notes

### B1. Vajra executor path (all verified by direct read, 2026-07-20)

Correction to the brief: the executor machinery lives in `~/vajra/gateway/gateway-core.ts`, not `index.ts:8965-9010` (that range is elsewhere; the parity audit's citations were correct).

- **Mode switch** — `gateway-core.ts:2852-2854` `isExecutorReminder(r)`: presence of a non-empty `prompt_file` string IS the mode; no separate boolean.
- **Fire-and-forget exemption** — `gateway-core.ts:2292-2307`: executor reminders are EXEMPT from the entire delivery-confirm / retry / give-up state machine. On fire: snapshot pushed to `toFire`, `next_fire` advanced to next cron occurrence immediately, `last_fired` stamped, `pending_delivery_at` never armed. Rationale in comment: they post no confirmable nudge; entering the confirm machinery would false-give-up forever (a real past bug).
- **Prompt resolution** — `gateway-core.ts:2865-2889` `resolveExecutorPromptFile`: shell-metachar allowlist regex `^[a-zA-Z0-9_\-\/.]+$`, explicit `..` segment rejection, containment check under `<vajraDir>/prompts/`, existsSync check. On ANY throw the fire path SKIPS the spawn rather than falling back to the nudge base (a nudge agent handed an executor pointer does nothing useful).
- **Model tiering** — `gateway-core.ts:2963` nudges use `getFastModel()` (Haiku); `:2980-2988` `resolveExecutorReminderModel`: default `getSmartModel()` (Opus); per-reminder `model` override honored only via `resolveReminderModelOverride` (symbolic aliases `sonnet`/`smart`/`fast` or allowlisted concrete ids); unknown value → REJECTED, default used, rejection returned for logging. Nothing user-controlled reaches `claude -p --model '<id>'`.
- **Timeout** — `gateway-core.ts:2836` `REMINDER_EXECUTOR_TIMEOUT_SEC = 2700` (45 min) vs the nudge `REMINDER_AGENT_TIMEOUT_SEC` (1800s/30min per comment at :2025). Executor rituals are multi-step (dreaming walks entities/, kaizen scans the ecosystem).
- **Burst cap** — `gateway-core.ts:3000` `MAX_SPAWNS_PER_TICK = 2` guards catchup storms; excess left due for next tick, no work dropped.
- **Config-shape lint** — `gateway-core.ts:2906-2953` `auditReminderConfigShape` + `REMINDER_EXECUTOR_BODY_PATTERNS`: flags enabled non-executor reminders whose body reads like a ritual ("run X agent", "read prompts/", "execute every step", "scan and produce/update") but has no `prompt_file` — the PR-#139 failure class where rituals were authored as nudges and spammed give-up notices. Lint, not auto-fix.
- **Live inventory** — `~/vajra/gateway/reminders.json`: 83 rows total; exactly 5 with `prompt_file`, all enabled:
  | prompt_file | cron | model |
  |---|---|---|
  | prompts/morning-brief.md | 0 9 * * * | default (smart) |
  | prompts/evening-wrap.md | 0 19 * * * | default (smart) |
  | prompts/dreaming.md | 0 */6 * * * | sonnet |
  | prompts/kaizen.md | 0 17 * * 5 | default (smart) |
  | prompts/book-sunday-refresh.md | 0 21 * * 0 | default (smart) |

- **Fire path** — `index.ts:8965-9014` `fireReminder`: mode select (nudge defaults vs executor prompt/timeout/model), invalid `prompt_file` → log + SKIP spawn (never falls back to nudge base; next occurrence retries after operator fix, because the exemption already advanced `next_fire`). Spawn = `tmuxRun('new-window', …)` at `:9000`. Exit-0 delivery-confirm backstop (`scheduleReminderExitConfirm`) is armed ONLY for cron NUDGES (`:9012` — `r.cron && !isExecutorReminder(r)`); executors are confirm-exempt. Post-fire transient-API retry check also excludes executors (`:9031`).
- **Spawn command** — `gateway-core.ts:3192-3264` `buildReminderAgentCommand`: defense-in-depth charset guards on agent_cwd/promptFile/model/reminderId, integer guard on timeoutSec; single-quote-escapes the message; wraps `claude -p` in `perl -e 'alarm N; exec @ARGV'` (macOS has no coreutils `timeout`); writes `.exit` sentinel (`echo "$?"`) always; passes `REMINDER_ID` + `REMINDER_DELIVERED_PATH` env vars; logs to `logs/reminder-<id8>.log`. **The actual invocation: `claude -p --model '<m>' --append-system-prompt-file '<prompt>' --add-dir '<vajraDir>' --dangerously-skip-permissions '<msg>'`.**
- **⚠ Vajra's permission model for executors is: NONE.** `--dangerously-skip-permissions`, running as Ryan's user on Ryan's laptop, full filesystem + network + `gog` + `gh` + WebSearch. This is precisely the model the SPEC.md:369-372 locked decision forbids for Neutron. The Vajra artifact to port is the DISPATCH SHAPE, not the trust model.
- **Delivery semantics per ritual** — executors do NOT use `/post-reminder` (that is the nudge confirm handshake). They post directly via `scripts/tg-post.sh` at the end of the run, or post nothing at all: dreaming is SILENT by design ("You do NOT post to Telegram. Dreaming is silent." — `prompts/dreaming.md:5`); kaizen and book-sunday-refresh post via tg-post.sh explicitly (`prompts/kaizen.md:5`, `prompts/book-sunday-refresh.md:5`); morning-brief/evening-wrap inherit the reminder-agent-base posting rules with length overrides.

### B2. What the 5 Vajra ritual prompts actually DO (drives the tool-set requirement)

| Ritual | Reads | Writes | External calls | Posts |
|---|---|---|---|---|
| morning-brief (88 li) | STATUS.md, attention-needed.json, tasks/DASHBOARD, daily notes, agent-logs mtimes, entities deltas | none | `gog calendar events` ×3 accounts, `gh pr list` | brief ≤20 lines to Telegram |
| evening-wrap (135 li) | git log across ~/vajra + all ~/repos/*, PR activity, agent logs, entities deltas | none | `gh pr list --search updated:today` | rollup ≤15 lines |
| dreaming (201 li) | entities/ pages mtime<6h, session notes, corrections-log since last-run marker, schema.md | FIXES broken wiki backlinks, writes daily-note delta section, promotes correction patterns | none | NOTHING (silent) |
| kaizen (136 li) | corrections-log, cron+gateway logs, kaizen patterns, session transcripts, tasks.md, ISSUES.md | writes weekly kaizen report | WebSearch (CC ecosystem scan) | report via tg-post.sh |
| book-sunday-refresh (57 li) | Projects/book/interviews/ last 7d, key-themes.md, SESSION-LOG.md | (review post only; may update key-themes CANDIDATES) | none | post to Book topic via tg-post.sh |

Requirement signal: rituals need (a) broad READ across the owner's project/vault space, (b) scoped WRITES (entities upkeep, daily notes, reports), (c) a small set of external READ-ONLY integrations (calendar, PRs, web search), (d) a post-to-chat affordance, (e) one ritual that is deliberately silent. None need destructive ops (no deletes outside their write scope, no sends-as-owner, no infra mutation).

### B3. Neutron reminders subsystem as-is (verified by direct read, 2026-07-20)

- **Module layout** — `reminders/{store,tick,dispatcher,prompt,message-shape,context,index}.ts` (~1.5k lines + equal tests); agent-facing tools in `cores/free/reminders/src/` (backend, chat-commands, tools, smart-wrap, manifest).
- **Dispatcher** — `reminders/dispatcher.ts:181-285` `buildReminderDispatcher`: classify shape → resolve destination (`topic_id` → `[ROUTING]` header → General; `deriveReminderProjectId` at `:76-92` maps `app-project:<id>` / `web:<user>:<project>` / raw project id → destination project) → compose via `ReminderLlm` seam → post via `ReminderOutbound.post`. Rejected post THROWS so the tick reverts the claim and the row retries next tick (`:278-282`, #319 contract: dispatcher only throws BEFORE successful delivery).
- **The read-only wall** — `dispatcher.ts:121` `DEFAULT_TOOL_NAMES = ['Read', 'Glob', 'Grep']`; `:124` `DEFAULT_TIMEOUT_MS = 90_000`; `:127` `DEFAULT_MAX_TOKENS = 512`; model = `FAST_MODEL` (`:183`). Compose turn runs on the warm substrate with `metering_context.project_id` keyed to the DESTINATION project (`:230`).
- **The recorded drop** — `reminders/prompt.ts:11-14`: "It is a NUDGE composer, not an executor — it never takes external actions (the substrate is wired read-only by the dispatcher)". Voice rules even instruct the composer to TRANSLATE imperative intents into nudges (`prompt.ts:34-36`) — the executor gap is enforced in three layers: tool list, max_tokens, and prompt.
- **Composer wiring** — `open/composer.ts:1716-1740`: dispatcher wired with `liveAgentSubstrate` (the same CC-spawn REPL live chat uses — never a direct API call), context = project STATUS.md, post through the single `deliver(topic, envelope)` seam (`gateway/http/deliver.ts`) → durable history row + live app-ws push.
- **Substrate spawn shape** — `buildSubstrateReminderLlm` (`dispatcher.ts:134-151`): `substrate.start(spec)` + collect-tokens with abort-on-timeout. AgentSpec carries `tools` (allow-list consumed as `--tools` names), `model_preference`, `max_tokens`, `metering_context`.
- **Tick loop** — `reminders/tick.ts:78-245` `ReminderTickLoop`: 30s interval, single-flight (overlap → skip), per-tick limit 50, IANA `time_zone` for cron resolution (`:96`, `:266-282` `computeNextFire` — DST-correct via `@neutronai/cron`; corrupt cron → `null` → fire-once-then-retire, poison rows can't wedge the loop). **#319 claim-before-dispatch**: recurring rows `advanceRecurrence` FIRST, then dispatch; a caught dispatch throw runs `claimRevert` (compare-and-swap so a concurrent owner reschedule isn't clobbered); a true crash takes the at-most-once path. Post-fire `on_fired` hook (Expo push) is failure-isolated.
- **Store schema** — `reminders/store.ts:33-63` `Reminder`: `id, owner_slug, topic_id, fire_at, message, status(pending|fired|cancelled), recurrence(weekly|monthly|occasional|null), recurrence_spec(cron|null), source, created_at, fired_at, cancelled_at`. **NO `prompt_file` column, NO `model` column, NO enabled/disabled flag** (parity audit: pause = destroy-and-recreate). SQL column `project_slug` frozen, TS-side `owner_slug`. Any executor mode needs a schema migration.
