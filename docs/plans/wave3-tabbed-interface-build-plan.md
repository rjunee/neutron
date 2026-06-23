# WAVE 3 — Tabbed Project Interface: Build Plan

> **Status:** design (Atlas, 2026-06-22). READ-ONLY codebase audit + PR-sized build sequence.
> **Authority:** implements SPEC.md Decisions Log 2026-06-22 ("TABBED project interface + Cores install-scope…") + WAVE 3 Phases→Steps (SPEC.md:184-186). v1 scope confirmed by Ryan 2026-06-22.
> **v1 scope:** tabbed shell → Documents tab → per-project Tasks tab. **v2-deferred (architecture must accommodate, do NOT build):** global cross-project roll-up tab, custom user-built tabs.
> Every claim below is tagged **[verified]** (read from code, file:line cited) or **[estimate]** (design proposal, confirm in the PR).

---

## 0. Headline finding — this is mostly *wiring*, not greenfield

The SPEC frames WAVE 3 as if the task system is a "hacky always-out-of-sync markdown port" and Documents/tabs are to be built from scratch. **The code says otherwise.** Most of the substrate already exists; WAVE 3 is largely (a) making the *hardcoded* mobile tab set *registry-driven*, (b) adding an install-*scope* dimension, (c) building the **web** tab shell + web Documents/Tasks views (web is still chat-only), and (d) flipping task prioritization from deterministic to LLM-primary.

| SPEC premise | Reality in code | Net WAVE 3 work |
|---|---|---|
| "Tasks = markdown port, build the SQLite store" | **[verified]** Canonical `tasks` SQLite table already primary (`migrations/0032_tasks_canonical.sql:68`); markdown is a *projection*, not source-of-truth | LLM prioritization + web tab + **retire** the markdown projection. NOT build-the-store. |
| "Agent-native CRUD parity (to build)" | **[verified]** `cores/free/tasks` wraps the canonical `TaskStore` via `buildSubstrateTaskStoreBackend` — agent + app write the *same* table (`cores/free/tasks/README.md:58-66`) | Verify, don't build. |
| "Documents tab — list/view/**comment** (to build)" | **[verified]** Comment backend already shipped: `/docs/comments`, `/reply`, `/thread`, `/escalate`, `/resolve` (`gateway/http/app-docs-surface.ts:135-148`); mobile docs tab w/ file-tree + editor exists (`app/app/projects/[id]/docs.tsx`) | Build the **web** Documents tab + web comment UI; reuse the backend. |
| "Each project's UI becomes a TAB set" | **[verified]** Mobile already has a **hardcoded** 5-tab set (`app/components/ProjectTabBar.tsx:35` `PROJECT_TABS`); **web is chat-only** (single page, sidebar project selector, `landing/chat-react/ChatApp.tsx`) | Make mobile tabs registry-driven; build the web tab shell from zero. |
| "Cores contribute tabs" | **[verified]** Cores reach the UI *only* via launcher icons + `open_app_tab` deep-links (`app/lib/launcher-client.ts:33,51`); manifest declares a `project_tab`/`app_tab` surface but **nothing renders core-contributed top-level tabs** | New: tab-resolver that reads installed cores' `project_tab` surfaces. |
| "Core installs per-project OR globally" | **[verified]** `core_installations` PK is `(project_slug, core_slug)` — per-project only, no global scope (`migrations/0021_p3_cores_runtime.sql:70-87`) | New: install-scope dimension (global). |

**The single most load-bearing reframe:** the SPEC's "retire the always-out-of-sync markdown" goal is *already 80% done* — SQLite is already canonical. What remains is (1) deleting/gating the markdown *projection* surface (`tasks.md` / `DASHBOARD.md` / `task-inbox.jsonl` scanner) and (2) the LLM-primary prioritization flip. Do not re-architect a store that already exists.

---

## 1. Current-state map (verified)

### 1.1 Web client — `landing/`  **[verified]**
- Plain **React 19** (no Next, no Vite, no router), bundled by `Bun.build({target:'browser', format:'esm'})` and served by `landing/server.ts` at `GET /chat` (`server.ts:1216-1247`). Bundle lazily built on first request (`server.ts:1121-1141`).
- Gated by `landing/web-chat-flag.ts` — `WebChatClient = 'react' | 'vanilla'`, default **`vanilla`**; override via `?client=` or `NEUTRON_WEB_CHAT_CLIENT` (`web-chat-flag.ts:18,37-39`).
- Component tree: `main.tsx` → `AssistantRuntimeProvider` → `ChatApp` → `TopicRail` (project selector rail) + `ThreadPrimitive.*` (assistant-ui). Project selection is **state-only** (`controller.projectId`), not URL-routed. **No tabs, no docs/tasks views.** `landing/chat-react/{main.tsx,ChatApp.tsx,controller.ts,config.ts}`.

### 1.2 Mobile client — `app/`  **[verified]**
- **Expo 54 + RN 0.81 + expo-router 6** (file-based routes). Project detail shell at `app/app/projects/[id]/_layout.tsx` renders `ProjectTabBar` and routes `router.replace(/projects/<id>/<tab>)`.
- **Hardcoded** 5-tab set: `chat | launcher("Apps") | tasks | reminders | docs` (`app/components/ProjectTabBar.tsx:35` `PROJECT_TABS`). `ProjectTabBar` *already accepts* an optional `tabs` prop (line 49) but every caller uses the hardcoded default. Per-project "last tab" persisted to `AsyncStorage`.
- Tab content lives in sibling route files: `chat.tsx`, `launcher.tsx`, `tasks.tsx`, `reminders.tsx`, `docs.tsx`.

### 1.3 chat-core — `chat-core/`  **[verified]**
- Transport-agnostic sync library shared web+mobile. WebSocket to `/ws/app/chat`, monotonic server `seq` + resume + UPSERT dedup. Web store = OPFS; mobile store = op-sqlite. Not UI. (`chat-core/{index.ts,web-session.ts,ws-client.ts,sync-engine.ts}`.)

### 1.4 Documents  **[verified]**
- **Bodies = filesystem**, `<owner_home>/Projects/<project_id>/docs/` (`gateway/http/doc-store.ts:11`). No `documents` DB table — Obsidian was never load-bearing for the agent; it reads the filesystem.
- **Search:** `doc-search/` = SQLite FTS5 index at `cache/doc-search/index.db`, lazy-refreshed; agent tools `doc_search` / `doc_read` (`read:docs`-gated). (`doc-search/{store.ts,tool.ts}`.)
- **HTTP API (exists):** `/api/app/projects/<id>/docs/{tree,file,file/move,folder,binary,…}` (`gateway/http/app-docs-surface.ts:251-282`).
- **Comments (exists, backend):** `/docs/comments` (list+post), `/docs/comments/<event_id>/{reply,thread,escalate,resolve}` — incl. **escalate-to-chat** (S3) (`app/.../app-docs-surface.ts:135-148`). Gated: returns `503 comments_unavailable` when the comment store is absent (line 95).
- **UI:** mobile docs tab = file-tree + markdown editor/preview (`app/app/projects/[id]/docs.tsx`). **Web: none.**

### 1.5 Cores — `cores/`, `core-sdk/`  **[verified]**
- A Core = npm pkg with a `package.json:neutron` manifest (`core-sdk/types.ts`): `capabilities[]`, `tier_support`, `tools[]`, `ui_components[]` (surfaces: `launcher_icon | project_tab | app_tab | settings_panel | route_mount`), `billing_hooks`, `linked_sources`.
- **Install state:** `core_installations(project_slug, core_slug, …, data_layout, install_state)` — **per-project only** (`migrations/0021_p3_cores_runtime.sql:70-87`, install_state added `0036`).
- **Only wired UI path:** `launcher_icon` → launcher entry → `open_app_tab` deep-link (`gateway/http/project-launcher-store.ts:158-180`, `app/lib/launcher-client.ts`). The `project_tab` surface is *declared in the manifest type but not rendered anywhere.* **[verified]** grep found no renderer.
- Bundled free cores: `research, tasks, calendar, notes, agent-settings` (`cores/free/`). Runtime: `cores/runtime/{installations-store.ts,lifecycle.ts,loader.ts,capability-guard.ts}`.

### 1.6 Tasks — `tasks/`  **[verified]**
- **Canonical SQLite `tasks` table** primary (`migrations/0032_tasks_canonical.sql:68-84`): id, project_slug, project_id, title, status, priority(0-3), due_date, source, timestamps. + `focus_score` columns (`0037`).
- **Deterministic** focus-score (`tasks/focus-score.ts`, `FOCUS_SCORE_VERSION=1`): `(urgency*3)+(importance*2)+staleness`; 4h recompute cron (`tasks/focus-score-cron.ts`).
- **Markdown projection (the thing to retire):** `task-inbox.jsonl` append queue → `scanner.ts` (CLAIM→PARSE→APPLY→ARCHIVE→RENDER) → `tasks.md` + `DASHBOARD.md` read-only projections (`tasks/inbox/`, `tasks/projection/`).
- **Agent CRUD parity DONE:** `cores/free/tasks` wraps the same canonical `TaskStore` (`buildSubstrateTaskStoreBackend`, README:58-66). HTTP: `/api/app/projects/<id>/tasks`. Mobile tasks tab exists.

### 1.7 DB / migrations  **[verified]**
- SQLite (`bun:sqlite` server, op-sqlite RN). Migrations `migrations/NNNN_*.sql`, monotonic, runner tracks `_migrations`, golden snapshot `expected-schema.txt`. Latest ≈ `0083`. New tables append at `0084+`.

---

## 2. Spec-conformance diff (SPEC says X / code does Y / gap Z)

| # | SPEC (2026-06-22) | Code today | Gap = WAVE 3 work |
|---|---|---|---|
| C1 | "web+mobile UI becomes a TAB set" | mobile tabbed (hardcoded); **web chat-only** | Web tab shell (greenfield); mobile tabs → registry-driven |
| C2 | "tabs contributed by installed Cores" | core→UI only via launcher icons; `project_tab` surface unrendered | Tab-resolver reads cores' `project_tab` ui_components |
| C3 | "Core installs per-project OR **globally**" | `core_installations` per-project only | Install-scope (global) dimension |
| C4 | "GLOBAL tabs (e.g. Admin)" | no global-tab concept | Global tab descriptor + Admin as builtin global tab |
| C5 | "Documents tab — list/view/**comment**, every project" | mobile docs tab + comment *backend* exist; **web none** | Web Documents tab + web comment UI; mobile comment-UI parity |
| C6 | "Obsidian RETIRED completely" | agent already reads filesystem, not Obsidian | Mostly a *framing* close-out; ensure no Obsidian dep in daily path |
| C7 | "Tasks = SQLite PRIMARY, markdown retired as source-of-truth" | **already true** — SQLite canonical, markdown is projection | Delete/gate the markdown *projection* (scanner + tasks.md/DASHBOARD.md) |
| C8 | "Prioritization: **LLM PRIMARY**, deterministic FALLBACK" | deterministic-only (`focus-score.ts`) | Add LLM prioritizer as primary; focus-score becomes fallback |
| C9 | "Tasks tab = dynamic **web view (AJAX/React)**, not markdown" | mobile RN tab exists; no web tasks view | Web Tasks tab (React) |
| C10 | "Agent-native CRUD parity" | **DONE** (`buildSubstrateTaskStoreBackend`) | Verify only |
| C11 | "global cross-project roll-up tab — architecture-ready, v1 may defer" | none | **v2-deferred**; tab-resolver must support `scope:'global'` so it slots in later |
| C12 | "custom user-built tabs — deferred" | none | **v2-deferred**; descriptor `source` enum must leave room for `'custom'` |

---

## 3. Architecture design

### 3.1 Tab-shell mechanism (C1, C2, C4)

**Single source of truth = an engine-side tab *resolver* both clients consume.** Do not hardcode tabs in either client.

**Tab descriptor** (engine type, returned over HTTP) **[estimate]**:
```
TabDescriptor {
  key: string                 // 'chat' | 'documents' | 'tasks' | core_slug-derived
  label: string
  scope: 'project' | 'global'
  source: 'builtin' | 'core'  // (room for 'custom' in v2 — do not add now)
  core_slug?: string          // when source='core'
  order: number
  mount: { kind: 'native-route' | 'react-view' | 'webview', target: string }
}
```
- `mount.kind`: **builtin** tabs (chat/documents/tasks) render with the client's native view (RN route / React component). **core** tabs render in a sandboxed webview/iframe pointed at the core's declared `project_tab` entry (substituting `<project_id>`), mirroring the existing `open_app_tab` substitution (`project-launcher-store.ts:179`).

**New endpoints** (engine) **[estimate]**:
- `GET /api/app/projects/<id>/tabs` → ordered project-scope descriptors = builtin (Chat, Documents, Tasks) ∪ `project_tab` surfaces of cores installed in that project's scope.
- `GET /api/app/tabs` → global descriptors = builtin Admin ∪ `project_tab`/global surfaces of globally-installed cores. (Returns Admin only in v1; structure ready for the global Tasks roll-up.)

**Resolution** = read `core_installations` (+ new scope rows, §3.2) → for each installed core load manifest → emit a descriptor per `ui_components[]` entry whose surface is `project_tab` (project endpoint) or global (global endpoint). Builtin descriptors are a static list the resolver prepends.

**Clients:**
- **Mobile:** replace the `PROJECT_TABS` default with a fetch of `/tabs`; pass the result into `ProjectTabBar`'s existing `tabs` prop (`ProjectTabBar.tsx:49` — the seam is already there). Core tabs → a generic `cores/[slug].tsx` webview route. Falls back to the hardcoded set if the flag/endpoint is off (no regression).
- **Web:** new `ProjectShell` React component wrapping the current `ChatApp` as the **Chat** tab + a tab bar driven by `/tabs` + a content switch (no react-router needed — a `useState` active-tab switch is sufficient for v1; project already lives in `controller.projectId`).

**Flag:** `NEUTRON_TABS_REGISTRY` (engine resolver + mobile) and `NEUTRON_WEB_TABS` (web shell). Both default OFF → mobile keeps hardcoded tabs, web keeps chat-only. Composes with the existing `web-chat-flag` (web tabs require the React client).

### 3.2 Cores install-scope registry (C3)

**Recommendation [estimate]:** add a sibling table rather than overload the per-project PK.
```
-- migration 0084_core_global_installations.sql
CREATE TABLE core_global_installations (
  core_slug TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  manifest_capabilities_json TEXT NOT NULL,
  install_state TEXT DEFAULT 'install_ok',
  installed_at INTEGER NOT NULL,
  uninstalled_at INTEGER
);
```
Rationale: `core_installations` is keyed `(project_slug, core_slug)` and every query assumes a project. A sentinel `project_slug='*'` would pollute every per-project read path; a dedicated table keeps per-project queries untouched and makes "installed globally" a clean union in the resolver. (**Alternative considered:** `ALTER TABLE core_installations ADD COLUMN scope` + sentinel slug — rejected: larger blast radius across `CoreInstallationsStore` + lifecycle.)

**Manifest additions [estimate]:** `install_scopes: ('project'|'global')[]` (which scopes a core supports) + optional per-`ui_component` `scope`. Lifecycle (`cores/runtime/lifecycle.ts`) gains a `scope` arg; `CoreInstallationsStore` gains global CRUD. Tab-resolver (§3.1) unions both tables.

**Admin** = a builtin **global** tab descriptor (not a core) in v1.

### 3.3 Documents data model + UI (C5, C6)

**Decision [estimate]: keep filesystem as the source of truth for doc bodies** (already works, already FTS-indexed, Obsidian already not load-bearing). Do **not** add a `documents` table in v1 — it would duplicate the filesystem + index for no v1 benefit. Comments already have a backend store + routes.

- **Web Documents tab:** list (reuse `GET /docs/tree`), markdown viewer (`GET /docs/file`), comment sidebar (reuse `/docs/comments*`). Editing can ship read+comment first, edit second.
- **Comment UI parity:** web gets the comment thread/reply/resolve UI; verify mobile docs tab exposes the same (escalate-to-chat already in the backend, S3).
- **Obsidian retire = close-out:** confirm no daily-path code requires Obsidian; the Documents tab becomes the primary surface. Largely a documentation/flag close-out, not new storage.

### 3.4 Tasks Core (C7-C10)

The store, parity, and reminders links already exist. WAVE 3 adds:

1. **LLM-primary prioritization** **[estimate]:** new `tasks/prioritize-llm.ts` — an LLM call ranks open tasks for a project (input: title/desc/due/priority/age; output: ordered ids + one-line rationale). New columns (`0085`): `llm_rank INTEGER`, `llm_reason TEXT`, `prioritized_by TEXT CHECK(prioritized_by IN ('llm','deterministic'))`, `prioritized_at TEXT`. Primary path = LLM; **fallback** to the existing `focus-score.ts` when the LLM is unavailable/over-budget/errors. Keep `focus_score` column as the fallback ranking. Flag `NEUTRON_TASKS_LLM_PRIORITY`.
2. **Web Tasks tab** **[estimate]:** React view over `GET/POST/PATCH /api/app/projects/<id>/tasks` — list, create, complete, reprioritize; surfaces LLM rank + reason. Mounts into the §3.1 web shell.
3. **Retire the markdown projection** **[estimate]:** gate `task-inbox.jsonl` scanner + `tasks.md`/`DASHBOARD.md` projection writer behind `NEUTRON_TASKS_MARKDOWN_VIEW` (default OFF) for one release, then delete. **Confirm in the PR** whether the scanner is boot-wired or cron/CLI-only (grep of `gateway`/`open` did not surface a boot call — **[needs verification]**).
4. **Agent parity:** verify only (C10 already satisfied).
5. **Global roll-up tab:** **v2-deferred** (C11). The §3.1 `GET /api/app/tabs` + `scope:'global'` descriptor is the slot; the only missing piece for v2 is a cross-project task query — not built now.

---

## 4. PR-sized build sequence

Each PR is independently mergeable, flag-gated, and leaves `main` green. After PR-4, the **Documents** track (5-6) and **Tasks** track (7-9) are independent and can run in parallel.

**Engine foundation**
- **PR-1 — Tab descriptor + resolver endpoints.** `tabs/registry.ts` + `GET /api/app/projects/<id>/tabs` + `GET /api/app/tabs`. Returns *builtin* descriptors only (Chat, Documents, Tasks; global Admin). No client change. Flag `NEUTRON_TABS_REGISTRY`. Pure additive. *Tests: resolver unit + route contract.*
- **PR-2 — Cores install-scope.** Migration `0084_core_global_installations.sql`; `CoreInstallationsStore` global CRUD; lifecycle `scope` arg; manifest `install_scopes` + per-component `scope`; resolver (PR-1) now unions core `project_tab` surfaces. No client change. *Tests: global install/uninstall, resolver union, capability-gate unchanged.*

**Clients get tabs**
- **PR-3 — Mobile tabs → registry-driven.** Fetch `/tabs`; feed `ProjectTabBar`'s existing `tabs` prop; generic `projects/[id]/cores/[slug].tsx` webview route for core tabs; fallback to `PROJECT_TABS` when flag off. *No regression when flag off.*
- **PR-4 — Web tab shell.** `ProjectShell` wraps `ChatApp` as the Chat tab + `/tabs`-driven tab bar + content switch. Non-chat tabs = placeholders. Flag `NEUTRON_WEB_TABS` (requires React web client). *Tests: shell renders, chat parity preserved, flag-off = current chat-only page.*

**Documents track (parallel after PR-4)**
- **PR-5 — Web Documents tab.** List (`/docs/tree`) + markdown viewer (`/docs/file`) + comment sidebar (`/docs/comments*`). Read+comment first. Mounts in web shell.
- **PR-6 — Documents parity + Obsidian retire close-out.** Web edit; mobile comment-UI parity; confirm + remove any Obsidian daily-path dependency; flip Documents to primary doc surface. *Acceptance: every project has a Documents tab that lists/opens/comments; no Obsidian dependency.*

**Tasks track (parallel after PR-4)**
- **PR-7 — LLM-primary prioritization.** `tasks/prioritize-llm.ts` + migration `0085` columns; LLM primary, focus-score fallback; cron switches to LLM-primary. Flag `NEUTRON_TASKS_LLM_PRIORITY`. *Tests: LLM path ranks; forced-error path falls back to deterministic; columns populate.*
- **PR-8 — Web Tasks tab.** React view over `/api/app/projects/<id>/tasks`; create/complete/reprioritize; shows LLM rank+reason; mounts in web shell. *Acceptance: per-project Tasks web view with agent+user parity CRUD.*
- **PR-9 — Retire markdown task port.** Gate scanner + `tasks.md`/`DASHBOARD.md` projection behind `NEUTRON_TASKS_MARKDOWN_VIEW` (default OFF); verify boot-wiring; verify agent parity (C10). Removes the WAVE 2 PR #15 markdown port as a daily surface. *Acceptance: WAVE 2 markdown port retired; SQLite-only daily path.*

**v2-deferred (do NOT build; architecture accommodates):** global cross-project Tasks roll-up tab (slot = `GET /api/app/tabs` + `scope:'global'` + a cross-project task query); custom user-built tabs (slot = descriptor `source:'custom'`).

---

## 5. Estimate-vs-verify ledger

**[verified] (read from code):** web chat-only + flag; mobile hardcoded 5-tab bar + `tabs` prop seam; `core_installations` per-project schema; canonical `tasks` table + deterministic focus-score; markdown projection layer; agent/user task parity via `buildSubstrateTaskStoreBackend`; doc bodies filesystem-backed + FTS index + `doc_search/doc_read`; docs HTTP API incl. comments/escalate; launcher-icon is the only wired core→UI path; `project_tab` surface declared-but-unrendered; migration convention.

**[estimate] (design proposals — confirm in-PR):** TabDescriptor shape + endpoint payloads; `core_global_installations` table vs scope-column choice; manifest `install_scopes`; LLM-prioritizer interface/budget/caching; web shell using a `useState` switch vs a router; webview sandbox for core tabs.

**[needs verification in PR]:** whether the task-inbox scanner / projection writer is boot-wired or cron/CLI-only (sizes PR-9); exact `503 comments_unavailable` gating condition (sizes PR-5); whether mobile docs tab already renders comments (sizes PR-6 parity work).
