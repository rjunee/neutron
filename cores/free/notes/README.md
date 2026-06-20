# @neutron/notes

Tier 1 free Second-Brain Core for Neutron. **v0.2.0 — Notes Core S1 (2026-05-20).**

Self-contained drawers / wings / rooms / notes / KG-nodes / KG-edges
over per-project SQLite at
`<OWNER_HOME>/Projects/<project_id>/notes/notes.db`. ZERO imports
from any external memory package — the schema is re-implemented
from the proven drawer/KG mental model in-tree under
`migrations/0001_drawers_notes_kg.sql`.

## Surfaces

- **8 MCP tools.** Four legacy (`notes_write` / `notes_recall` /
  `notes_list` / `notes_link`) + four new (`notes_create_drawer` /
  `notes_drawer_list` / `notes_search` / `notes_traverse`). Every
  dispatch flows through Sprint 31's `CapabilityGuard`.
- **Chat commands.** `/note <body>` capture, `/note find <q>` hybrid
  search, `/note drawer <name>` switch active drawer, `/note tunnel
  <a> <b>` directed KG edge.
- **Drawer-browser HTTP surface.** Eight routes under
  `/api/cores/notes/...` covering drawer CRUD, note CRUD, tunnel,
  search, and BFS traverse (depth 1–3).
- **P5.3 launcher tile.** `primary_action='open_app_tab'` →
  `/projects/<project_id>/notes` + long-press menu with a "I want to
  take a note" chat-send-prefix item.

## Storage

Per-project sidecar at `<OWNER_HOME>/Projects/<project_id>/notes/notes.db`.
Lazy-init via `NotesStoreResolver.resolve(project_id)`. Locked
PRAGMAs: WAL + FK + synchronous=NORMAL + busy_timeout=100 +
temp_store=MEMORY + cache_size=-64000. Defence-in-depth: the
`notes_meta` row stamps the project_id on first init, so a sidecar
copied between project dirs surfaces a `NotesSidecarMismatchError`
on next open.

Schema:

| Table | Role |
|---|---|
| `drawers` | Top-level containers (inbox, pinned, archive, custom). |
| `wings` | Optional cross-drawer groupings (forward-compat; v1 ships the table only). |
| `rooms` | Per-drawer sub-sections (forward-compat as above). |
| `notes` | Markdown-bodied content rows, tagged + soft-deletable. |
| `notes_fts` | FTS5 virtual table over `notes.content`. Triggers keep it in sync. |
| `kg_nodes` | Every persisted note auto-gets a `kind='note'` node. |
| `kg_edges` | Directed edges; `kind='user_tunnel'` for explicit `/note tunnel`. |
| `notes_meta` | Single-row schema_version + project_id stamp. |

## Testing

```
bun test cores/free/notes --max-concurrency=2
```

Per-Core unit suites: `notes-store.test.ts`, `chat-commands.test.ts`,
`search.test.ts`, `tools.test.ts`, `manifest.test.ts`,
`install-lifecycle.test.ts`. The mandatory production-composer-
reachability test lives at
`gateway/__tests__/notes-production-composer.test.ts`.

## Out of scope (S2+)

- LLM-driven entity extraction on write (S2 adds `auto_tunnels[]`).
- Inter-Core tunnels (notes → tasks / reminders / docs). S3.
- Vec embeddings — S1 ships lex-only via FTS5 with a deterministic-
  rank vec stub.
- Migration from the owner's prior memory DB (separate workstream,
  master-plan M1).
- Telegram-side `/note` parity (the chat-bridge filter wires
  app-ws only in S1; the parser is shared so a follow-up wires
  Telegram mechanically).
