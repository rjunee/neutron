# agent-settings Core

Tier 1 free Core that makes the onboarding "tweak later" promise real.
The onboarding final-handoff tells the user they can rename / delete /
merge projects, switch the agent's personality, and rename the agent
later — just by asking. This Core supplies the tools the owner's
Claude Code subprocess invokes to honour that.

## Tools

| Tool | Signature | Effect |
|---|---|---|
| `list_projects` | `() → {projects: Array<{id, name, slug, topic_id, context_summary}>}` | Current (non-deleted) projects. |
| `rename_project` | `(old_name, new_name) → {success, project?}` | Renames the project + retitles its Telegram forum topic. |
| `delete_project` | `(name) → {success, removed?:{name, context_archived_at}}` | Soft-deletes (sets `deleted_at`) + closes/archives the Telegram topic. |
| `archive_project` | `(name) → {success, archived?:{name, archived_at}}` | Reversibly archives (sets `archived_at`, migration 0095): leaves the rail but stays in the Admin tab, restorable. Closes the Telegram topic. Distinct from delete. |
| `restore_project` | `(name) → {success, restored?:{name}}` | Clears `archived_at` — returns an archived project to the rail. |
| `merge_projects` | `(from_name, into_name) → {success, merged_project?}` | Moves `from`'s members into `into`, soft-deletes `from`, archives `from`'s topic. |
| `update_personality` | `(new_archetype?, new_description?) → {success, personality?}` | Updates the registry `agent_personality`. |
| `update_agent_name` | `(new_name) → {success, agent_name?}` | Updates the registry `agent_name`. |

Every tool returns `{success: boolean, ...}` and emits a plain-text
Telegram confirmation on success.

## Stores

- **Projects** → the canonical per-project `projects` + `project_members`
  tables (migration `0038_projects_canonical.sql`; soft-delete columns
  `deleted_at` / `context_archived_at` / `topic_id` added in
  `migrations/0053_projects_soft_delete.sql`). NOT onboarding
  phase_state; NOT the `topics` table.
- **Personality + agent name** → the platform instance registry row
  (`agent_name`, `agent_personality`). The per-instance gateway opens
  registry.db read-only at boot, so writes route through an injected
  `AgentProfileBackend` that opens a second RW handle via
  `NEUTRON_REGISTRY_DB_PATH` (the same seam the persona-sync onboarding
  hook uses).
- **Telegram** → an injected `AgentSettingsTelegram` sink
  (confirmations + `editForumTopic` / `closeForumTopic`). Best-effort —
  a Telegram failure never rolls back a committed DB mutation.

## Wiring

Registered into the production `ToolRegistry` by
`gateway/cores/install-bundled.ts` via the `agent_settings`
`CoreBackendFactory` built in
`gateway/index.ts:buildCoresBackendFactories`. The tool names are
surfaced to the owner's CC subprocess through
`runtime/system-prompt.ts:AGENT_SETTINGS_TOOLS_FRAGMENT`.

## Known limitation

Onboarding does NOT currently populate the canonical `projects` table.
Wow-moment project shells
(`onboarding/wow-moment/actions/03-project-shells.ts`) land as `topics`
rows keyed by a UUID `project_id` with no name column. The `projects`
table is populated lazily on first PATCH `/settings` access or by the
demo seeder. These tools are correct against the canonical store
regardless; on an instance that has never opened a project's settings,
`list_projects` may return empty. Closing the onboarding→projects
population gap is a separate sprint (it touches `onboarding/interview/*`).
