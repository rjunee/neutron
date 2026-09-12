/**
 * The reply sink's `/activity` route — the transport seam between the tool-tap hook
 * (a SEPARATE process, sharing no memory with the gateway) and the in-process
 * inspector buffer.
 *
 * Drives the real loopback sink over HTTP, exactly as the hook does. Asserts the
 * token gate, the late-bound-tap contract (503 when nothing is wired, so an LLM-less
 * boot degrades to "no tool rows" rather than an error), input validation, and — the
 * one that matters operationally — that a THROWING recorder returns 200 so the
 * inspector can never surface as a failed tool call to the agent.
 *
 * EVERY CASE NOW POSTS AS A REGISTERED SESSION. It used to post `session_id:
 * 'no-such-session'` and assert a 200 with the General scope, on the reasoning that
 * losing an activity row is worse than mis-scoping one. That trade was made when the
 * sink token died with the gateway process; ISSUES #537 made the token durable, so an
 * unregistered session id is no longer "a row we might as well keep" — it is an
 * orphaned child from a previous incarnation, or a forged id. The route is gated on a
 * live session now, and the denial is asserted at the bottom of this file.
 */

import { afterEach, describe, expect, it } from 'bun:test'

import { getReplSinkInfo, setReplActivityTap, type ReplActivityTap } from '../repl-sink.ts'
import { sink } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'

interface Tapped {
  project_id: string | null
  phase: 'pre' | 'post'
  tool_name: string
  detail: string
}

const info = await getReplSinkInfo()

/**
 * A session this gateway is driving, plus THE CREDENTIAL THAT CHILD WOULD PRESENT.
 * The route authorizes credential → session now, so posting the instance root token
 * with a known session id is exactly the orphan shape and is refused; a test standing
 * in for the child has to hold the child's own value.
 */
const LIVE_SESSION_ID = 'activity-route-live-session'
let liveCredential = ''
function registerLiveSession(projectId?: string): void {
  const session = new ReplSession('k', 'gen', LIVE_SESSION_ID, 'chan', '/tmp')
  if (projectId !== undefined) session.projectId = projectId
  sink.register(LIVE_SESSION_ID, session)
  liveCredential = sink.credentialFor(session)
}

async function post(body: unknown, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${info.port}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sink-Token': token ?? liveCredential },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  setReplActivityTap(undefined)
  sink.unregister(LIVE_SESSION_ID)
  liveCredential = ''
})

describe('sink /activity route', () => {
  it('dispatches a valid POST to the wired tap', async () => {
    const seen: Tapped[] = []
    const tap: ReplActivityTap = (i) => void seen.push(i as Tapped)
    setReplActivityTap(tap)

    registerLiveSession()
    const res = await post({
      session_id: LIVE_SESSION_ID,
      phase: 'pre',
      tool_name: 'Bash',
      detail: 'bun test',
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.phase).toBe('pre')
    expect(seen[0]?.tool_name).toBe('Bash')
    expect(seen[0]?.detail).toBe('bun test')
    // A session with no project scope records against the General scope (null
    // project); the scope comes from the REGISTERED session now, never from a
    // lookup that could miss.
    expect(seen[0]?.project_id).toBeNull()
  })

  it('503s when no tap is wired (LLM-less / board-less boot)', async () => {
    registerLiveSession()
    const res = await post({ session_id: LIVE_SESSION_ID, phase: 'pre', tool_name: 'Bash' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'no-tap' })
  })

  it('rejects a bad or missing sink token', async () => {
    setReplActivityTap(() => {})
    const res = await post({ session_id: LIVE_SESSION_ID, phase: 'pre', tool_name: 'Bash' }, 'wrong-token')
    expect(res.status).not.toBe(200)
  })

  it('400s on a missing/unknown phase or an empty tool name', async () => {
    registerLiveSession()
    const seen: Tapped[] = []
    setReplActivityTap((i) => void seen.push(i as Tapped))
    expect((await post({ session_id: LIVE_SESSION_ID, tool_name: 'Bash' })).status).toBe(400)
    expect((await post({ session_id: LIVE_SESSION_ID, phase: 'nope', tool_name: 'Bash' })).status).toBe(400)
    expect((await post({ session_id: LIVE_SESSION_ID, phase: 'pre', tool_name: '' })).status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('defaults a missing detail to the empty string', async () => {
    registerLiveSession()
    const seen: Tapped[] = []
    setReplActivityTap((i) => void seen.push(i as Tapped))
    await post({ session_id: LIVE_SESSION_ID, phase: 'post', tool_name: 'Read' })
    expect(seen[0]?.detail).toBe('')
  })

  it('returns 200 when the recorder THROWS — never an HTTP fault at the agent', async () => {
    registerLiveSession()
    setReplActivityTap(() => {
      throw new Error('buffer exploded')
    })
    const res = await post({ session_id: LIVE_SESSION_ID, phase: 'pre', tool_name: 'Bash' })
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: 'error' })
  })

  it('identity-guarded clear does not null a DIFFERENT live tap', async () => {
    registerLiveSession()
    const { clearReplActivityTapIf } = await import('../repl-sink.ts')
    const live: ReplActivityTap = () => {}
    const stale: ReplActivityTap = () => {}
    setReplActivityTap(live)
    clearReplActivityTapIf(stale) // an older graph's teardown
    expect((await post({ session_id: LIVE_SESSION_ID, phase: 'pre', tool_name: 'Bash' })).status).toBe(200)
    clearReplActivityTapIf(live) // its own teardown
    expect((await post({ session_id: LIVE_SESSION_ID, phase: 'pre', tool_name: 'Bash' })).status).toBe(503)
  })
})
