# AGENTS.md — Code-Gen Core build trail

Per docs/plans/code-gen-core-tier1-brief.md.

## Current file layout (reconciled 2026-07-17)

The dated **S0/S1/S2** sections below are point-in-time build-trail provenance; several file names
they cite (`src/mcp-tools-extra.ts`, `src/chat-commands.ts`, `src/runtime-runner.ts`,
`src/judgment.ts`, `src/prompts/*-system.ts`) predate a later reorganization and **no longer
resolve**. The current `src/` homes:

- `src/backend.ts` — the `CodegenRunner` interface + orchestrator with two reference runners:
  `buildInMemoryCodegenRunner` (the deterministic test fake) and `buildSkeletonCodegenRunner` (which
  throws `CodegenNotConfiguredError`). The production substrate-backed runner is **deferred** (Tier-2
  follow-up per the sprint brief's "Out of scope"); production wiring is currently retired — boot
  installs the skeleton at `gateway/boot-cores-factories.ts` (so an uninjected `codegen_dispatch`
  legacy MCP-tool call fails loud + actionable). NOTE: the daily-driver `/code <task>` command does
  NOT go through this Core — it bypasses Code-Gen Core and runs through foundational Trident (the
  Code-Gen Core gateway wrapper was retired in #47). The orchestrator is shape-compatible with the
  real runner once it lands.
- `src/host-runners.ts` — host-process runner INTERFACES (`gh` / `git` / `bun test`) + the test stub
  `buildStubHostRunners`. No production `child_process.spawn` adapter exists in-tree today.
- `src/substrate-runtime.ts` — the opaque LLM-call closure + sub-agent dispatcher adapter
  (mirrors the Research Core's `substrate-runtime.ts`).
- `src/tools.ts` — capability-guarded MCP tool wiring (`codegen_dispatch` / `codegen_status` /
  `codegen_fetch` / `codegen_cancel`).
- `src/tool-handlers.ts` — worktree-scoped tool-call dispatch handlers (read/write/edit/bash/grep/glob).
- `src/manifest.ts` — the Core manifest (+ in-tree Forge/Argus/judge prompt text).
- `src/sidecar/store.ts` — per-project SQLite sidecar CRUD.
- `src/worktree-resolver.ts` — per-project git worktree resolver.
- `src/ui/{launcher-icon,app-tab-surface}.ts` — launcher tile + app-tab metadata.

## S0 (initial scaffold, 2026-05-18)

Manifest + 3 MCP tools (codegen_dispatch / codegen_status /
codegen_fetch) + in-memory orchestrator + skeleton runner +
typed-error hierarchy + capability-guard wrapping + install-lifecycle
+ manifest + tools unit tests. The production substrate-backed
runner was deliberately STUBBED via `CodegenNotConfiguredError` —
uninjected installs failed loud + actionable.

## S1 (this sprint, 2026-05-21) — production buildout

- Promoted to v0.2.0.
- 5 new MCP tools (codegen_review / codegen_merge / codegen_judge /
  codegen_history / codegen_cancel) in `src/mcp-tools-extra.ts`.
- 8 chat commands in `src/chat-commands.ts`.
- Per-project SQLite sidecar at `<OWNER_HOME>/Projects/<id>/code-gen/
  code-gen.db` (resolver + CRUD in `src/sidecar/store.ts`; migration
  at `migrations/0001_code_tasks_settings_transcripts_audit.sql`).
- Per-project git worktree at `<OWNER_HOME>/Projects/<id>/code/`
  (resolver in `src/worktree-resolver.ts`).
- Production `RuntimeCodegenRunner` in `src/runtime-runner.ts` —
  composes Forge → Argus → (gated) merge via the substrate-agnostic
  `runtime/subagent/spawn.ts` (Code-Gen is the FIRST production
  caller).
- IN-TREE Forge + Argus + judge system prompts at
  `src/prompts/forge-system.ts` / `argus-system.ts` / `judge-system.ts`
  — ZERO imports from the host app.
- Auto-merge confirmation gate enforced IN CODE at THREE call sites
  (MCP tool, chat-command dispatcher, RuntimeCodegenRunner step) +
  the mandatory unit test at `__tests__/auto-merge-gate.test.ts`.
- LLM-driven judgment surface (`composeDeployJudgment` +
  `composePrBreaksAnalysis`) in `src/judgment.ts` — pluggable LLM
  dep, deterministic fallback on `llm_error`.
- P5.3 launcher tile binding (label + emoji + `primary_action='open_app_tab'`
  + `app_tab_path` + 3-entry long-press menu) in `src/ui/launcher-icon.ts`;
  `app_tab` UI component metadata in `src/ui/app-tab-surface.ts`.
- 3 new SDK capabilities (`host:gh`, `network:github`,
  `agent:dispatch_subagent`) declared in `package.json`'s
  `"neutron"` block. Capabilities validate against the OPEN
  `<verb>:<resource>` shape (X3 — one manifest contract); a
  platform-known capability is additionally listed in the single
  source `cores/sdk/manifest.ts:KNOWN_CAPABILITIES` (+ covered in
  `cores/sdk/__tests__/manifest.test.ts` /
  `cores/runtime/__tests__/manifest-conformance.test.ts`). The old
  four-place edit across `core-sdk/{types,validator}.ts` +
  `manifest.schema.json` is gone — those were folded into the single
  Zod schema and deleted.
- Production-composer reachability guard at
  `gateway/__tests__/code-gen-core-production-composer.test.ts`.

## Trident-pattern audit

The Code-Gen Core is the consumer-facing wrapping of the owner's
daily-driver `/trident` skill. Mapping (see brief § 2.1):

| Host-app side | Code-Gen Core equivalent |
|---|---|
| `/trident <task>` skill on the owner's CC | `/code <task>` chat command |
| The host app's detached `claude -p` spawn script | in-process Sonnet 4.6 sub-agent via `runtime/subagent/spawn.ts` |
| `prompts/forge.md` (84+ LOC) | `src/prompts/forge-system.ts` (narrower IN-TREE) |
| `prompts/argus.md` | `src/prompts/argus-system.ts` (narrower IN-TREE) |
| The host app's `trident-<slug>.state.json` + CC-skill re-entry | per-project sidecar `code_tasks` row + in-process `await` |
| The host app's completion-delivery webhook + Telegram inline keyboard | gateway-side plain-text PR link |
| Trident `max_rounds=8` cap | `RuntimeCodegenRunner` `max_argus_rounds: 8` (settable per project) |

## S2 (future sprint) — known follow-ups

- Inter-Core tunnels (code-gen tasks → notes drawers / research briefs).
- PR-comment-reading sub-agent (Tier 2 Coding-Pro feature).
- Auto-rebase on conflict (S1 surfaces conflicts; user resolves).
- CI-failure auto-fix loop (`/trident check` re-fire pattern stays
  host-app-side; S1 surfaces CI failures + asks the user).
- Browser-based diff viewer app-tab landing in P5.x.
- Full sub-agent transcript persistence (S1 caps at 4 KB
  `response_excerpt`; full transcripts are deferred).
