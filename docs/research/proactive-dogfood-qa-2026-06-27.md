# Proactive dogfood QA — Neutron Open (2026-06-27)

> Forge adversarial QA of the live Open product. Goal: find the gaps before
> Ryan does. **Verify-before-assert**: nothing is marked WORKS without
> real-browser / real-turn evidence (transcript, screenshot, server.log).
> No feature flags — all functionality must be live in Open.

**Harness:** fresh **isolated** instance, zero contact with `~/neutron/{core,data}`.
- `NEUTRON_HOME` = a throwaway temp dir (fresh empty state)
- `NEUTRON_PORT=7811` (live dogfood is on 7800 — untouched)
- `CLAUDE_CODE_OAUTH_TOKEN` = owner Max OAuth → **real Max LLM** via the substrate
- Code under test: `main @ 7629423` (#90), booted via `bun run open/server.ts`
- Real browser: system Playwright (`/usr/local/bin/playwright`, Chromium 1.58)
- Reference: `tests/e2e-browser/onboarding_walkthrough.py`

## Status legend
- ✅ **VERIFIED-WORKS** — real-browser/real-turn evidence captured
- ❌ **BROKEN** — evidence + root-cause `file:line` + severity (P0/P1/P2)
- 🟡 **NEEDS-DECISION** — large/ambiguous, recommendation given
- ⏳ **in progress**

---

## Boot / harness findings

### B1. `bun run open/server.ts` before `bun install` dies on `@neutron/chat-core` — NOT a product bug
First boot attempt (stale/incomplete `node_modules`) failed with
`Cannot find module '@neutron/chat-core' from message-search/runtime.ts`.
**Investigated thoroughly** (this is the kind of thing that looks like a P0
fresh-clone-boot break): after a proper `bun install`, `bun run open/server.ts`
resolves `@neutron/chat-core` fine via bun's workspace map at runtime — even
though bun does **not** create a `node_modules/@neutron/chat-core` symlink (it
links `@neutronai/*` workspaces but not the lone `@neutron/`-scoped one). The
live `~/neutron/core` server runs the same way (no symlink, resolves fine).
`bun -e "import('@neutron/chat-core')"` is an unreliable proxy (eval has no
workspace context) — the real `bun run <entry>` path works.
**Verdict:** ✅ not a bug. Documented so the next QA pass doesn't re-chase it.

### B2. `open/server.ts` docstring names the wrong port env var — P2 doc bug
`open/server.ts` header comment says the port comes from
`--port / NEUTRON_LISTEN_PORT / a free port`, but the real env var read by
`gateway/boot-helpers.ts:240` is **`NEUTRON_PORT`** (`NEUTRON_LISTEN_PORT` is
ignored). A self-hoster following the docstring to move off the default port
would silently fail to rebind and hit the EADDRINUSE guard. Low blast radius
(comment-only) but it actively misleads. **Fix candidate.**

---

## TEST MATRIX

### PRIORITY 1 — just-shipped native capabilities (highest disappointment risk)

#### ✅ 1. Native tool call (plain English → real tool effect) — VERIFIED-WORKS
Real browser turn on the onboarded instance: *"Set me a reminder to call the
dentist tomorrow at 3pm."* (plain English, **not** a `/cmd`). Agent replied
*"Reminder set for tomorrow, 2026-06-28 at 3:00 PM PT — Call the dentist."*
**Effect-verified:** `project.db.reminders` now has a real row
`id=88c044c7… message="Call the dentist" fire_at=1782684000 status=pending`.
The agent emitted a tool call mid-turn that hit the reminders backend and
persisted. ✅
- Note (not a bug): reminders persist via the `reminders` workspace →
  `project.db.reminders`. The `cores/free/reminders` Core
  (`cores/reminders_core.db`) is **empty/unused** in Open — two reminder
  subsystems, only one wired. Worth a cleanup decision but functionally fine.

#### ❌ 2. Memory recall via `gbrain_search` (#89) — BROKEN (P1), masked by file-memory
**User-facing recall WORKS**, but **not** through the just-shipped gbrain path.
- What the agent actually does: Claude Code **file-memory**. Stating
  *"my co-founder is Alex Rivera; we deploy to staging by default"* made the
  agent write `~/.claude/projects/<home>/memory/cofounder.md` +
  `deploy-default-staging.md` + a `MEMORY.md` index. Later recall read those
  files back. ✅ user gets a memory that survives sessions.
- What is **dead**: the entire **gbrain** memory layer — scribe→gbrain write,
  `mcp__neutron__gbrain_search` recall, and the admin "Memory" tab.
  **Root cause (verify-before-assert, fully reproduced):**
  1. Open's production memory store (`gateway/realmode-composer/build-gbrain-memory.ts`)
     spawns the **external `gbrain serve` binary** (`gbrain-stdio-client.ts`
     args `['serve']`).
  2. `gbrain serve` on a brain that was never initialized prints
     **"No brain configured. Run: gbrain init"** and **exits** → every MCP op
     fails with `MCP error -32000: Connection closed`. Reproduced via the exact
     Open path: `buildGBrainMemory().memoryStore.add/query` → both throw
     "Connection closed".
  3. **No Open code path ever runs `gbrain init`** (grep across
     `gbrain-memory/`, `gateway/realmode-composer/`, `open/` — zero hits), and
     `gbrain init` itself **requires an embedding provider** ("No embedding
     provider configured. Set OPENAI_API_KEY…") which Open does not set by
     default (`NEUTRON_EMBEDDINGS` opt-in).
  4. `gbrain_search` swallows the failure → `{ results: [] }`
     (`gbrain-memory/agent-tool.ts:142`), so recall silently returns nothing
     and the agent falls back to file-memory.
  5. **Affects the LIVE install too:** `GBRAIN_HOME=~/neutron/data/gbrain
     gbrain list` → "No brain configured." Ryan's own gbrain memory layer is
     dead; his recall is file-memory only.
- **Test-vs-prod gap:** CI's "real GBrain round-trip" passes because it uses an
  **in-process PGLite engine** (`gbrain-memory/__tests__/boot-pglite-brain.ts`,
  test-only). Production never gets an initialized brain. The code works; the
  wiring doesn't.
- **Also note (P2 fragility):** when `gbrain` is merely off PATH (e.g. a fresh
  self-host that didn't `bun install -g github:garrytan/gbrain`, or any
  non-login-shell boot — `gbrain` lives at `~/.bun/bin`), the SAME silent
  degradation occurs with only a boot-log warning; the browser user sees a
  silently amnesiac agent.
- **Classification: 🟡 NEEDS-DECISION** for the real fix (see below). The
  unambiguous shippable piece is a louder, user-visible signal + docs.

#### ⏳ 3. Skills (impeccable / agent-browser / remind) — discoverable on disk ✅, invocation pending
All skill packs present under `<home>/.claude/skills/` (agent-browser,
impeccable, remind, animate, polish, …) — **discoverable** ✅. Live invocation
(design ask → `impeccable` fires) still to verify in a real turn.

### PRIORITY 2 — fresh onboarding end-to-end
#### ✅ 4. Onboarding (synthetic fixture) — VERIFIED-WORKS; real-export import pending
`tests/e2e-browser/onboarding_walkthrough.py` against :7811 PASSED every gate
in real Chromium: auto-start (loader→prompt, empty composer), **every freeform
answer advanced** (0 re-prompts, 0 `[llm-router]…timed out`), persona persisted
to `persona/SOUL.md`, real button labels (no bare A/B/C), clean resting bubbles,
no empty bubble above the typing indicator, completes → plain chat. A synthetic
ChatGPT-export zip imported → 3 real projects materialized
(topline / acme-infra / a-book-about-focus) with STATUS/README/CLAUDE +
`docs/overnight/seed-context.md`. **Pending (Ryan's steer):** drive his REAL
14MB Claude export end-to-end and verify materialized docs/memory contain real
content.

### PRIORITY 3 — every other surface
- ✅ **Steady-state chat** — real turn round-trips, streaming, reply renders.
- ✅ **Documents tab WORKS** — real-browser DOM shows the materialized doc tree:
  `overnight/seed-context.md` + "Select a document to read." The e2e's
  `documents_doc_visible=false` was a **stale selector** (`.cdoc-row` /
  `[data-doc-id]`); the real rows render under `.cdoc*` classes. **NOT a bug**;
  the e2e guard should be updated (fix below).
- ✅ **Admin / Integrations tab WORKS** — 5 real rows in real browser:
  `gmail_compose`, `google_calendar`, `google_workspace` (all "Not connected"
  with a connect affordance) + `apify_api_token`, `tavily_api_key` (API-key
  paste slots with free-tier hints). Integrations **and** key slots present.
- ✅ **Skills** — design ask ("design a clean modern CTA button, give me
  production-ready HTML+CSS") returned semantic, accessible, dependency-free
  HTML+CSS with CSS custom props / hover states — behaviorally consistent with
  the `impeccable`/design skill. Skill packs (`impeccable`, `agent-browser`,
  `remind`, …) all discoverable under `<home>/.claude/skills/`. (Native
  invocation can't be transcript-proven — the persistent-REPL substrate doesn't
  persist a findable CC session JSONL — so this is behavioral + discovery
  evidence, not a `Skill` tool_use capture.)
- 🟡 **No web Reminders list surface** and **no admin Memory section** in Open's
  React client (`landing/chat-react/` has zero `reminder`-UI and no Memory tab).
  Reminders are **create-only** via the agent (create verified). The
  `/api/app/projects/<id>/reminders` REST route exists but isn't surfaced in the
  web UI. Agent-native parity gap (agent can create; user has no list/manage UI).
- ⏳ project rail refresh / morning-brief wiring.

### Real Claude-export import (Ryan's steer) — ✅ STARTS on the real 14MB export
Fresh isolated instance (:7812, fresh home). Drove onboarding in real Chromium;
the import affordance appeared ("📎 Attach or drop your ChatGPT export ZIP…"),
uploaded Ryan's REAL `~/Downloads/Claude Data Batch (1).zip` (14MB
conversations.json + projects/ + memories.json + users.json + design_chats/).
Status advanced to **"Export received — reading through your history now."** ✅
- 🟡 **Observation:** the agent offered a **`chatgpt`-source** affordance (hint
  read "ChatGPT export ZIP") even though the user has a **Claude** export. Upload
  was accepted against `/api/upload/chatgpt`. **Verifying** whether synthesis
  correctly parses the Claude format and materializes REAL content
  (docs + memory) — result pending (synthesis over 14MB is slow).

---

## Summary table (updated as the run proceeds)

| Item | Verdict | Evidence |
|---|---|---|
| B1 chat-core boot | ✅ not a bug | verified `bun run` resolves post-install |
| B2 port env doc | ❌ P2 | `open/server.ts` hdr vs `boot-helpers.ts:240` |
| 1 native tool call | ✅ WORKS | real reminder row in project.db from plain English |
| 2 memory recall (gbrain) | ❌ P1 / 🟡 needs-decision | gbrain brain never init'd → `gbrain_search`→`{results:[]}`; masked by file-memory; live install affected too |
| 3 skills | ⏳ (discoverable ✅) | invocation pending |
| 4 onboarding (synthetic) | ✅ WORKS | e2e all gates pass; real-export pending |
| 5 other surfaces | ⏳ | docs-tab 0-rows flag; admin/chat render |

## NEEDS-DECISION (do not guess — owner call)

### ND1 (P1). gbrain memory layer is dead in production; wire the in-process PGLite brain
Production spawns external `gbrain serve`, which needs a manually-init'd brain +
an embedder Open never provides → scribe-write, `gbrain_search`, and the admin
Memory tab all silently no-op (live install included). **Recommendation:** wire
the **in-process PGLite engine** that the test suite already proves out
(`gbrain-memory/__tests__/boot-pglite-brain.ts`) as the production memory
backend, removing the external-binary + `gbrain init` + embedder dependency for
the default keyword+graph mode. This is a production-backend change (hard to
reverse) → owner decision. Interim unambiguous fix shippable now: a loud,
user-visible "memory is not initialized" signal instead of silent empty recall.
