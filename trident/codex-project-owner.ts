import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { codexProjectHome } from './codex-auth.ts'

const OWNER_FILE = 'project-owner.json'

/** A configuration refusal: never turn it into a missing credential or fallback. */
export class CodexProjectOwnerError extends Error {
  readonly code = 'codex_project_owner_refused'
  constructor() {
    super('Codex project directory ownership could not be verified. See docs/codex-project-owner-migration.md before migrating an existing directory.')
    this.name = 'CodexProjectOwnerError'
  }
}

function projectHome(globalHome: string, projectId: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(projectId)) throw new CodexProjectOwnerError()
  return codexProjectHome(globalHome, projectId)
}

function verify(home: string, projectId: string): void {
  let owner: unknown
  try {
    owner = JSON.parse(readFileSync(join(home, OWNER_FILE), 'utf8'))
  } catch {
    throw new CodexProjectOwnerError()
  }
  if (owner !== projectId) throw new CodexProjectOwnerError()
}

/** Exclusive directory creation establishes identity; every subsequent access compares it. */
export function ownedCodexProjectHome(globalHome: string, projectId: string): string {
  const home = projectHome(globalHome, projectId)
  mkdirSync(dirname(home), { recursive: true, mode: 0o700 })
  let created = false
  try {
    mkdirSync(home, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (created) {
    writeFileSync(join(home, OWNER_FILE), JSON.stringify(projectId) + '\n', { flag: 'wx', mode: 0o600 })
  }
  verify(home, projectId)
  return home
}

/**
 * Explicit offline migration only. The operator supplies independently established
 * project identity; neither a hash nor a subscription account proves that identity.
 * Existing markers are immutable, and credential bytes are never read or rewritten.
 */
export function migrateCodexProjectOwner(globalHome: string, confirmedProjectId: string): { changed: boolean } {
  const home = projectHome(globalHome, confirmedProjectId)
  try {
    writeFileSync(join(home, OWNER_FILE), JSON.stringify(confirmedProjectId) + '\n', { flag: 'wx', mode: 0o600 })
    return { changed: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  verify(home, confirmedProjectId)
  return { changed: false }
}
