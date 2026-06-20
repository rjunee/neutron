# @neutron/reminders-core

Tier 1 free Reminders Core for Neutron. Wraps the existing
`@neutron/reminders` engine (per-project SQLite store from
`reminders/store.ts`) and surfaces four MCP tools:

- `reminders_create` — schedule a one-shot reminder
- `reminders_list`   — list pending reminders, soonest-firing first
- `reminders_snooze` — move a pending reminder to a later fire time
- `reminders_cancel` — cancel a pending reminder

Bundled into the public OSS repo at `cores/free/reminders/` per the
locked 2-tier Cores model
(`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

## Why a separate package name

The engine workspace already owns `@neutron/reminders`; this Core ships
as `@neutron/reminders-core` (slug `reminders_core`) so the two
workspaces coexist without colliding. Display name in the launcher is
just "Reminders" — the suffix is internal plumbing only.

## Install

The runtime composer installs this Core automatically when the
bundled-Core registry boots from a root that includes
`cores/free/*` (multi-root mechanic landed in PR #139). On install
the lifecycle module:

1. Validates the manifest (Sprint 24 `parseManifest`).
2. Allocates a sidecar SQLite layout at `<dataDir>/cores/reminders_core.db`
   (driven by the `read:/write:reminders_core.db` capabilities — the
   `reminders_core` resource name matches the Core's slug, which
   triggers the sidecar branch of `decideDataLayout`). The sidecar
   is reserved for future Core-private metadata; the v1 tool wiring
   routes through the engine's shared `reminders` table so
   the existing fire-time tick loop keeps firing rows the Core
   creates.
3. Registers the four MCP tools, each capability-guarded by
   Sprint 31's `CapabilityGuard.wrapToolHandler`.

The launcher icon surface (`ui_components[0]`) is manifest metadata
only at v1; the actual launcher tab lands in P5.3 (and the dedicated
reminder list/edit screen in P5.4).

## Storage model + uninstall — IMPORTANT

This Core **piggybacks on the shared engine `reminders` table in
`project.db`**. The sidecar declared in `capabilities`
(`read:/write:reminders_core.db`) is reserved for future Core-private
metadata; the v1 backend writes every reminder through to the engine
table so the engine's existing fire-time tick loop keeps dispatching
rows the Core creates — without this piggyback the Core would need
its own tick loop or its rows would never fire.

To make uninstall safe, every reminder this Core creates carries the
package name in the engine's `source` column (migration 0031). The
Core exports a `cancelOwnedReminders({ project_slug, projectDb })`
function that scopes a cancellation pass to `source =
'@neutron/reminders-core'` so it touches the rows this Core created
and ONLY those rows — organic engine reminders (gateway reminder
agents, wow-moment lifestyle nudges, interest-check-ins) carry
`source = NULL` and are excluded.

**Uninstall contract for the deployment wrapper:**

```ts
import { cancelOwnedReminders } from '@neutron/reminders-core'
import { uninstallCore } from '@neutron/cores-runtime'

// MUST be called BEFORE uninstallCore — the runtime deletes the
// sidecar but knows nothing about rows the Core wrote into project.db.
await cancelOwnedReminders({ project_slug, projectDb })
await uninstallCore({ project_slug, core_slug: 'reminders_core', /* ... */ })
```

Without this sweep, every pending Core-created reminder would orphan
in `project.db` and **keep firing via the engine's tick loop after the
Core is gone**. The sweep is idempotent — a second call after every
row is cancelled returns `{ cancelled: 0 }`.

## Testing

```
bun test cores/free/reminders
```

Tests construct a real `ReminderStore` against an in-memory `ProjectDb`
with migrations applied, so the suite exercises the adapter against
the same SQL surface that ships in production — no `MemoryStore`-style
fake required.

## Forward-compat notes

- Snooze is implemented as an atomic cancel + re-create on the adapter
  side because the engine doesn't expose a direct fire_at-mutator for
  one-shot rows (only `advanceRecurrence` for recurring rows). A future
  sprint that adds a `snooze` method to `ReminderStore` can replace the
  cancel+create path without changing the tool contract.
- `project_id` is persisted as the engine's `topic_id` column. When a
  first-class `project_id` lands on the schema, the adapter swaps the
  mapping; tool consumers see no change.
- The `reminders_core.db` sidecar allocated at install time is reserved
  for future Core-private metadata. P5.4 / P6 will decide whether to
  promote the Core to own the storage outright (which would shift the
  cleanup hook from "tag-scoped cancel in project.db" to "delete the
  sidecar").
- `reminders_list` only returns pending rows in v1 — the manifest's
  `status` enum has been tightened to `['pending']` so callers can't
  ask for fired/cancelled history (which the engine has no first-class
  list API for). Forward-compat: a future engine `listAll` lands first,
  then this enum widens.
