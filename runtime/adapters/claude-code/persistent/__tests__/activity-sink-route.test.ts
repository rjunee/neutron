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
 */

import { afterEach, describe, expect, it } from 'bun:test'

import { getReplSinkInfo, setReplActivityTap, type ReplActivityTap } from '../repl-sink.ts'

interface Tapped {
  project_id: string | null
  phase: 'pre' | 'post'
  tool_name: string
  detail: string
}

const info = getReplSinkInfo()

async function post(body: unknown, token = info.token): Promise<Response> {
  return fetch(`http://127.0.0.1:${info.port}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sink-Token': token },
    body: JSON.stringify(body),
  })
}

afterEach(() => setReplActivityTap(undefined))

describe('sink /activity route', () => {
  it('dispatches a valid POST to the wired tap', async () => {
    const seen: Tapped[] = []
    const tap: ReplActivityTap = (i) => void seen.push(i as Tapped)
    setReplActivityTap(tap)

    const res = await post({
      session_id: 'no-such-session',
      phase: 'pre',
      tool_name: 'Bash',
      detail: 'bun test',
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.phase).toBe('pre')
    expect(seen[0]?.tool_name).toBe('Bash')
    expect(seen[0]?.detail).toBe('bun test')
    // An unregistered session degrades to the General scope (null project) rather
    // than 404ing — losing an activity row is worse than mis-scoping one, and this
    // mirrors the pre-existing `/tool-call` degradation.
    expect(seen[0]?.project_id).toBeNull()
  })

  it('503s when no tap is wired (LLM-less / board-less boot)', async () => {
    const res = await post({ session_id: 's', phase: 'pre', tool_name: 'Bash' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'no-tap' })
  })

  it('rejects a bad or missing sink token', async () => {
    setReplActivityTap(() => {})
    const res = await post({ session_id: 's', phase: 'pre', tool_name: 'Bash' }, 'wrong-token')
    expect(res.status).not.toBe(200)
  })

  it('400s on a missing/unknown phase or an empty tool name', async () => {
    const seen: Tapped[] = []
    setReplActivityTap((i) => void seen.push(i as Tapped))
    expect((await post({ session_id: 's', tool_name: 'Bash' })).status).toBe(400)
    expect((await post({ session_id: 's', phase: 'nope', tool_name: 'Bash' })).status).toBe(400)
    expect((await post({ session_id: 's', phase: 'pre', tool_name: '' })).status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('defaults a missing detail to the empty string', async () => {
    const seen: Tapped[] = []
    setReplActivityTap((i) => void seen.push(i as Tapped))
    await post({ session_id: 's', phase: 'post', tool_name: 'Read' })
    expect(seen[0]?.detail).toBe('')
  })

  it('returns 200 when the recorder THROWS — never an HTTP fault at the agent', async () => {
    setReplActivityTap(() => {
      throw new Error('buffer exploded')
    })
    const res = await post({ session_id: 's', phase: 'pre', tool_name: 'Bash' })
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: 'error' })
  })

  it('identity-guarded clear does not null a DIFFERENT live tap', async () => {
    const { clearReplActivityTapIf } = await import('../repl-sink.ts')
    const live: ReplActivityTap = () => {}
    const stale: ReplActivityTap = () => {}
    setReplActivityTap(live)
    clearReplActivityTapIf(stale) // an older graph's teardown
    expect((await post({ session_id: 's', phase: 'pre', tool_name: 'Bash' })).status).toBe(200)
    clearReplActivityTapIf(live) // its own teardown
    expect((await post({ session_id: 's', phase: 'pre', tool_name: 'Bash' })).status).toBe(503)
  })
})
