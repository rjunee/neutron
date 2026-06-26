---
title: "Neutron Connect — group-chat agent engagement mode (per-project setting)"
status: spec (build-ready) — awaiting Ryan's sign-off on the DEFAULT mode
created: 2026-06-26
author: Neutron Coding orchestrator (written inline after the Atlas spec spawn wedged twice on the Vajra-fleet channel-MCP transient)
decision_source: Ryan 2026-06-26 ("a setting in each group project: 1) tag-gated @mention neutron, or 2) ALL messages auto-sent to neutron")
grounds:
  - ~/repos/neutron-managed/docs/connect-spec.md §1.5 (member routing within the host's ONE shared session), §4 (multi-author attribution), §1.4 (read/write capability), §1.8 (host→collaborator scoped mirror)
  - ~/repos/neutron-open/agent-dispatch/ (gap #3 — named-specialist + ad-hoc dispatch on runtime/subagent/, shipped 2026-06-26 #71)
  - inspiration: Anthropic "Claude Tag" (Slack member, passive until @-tagged, delegates async with scoped tools)
verify-note: connect-spec sections cited are VERIFIED-read. The exact Open routing-code seams (file:line) are named CONCEPTUALLY here; Forge MUST grep + cite the live seam at build (verify-before-assert) before editing — do not take the file names below as confirmed line refs.
---

# Connect group-chat agent engagement mode

## Problem
Neutron Connect is already a "many-humans-one-Claude" group chat: multiple human collaborators converse with a single shared agent session, every message `author`-tagged (connect-spec §1.5 routing, §4 attribution). Today all member posts route to that one shared session — i.e. the agent is effectively engaged on every message. Ryan wants each group/shared project to choose between that and a Claude-Tag-style "stay quiet until tagged" mode.

## The setting (Ryan-locked)
A per-shared-project enum **`agent_engagement_mode`** with exactly two values:
- **`tag_gated`** — the agent engages ONLY when a member @-mentions it (`@neutron`). Members converse freely; the agent is silent otherwise.
- **`all_messages`** — every member's message auto-routes to the agent (the current shared-session behavior).

One setting per shared project. Settable by the project owner (admin/project-settings surface) and agent-natively (an MCP tool / chat command so the agent can read+set it on request — parity rule).

### Proposed DEFAULT (awaiting Ryan)
**`tag_gated`** is the recommended default. Rationale: a multi-human group chat where the agent replies to every human-to-human message is noisy and surprising; "quiet until tagged" matches the Claude Tag mental model and is the safer default. `all_messages` is opt-in for projects that genuinely want the agent reacting to everything (e.g. a solo project, or a "scribe-everything" workflow). **OPEN QUESTION for Ryan: confirm `tag_gated` as default, or prefer `all_messages` to preserve today's behavior for existing projects?** (Migration note: existing projects are on `all_messages`-equivalent today; defaulting new projects to `tag_gated` changes nothing for them but should be an explicit backfill decision.)

## Mechanics

### 1. Storage
Add `agent_engagement_mode TEXT NOT NULL DEFAULT '<chosen-default>'` to the shared-project / project row (the same row the Connect shared-project reference lives on — connect-spec §1.7). Forward-only migration. TS type `'tag_gated' | 'all_messages'`. Read at message-ingress.

### 2. Routing seam (the core change)
At the ingress where a member post enters the host's ONE shared session (connect-spec §1.5 — Forge: grep the actual seam, likely the chat-bridge / connect-relay ingress that stamps `author` and forwards to the session):
- **`all_messages`** → unchanged: forward every member post to the agent session.
- **`tag_gated`** → forward to the agent ONLY if the post contains an `@neutron` mention; otherwise persist the message to the shared transcript (so humans still see each other's messages + the agent has context next time it IS tagged) but do NOT trigger an agent turn.

The shared transcript MUST still receive every message in both modes (the agent needs the conversation as context when later tagged; humans need to see each other). Only the *agent-turn trigger* is gated.

### 3. @mention detection
Detect `@neutron` (the agent's handle/alias) in the post text. Reuse any existing mention parsing if present (Forge: grep — there is KG `mentions` parsing in runtime/auto-link.ts but that is a different concern; the chat-mention detector is likely new). Rules: case-insensitive; match the configured agent handle/alias; ignore mentions inside inline-code/quotes (doc-quote guard, same principle as the PTY detectors); multiple mentions = one trigger.

### 4. Tag-to-delegate (ride gap #3)
When `tag_gated` and the tagged message is a task ("@neutron do X"), route it through the **agent-dispatch family** (`agent-dispatch/` — gap #3, shipped #71: named-specialist + ad-hoc dispatch on `runtime/subagent/`) so the agent can work async and **report its result back into the shared thread** (attributed as the agent, author-stamped per §4). A quick conversational tag ("@neutron what's X?") can answer inline on the shared session; a delegated task spawns a dispatched subagent. Forge decides the inline-vs-dispatch boundary (heuristic or explicit `/delegate`), spec it.

### 5. Scoped access
The agent's tools/Cores when acting in a group chat are scoped to that shared project. Connect already scopes the host→collaborator memory mirror (§1.8, `source=<project>@<host>`); extend the same scoping principle to which Cores/tools the agent may use in that project's chat. (First cut may scope to the host's installed Cores; tighten later.)

## Edge cases (spec, don't hand-wave)
- **Attribution (§4):** when tagged, the agent's response/dispatch is attributed to the tagging member as the requester; the agent's own posts carry the agent author envelope.
- **Read vs write members (§1.4):** a read-only member's @neutron mention — does it trigger? Proposed: no (read-only can't drive agent turns); confirm.
- **Host vs collaborator instances:** collaborators are their own instances seeing a scoped mirror (§1.8). The engagement-mode gating happens at the host's shared-session ingress (the canonical session). Ensure collaborators' view is consistent (they see the same gated/ungated behavior).
- **Mode switch mid-conversation:** takes effect on the next message; no replay of past ungated messages.
- **No-mention in tag_gated with no agent reply:** ensure the UI doesn't show a spurious typing indicator (the agent isn't engaging).

## Implementation sequence (Forge-ready; NO FEATURE FLAGS — the setting IS the behavior)
1. Schema + TS type + migration for `agent_engagement_mode` (default = Ryan's choice).
2. Project-settings surface to set it (admin UI + agent-native MCP tool/command).
3. Ingress tag-gate filter at the shared-session routing seam (§1.5) — `all_messages` passthrough vs `tag_gated` mention-gate; transcript always persists.
4. `@neutron` mention detector (handle/alias, doc-quote guard).
5. Tag-to-delegate wiring → `agent-dispatch/` (gap #3), report-back into the thread.
6. Tool/Core scoping to the shared project.
7. Tests that exercise the WIRING (not units): in `tag_gated`, a non-mention post persists but triggers NO agent turn; an `@neutron` post DOES; in `all_messages`, every post triggers; a delegated task spawns a dispatched subagent that reports back; attribution correct.

## Repos
- Engine routing + mention-gate + dispatch wiring + the setting on the shared-project model → **Open** (`rjunee/neutron`).
- Any Managed-side project-settings admin surface → **Managed** (after the Open piece lands + vendor-bump).
