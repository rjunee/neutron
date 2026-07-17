# `@neutron/reminders-core` — Tier 1 free Reminders Core

The third Tier 1 free Core in the Neutron roadmap (after Notes and the
upcoming Tasks Core). Wraps the existing `@neutron/reminders` engine
and surfaces four MCP tools to the launcher: create, list, snooze, and
cancel reminders. Bundled into the public OSS repo at
`cores/free/reminders/`.

## Status

Initial scaffold (Sprint cores-free-reminders-tier1, 2026-05-17).
Manifest, ReminderStore-adapter backend, capability-gated tool
handlers, and unit tests are in place. The launcher UI surface is
manifest-only — actual launcher tab lands in P5.3, dedicated reminder
screen in P5.4 per sprint roadmap § 4.

## Architecture

```
@neutron/reminders-core
│
├── package.json        Manifest declares read:/write:reminders_core.db
│                       capabilities (sidecar layout via Sprint 31
│                       data-namespace allocator — the resource name
│                       matches the Core's slug so the allocator picks
│                       sidecar). Four MCP tools.
│
├── src/
│   ├── manifest.ts     CORE_SLUG / TOOL_NAMES / loadManifest helper
│   ├── backend.ts      RemindersBackend interface + ReminderStore
│   │                   adapter wrapping the existing engine
│   ├── tools.ts        buildTools(deps) — Sprint 31 CapabilityGuard
│   │                   wrapping each handler
│   └── ui/             launcher-icon.ts placeholder (P5.3 lands real UI)
│
└── __tests__/          Unit tests against every public surface.
```

## Why this package is `@neutron/reminders-core` and not `@neutron/reminders`

The engine workspace at `reminders/` already owns `@neutron/reminders`.
The Core's package name takes the `-core` suffix so the two workspaces
coexist without bun-workspace name collisions. Slug becomes
`reminders_core`. The launcher's display name is "Reminders" (the
suffix is internal plumbing only — see
`src/ui/launcher-icon.ts:LAUNCHER_ICON.label`).

## Snooze without touching the engine write API

The brief locks "reminders/ engine public API untouched at the write
path." The engine's `ReminderStore` exposes `create`, `cancel`,
`markFired`, `advanceRecurrence` (recurring rows only), `listDue`,
`listPending`, `get` — but no one-shot `snooze`. The adapter
implements `snooze` as an atomic cancel + re-create against the same
engine APIs, returning the new id alongside the cancelled original id
so callers can update references. When a future sprint adds a
`ReminderStore.snooze` method the adapter can swap to it; the tool
contract here stays unchanged.

## Storage model + uninstall

This Core **piggybacks on the shared engine `reminders` table in
`project.db`**. The sidecar declared in `capabilities`
(`read:/write:reminders_core.db`) is reserved for future Core-private
metadata; v1 routes every reminder through to the engine table so the
existing fire-time tick loop keeps firing rows the Core creates.

To make uninstall safe, every reminder this Core creates carries the
package name in the engine's `source` column (added by migration 0031
specifically for this hook). The exported function
`cancelOwnedReminders({ project_slug, projectDb })` sweeps all pending
rows with `source = '@neutron/reminders-core'` and marks them
cancelled — leaving organic engine reminders (NULL source) untouched.
The deployment wrapper that calls `uninstallCore({...})` MUST call
`cancelOwnedReminders({...})` first; without it, every pending
Core-created reminder would orphan in `project.db` and KEEP FIRING via
the engine's tick loop after the Core is gone. This is asserted by
`__tests__/install-lifecycle.test.ts` "cancelOwnedReminders sweeps
Core-tagged rows but leaves organic engine rows alone".

The cleanup uses an equality match (`source = ?`) on the engine's
`listPendingBySource`, which excludes NULL-source rows by SQL
three-valued-logic. A future migration that rewrites the source tag
must update `CORE_SOURCE_TAG` in lockstep so legacy rows still match
the new tag during the rollout window.

Snooze preserves the original row's `source` on the replacement
(`backend.ts` `snooze`): `list()` returns every pending row for the
the owner, including organic engine rows with NULL source, so a user can
call `snooze` on a row this Core did not create. Re-tagging the
replacement as `CORE_SOURCE_TAG` would make `cancelOwnedReminders`
later cancel a reminder the Core never owned — the symmetric inverse
of the r1 uninstall leak. Asserted by
`__tests__/install-lifecycle.test.ts` "snooze on an organic engine
row preserves NULL source so cancelOwnedReminders leaves it alone".

## Cross-refs

- `SPEC.md § Phases→Steps` — Tier 1 Cores (free-Core inventory)
- `docs/research/neutron-cores-marketplace-split-2026-05-17.md` — 2-tier Cores model
- `cores/sdk/SDK-CONTRACT.md` — author-facing API
- `docs/research/AS-BUILT-archive-2026-07.md` (formerly root `AS-BUILT.md`; the
  "Sprint 31 — P3 Cores runtime" entry itself is pre-carve history) — install /
  capability gate / audit log
- `reminders/store.ts` — `ReminderStore` interface this Core programs against
- `reminders/tick.ts` — the fire-time tick loop the engine owns
