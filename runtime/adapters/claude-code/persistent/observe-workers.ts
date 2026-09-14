import { resolve } from 'node:path'
import { sink } from './pool-state.ts'
import { observeWorkerScreen, type WorkerObservation } from './worker-observation.ts'
import type { ReplSession } from './repl-session.ts'

/** Observe exact worktree ownership, never a shared launcher's state. The caller
 * supplies all known worktree paths for one run. No attach, keypress or signal. */
export async function observeWorkers(
  worktrees: readonly string[],
  sessions: readonly ReplSession[] = sink.registeredSessions(),
): Promise<WorkerObservation> {
  const paths = new Set(worktrees.map((p) => resolve(p)))
  const matches = sessions.filter((s) => paths.has(resolve(s.cwd)))
  const observations = await Promise.all(matches.map(observeSession))
  const blocked = observations.find((o) => o.state === 'blocked')
  if (blocked) return blocked
  // One working sibling cannot establish that every worker can proceed.
  if (observations.length > 0 && observations.every((o) => o.state === 'working')) return observations[0]!
  return {
    state: 'unknown', observed_at: new Date().toISOString(),
    detail: observations.length ? observations.map((o) => o.detail).join('; ') : 'no observed session owns these worktrees',
    screen: observations.map((o) => o.screen).join('\n').slice(-8000),
  }
}

/** A hung capture transport must not hang the orchestrator observing it. */
export async function observeSession(session: ReplSession): Promise<WorkerObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let o = observeWorkerScreen(session.ring.text(), false)
  o.detail += `; retained_output_at=${new Date(session.lastDataAt).toISOString()}`
  try {
    if (!session.hasChildExited() && session.child.readScreen !== undefined) {
      const screen = await Promise.race([
        session.child.readScreen(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('capture deadline')), 2000)
        }),
      ])
      o = observeWorkerScreen(screen, true)
    }
  } catch {
    o = { ...o, detail: `current screen unavailable; ${o.detail}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return { ...o, detail: `session=${session.sessionId}; ${o.detail}` }
}
