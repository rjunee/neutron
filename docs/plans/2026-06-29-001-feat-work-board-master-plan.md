---
title: "Work Board — master plan (live work-tracking tab + orchestrator reliability + trident parallel-execution)"
type: feat
status: awaiting-review
date: 2026-06-29
repo: neutron-open (engine/feature)
decision_home: neutron-managed SPEC.md § Decisions Log 2026-06-29 "NEW FEATURE — Work Board"
research_basis: Projects/neutron/research/agentic-dev-orchestration-sota-2026-06-29.md
---

# Work Board — master plan

One feature that solves **two** problems at once:

- **Engineering reliability (no context pollution).** The orchestrator (the chat session) gets confused juggling several features because their state lives in the *conversation* and the window rots. The Work Board moves that state ON DISK and makes the conversation a thin, disposable query layer. (Ryan, 2026-06-29: "even with trident's build-internals isolated, the topic session gets all confused as fuck about what we are doing.")
- **UX.** A first-class per-project tab showing, at a glance, what's in progress / next, and which agents are working right now.

This plan is the single source for the build. It also resolves the trident **parallel-execution model** (the keystone, verified by live test below) and the **#123 disposition**.

> **Acceptance bar for the whole feature (Ryan-locked):** "done" = WIRED + SERVED + verified in a real `neutronagent.ai` install. Each phase ships independently and is verified in a real install, not just by passing tests.
> **NO FEATURE FLAGS / no dual code paths.** Build ON as the default. **ALL functionality in Neutron Open** (Managed is a thin hosting wrapper). Tenant-vocab-SILENT.

---

## 0. Verified facts this plan rests on (do not re-derive)

Live tests on real interactive `claude` + the real `Workflow` tool (2026-06-29):

- **A fired Workflow runs in the background; the launching session STAYS RESPONSIVE.** (Injected a chat turn mid-run, answered instantly.)
- **The workflow's internals stay OUT of the launching session's context** — only the compact result returns. (Context-isolation already works; it was never the problem.)
- **KEYSTONE: one session fired 3 Workflows that ran TRULY IN PARALLEL** — all START 16:49:12, all DONE 16:50:12 (the 60s sleep; not serialized), all returned `ok`, session responsive throughout. ⇒ **one topic/orchestrator REPL can orchestrate N parallel tridents. Sibling/per-run REPLs are NOT required for parallelism.**
- Neutron's persistent-REPL substrate **settles a turn on the first `reply()`** (`runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts:1295/1326`) AND has an **out-of-band inject path** that can deliver a NEW turn to a warm session (`injectMessage` `persistent-repl-substrate.ts:2326`; system-notice inject `dev-channel.ts:277`). ⇒ async-harvest is feasible without holding a turn open.

---

## 1. Scoping diff — what exists vs what's needed (file:line)

| Dimension | CURRENT code | GAP / plan |
| --- | --- | --- |
| **Tabs** | Engine-resolved over HTTP. `BUILTIN_TABS` frozen array `tabs/registry.ts:88-121` (Chat order 0, Documents 10, Tasks 20; spaced by 10). `GET /api/app/projects/<id>/tabs` `gateway/http/app-tabs-surface.ts:72`. Web renders via `TabContent` switch on `mount.target` `landing/chat-react/.../ProjectShell.tsx:100-165`; mobile maps `mount.target`→route file `app/lib/project-tabs.ts:92-103`. | Add ONE `BUILTIN_TABS` entry (key `work_board`, label "Work Board", target `workboard`, order **5** — right after Chat). Web: a `target==='workboard'` branch in `TabContent` + `WorkBoardTab.tsx`. Mobile: route file `app/app/projects/[id]/workboard.tsx`. No client tab-list edits (both fetch the registry). |
| **project.db** | Migrations `migrations/NNNN_*.sql`, forward-only, STRICT tables; latest `0089` → next **`0090`**. Single instance DB tagged by `project_slug` (`gateway/index.ts:180-181`); typed `ProjectDb` wrapper `persistence/db.ts:52`; store pattern = `TridentRunStore(input.db)` `gateway/composition/build-core-modules.ts:296`. | New `0090_work_board_items.sql` + a `WorkBoardStore` taking `ProjectDb` (mirror `trident/store.ts`). |
| **Orchestrator tool surface** | Chat REPL built-in tools `DEFAULT_TOOL_NAMES=['Read','Glob','Grep','Write','Edit','Bash','Skill']` `build-live-agent-turn.ts:103`. Agent tools (Cores/gbrain/reminders) reach the agent via `ToolRegistry.register` (non-`agent_hidden`) → manifest snapshot → `mcp__neutron__*` bridge on the warm REPL (`enableToolBridge`) — `mcp/surfaces/core-tools.ts`, `gbrain-memory/agent-tool.ts:115`, `runtime/adapters/claude-code/persistent/tools-bridge.ts`. | Register `work_board_*` tools on `ToolRegistry` (non-`agent_hidden`), sibling to `wire-cores-surfaces.ts`. They surface as `mcp__neutron__work_board_*`. NO change to `DEFAULT_TOOL_NAMES` needed for the board tools (they ride the MCP bridge). |
| **Per-turn context injection** | **NOT a CC SessionStart hook** — that hook is explicitly DROPPED in Open (`build-settings.ts:7-9`; only the `Stop`→`enforce-reply` hook is wired). The documented `<checkpoint>` block (`prompts/topic-agent-base.md:67-77`) is INERT in the Open live-agent path. Real per-turn injection is composer-side: `build-live-agent-turn.ts` system assembly `:728-777` + the `reflection.loadContext()` seam `:759-772`. | Add a Work Board fragment beside the `reflection` seam so EVERY turn re-grounds on the board. (This is the drift-guard + the orchestrator's external-memory rehydration point.) |
| **Agent dispatch + activity** | In-memory `runtime/subagent/registry.ts` (`SubagentRecord`, `AgentKind=forge\|atlas\|sentinel\|argus\|core`); `agent-dispatch/service.ts`. Today's "working" affordance = the **typing indicator** (`agent_typing` frame `channels/adapters/app-ws/envelope.ts:326`). Trident persists `subagent_run_id`/`subagent_status` on the run row. | Bind each dispatch to a Work Board item id; surface per-item activity by combining the trident row `subagent_status`/`phase` (durable) + a NEW pushed app-ws frame (see §6). |
| **Trident** | `code_trident_runs` (`migrations/0077`, +`0081`/`0089`); `TridentRunStore` `trident/store.ts`; outer loop `TridentTickLoop` (90s) `trident/tick.ts`; `trident/state-machine.ts`; `trident/orchestrator.ts`; inner loop `trident/inner-loop.ts` (on main: spawns `claude -p` directly `:48` — billing-disqualified). `/code` creates a run `trident/code-command.ts:188`. | Replace the inner-loop launcher with the verified **topic-REPL fires Workflow + async-harvest** model (§7). Bind each run to a Work Board item. |
| **App-ws push** | `gateway/http/app-ws-surface.ts:183`; fan-out via `InMemoryAppWsSessionRegistry.send(topic, env)` `session-registry.ts:121`; out-of-band push exemplar = `projects_changed` pushed from `open/composer.ts:1763`, applied web-side `controller.ts:382`. | Add a `work_board_changed` (and activity-state) `AppWsOutbound` variant in `envelope.ts`, pushed via the same registry `send` — mirrors `projects_changed`. |
| **CC TodoWrite** | **ZERO handling** anywhere (greenfield). `TodoWrite` not in `DEFAULT_TOOL_NAMES`, not intercepted. | TodoWrite ingestion is greenfield → deferred to a later phase (§4); the orchestrator's own `work_board_*` tool is the primary mechanism. |

---

## 2. Data model + migration

`migrations/0090_work_board_items.sql` (STRICT, forward-only):

```sql
CREATE TABLE work_board_items (
  id            TEXT PRIMARY KEY,           -- ulid
  project_slug  TEXT NOT NULL,
  title         TEXT NOT NULL,              -- ONE line
  status        TEXT NOT NULL,              -- 'upcoming' | 'in_progress' | 'done'
  sort_order    REAL NOT NULL,              -- fractional ordering for cheap reorders
  design_doc_ref TEXT,                      -- optional path/URL to a full design doc
  activity      TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'subagent' | 'inline'
  linked_run_id TEXT,                       -- code_trident_runs.id / subagent run_id when active
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER                     -- set when status->done (datestamp)
) STRICT;
CREATE INDEX idx_work_board_project_status ON work_board_items(project_slug, status);
CREATE INDEX idx_work_board_active ON work_board_items(project_slug, activity) WHERE activity != 'idle';
```

`WorkBoardStore` (`work-board/store.ts`, mirror `trident/store.ts`): typed `ProjectDb` wrapper — `create`, `list(project_slug)` (active+next ordered by `sort_order`, then completed by `completed_at` desc), `update`, `complete`, `reorder`, `setActivity(id, activity, run_id)`, `bindRun`. Async writes, sync reads.

---

## 3. The orchestrator Work Board tool(s)

Register on `ToolRegistry` (non-`agent_hidden`), wired during composition sibling to `wire-cores-surfaces.ts`; surfaces as `mcp__neutron__work_board_*` on the warm REPL via the existing bridge:

- `work_board_list()` → current board (the agent reads it every turn; also injected automatically per §5).
- `work_board_add({title, status?, design_doc_ref?})` → returns item id.
- `work_board_update({id, title?, status?, design_doc_ref?})`.
- `work_board_complete({id})` → status=done, stamps `completed_at`.
- `work_board_reorder({id, before?|after?})`.

Handlers dispatch in-process against `WorkBoardStore`; every mutation also pushes a `work_board_changed` app-ws frame (§6) so the tab updates live.

---

## 4. CC TodoWrite ingestion (later phase — greenfield)

No existing handling. When built: grant `TodoWrite` to the orchestrator surface and observe its payloads via a `PostToolUse`-style hook (the substrate currently wires only a `Stop` hook — `build-settings.ts:43`), mapping native multi-step todos into board items (Neutron store stays the durable truth; TodoWrite is a one-way input). Sequenced LAST (§11 Phase 5) because it's net-new and not on the reliability critical path.

---

## 5. Drift-guard (advisory) + per-turn re-grounding

Hook the composer's `reflection` seam (`build-live-agent-turn.ts:759-772`), NOT a CC SessionStart hook (inert in Open):

- **Every turn**, inject the current board (compact: one line per active/next item + activity state) into the system context. The orchestrator always re-grounds on truth instead of reconstructing from a rotting transcript.
- **Advisory flag:** if the orchestrator is about to dispatch/act on something with no matching board item, surface a reminder ("no Work Board item for this — add one first"). Design the seam so it can later escalate to a hard refusal (do NOT build the block now).

---

## 6. Activity-icon tracking + live delivery

- Add `AppWsOutbound` variants in `channels/adapters/app-ws/envelope.ts`: `work_board_changed` (full/delta board) and reuse it to carry per-item `activity` state.
- Push via `InMemoryAppWsSessionRegistry.send(topic, env)` (`session-registry.ts:121`) on every board mutation and on every agent activity transition — exactly the `projects_changed` model (`open/composer.ts:1763`).
- Activity source of truth: when a run binds to an item, set `activity='subagent'` (+ `linked_run_id`); the trident row `subagent_status`/`phase` drives the fine-grained "what each forge is doing"; inline work in the topic sets `activity='inline'`. Clear to `idle` on completion.
- Web `WorkBoardTab.tsx` + mobile `workboard.tsx` render: active+next at top (colored status dot + activity icon: sub-agent icon vs distinct "inline" icon), completed collapsed at bottom with datestamp, item title links to `design_doc_ref` (Docs deep-link).

---

## 7. Trident parallel-execution model (the keystone — verified)

**Topic/orchestrator REPL fires N Workflows + async-harvest. No sibling REPLs for parallelism.**

1. Expose the `Workflow` tool to the orchestrator (via the MCP bridge surface; least-privilege is weak — the REPL already has `Bash`).
2. To start a trident: orchestrator creates/uses a Work Board item, fires `Workflow` (bound to that item), **replies immediately** ("started build X") → turn settles, orchestrator stays responsive.
3. The Workflow runs in the background; its Forge agent gets its own worktree (`isolation:'worktree'`).
4. On completion, deliver the result back via an **injected harvest turn** (`injectMessage` `persistent-repl-substrate.ts:2326` / system-notice inject `dev-channel.ts:277`) → harvest `TRIDENT_RESULT`, update the run row (`code_trident_runs`) + the Work Board item, run outer-loop bookkeeping.
5. **N parallel tridents** = N background Workflows fired from the one orchestrator REPL, each bound to a board item (verified parallel + responsive, §0).
6. **Sibling REPLs = optional tunable** for crash/resource isolation on very heavy/long runs (all-under-one-process means one crash kills all in-flight) — largely covered by the durable outer loop + per-phase checkpoints (`inner_checkpoint`, migration 0089); make "where the workflow executes" an implementation detail behind one dispatch abstraction.
7. **#123 disposition: do NOT merge its sibling+held-open approach.** It was a workaround for settle-on-first-reply; the inject path makes clean fire-and-async-harvest the right model. The corrected model is built here.

**Two build-time verifications gate this (run them FIRST — §11 Phase 0):**
- (V1) end-to-end: a real `/code` run where the orchestrator fires the Workflow, settles, and harvests `TRIDENT_RESULT` via an injected turn in Neutron's substrate.
- (V2) resource behavior at higher N (when, if ever, to spill to a sibling).

---

## 8. Orchestrator context-management (the reliability mechanism)

The Work Board is the orchestrator's EXTERNAL memory; the conversation becomes disposable.

- **Layer A — per-turn re-grounding** (§5): the board is injected every turn (cheap, minimal text).
- **Layer B — aggressive reset/rehydrate:** when the orchestrator window exceeds a good-zone band (research doc: degradation past ~40-60% utilization), compact/reset, then rehydrate from disk — board + STATUS + the active item's design doc. Because all durable state is external, the reset is LOSSLESS.
- Mechanism options to evaluate at build time (V-tested): native context-editing (`clear_tool_uses_*`), the memory tool (`memory_*`), `/compact`, and a token/turn-count trigger. The substrate already has the inject path to re-seed a fresh window. Recommend the concrete trigger in Phase 3.

---

## 9. Web + mobile tab UI

- Web: `WorkBoardTab.tsx` + `TabContent` branch (`ProjectShell.tsx:132-164`). Mobile: `app/app/projects/[id]/workboard.tsx`. Both consume a `GET /api/app/projects/<id>/work-board` + live `work_board_changed` frames.
- UX (minimal, Ryan-locked): single list — active+next at top, each ONE line with a colored status dot + activity icon (sub-agent vs distinct inline) + optional design-doc link; completed items collapsed at the bottom with a completion datestamp. No section cruft. Follow project design conventions; no AI-slop.

---

## 10. (folded into §1 table + §6/§9)

---

## 11. Phased build plan (each phase ships + is verified in a real install)

- **Phase 0 — Trident exec-model verification (gates §7).** Run V1 (fire→settle→injected-harvest end-to-end in Neutron's substrate) + V2 (N-concurrent resource check). EARS: *WHEN the orchestrator fires a `/code` Workflow and replies, THE SYSTEM SHALL harvest `TRIDENT_RESULT` via an injected turn and mark the run terminal, with the session responsive throughout.* Decide #123 (expected: supersede). No board UI yet.
- **Phase 1 — Store + tool + tab shell.** `0090` migration + `WorkBoardStore` + `work_board_*` tools + the `BUILTIN_TABS` entry + a read-only `WorkBoardTab` (web+mobile) listing items. EARS: *WHEN the owner opens a project, THE SYSTEM SHALL show a Work Board tab listing items from the store.*
- **Phase 2 — Live mutations + per-turn injection.** Agent mutates the board via tools; `work_board_changed` frames update the tab live; the board is injected into every orchestrator turn. EARS: *WHEN the agent adds/updates/completes an item, THE SYSTEM SHALL reflect it on the tab within one push and in the next turn's context.*
- **Phase 3 — Hard-rule dispatch binding + activity icons + context-mgmt.** Every Forge/Argus/Atlas/inline dispatch binds to an item (enforced); per-item activity icons (sub-agent / inline) push live; aggressive reset/rehydrate wired. EARS: *WHEN an agent run is dispatched, THE SYSTEM SHALL require a bound board item and show its live activity icon until completion.*
- **Phase 4 — Parallel trident through the board.** Orchestrator fires N tridents bound to N items, each its own worktree, harvested independently; the board shows all live. EARS: *WHEN the owner starts 3 features, THE SYSTEM SHALL run 3 tridents concurrently, each tracked on its own board item, without orchestrator confusion.*
- **Phase 5 — CC TodoWrite ingestion (optional/last).** Native multi-step todos sync into the board.

Repo routing: **all Neutron Open.** Each phase = its own PR(s), verified in a real install before the next.

---

## 12. Risks + open questions

- **V1 (injected-harvest) is the critical unknown.** If wiring workflow-completion → injected harvest turn proves unreliable in Neutron's substrate, fall back to the held-open launcher (#123's mechanism) on the topic REPL — still no sibling key. Phase 0 de-risks this before any board work.
- **Resource ceiling at high N** (V2) — when one process hosting many workflows strains; the sibling tunable is the escape hatch.
- **Hard-rule enforcement ergonomics** — forcing "write an item first" must not be annoying for trivial inline work; advisory-first softens this.
- **TodoWrite mapping** is greenfield; keep it last so it can't block the reliability win.
- Open question for Ryan: should completed items ever auto-archive/age out, or stay forever for full history? (Plan assumes: stay, collapsed.)

---

## 13. SYSTEM-OVERVIEW.md changes (at build time)

- § Code map — add `work-board/` (store + tools) and the `workboard` tab (web+mobile).
- § new subsection "Work Board" — the per-project live work tracker + its role as the orchestrator's external memory.
- § Trident — update the inner-loop execution model to topic-REPL-fires-Workflow + async-harvest; note #123 superseded.
- § Orchestrator context-management — new subsection (per-turn board injection + aggressive reset/rehydrate).
- § Known gaps — TodoWrite ingestion pending (Phase 5).
