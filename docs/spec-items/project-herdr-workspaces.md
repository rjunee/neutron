---
title: Project-owned Herdr workspaces and sleep lifecycle
group: platform
status: open
priority: P0
cutover: true
needs_spec: false
---

# Project-owned Herdr workspaces

Owner-directed on 2026-09-23; see SPEC.md's decision of that date. The locked
pivot, `docs/plans/harness-orchestrator-pivot-2026-09-11.md:85-102`, retains one
project conversation and native same-provider subagents. Terminal organisation
does not create another conversation or another worker.

Each active project has its own Herdr workspace. General and any genuinely
shared helper that must remain warm belong to the separate `Neutron General`
workspace. General has a distinct scope, including from a project named general.
The first tab is `Chat`; separate agent processes have meaningful role/task tab
names. Native harness children remain native children; a task view must not
launch a duplicate worker merely to provide a tab.

Workspace identity comes from explicit instance/project scope and a durable
creation record, corroborated against the live server. Names, cwd, inherited
workspace environment, and an unverified saved handle are not identity. Creation
is reserved before the RPC; an interrupted or ambiguous creation is not retried
as a fresh workspace. A missing or mismatched ownership marker refuses use.
The marker is a correlation value, not a credential against an actor controlling
the same Herdr server.

Background work can wake a workspace without starting a model conversation.
An inert, owned `Chat` placeholder reserves the first tab; opening chat replaces
it only after verifying its exact recorded process identity. It does not start
a model or request tools. An activity lease must retain it only while actual work
keeps the project awake. Creation must preserve focus. Existing chat panes are adopted through the
existing REPL identity checks, never overwritten by a new chat spawn.

A project is awake while a conversation, queued dispatch, build, pending
approval, or unresolved live child requires it. After work and foreground
activity end, retirement preserves transcripts, closes verified owned panes,
clears their ownership claims under lock, and closes the empty workspace. A new
message or due project work wakes it. Unknown liveness does not license closure.
Gateway restart preserves active work and is not a sleep event.

## Acceptance

- [ ] Explicit project placement creates separate workspaces for two projects
      and General, even when their display names and cwd match; it never falls
      back to an inherited workspace on missing manager or invalid identity.
      Verify: `project-workspaces.test.ts`, `herdr-project-placement.test.ts`.
- [ ] Concurrent creation cannot produce two workspaces for one scope. A crash
      reservation, inaccessible server, mismatched marker, or ambiguous result
      refuses new creation; a positively absent old workspace can be recreated.
      Verify: `project-workspaces.test.ts` with both accepting and refusing cases.
- [ ] Chat is tab zero, named `Chat`; worker tabs describe their role/task. A
      second spawn cannot replace a live Chat tab, while a proven-closed chat
      can be replaced. Worker-first wake reserves Chat without starting a model;
      replacing a foreign placeholder is refused. Tab labels are asserted on actual RPC requests.
      Verify: `project-workspaces.test.ts`, `herdr-project-placement.test.ts`.
- [ ] Production Claude/Codex conversation and worker composition resolves the
      actual per-dispatch scope, including General, and routes through this
      manager. Verify consuming Open composition and
      `open/__tests__/project-build-e2e.test.ts`.
- [ ] Sleep refuses busy, queued, uncertain, foreign, and unverified sessions;
      an idle owned workspace closes without deleting conversation history and
      resumes on wake. Restart adopts surviving work without duplication.
      Verify lifecycle integration tests and a fresh deployed live cycle.

The first change supplies workspace ownership and terminal placement only.
Production composition and safe sleep/retirement are subsequent slices; this
item remains open until those consuming paths and live behaviour are verified.
