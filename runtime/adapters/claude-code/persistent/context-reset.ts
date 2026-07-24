// persistent/context-reset.ts — the `/reset` chat-command runtime primitive.
//
// Actuate CONTEXT_RESET_COMMAND (`/clear`) against the LIVE warm pooled cc-agent
// REPL for a conversation, clearing the MODEL's transcript while the underlying
// `claude` process (its MCP servers / dev-channel / system prompt) stays alive
// and keeps serving subsequent turns. This is the SAME mechanism the per-turn
// import warm-session reset uses (`pool.ts:372-402`), lifted into a standalone,
// gateway-invocable primitive for the user-facing `/reset` command.
//
// WHY NOT a respawn: `respawnSupervisedSession` (`supervision.ts`) ALWAYS
// `--resume`s the same transcript (`session-respawn.ts` — "respawn is always
// resume"), so it PRESERVES context — the wrong primitive for a reset. `/clear`
// is the context-wiping actuation.
//
// The reset runs UNDER the session's `acquireTurn()` mutex so it can never race
// a live in-flight turn's inject. A reset that arrives mid-turn waits up to
// `acquire_wait_ms` for the turn to settle; if it is still busy it reports `busy`
// and writes NOTHING — and it self-releases the abandoned mutex slot so a later
// turn is never wedged.

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { pool } from './pool-state.ts'
import type { ReplSession } from './repl-session.ts'
import {
  CONTEXT_RESET_COMMAND,
  DEFAULT_IDLE_MAX_MS,
  DEFAULT_IDLE_QUIET_MS,
  SESSION_KEY_SEP,
} from './signatures.ts'
import { waitForReplIdle } from './spawn.ts'

/** Default bound the reset waits for an in-flight turn to settle before it gives
 *  up and reports `busy`. Comfortably above `DEFAULT_IDLE_MAX_MS` (6 s) — the
 *  longest a settling turn holds the mutex during its own post-reply idle wait —
 *  so a reset arriving just as a turn finishes still gets the slot. */
const DEFAULT_ACQUIRE_WAIT_MS = 8_000

export interface ResetPooledContextInput {
  substrate_instance_id: string
  user_id: string
  /** Live project scope dimension of the pool key (`'general'` for the General chat). */
  project_scope: string
  /** How long to wait for an in-flight turn to settle before reporting `busy`.
   *  Default {@link DEFAULT_ACQUIRE_WAIT_MS} (8 s). */
  acquire_wait_ms?: number
  /** PTY-quiet floor the reset waits for before/after writing `/clear`.
   *  Default `DEFAULT_IDLE_QUIET_MS` (`signatures.ts`). */
  idle_quiet_ms?: number
  /** Cap on the idle wait. Default `DEFAULT_IDLE_MAX_MS` (`signatures.ts`). */
  idle_max_ms?: number
}

export type ResetPooledContextOutcome =
  | { ok: true; sessions_reset: number }
  | { ok: false; reason: 'no_live_session' | 'busy' | 'reset_failed'; detail?: string }

/**
 * Clear the model context of the live warm REPL(s) for a conversation.
 *
 * Pool-key match: the key is `[instance, user, project, credential].join(NUL)`
 * (`poolKeyFor`); the credential dimension is resolved per-dispatch, so we
 * WILDCARD it — matching every pooled session whose key starts with
 * `[instance, user, project_scope].join(NUL) + NUL`. The trailing NUL guarantees
 * the 3-dim prefix can never false-match a legacy 2-dim key (which carries only
 * one NUL total).
 *
 * Outcomes:
 *  - `{ ok: true, sessions_reset }`   — one `/clear\r` written per live session.
 *  - `{ ok: false, reason: 'no_live_session' }` — nothing warm to clear.
 *  - `{ ok: false, reason: 'busy' }`  — a turn is still in flight; NOTHING written.
 *  - `{ ok: false, reason: 'reset_failed', detail }` — the actuation threw.
 */
export async function resetPooledSessionContext(
  input: ResetPooledContextInput,
): Promise<ResetPooledContextOutcome> {
  const waitMs = input.acquire_wait_ms ?? DEFAULT_ACQUIRE_WAIT_MS
  const quietMs = input.idle_quiet_ms ?? DEFAULT_IDLE_QUIET_MS
  const maxMs = input.idle_max_ms ?? DEFAULT_IDLE_MAX_MS
  const prefix =
    [input.substrate_instance_id, input.user_id, input.project_scope].join(SESSION_KEY_SEP) +
    SESSION_KEY_SEP

  // Collect the pooled session PROMISES whose key matches the (instance, user,
  // project) prefix — credential wildcarded. `pool` is `Map<string, Promise<…>>`.
  const matched: Array<Promise<ReplSession>> = []
  for (const [key, sessionP] of pool) {
    if (key.startsWith(prefix)) matched.push(sessionP)
  }
  if (matched.length === 0) return { ok: false, reason: 'no_live_session' }

  // Resolve each — a still-spawning promise that REJECTED is skipped (no live
  // session), and an already-exited child is skipped (nothing to clear).
  const live: ReplSession[] = []
  for (const sessionP of matched) {
    let session: ReplSession
    try {
      session = await sessionP
    } catch {
      continue
    }
    if (session.hasChildExited()) continue
    live.push(session)
  }
  if (live.length === 0) return { ok: false, reason: 'no_live_session' }

  let resetCount = 0
  for (const session of live) {
    // BOUNDED acquire: `acquireTurn()` enqueues the slot SYNCHRONOUSLY on call, so
    // once we've called it the slot WILL eventually be granted. Race it against a
    // timeout — if the timeout wins we must NOT drop the (still-queued) grant on
    // the floor: self-release it when it lands, else the session's turn mutex
    // wedges forever (every later `acquireTurn` awaits a `prev` that never
    // resolves). Nothing is written on the busy path.
    const acquireP = session.acquireTurn()
    const granted = await Promise.race([
      acquireP.then(() => true),
      Bun.sleep(waitMs).then(() => false),
    ])
    if (!granted) {
      fireAndForget(
        'context-reset.selfReleaseAbandonedSlot',
        acquireP.then((release) => release()),
      )
      return { ok: false, reason: 'busy' }
    }

    const release = await acquireP
    try {
      // Re-check liveness under the mutex — the child could have exited while we
      // waited for the slot.
      if (session.hasChildExited()) continue
      // The pool.ts:378-385 sequence verbatim: settle idle, write `/clear`, force
      // a beat so the idle wait can't short-circuit before the TUI reacts, settle
      // idle again so the REPL is clean + at rest for the next turn.
      await waitForReplIdle(session, quietMs, maxMs)
      session.child.write(`${CONTEXT_RESET_COMMAND}\r`)
      await Bun.sleep(quietMs)
      await waitForReplIdle(session, quietMs, maxMs)
      resetCount += 1
    } catch (err) {
      return {
        ok: false,
        reason: 'reset_failed',
        detail: err instanceof Error ? err.message : String(err),
      }
    } finally {
      release()
    }
  }

  // Every match was skipped as dead under the mutex ⇒ nothing was actually
  // cleared; report honestly rather than a hollow ok:0.
  if (resetCount === 0) return { ok: false, reason: 'no_live_session' }
  return { ok: true, sessions_reset: resetCount }
}
