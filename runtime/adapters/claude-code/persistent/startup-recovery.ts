import { statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { beginBootAdoption, type BootAdoptionDeps } from './boot-adoption.ts'
import { disownPane, readRegistryState, registryConversationScopeMatches, type ReplRegistryRecord } from './repl-registry.ts'
import { authFingerprintFor } from './repl-session.ts'
import { sessionJsonlPath } from './session-size-watchdog.ts'
import { resolveTranscriptProjectsDir } from './signatures.ts'
import { getOrSpawnSession, type ReplSpawnProfile } from './spawn.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'
import { pool } from './pool-state.ts'

export type StartupRecoveryOutcome =
  | { status: 'adopted' | 'resumed' | 'skipped' }
  | { status: 'refused'; reason: string }

/** Exact-key discovery includes rows whose dead pane was already cleared. Clearing
 * a pane preserves its conversation; explicit retirement removes the entire row. */
export function readStartupRepl(options: PersistentReplSubstrateOptions, sessionKey: string): ReplRegistryRecord | undefined {
  if (options.replRegistryPath === undefined) return undefined
  const state = readRegistryState(options.replRegistryPath)
  if (state.kind === 'unreadable' || state.kind === 'loaded' && state.droppedKeys.includes(sessionKey)) {
    throw new Error('startup recovery cannot establish durable registry identity')
  }
  const row = state.kind === 'loaded' ? state.registry[sessionKey] : undefined
  if (row !== undefined && !registryConversationScopeMatches(row, options)) {
    throw new Error('startup recovery conversation scope is ambiguous or mismatched')
  }
  // Scope retirement preserves a resumable transcript, not authority to wake it
  // during boot or the autonomous recovery sweep. A new admitted turn owns wake.
  if (row?.asleep_at !== undefined) return undefined
  return row
}

/** Process readiness only: no prompt, turn, admission lease or workflow dispatch.
 * The ordinary ownership probes and pre-spawn reservation remain authoritative. */
export async function recoverStartupRepl(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  tools: ReplSpawnProfile['tools'],
  deps: {
    adoption?: BootAdoptionDeps
    spawn?: typeof getOrSpawnSession
  } = {},
): Promise<StartupRecoveryOutcome> {
  try {
    if (options.ephemeral === true) return { status: 'skipped' }
    const before = readStartupRepl(options, sessionKey)
    if (before === undefined) return { status: 'skipped' }
    const expectedAuthFingerprint = authFingerprintFor(options.env, options.sinkTokenPath)
    if (before.reuse?.auth_fingerprint !== expectedAuthFingerprint) {
      throw new Error('startup recovery credential fingerprint is missing or changed')
    }
    const pending = pool.get(sessionKey)
    if (pending !== undefined) {
      // The existing owner's normal gate still checks shutdown/key fences and
      // claim renewal deadlines. This branch does not acquire new authority;
      // its concrete pooled child and current row are verified below.
      const guarded = await beginBootAdoption(options, sessionKey)
      if (guarded.kind === 'undecided') return { status: 'refused', reason: guarded.reason }
      const owned = await pending
      const current = readStartupRepl(options, sessionKey)
      if (pool.get(sessionKey) === pending && current?.sessionId === owned.sessionId &&
          current.child_generation === owned.childGeneration &&
          current.adoption_claim_by === owned.paneClaimBy &&
          current.reuse?.auth_fingerprint === expectedAuthFingerprint &&
          owned.authFingerprint === expectedAuthFingerprint && !owned.hasChildExited()) {
        return { status: 'adopted' }
      }
      throw new Error('startup recovery pooled owner requires reconciliation')
    }
    const outcome = await beginBootAdoption(options, sessionKey, {
      ...deps.adoption, expectedAuthFingerprint,
    })
    if (outcome.kind === 'adopted') return { status: 'adopted' }
    if (outcome.kind === 'undecided') return { status: 'refused', reason: outcome.reason }
    const row = readStartupRepl(options, sessionKey)
    // Reconciliation may remove a dead pane's claim, but no other writer may
    // replace the conversation or retire it while startup is awaiting probes.
    if (row === undefined || !isDeepStrictEqual(disownPane(row), disownPane(before))) {
      throw new Error('startup recovery row changed during reconciliation')
    }
    if (row.pane_handle !== undefined) throw new Error('startup recovery still has an unadopted pane owner')
    if (!row.has_session || !row.model?.trim() || row.capped_at !== undefined) {
      throw new Error('startup recovery requires an uncapped captured session and its recorded model')
    }
    if (row.cwd !== options.cwd || row.reuse?.auth_fingerprint !== expectedAuthFingerprint ||
        row.reuse.tool_surface !== tools.map(tool => tool.name).join(',') ||
        row.reuse.tool_bridge !== (options.enableToolBridge === true)) {
      throw new Error('startup recovery credential, directory or tool profile changed')
    }
    const transcript = statSync(sessionJsonlPath(row.sessionId, row.cwd, resolveTranscriptProjectsDir(options)))
    if (!transcript.isFile() || transcript.size === 0) throw new Error('startup recovery transcript is unavailable')
    const recovered = await (deps.spawn ?? getOrSpawnSession)(sessionKey,
      { ...options, ...(row.effort === undefined ? {} : { effort: row.effort }) },
      { tools, model_preference: [row.model] },
      { sessionId: row.sessionId, expectedRecord: row })
    if (recovered.sessionId !== row.sessionId || recovered.forceFreshRespawn || recovered.pendingResumeSessionId !== undefined) {
      throw new Error('startup recovery did not resume the recorded conversation')
    }
    return { status: 'resumed' }
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}
