/**
 * agent-skills.ts — native Claude Code SKILL.md discovery for the live agent.
 *
 * P1-5 (architecture-lift audit 2026-06-27 § P1-5). Vajra exposes ~25 real
 * Claude Code skills under `~/.claude/skills/` that the spawned REPL discovers
 * NATIVELY and the agent invokes mid-turn (the built-in `Skill` mechanism).
 * Neutron previously had NO native skill-discovery path for the spawned agent:
 * `impeccable` (the CLAUDE.md-mandated design path) and `agent-browser` were
 * wholly unreachable, and the only "skills" surface was the system-prompt
 * convention-injection loader (`gateway/wiring/skills-loader.ts`) plus
 * skill-forge's *proposal* lifecycle — neither is the native loader.
 *
 * This module LIFTS the mechanism: it materializes a set of `SKILL.md` packs
 * into the live agent's PROJECT skills directory (`<cwd>/.claude/skills/`), which
 * Claude Code discovers natively for the spawned interactive REPL (cwd =
 * `owner_home`). The packs ship version-controlled in the repo-root `skills/`
 * directory (`impeccable` + its design sub-skills, `agent-browser`, `remind`),
 * lifted from Vajra `~/.claude/skills/`.
 *
 * Why project-scope (`<cwd>/.claude/skills`) and NOT a custom `CLAUDE_CONFIG_DIR`:
 * the substrate's `claudeConfigDir` plumbing is dormant (no live caller threads
 * it — see `build-llm-call-substrate.ts` `claude_config_dir` docs) and pointing
 * the warm REPL at a fresh config dir would activate an untested auth /
 * first-run-dialog path that risks wedging the live conversation. The project
 * `.claude/skills/` directory is the SAME native Claude Code skill loader Vajra's
 * `~/.claude/skills` rides on (same `SKILL.md` frontmatter, same `Skill` tool),
 * scoped to the agent's own home — zero auth/first-run blast radius.
 *
 * Skill-forge re-points its approved-skill OUTPUT at this same directory
 * (`registrar.ts` now writes `<skillsDir>/<name>/SKILL.md` packs), so a forged
 * skill becomes immediately discoverable here too — closing the loop from
 * "proposal lifecycle" to "actually-loadable native skill." Provisioning never
 * deletes a pack it didn't ship, so forged packs coexist with the bundled ones.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Repo-root `skills/` directory holding the bundled, version-controlled
 * `SKILL.md` packs. Resolved relative to this module so it works both in the
 * source tree and the installed `~/neutron/core` checkout (same layout).
 * `runtime/adapters/claude-code/persistent/` → up four → repo root.
 */
export const BUNDLED_SKILLS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'skills')

/**
 * The project-level skills directory Claude Code discovers for a REPL spawned
 * with `cwd`. CC reads `<cwd>/.claude/skills/<name>/SKILL.md` natively — the
 * same loader + `SKILL.md` frontmatter Vajra's `~/.claude/skills` rides on.
 */
export function resolveAgentSkillsDir(cwd: string): string {
  return join(cwd, '.claude', 'skills')
}

export interface ProvisionAgentSkillsOptions {
  /** Target skills dir — typically `resolveAgentSkillsDir(owner_home)`. */
  skillsDir: string
  /** Source of bundled packs. Defaults to {@link BUNDLED_SKILLS_DIR}. */
  bundledSkillsDir?: string
}

export interface ProvisionAgentSkillsResult {
  /** Absolute skills dir provisioned. */
  skillsDir: string
  /** Pack names copied from the bundle this call (lexicographic). */
  bundled: string[]
  /** All pack names present after provisioning (bundled + pre-existing forged). */
  present: string[]
}

/** A directory is a valid skill pack iff it contains a `SKILL.md`. */
function isSkillPack(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'))
  } catch {
    return false
  }
}

/**
 * Materialize the bundled `SKILL.md` packs into `skillsDir` so the spawned REPL
 * discovers them natively. Idempotent: bundled packs are refreshed (force-copied)
 * on every call so an engine update propagates, but packs NOT in the bundle
 * (e.g. skill-forge output) are left untouched. Best-effort — a copy failure for
 * one pack never blocks the spawn (the agent simply lacks that one skill).
 */
export function provisionAgentSkills(
  opts: ProvisionAgentSkillsOptions,
): ProvisionAgentSkillsResult {
  const bundledSkillsDir = opts.bundledSkillsDir ?? BUNDLED_SKILLS_DIR
  mkdirSync(opts.skillsDir, { recursive: true })

  const bundled: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(bundledSkillsDir)
  } catch {
    // No bundle present (unexpected) — nothing to provision; pre-existing
    // forged packs (if any) still stand.
    entries = []
  }
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue
    const src = join(bundledSkillsDir, name)
    if (!isSkillPack(src)) continue
    const dest = join(opts.skillsDir, name)
    try {
      cpSync(src, dest, { recursive: true, force: true })
      bundled.push(name)
    } catch {
      // Best-effort: skip a pack that fails to copy.
    }
  }

  // Everything present now (bundled refreshed this call + any forged packs).
  let present: string[] = []
  try {
    present = readdirSync(opts.skillsDir)
      .filter((n) => !n.startsWith('.') && isSkillPack(join(opts.skillsDir, n)))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    present = bundled
  }

  return { skillsDir: opts.skillsDir, bundled, present }
}
