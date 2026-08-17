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
  /** Deliver a server frame through the session the controller is holding. */
  deliver: (topicId: string, frame: unknown) => void
} {
  const sessions = new Map<string, StallableSession>()
  const sinks = new Map<string, (frame: unknown) => void>()
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
    createSession: (sessionSinks, scope) => {
      sinks.set(scope.topicId, sessionSinks.onFrame)
      const existing = sessions.get(scope.topicId)
      if (existing !== undefined) return existing
      const s = new StallableSession(scope.topicId)
      sessions.set(scope.topicId, s)
      return s
    },
  })
  controller.subscribe((vm) => frames.push(vm))
  const deliver = (topicId: string, frame: unknown): void => {
    const onFrame = sinks.get(topicId)
    if (onFrame === undefined) throw new Error(`no frame sink for ${topicId}`)
    onFrame(frame)
  }
  return { controller, sessions, frames, records, deliver }
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
    // Every assertion below lives inside a per-project guard, so a run that
    // published NO frames would satisfy all of them vacuously. Prove there was
    // something to check first.
    expect(frames.filter((f) => f.projectId === 'alpha').length).toBeGreaterThan(0)
    expect(frames.filter((f) => f.projectId === 'beta').length).toBeGreaterThan(0)
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

describe('rows that are painted are rows that are read', () => {
  it('SENDS THE READ RECEIPT FOR CACHED ROWS WITHOUT WAITING ON THE STORE', async () => {
    // The receipt used to be sent only from the resolved read, which was fine
    // while the switch had nothing on screen until then. Now the agent messages
    // are visibly painted in the first frame — so a stalled read leaves rows the
    // owner is looking at unacknowledged, the server watermark never advances, and
    // its next `projects_changed` restores the unread badge this switch cleared.
    const { controller, sessions } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [
      msg('app:owner:alpha', 1),
      msg('app:owner:alpha', 2),
    ])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    const alpha = sessions.get('app:owner:alpha')!
    // Hold the store open for the whole switch: any receipt that arrives is one
    // the read did not deliver.
    alpha.stalled = true
    alpha.readsRead.length = 0
    controller.setProject('alpha')

    expect(alpha.readsRead.flat()).toEqual(['mid-app:owner:alpha-1', 'mid-app:owner:alpha-2'])
    alpha.release()
  })

  it('routes those receipts through the ENTERED project’s session, never the one left', async () => {
    // The invariant the underfoot guard exists for, on the new synchronous path.
    const { controller, sessions } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 5)])

    const alpha = sessions.get('app:owner:alpha')!
    const beta = sessions.get('app:owner:beta')!
    alpha.stalled = true
    beta.stalled = true
    alpha.readsRead.length = 0
    beta.readsRead.length = 0
    controller.setProject('alpha')

    expect(alpha.readsRead.flat()).toContain('mid-app:owner:alpha-1')
    expect(beta.readsRead.flat()).not.toContain('mid-app:owner:alpha-1')
    alpha.release()
    beta.release()
  })

  it('reports only agent rows, so a receipt cannot light the owner’s own read tick', async () => {
    const { controller, sessions } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [
      msg('app:owner:alpha', 1, 'user'),
      msg('app:owner:alpha', 2, 'agent'),
    ])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [])

    const alpha = sessions.get('app:owner:alpha')!
    alpha.stalled = true
    alpha.readsRead.length = 0
    controller.setProject('alpha')

    expect(alpha.readsRead.flat()).toEqual(['mid-app:owner:alpha-2'])
    alpha.release()
  })
})

describe('the cache has a lifecycle, not just a size', () => {
  it('A DELETED PROJECT CANNOT PAINT ITS HISTORY INTO A RECREATED ONE', async () => {
    // `topicForProject` is a pure function of (userId, projectId), so a project
    // deleted and recreated under the same id maps to the SAME topic — keying the
    // cache by topic buys nothing against that, whatever the docblock used to
    // claim. The `projects_changed` frame that reports the deletion is what
    // invalidates it.
    const { controller, sessions, frames, deliver } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    // Alpha is deleted while the owner sits in beta.
    deliver('app:owner:beta', {
      v: 1,
      type: 'projects_changed',
      projects: [{ id: 'beta', label: 'Beta' }],
      ts: 1,
    })
    // Recreated under the same id — and its store is empty, as a new project's is.
    deliver('app:owner:beta', {
      v: 1,
      type: 'projects_changed',
      projects: [{ id: 'beta', label: 'Beta' }, { id: 'alpha', label: 'Alpha (new)' }],
      ts: 2,
    })
    sessions.get('app:owner:alpha')!.rows = []

    frames.length = 0
    controller.setProject('alpha')
    expect(frames[0]!.messages).toHaveLength(0)
  })

  it('keeps General and the active project, which are never deletions', async () => {
    // The invalidation is driven by "absent from the rail". General is never on
    // the rail and the active topic is never gone, so a naive check would evict
    // both on every frame — a control that fails if the guard is dropped.
    const { controller, sessions, frames, deliver } = setup()
    await visit(controller, sessions, null, 'app:owner', [msg('app:owner', 1)])
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])

    deliver('app:owner:alpha', {
      v: 1,
      type: 'projects_changed',
      projects: [{ id: 'beta', label: 'Beta' }],
      ts: 1,
    })

    frames.length = 0
    controller.setProject(null)
    expect(frames[0]!.messages.map((m) => m.text)).toEqual(['app:owner message 1'])
    frames.length = 0
    controller.setProject('alpha')
    expect(frames[0]!.messages.map((m) => m.text)).toEqual(['app:owner:alpha message 1'])
  })

  it('stop() drops every cached transcript — a stopped controller holds no chat', async () => {
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    controller.stop()
    sessions.get('app:owner:alpha')!.stalled = true
    frames.length = 0
    controller.setProject('alpha')
    expect(frames[0]!.messages).toHaveLength(0)
    sessions.get('app:owner:alpha')!.release()
  })

  it('orders by last USE, so the project the owner keeps returning to survives', async () => {
    // Written-once entries used to outrank read-many ones, because only the write
    // side re-inserted. Fill the cache past its limit by writing, while re-reading
    // one entry — and STALL that one's store so the read is the only thing that
    // can be touching it. Without read-side recency alpha's last touch stays its
    // first write, and 30 fillers past a 24-entry limit evict it.
    const { controller, sessions, frames } = setup()
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    const alpha = sessions.get('app:owner:alpha')!
    alpha.stalled = true
    for (let i = 0; i < 30; i++) {
      const id = `filler-${i}`
      await visit(controller, sessions, id, `app:owner:${id}`, [msg(`app:owner:${id}`, 1)])
      // Re-entering alpha is a READ of its entry, and nothing else: its own read
      // never resolves, so it can never re-write the entry.
      controller.setProject('alpha')
      expect(controller.getViewModel().messages.map((m) => m.text)).toEqual([
        'app:owner:alpha message 1',
      ])
    }

    frames.length = 0
    controller.setProject('filler-29')
    controller.setProject('alpha')
    expect(frames.at(-1)!.messages.map((m) => m.text)).toEqual(['app:owner:alpha message 1'])
    alpha.release()
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

  it('IS STAMPED AFTER THE FRAME, NOT INSIDE THE SWITCH THAT SCHEDULED IT', async () => {
    // ── WHY THIS TEST IS SHAPED LIKE THIS ────────────────────────────────────
    // The only assertion that existed for `frame_rendered` checked that the mark
    // was PRESENT. Presence is exactly what a broken implementation also has: a
    // review mutated `afterNextFrame` to call `fn()` directly — stamping the mark
    // synchronously, before any paint, which is the whole defect the mark exists
    // to detect — and every test still passed. A guard that cannot fail is not a
    // guard.
    //
    // What distinguishes a paint mark from a same-stack mark is WHEN it lands, and
    // that is asserted here WITHOUT comparing real elapsed time against a
    // threshold (ISSUES #438: such a bound measures the runner's load, not the
    // code). Instead the schedule is driven by hand — rAF is ours, and a second
    // `setProject` supersedes the timer, which flushes the record on demand. So
    // each assertion is "was the mark stamped by THIS point in the schedule",
    // which is the ordering property itself. Three mutations die on it:
    //
    //   fn()        → stamped inside the switch, before any frame   → fails
    //   raf(fn)     → stamped in the rAF callback, before the paint → fails
    //   raf(→ task) → stamped in the trailing task, after it        → passes
    //
    // The middle one matters on its own: a single rAF callback runs BEFORE that
    // frame's paint, so it would time the render and not the picture.
    const g = globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }
    const original = g.requestAnimationFrame
    let frameCb: (() => void) | null = null
    g.requestAnimationFrame = (cb: () => void): number => {
      frameCb = cb
      return 1
    }
    /**
     * Take the frame the switch just scheduled, asserting one exists. Reading
     * `frameCb` through a function is also what keeps it typed: at the call site
     * TypeScript narrows the outer `let` to `null`, because it cannot see that
     * `setProject` reaches the closure that assigns it.
     */
    const takeScheduledFrame = (): (() => void) => {
      if (frameCb === null) throw new Error('the switch scheduled no frame')
      const cb = frameCb
      frameCb = null
      return cb
    }
    try {
      const { controller, sessions, records } = setup()
      await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
      await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

      // (1) NO FRAME HAS HAPPENED. Switching away supersedes and flushes the
      // record, so whatever it carries now was stamped inside the switch.
      records.length = 0
      frameCb = null
      controller.setProject('alpha')
      takeScheduledFrame() // scheduled, deliberately never run
      controller.setProject('beta')
      const beforeFrame = records.find((r) => r.to === 'alpha')
      expect(beforeFrame).toBeDefined()
      expect(beforeFrame!.marks.frame_rendered).toBeUndefined()

      // (2) INSIDE THE rAF CALLBACK, which is before the paint. Run it, then
      // flush in the SAME task so the trailing task cannot have run yet.
      records.length = 0
      frameCb = null
      controller.setProject('alpha')
      takeScheduledFrame()()
      controller.setProject('beta')
      const duringFrame = records.find((r) => r.to === 'alpha')
      expect(duringFrame).toBeDefined()
      expect(duringFrame!.marks.frame_rendered).toBeUndefined()

      // (3) AFTER the trailing task — the first instant the frame is actually on
      // screen. This is the positive control: the mark does arrive, so (1) and (2)
      // are about ordering and not about a mark that never lands at all.
      records.length = 0
      frameCb = null
      controller.setProject('alpha')
      takeScheduledFrame()()
      await tick()
      await tick()
      const afterFrame = records.find((r) => r.to === 'alpha')
      expect(afterFrame).toBeDefined()
      expect(afterFrame!.marks.frame_rendered).toBeDefined()
    } finally {
      if (original === undefined) delete g.requestAnimationFrame
      else g.requestAnimationFrame = original
    }
  })

  it('CHARGES A SLOW RENDER TO THE RENDER, WHICH IS WHAT THE REPORT GOT WRONG', async () => {
    // ── THE DECOMPOSITION, ASSERTED ──────────────────────────────────────────
    // 47 real samples read `transcript_read` median 3283 ms against
    // `vm_published` median 3 ms, and the conclusion everyone drew from that —
    // "rendering is instant, the store read is the whole cost" — is wrong in both
    // halves. The reason lived only in a comment until this test: `vm_published`
    // is stamped INSIDE `publish()`, so it measures notifying subscribers and not
    // the render they perform, and `transcript_read` is stamped after an `await`
    // whose continuation cannot run until that render finishes.
    //
    // A fake clock makes it exact rather than approximate, and keeps the assertion
    // off real elapsed time (ISSUES #438). The ORDERING is what has to be faithful:
    // `publish()` only SCHEDULES React's render, and React flushes it synchronously
    // at the end of the discrete event — after `setProject` has returned, and
    // therefore before any microtask, which is where the awaited read resumes. So
    // the render is modelled as a scheduled cost the test flushes at exactly that
    // point. Advancing the clock inside the subscriber instead would put the render
    // inside `vm_published`, and the whole reason this bug was invisible is that it
    // is NOT there.
    let t = 0
    const sessions = new Map<string, StallableSession>()
    const records: SwitchRecord[] = []
    const controller = new NeutronChatController({
      projectId: null,
      projects: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }],
      topicForProject: (p) => (p === null ? 'app:owner' : `app:owner:${p}`),
      switchTimingEmit: (r) => records.push(r),
      switchTimingNow: () => t,
      createSession: (_sinks, scope) => {
        const existing = sessions.get(scope.topicId)
        if (existing !== undefined) return existing
        const s = new StallableSession(scope.topicId)
        sessions.set(scope.topicId, s)
        return s
      },
    })
    let renderScheduled = false
    controller.subscribe(() => {
      renderScheduled = true
    })
    /** React's discrete-event flush: synchronous, once, after the handler returns. */
    const flushRender = (): void => {
      if (!renderScheduled) return
      renderScheduled = false
      t += 250
    }
    await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
    await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])

    records.length = 0
    renderScheduled = false
    controller.setProject('alpha')
    flushRender()
    await tick()
    await tick()

    const r = records.find((rec) => rec.to === 'alpha')
    expect(r).toBeDefined()
    const vm = r!.marks.vm_published
    const read = r!.marks.transcript_read
    expect(vm).toBeDefined()
    expect(read).toBeDefined()
    // `vm_published` sees NONE of the render — it is stamped while the render is
    // merely scheduled. This is the "3 ms" half of the owner's report, and it is
    // why the instrument read as though painting were free.
    expect(vm!).toBe(0)
    // THE MISATTRIBUTION: the store read is instant here (the clock only advances
    // for renders), yet `transcript_read` carries a whole 250 ms render, because
    // the awaited continuation could not resume until the render finished. This is
    // the "3283 ms" half, and the two together are the false conclusion.
    expect(read!).toBeGreaterThanOrEqual(250)
    expect(read! - vm!).toBeGreaterThanOrEqual(250)
    // And the paint mark is what separates the two: it lands with the render, not
    // with the data, so `frame_rendered ≈ transcript_read` reads "the render is
    // the cost" instead of blaming the store.
    expect(r!.marks.frame_rendered).toBeDefined()
    expect(r!.marks.frame_rendered!).toBeGreaterThanOrEqual(read!)
  })

  it('does not hold the record open for a paint that a hidden tab never makes', async () => {
    // rAF does not run in a backgrounded tab, so the paint mark cannot arrive.
    // While it was REQUIRED that produced `Project switch incomplete …
    // never_arrived=frame_rendered` after the full deadline, for a switch that
    // completed correctly. Absent rAF entirely, so nothing schedules the stamp.
    const g = globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }
    const original = g.requestAnimationFrame
    g.requestAnimationFrame = (): number => 1 // accepted, never called: no frames here
    try {
      const { controller, sessions, records } = setup()
      await visit(controller, sessions, 'alpha', 'app:owner:alpha', [msg('app:owner:alpha', 1)])
      await visit(controller, sessions, 'beta', 'app:owner:beta', [msg('app:owner:beta', 1)])
      records.length = 0
      controller.setProject('alpha')
      // Long enough for the paint-settle window, far short of the deadline.
      await new Promise((r) => setTimeout(r, 400))

      const record = records.find((r) => r.to === 'alpha')
      expect(record).toBeDefined()
      expect(record!.marks.frame_rendered).toBeUndefined()
      // The switch DID complete. Only the picture is missing, and that is a fact
      // about the tab, not a failure of the switch.
      expect(record!.incomplete).toBe(false)
      expect(record!.marks.transcript).toBeDefined()
    } finally {
      if (original === undefined) delete g.requestAnimationFrame
      else g.requestAnimationFrame = original
    }
  })
})
