# Bundled agent skills (`skills/`)

Native Claude Code `SKILL.md` packs shipped with Neutron Open. At boot,
`provisionAgentSkills()`
(`runtime/adapters/claude-code/persistent/agent-skills.ts`) materializes these
into the live agent's project skills dir (`<owner_home>/.claude/skills/`), where
the spawned REPL discovers and invokes them natively via the built-in `Skill`
mechanism. See `docs/SYSTEM-OVERVIEW.md` → "Native SKILL.md discovery for the
agent (P1-5)".

Each pack is a directory containing a `SKILL.md` (plus optional `reference/`,
`scripts/`, `templates/`). A directory without a `SKILL.md` is ignored.

## Packs

- **`impeccable`** + its design sub-skills (`adapt`, `animate`, `audit`, `bolder`,
  `clarify`, `colorize`, `critique`, `delight`, `distill`, `harden`, `layout`,
  `optimize`, `overdrive`, `polish`, `quieter`, `shape`, `typeset`) — the
  production-grade frontend-design path. `impeccable` is Apache-2.0, based on
  Anthropic's frontend-design skill (see `impeccable/NOTICE.md`).
- **`agent-browser`** — browser-automation CLI driver for the agent.
- **`remind`** — Neutron-native reminder management; routes the agent to the
  bridged `mcp__neutron__reminders_*` tools.

Skill-forge writes approved/forged skills here too (as `<name>/SKILL.md` packs),
so a forged skill becomes immediately discoverable. Provisioning refreshes the
bundled packs on every boot and never deletes a forged pack.
