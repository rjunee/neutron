# AGENTS.md — gbrain-memory

This module (`@neutron/gbrain-memory`) owns Neutron's integration with **GBrain** (`github.com/garrytan/gbrain`), the sole per-project memory store. It replaced the old `@neutron/memory-store` adapter wholesale in the MM rip-and-replace sprint (2026-06-06) — there is no dual-store and no MemoryStore code left in the tree.

GBrain itself is the memory engine (a Postgres-native personal-knowledge brain: PGLite file for OSS / Postgres for Managed). This module is the thin seam Neutron programs against:

- `memory-store.ts` — the substrate-neutral `MemoryStore` + `McpClient` interfaces.
- `GBrainSyncHook.ts` — the `SyncHook` (`runtime/entity-writer.ts`) implementation that fans an entity-page write into GBrain: `put_page` (body) + `add_link`/`get_links`/`remove_link` (typed edges).
- `gbrain-memory-store.ts` — `MemoryStore` over an `McpClient` (`put_page`/`search`/`delete_page`/`get_stats`), used by the admin "Memory" tab.
- `gbrain-stdio-client.ts` — the production MCP transport: spawns `gbrain serve` and speaks MCP over stdio.
- `version-notice.ts` — parses GBrain's `UPGRADE_AVAILABLE` stderr marker (notify mode; Neutron never silent-auto-upgrades an instance's memory substrate).

One GBrain brain per instance; it must NOT share state across instances. The per-instance systemd unit may set `GBRAIN_BRAIN_ID`; the gateway sets `GBRAIN_SOURCE` to the active project slug before launching `gbrain serve`. The brain data lives at `<instance-home>/gbrain/`. The GBrain CLI is platform code; the brain is per-project data — the instance boundary holds at the file system and the project boundary holds at the GBrain source. Nothing in this module cross-checks instance identity; it trusts the `McpClient` it is handed is already scoped.

Project-scoped partitioning uses one `GBRAIN_SOURCE` per project. The cross-install team-mount layer remains separate Neutron Connect work.

Cross-refs: `docs/architecture/memory-adapter-gbrain-2026-06-06.md`, `docs/plans/memory-store-to-gbrain-migration-2026-06-06.md`.
