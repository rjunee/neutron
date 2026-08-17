/**
 * A PROJECT SWITCH DOES NOT WAIT ON THE STORE.
 *
 * ── WHAT WAS ACTUALLY MEASURED ───────────────────────────────────────────────
 * 47 real `project_switch` samples from the owner's client diagnostics read
 * `transcript_read` median 3283 ms / p90 6614 ms against `vm_published` median
 * 3 ms, which says "rendering is instant, the store read is the whole cost".
 * Both halves of that reading are wrong, and measuring the pieces separately is
 * what showed it:
 *
 *   • THE READ IS NOT SLOW. `session.messages()` + `session.pendingCount()` over
 *     a 12-topic × 533-message OPFS-backed store: median 0.1 ms, p90 0.4 ms, max
 *     1.0 ms — and 0.2 ms with a 60-upsert write burst in flight. OPFS is not in
 *     the read path at all: `chat-core/stores/opfs-store.ts:113-115` delegates
 *     `list()` straight to the in-memory index, and the only OPFS reads are the
 *     one-shot `hydrate()` at boot (184 ms for a 3.8 MB snapshot) and the
 *     snapshot writes.
 *
 *   • THE MARK CHARGES THE READ FOR THE MAIN THREAD IT WAITED ON.
 *     `transcript_read` is stamped after an `await` (`controller.ts`), and React
 *     flushes the render caused by the preceding `publish()` synchronously inside
 *     the click. Measured through React's synthetic discrete-event path, a 250 ms
 *     render put `render_ended` at 256.6 ms and `transcript_read` at 257.6 ms
 *     while `vm_published` reported 0.2 ms. The same probe wired to a NON-React
 *     listener (so React defers) reports `transcript_read` 1.8 ms for the same
 *     250 ms render — i.e. the probe can distinguish the two, and through React
 *     the render is inside the window.
 *
 * ⇒ the switch's cost is the render, and the transcript arrives in a SECOND
 * render queued behind the first. So the fix is not a faster read; it is not
 * having an empty frame to render at all.
 *
 * ── WHAT THESE TESTS PIN ─────────────────────────────────────────────────────
 * 1. The FIRST frame published by a switch into an already-visited project
 *    carries that project's transcript (it used to be empty, always).
 * 2. That frame is published even when the store read never resolves — the
 *    switch is off the store's critical path.
 * 3. The session-changed-underfoot guard still holds: a slow read for the topic
 *    the owner LEFT cannot clobber the topic they entered, and cannot route the
 *    old topic's read receipts through the new project's session.
 * 4. Nothing serves one project's messages into another's frame.
 */

import { describe, expect, it } from 'bun:test'

import { NeutronChatController, type ControllerSession, type ChatViewModel } from '../controller.ts'
import type { SwitchRecord } from '../switch-timing.ts'
import type { ChatMessage } from '@neutronai/chat-core'

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

function msg(topic: string, i: number, role: 'user' | 'agent' = 'agent'): ChatMessage {
  return {
    topic_id: topic,
    client_msg_id: `cmid-${topic}-${i}`,
    message_id: `mid-${topic}-${i}`,
    seq: i,
    role,
    project_id: null,
    attachments: null,
    transcript: null,
    body: `${topic} message ${i}`,
    created_at: i,
    status: 'acked',
    delivered_to: null,
    read_by: null,
    reactions: null,
    reactions_rev: null,
    edited_at: null,
    deleted: false,
    edit_rev: null,
  } as ChatMessage
}

/** A session whose store read can be held open, per topic. */
class StallableSession implements ControllerSession {
  rows: ChatMessage[] = []
  pending = 0
  /** Set to hold `messages()` open; resolve with `release()`. */
  stalled = false
  readonly readsRead: string[][] = []
  private waiters: Array<() => void> = []

  constructor(readonly topicId: string) {}

  start(): void {}
  stop(): void {}
  setActive(): void {}
  status(): 'open' {
    return 'open'
  }
  async send(): Promise<void> {}
  async messages(): Promise<ChatMessage[]> {
    if (this.stalled) await new Promise<void>((r) => this.waiters.push(r))
    return this.rows.map((m) => ({ ...m }))
  }
  async pendingCount(): Promise<number> {
    return this.pending
  }
  markRead(ids: readonly string[]): void {
    this.readsRead.push([...ids])
  }
  release(): void {
    this.stalled = false
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }
}

function setup(): {
  controller: NeutronChatController
  sessions: Map<string, StallableSession>
  frames: ChatViewModel[]
  records: SwitchRecord[]
} {
  const sessions = new Map<string, StallableSession>()
  const frames: ChatViewModel[] = []
  const records: SwitchRecord[] = []
  const controller = new NeutronChatController({
    projectId: null,
    projects: [
      { id: 'alpha', label: 'Alpha' },
      { id: 'beta', label: 'Beta' },
    ],
    topicForProject: (p) => (p === null ? 'app:owner' : `app:owner:${p}`),
    switchTimingEmit: (r) => records.push(r),
    createSession: (_sinks, scope) => {
      const existing = sessions.get(scope.topicId)
      if (existing !== undefined) return existing
      const s = new StallableSession(scope.topicId)
      sessions.set(scope.topicId, s)
      return s
    },
  })
  controller.subscribe((vm) => frames.push(vm))
  return { controller, sessions, frames, records }
}

/** Visit a project once so its transcript is known, then leave. */
async function visit(
  controller: NeutronChatController,
  sessions: Map<string, StallableSession>,
  projectId: string | null,
  topicId: string,
  rows: ChatMessage[],
  pending = 0,
): Promise<void> {
  controller.setProject(projectId)
  await tick()
  const s = sessions.get(topicId)
  if (s === undefined) throw new Error(`no session for ${topicId}`)
  s.rows = rows
  s.pending = pending
  // A live change (an inbound frame) is what refreshes the controller's read.
  await (controller as unknown as { handleChange(): Promise<void> }).handleChange()
}

describe('a project switch does not block on the store read', () => {
  it('THE FIRST FRAME OF A RE-ENTERED PROJECT ALREADY CARRIES ITS TRANSCRIPT', async () => {
    // Before the fix `setProject` published `msgs: []` and waited for the awaited
    // read to bring the transcript back, so the switch rendered an empty thread
    // first and the real one second. This is the assertion that failed.
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [
      msg('app:owner:alpha', 1),
      msg('app:owner:alpha', 2),
    ])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    frames.length = 0
    controller.setProject('alpha')
    // THE FIRST frame — synchronous with the click, before any await resolves.
    const first = frames[0]
    expect(first).toBeDefined()
    expect(first!.projectId).toBe('alpha')
    expect(first!.messages.map((m) => m.text)).toEqual([
      'app:owner:alpha message 1',
      'app:owner:alpha message 2',
    ])
  })

  it('publishes that frame even when the store read NEVER resolves', async () => {
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 7)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    // Hold the store open for the whole switch. If the transcript's arrival
    // depended on the read, this frame would be empty and stay empty.
    sessions.get('app:owner:alpha')!.stalled = true
    frames.length = 0
    controller.setProject('alpha')
    expect(frames[0]!.messages.map((m) => m.text)).toEqual(['app:owner:alpha message 7'])
    await tick()
    await tick()
    // Still no read has resolved, and the transcript is still on screen.
    expect(controller.getViewModel().messages).toHaveLength(1)
    sessions.get('app:owner:alpha')!.release()
  })

  it('carries the pending-send count too, so the badge does not blink to zero', async () => {
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)], 3)
    await visit(controller, sessions, 'beta', 'app:owner:beta', [])

    frames.length = 0
    controller.setProject('alpha')
    expect(frames[0]!.pending).toBe(3)
  })

  it('NEVER serves one project’s messages into another’s frame', async () => {
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    frames.length = 0
    controller.setProject('alpha')
    controller.setProject('beta')
    for (const f of frames) {
      const texts = f.messages.map((m) => m.text)
      if (f.projectId === 'beta') expect(texts).not.toContain('app:owner:alpha message 1')
      if (f.projectId === 'alpha') expect(texts).not.toContain('app:owner:beta message 1')
    }
    // General is its own topic and starts unknown — it must not inherit either.
    controller.setProject(null)
    expect(controller.getViewModel().messages).toHaveLength(0)
  })

  it('a first-ever visit publishes empty and fills from the read', async () => {
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])

    frames.length = 0
    controller.setProject('beta')
    expect(frames[0]!.messages).toHaveLength(0)
    sessions.get('app:owner:beta')!.rows = [msg('app:owner:beta', 1)]
    await (controller as unknown as { handleChange(): Promise<void> }).handleChange()
    expect(controller.getViewModel().messages.map((m) => m.text)).toEqual([
      'app:owner:beta message 1',
    ])
  })
})

describe('the session-changed-underfoot guard still holds', () => {
  it('A STALE READ CANNOT CLOBBER THE TOPIC THE OWNER ENTERED', async () => {
    const { controller, sessions } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    // Enter alpha, stall its read, then leave for beta before it resolves.
    const alpha = sessions.get('app:owner:alpha')!
    alpha.stalled = true
    alpha.rows = [msg('app:owner:alpha', 1), msg('app:owner:alpha', 2)]
    controller.setProject('alpha')
    const inFlight = (controller as unknown as { handleChange(): Promise<void> }).handleChange()
    controller.setProject('beta')
    alpha.release()
    await inFlight
    await tick()

    const vm = controller.getViewModel()
    expect(vm.projectId).toBe('beta')
    expect(vm.messages.map((m) => m.text)).toEqual(['app:owner:beta message 1'])
  })

  it('and cannot route the OLD topic’s read receipts through the new session', async () => {
    const { controller, sessions } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [])

    const alpha = sessions.get('app:owner:alpha')!
    const beta = sessions.get('app:owner:beta')!
    alpha.stalled = true
    alpha.rows = [msg('app:owner:alpha', 9)]
    controller.setProject('alpha')
    const inFlight = (controller as unknown as { handleChange(): Promise<void> }).handleChange()
    controller.setProject('beta')
    beta.readsRead.length = 0
    alpha.release()
    await inFlight
    await tick()

    // Beta's session must never be handed alpha's message ids.
    expect(beta.readsRead.flat()).not.toContain('mid-app:owner:alpha-9')
  })

  it('the stale read is still FILED under its own topic, so re-entry is instant', async () => {
    // The guard drops the read from the VIEW; it must not drop it from the cache,
    // else the topic the owner just left goes back to painting empty.
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [])

    const alpha = sessions.get('app:owner:alpha')!
    alpha.stalled = true
    alpha.rows = [msg('app:owner:alpha', 1), msg('app:owner:alpha', 2)]
    controller.setProject('alpha')
    const inFlight = (controller as unknown as { handleChange(): Promise<void> }).handleChange()
    controller.setProject('beta')
    alpha.release()
    await inFlight

    frames.length = 0
    controller.setProject('alpha')
    expect(frames[0]!.messages.map((m) => m.text)).toEqual([
      'app:owner:alpha message 1',
      'app:owner:alpha message 2',
    ])
  })
})

describe('the switch stopwatch can no longer blame the store for the render', () => {
  it('reports frame_rendered, so a slow paint is attributable', async () => {
    const { controller, sessions, records } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    records.length = 0
    controller.setProject('beta')
    // rAF is absent under bun; the controller falls back to a task.
    await new Promise((r) => setTimeout(r, 20))
    controller.setProject('alpha')
    await new Promise((r) => setTimeout(r, 20))

    expect(records.length).toBeGreaterThan(0)
    const seen = records.some((r) => r.marks.frame_rendered !== undefined)
    expect(seen).toBe(true)
  })
})
