import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'

export const PROJECT_BUILD_STATE_RETENTION_MS = 7 * 24 * 60 * 60_000
export const PROJECT_BUILD_STATE_REAP_INTERVAL_MS = 60 * 60_000

export interface ProjectBuildStateRunReader {
  get(id: string): Pick<TridentRun, 'phase' | 'last_advanced_at'> | null
}

/** Remove state only for a positively known, expired terminal run. */
export async function reapProjectBuildState(options: {
  stateRoot: string
  runs: ProjectBuildStateRunReader
  /** Authoritative census; unavailable or malformed ownership retains evidence. */
  nativeChildren(): readonly AdmissionLeaseRow[]
  now?: number
  retentionMs?: number
}): Promise<string[]> {
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? PROJECT_BUILD_STATE_RETENTION_MS
  const heldRuns = new Set<string>()
  for (const lease of options.nativeChildren()) {
    let identity: unknown
    try { identity = JSON.parse(lease.workRef) } catch { return [] }
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string' || !value.trim())) return []
    heldRuns.add(identity[0] as string)
  }
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
    if (heldRuns.has(runId)) continue
    const run = options.runs.get(runId)
    if (run === null || !isTerminalPhase(run.phase)) continue
    const terminalAt = Date.parse(run.last_advanced_at)
    if (!Number.isFinite(terminalAt) || now - terminalAt < retentionMs) continue
    await rm(join(options.stateRoot, entry.name), { recursive: true, force: true })
    removed.push(runId)
  }
  return removed
}
