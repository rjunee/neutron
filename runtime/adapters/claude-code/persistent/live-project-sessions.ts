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
}

/** {@link liveProjectSessions} narrowed by the pool's exact-identity rule, over
 *  every pool value naming the scope (General is `'general'` OR absent in the pool,
 *  so a General caller passes both). Never awaits an unsettled spawn: a pending
 *  entry is `unresolved`, not waited on. */
export async function resolveLiveProjectSessions(
  poolProjectIds: ReadonlyArray<string | undefined>,
): Promise<ResolvedProjectSessions> {
  const out: ResolvedProjectSessions = { live: [], unresolved: 0 }
  const candidates = [...supervisedBySessionKey].filter(([, options]) =>
    poolProjectIds.includes(options.project_id) && options.substrate_instance_id.startsWith(PROJECT_PARENT_INSTANCE_PREFIX))
  for (const [sessionKey, options] of candidates) {
    const pending = pool.get(sessionKey)
    if (pending === undefined || Bun.peek.status(pending) !== 'fulfilled') {
      // No pool entry at all is a supervised row whose child is gone; still not absence.
      out.unresolved += 1
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
