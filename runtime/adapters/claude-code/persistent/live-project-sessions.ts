/**
 * The live `cc-agent-*` project conversation sessions — ONE definition (#1237).
 *
 * Two readers ask the same question at different strengths:
 *
 *   - {@link liveProjectSessions} — the SUPERVISED sessions scoped to one project id.
 *     The bounded-build acting turn (`open/wiring/project-build.ts`) calls it before
 *     and after a spawn, because the second call is the ONLY evidence a spawn
 *     produced anything. It reads supervision only, so a pool entry still resolving
 *     is visible to it (and waited on by its caller).
 *
 *   - {@link resolveLiveProjectSessions} — the same candidates narrowed by the pool's
 *     EXACT-IDENTITY rule (`pool.ts`): a candidate counts only while its pool entry
 *     has resolved, `childByKey.get(key) === session.child`, and the child has not
 *     exited. It is the liveness census's parent reader. A candidate that fails the
 *     rule is reported as `unresolved`, never silently dropped, so the census can
 *     read "a supervised entry exists but its child cannot be identified" as
 *     unknown instead of absent.
 *
 * Runtime-layer: no gateway import. `project_id` here is the POOL's scope value
 * (`'general'` or absent for General), not admission's `null`.
 */
import { childByKey, pool, supervisedBySessionKey } from './pool-state.ts'
import { readRegistryState } from './repl-registry.ts'
import { SESSION_KEY_SEP } from './signatures.ts'
import type { ReplSession } from './repl-session.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'

/** The live-chat substrate family — the only project PARENT sessions. */
export const PROJECT_PARENT_INSTANCE_PREFIX = 'cc-agent-'

/** The supervised `cc-agent-*` sessions scoped to one project id (pool value). */
export function liveProjectSessions(projectId: string): Array<[string, PersistentReplSubstrateOptions]> {
  return [...supervisedBySessionKey].filter(([, options]) =>
    options.project_id === projectId && options.substrate_instance_id.startsWith(PROJECT_PARENT_INSTANCE_PREFIX))
}

export interface ResolvedProjectSession {
  sessionKey: string
  options: PersistentReplSubstrateOptions
  session: ReplSession
}

export interface ResolvedProjectSessions {
  /** Candidates that satisfy the exact-identity rule. */
  live: ResolvedProjectSession[]
  /** Supervised candidates whose child could not be identified (pending, empty,
   *  exited, or replaced under the same key). Evidence of SOMETHING, not of absence. */
  unresolved: number
  /** #1226 — the subset of `unresolved` whose pool entry is a spawn STILL IN FLIGHT
   *  (a Chat about to exist), with its exact options. Absent in older fakes. */
  pending?: Array<{ sessionKey: string; options: PersistentReplSubstrateOptions }>
}

/** {@link liveProjectSessions} narrowed by the pool's exact-identity rule, over
 *  every pool value naming the scope (General is `'general'` OR absent in the pool,
 *  so a General caller passes both). Never awaits an unsettled spawn: a pending
 *  entry is `unresolved`, not waited on. */
export async function resolveLiveProjectSessions(
  poolProjectIds: ReadonlyArray<string | undefined>,
  filter: {
    /** #1226 — drop a candidate whose RECORDED conversation scope is positively a
     *  different one (null is General; the literal `general` project is its own). An
     *  unrecorded scope is kept: it cannot be attributed, so it is never dropped. */
    excludeConversationScopesOtherThan?: string | null
  } = {},
): Promise<ResolvedProjectSessions> {
  const out: ResolvedProjectSessions = { live: [], unresolved: 0, pending: [] }
  const exact = filter.excludeConversationScopesOtherThan
  const candidates = [...supervisedBySessionKey].filter(([, options]) =>
    poolProjectIds.includes(options.project_id) && options.substrate_instance_id.startsWith(PROJECT_PARENT_INSTANCE_PREFIX) &&
    (exact === undefined || options.conversationProjectId === undefined || options.conversationProjectId === exact))
  for (const [sessionKey, options] of candidates) {
    const pending = pool.get(sessionKey)
    if (pending === undefined || Bun.peek.status(pending) !== 'fulfilled') {
      // No pool entry at all is a supervised row whose child is gone; still not absence.
      out.unresolved += 1
      if (pending !== undefined && Bun.peek.status(pending) === 'pending') out.pending!.push({ sessionKey, options })
      continue
    }
    const session = await pending
    if (!session || session.hasChildExited() || childByKey.get(sessionKey) !== session.child) {
      out.unresolved += 1
      continue
    }
    out.live.push({ sessionKey, options, session })
  }
  return out
}

/** One ASLEEP owner conversation (#1226): a durable registry row with no live child. */
export interface AsleepConversation {
  sessionKey: string
  sessionId: string
  /** The credential the pool key was built from (`_nocred` when none). */
  credentialId: string
  asleepAt: number
}

/**
 * The scope's ASLEEP owner conversations, newest first, read from the DURABLE registry
 * (#1226) — so a wake after a gateway restart still keys the slept credential and
 * `--resume`s the conversation instead of trusting process memory.
 *
 * A row counts only when it is a project parent (`cc-agent-*`), carries `asleep_at`, has
 * a resumable session, has NO live-child fact (pid, pane handle, claim) and its recorded
 * conversation scope is EXACTLY `conversationProjectId` (null is General; the literal
 * `general` project is its own scope; an unrecorded scope never matches). Read-only.
 */
export function readAsleepConversations(
  registryPath: string,
  conversationProjectId: string | null,
): { kind: 'answered'; rows: AsleepConversation[] } | { kind: 'unreadable'; reason: string } {
  const state = readRegistryState(registryPath)
  if (state.kind === 'absent') return { kind: 'answered', rows: [] }
  if (state.kind === 'unreadable') return { kind: 'unreadable', reason: state.reason }
  const rows: AsleepConversation[] = []
  for (const [sessionKey, row] of Object.entries(state.registry)) {
    if (!sessionKey.startsWith(PROJECT_PARENT_INSTANCE_PREFIX) || typeof row.asleep_at !== 'number') continue
    if (!row.has_session || !row.sessionId || row.pid !== undefined || row.pane_handle !== undefined ||
        row.adoption_claim_by !== undefined) continue
    if (row.conversationProjectId === undefined || row.conversationProjectId !== conversationProjectId) continue
    const parts = sessionKey.split(SESSION_KEY_SEP)
    if (parts.length < 4 || !parts[3]) continue
    rows.push({ sessionKey, sessionId: row.sessionId, credentialId: parts[3], asleepAt: row.asleep_at })
  }
  return { kind: 'answered', rows: rows.sort((a, b) => b.asleepAt - a.asleepAt) }
}
