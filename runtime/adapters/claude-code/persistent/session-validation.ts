/**
 * session-validation.ts — JSONL-existence gate against ghost session ids.
 *
 * LIFTED VERBATIM from Nova `gateway/session-validation.ts` (§ 1 #7,
 * ◆ ADAPTED-AT-BOUNDARY — pure fs logic kept identical; only the on-disk root
 * is parameterised so the substrate can point it at a per-instance
 * `<owner_home>/.claude/projects` instead of `~/.claude/projects`).
 *
 * Incident this prevents (Nova 2026-04-13): a ghost session UUID was treated
 * as resumable before `claude` wrote any JSONL, trapping the session in an
 * infinite `--resume <uuid>`-fails self-heal loop. Gate via this check so only
 * UUIDs with at least one JSONL line on disk are ever treated as resumable.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Dashify a cwd path the way Claude Code does: external sources →
 * `-Users-sam-nova`. Matches the `~/.claude/projects/<cwd-dashed>/` naming.
 */
export function dashifyCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * Validate that a session UUID has a real JSONL backing on disk with at least
 * one line. Returns true iff the session is safe to treat as resumable.
 *
 * The session JSONL lives at `<projectsDir>/<cwd-dashed>/<sessionId>.jsonl`.
 * A session "claimed" by CC but that never wrote a JSONL is a ghost —
 * `--resume <uuid>` will fail forever.
 */
export function validateAndPersistSessionId(
  sessionId: string,
  cwd: string,
  projectsDir: string = join(homedir(), '.claude', 'projects'),
): boolean {
  if (!sessionId) return false
  const dashed = dashifyCwd(cwd)
  const path = join(projectsDir, dashed, `${sessionId}.jsonl`)
  if (!existsSync(path)) return false
  try {
    const content = readFileSync(path, 'utf8')
    return content.trim().length > 0
  } catch {
    return false
  }
}
