/**
 * @neutronai/skill-forge — registrar.
 *
 * P1-5 (lift audit § P1-5): "registering" an approved skill = writing a native
 * Claude Code `SKILL.md` PACK at `<skillsDir>/<name>/SKILL.md`, where `skillsDir`
 * is the live agent's project skills dir (`<owner_home>/.claude/skills`,
 * `runtime/adapters/claude-code/persistent/agent-skills.ts`
 * `resolveAgentSkillsDir`). The spawned REPL discovers that directory NATIVELY,
 * so an approved skill is immediately invokable via the built-in `Skill`
 * mechanism (not merely injected as system-prompt prose) and — being on disk —
 * survives a fresh session with ZERO additional wiring. This closes the loop from
 * skill-forge's "proposal lifecycle" to an actually-loadable native skill.
 *
 * (Previously this wrote `<skillsDir>/conventions/<name>.md`, consumed by the
 * system-prompt convention-injection loader. That loader still exists for
 * hand-authored conventions; skill-forge OUTPUT now targets the native pack form.)
 *
 * We never overwrite an existing pack: if `<name>/` is taken, we pick `<name>-2/`,
 * `<name>-3/`, … so an auto-distilled skill can never clobber a hand-authored or
 * bundled one.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { renderSkillPack } from './distiller.ts'
import type { SkillDraft } from './types.ts'

/** Mirror of `build-phase-spec-resolver.ts:resolveSkillsDir` (owner_data_dir form). */
export function resolveSkillsDir(ownerDataDir: string): string {
  const trimmed = ownerDataDir.endsWith('/') ? ownerDataDir.slice(0, -1) : ownerDataDir
  return `${trimmed}/skills`
}

export interface RegisterSkillResult {
  /** Absolute path of the written `SKILL.md`. */
  path: string
  /** The markdown that was written. */
  markdown: string
}

/**
 * Write the distilled skill as a native `SKILL.md` pack under `skillsDir`.
 * Creates the dir tree if absent. Returns the path written (collision-suffixed
 * at the pack-directory level if needed).
 */
export async function registerSkillFile(opts: {
  skillsDir: string
  draft: SkillDraft
}): Promise<RegisterSkillResult> {
  await fs.mkdir(opts.skillsDir, { recursive: true })
  const packDir = await uniquePackDir(opts.skillsDir, opts.draft.name)
  await fs.mkdir(packDir, { recursive: true })
  const markdown = renderSkillPack(opts.draft)
  const path = join(packDir, 'SKILL.md')
  await fs.writeFile(path, markdown, 'utf8')
  return { path, markdown }
}

async function uniquePackDir(dir: string, name: string): Promise<string> {
  const base = join(dir, name)
  if (!(await exists(base))) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = join(dir, `${name}-${i}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`registerSkillFile: could not find a free pack directory for ${name} in ${dir}`)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}
