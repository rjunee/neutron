/**
 * @neutronai/skill-forge — registrar.
 *
 * "Registering" an approved skill = writing its convention markdown under
 * `<owner_data_dir>/skills/conventions/<name>.md`. That is the EXACT directory
 * the realmode composer's skills-loader reads at every LLM turn
 * (`gateway/realmode-composer/skills-loader.ts` →
 * `build-phase-spec-resolver.ts:resolveSkillsDir`), so a written skill is
 * immediately agent-discoverable and — being on disk — survives a fresh
 * session with ZERO additional wiring.
 *
 * We never overwrite an existing convention file: if `<name>.md` is taken, we
 * pick `<name>-2.md`, `<name>-3.md`, … so an auto-distilled skill can never
 * clobber a hand-authored one.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { renderSkillMarkdown } from './distiller.ts'
import type { SkillDraft } from './types.ts'

/** Mirror of `build-phase-spec-resolver.ts:resolveSkillsDir` (owner_data_dir form). */
export function resolveSkillsDir(ownerDataDir: string): string {
  const trimmed = ownerDataDir.endsWith('/') ? ownerDataDir.slice(0, -1) : ownerDataDir
  return `${trimmed}/skills`
}

export interface RegisterSkillResult {
  /** Absolute path of the written skill markdown. */
  path: string
  /** The markdown that was written. */
  markdown: string
}

/**
 * Write the distilled skill into the conventions dir. Creates the dir tree if
 * absent. Returns the path written (collision-suffixed if needed).
 */
export async function registerSkillFile(opts: {
  skillsDir: string
  draft: SkillDraft
}): Promise<RegisterSkillResult> {
  const conventionsDir = join(opts.skillsDir, 'conventions')
  await fs.mkdir(conventionsDir, { recursive: true })
  const markdown = renderSkillMarkdown(opts.draft)
  const path = await uniquePath(conventionsDir, opts.draft.name)
  await fs.writeFile(path, markdown, 'utf8')
  return { path, markdown }
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const base = join(dir, `${name}.md`)
  if (!(await exists(base))) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = join(dir, `${name}-${i}.md`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`registerSkillFile: could not find a free filename for ${name} in ${dir}`)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}
