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
- ⏳ **1. Native tool call** (`mcp__neutron__*` mid-reasoning)
- ⏳ **2. Memory recall** (`mcp__neutron__gbrain_search`)
- ⏳ **3. Skills** (impeccable / agent-browser / remind)

### PRIORITY 2 — fresh onboarding end-to-end
- ⏳ **4. Onboarding** (auto-start, freeform advances, persona persisted,
  real button labels, export import, drops to chat)

### PRIORITY 3 — every other surface
- ⏳ **5. Chat / Documents / Admin / project rail / reminders / morning brief**

---

## Summary table (updated as the run proceeds)

| Item | Verdict | Evidence |
|---|---|---|
| B1 chat-core boot | ✅ not a bug | verified `bun run` resolves post-install |
| B2 port env doc | ❌ P2 | `open/server.ts` hdr vs `boot-helpers.ts:240` |
| 1 native tool call | ⏳ | |
| 2 memory recall | ⏳ | |
| 3 skills | ⏳ | |
| 4 onboarding e2e | ⏳ | |
| 5 other surfaces | ⏳ | |
