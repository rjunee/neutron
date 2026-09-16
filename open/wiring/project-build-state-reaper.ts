import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

export const PROJECT_BUILD_STATE_RETENTION_MS = 7 * 24 * 60 * 60_000
export const PROJECT_BUILD_STATE_REAP_INTERVAL_MS = 60 * 60_000

export interface ProjectBuildStateRunReader {
  get(id: string): Pick<TridentRun, 'phase' | 'last_advanced_at'> | null
}

/** Remove state only for a positively known, expired terminal run. */
export async function reapProjectBuildState(options: {
  stateRoot: string
  runs: ProjectBuildStateRunReader
  now?: number
  retentionMs?: number
}): Promise<string[]> {
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? PROJECT_BUILD_STATE_RETENTION_MS
  let entries
  try {
    entries = await readdir(options.stateRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let runId: string
    try { runId = decodeURIComponent(entry.name) }
    catch { continue }
    const run = options.runs.get(runId)
    if (run === null || !isTerminalPhase(run.phase)) continue
    const terminalAt = Date.parse(run.last_advanced_at)
    if (!Number.isFinite(terminalAt) || now - terminalAt < retentionMs) continue
    await rm(join(options.stateRoot, entry.name), { recursive: true, force: true })
    removed.push(runId)
  }
  return removed
}
