# `@neutron/notes` — Tier 1 free Second-Brain Core

The first Tier 1 free Core in the Neutron roadmap. **v0.2.0 — Notes
Core S1 (2026-05-20).** Self-contained drawers / wings / rooms /
notes / KG-nodes / KG-edges over per-project SQLite at
`<OWNER_HOME>/Projects/<project_id>/notes/notes.db`. Bundled into
the public OSS repo at `cores/free/notes/`.

## Status

v0.2.0 — Notes Core S1. Eight MCP tools, chat-command surface,
drawer-browser HTTP surface, live P5.3 launcher tile, hybrid lex+vec+
KG-traverse search, production-composer-reachability guard.

## Architecture

```
@neutron/notes
│
├── package.json        Manifest declares read:/write:notes.db +
│                       read:/write:notes.fts capabilities, 8 MCP
│                       tools, 2 ui_components (launcher_icon +
│                       app_tab). NO external memory-package dependency.
│
├── manifest.json       Sibling mirror of the package.json "neutron"
│                       block — kept in sync as a 5-LOC stringify so
│                       both validators (cores/sdk + core-sdk) accept
│                       either source.
│
├── migrations/
│   └── 0001_drawers_notes_kg.sql  Per-project schema.
│
├── src/
│   ├── manifest.ts                Locked constants + loadManifest
│   ├── notes-store.ts             Per-project storage layer
│   ├── store-resolver.ts          Per-project SQLite handle resolver
│   ├── backend.ts                 Legacy NotesBackend interface +
│   │                              NotesStore adapter for the four
│   │                              legacy MCP tools
│   ├── tools.ts                   Legacy 4 tools (CapabilityGuarded)
│   ├── mcp-tools.ts               New 4 tools (CapabilityGuarded)
│   ├── chat-commands.ts           Pure parser + dispatcher (/note)
│   ├── chat-bridge.ts             Gateway-facing ChatCommandFilter
│   ├── search.ts                  Hybrid lex+vec+KG-traverse search
│   └── ui/
│       ├── launcher-icon.ts       P5.3 launcher tile binding
│       └── drawer-browser-surface.ts  /api/cores/notes/... handler
│
└── __tests__/          Unit tests for every public surface.
```

## S1 build instructions

- ZERO imports from external sources or any external memory package. The
  schema is RE-IMPLEMENTED in-tree. Verified by grep gate.
- All migrations apply via `applyProjectScopedMigrations(db, dir)` —
  the shared per-project SQLite runner under `migrations/runner.ts`.
- Capability strings: `read:notes.db`, `write:notes.db`,
  `read:notes.fts`, `write:notes.fts`. The FTS pair surfaces audit
  rows independently from generic DB reads/writes.
- Every new MCP tool MUST require `project_id` explicitly (cross-
  project leakage impossible by construction).
- The `chat_command_filter` hook on `createAppWsSurface(...)` is the
  ONLY way `/note` short-circuits the LLM path. Don't add bespoke
  branches into `dispatchInbound`.

## MCP tool catalog (8 tools)

Legacy:
- `notes_write(content, tags?, project_id?)` → `{id}`
- `notes_recall(query, limit?, project_id?)` → `{results: NoteRow[]}`
- `notes_list(limit?, project_id?)` → `{results: NoteRow[]}`
- `notes_link(source_id, target_id, project_id?)` → `{ok, link_id}`

S1 new:
- `notes_create_drawer(project_id, name, kind?)` → `{id}`
- `notes_drawer_list(project_id)` → `{drawers: [...]}`
- `notes_search(project_id, query, limit?)` → `{results: SearchHit[]}`
- `notes_traverse(project_id, from, depth?)` → `{nodes, edges}`

## Cross-refs

- `docs/plans/notes-core-tier1-brief.md` — the locked sprint brief
- `SPEC.md § Phases→Steps` — Tier 1 Cores order
- `docs/research/neutron-cores-marketplace-split-2026-05-17.md` — 2-tier Cores model
- `cores/sdk/SDK-CONTRACT.md` — author-facing API surface
- `gateway/__tests__/notes-production-composer.test.ts` — mandatory
  composer reachability guard
