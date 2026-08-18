/**
 * WHAT A PROJECT SWITCH IS ALLOWED TO RE-RENDER.
 *
 * ── THE MEASUREMENT THIS FILE EXISTS TO PROTECT ─────────────────────────────────
 * The owner's switches took 3-9 s. `switch-timing.ts` documents the two wrong
 * answers that came before the right one — the store read was blamed for the render
 * it was waiting behind, and then the background refresh was blamed for a switch
 * that was already on screen. The actual cost, once the render could be seen
 * separately, was that a switch re-rendered transcripts that were NOT on screen and
 * had NOT changed. On a two-project harness, one warm switch before and after:
 *
 *      surface renders   4 -> 2      (the background conversations stop re-rendering)
 *      message conversions   N -> 0  (N = every message in the entered project)
 *      controller publishes  2 -> 1  (the refresh that changes nothing stops notifying)
 *
 * ── WHY THESE ASSERTIONS ARE COUNTS AND IDENTITIES, NOT DURATIONS ───────────────
 * Partly the usual reason — a wall-clock bound in CI is a flake generator and it does
 * not say what regressed. But mostly because the durations DID NOT SURVIVE being
 * measured twice: three back-to-back runs of the same unfixed tree gave 1322 ms, 415 ms
 * and 368 ms for the same switch, since the first run in a process pays JIT and DOM
 * warm-up. A single quoted millisecond figure from that harness would have been an
 * artefact of run order presented as a property of the code.
 *
 * The counts above, by contrast, came back byte-identical on every run AND at both
 * transcript sizes — and `conversions = N` is the whole diagnosis in one number: every
 * message in the project being entered was re-converted, so the cost scaled with the
 * transcript exactly as the owner experienced it.
 *
 * Each assertion here is therefore a COUNT of work done or an object IDENTITY
 * preserved. They are also the quantities that decay silently: each fix is one line
 * away from becoming a no-op (a lookup keyed on the wrong thing, one unstable prop,
 * one field missing from a comparator), with nothing failing anywhere to announce it.
 *
 * ── HOW THE RENDER COUNTER WORKS ────────────────────────────────────────────────
 * `ConversationRuntimeHost` calls `useChatRuntime` exactly once per render of a
 * conversation surface, so a spy on that module export IS a per-surface render
 * counter — obtained without adding a counter to production code, which would then
 * be the thing under test rather than the code. `toThreadMessage` is spied the same
 * way: it is the per-message conversion assistant-ui performs, and it is the work
 * that scales with the transcript.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { ChatMessage } from '@neutronai/chat-core'
import type { ChatViewModel, ControllerSession } from '../controller.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((q: string) => ({
      matches: /min-width:\s*1024px/.test(q),
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (typeof g['ResizeObserver'] !== 'function') {
    g['ResizeObserver'] = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function row(topic: string, i: number): ChatMessage {
  return {
    topic_id: topic,
    message_id: `${topic}-m${i}`,
    client_msg_id: '',
    seq: i + 1,
    role: i % 2 === 0 ? 'agent' : 'user',
    kind: null,
    attachments: null,
    transcript: null,
    body: `${topic} message ${i}`,
    created_at: i + 1,
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

/** A session that answers from a fixed row set — a fresh clone per read, exactly as
 *  a real store does, so nothing here passes by accidental identity reuse. */
class FixedSession implements ControllerSession {
  rows: ChatMessage[] = []
  reads = 0
  constructor(readonly topicId: string) {}
  start(): void {}
  stop(): void {}
  setActive(): void {}
  status(): 'open' {
    return 'open'
  }
  async send(): Promise<void> {}
  async messages(): Promise<ChatMessage[]> {
    this.reads += 1
    return this.rows.map((m) => ({ ...m }))
  }
  async pendingCount(): Promise<number> {
    return 0
  }
  markRead(): void {}
}

const PROJECTS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
]
const topicFor = (p: string | null): string => (p === null ? 'app:owner' : `app:owner:${p}`)

async function controllerWith(
  n: number,
): Promise<{
  controller: import('../controller.ts').NeutronChatController
  sessions: Map<string, FixedSession>
  frames: ChatViewModel[]
}> {
  const { NeutronChatController } = await import('../controller.ts')
  const sessions = new Map<string, FixedSession>()
  const frames: ChatViewModel[] = []
  const controller = new NeutronChatController({
    projectId: null,
    projects: PROJECTS,
    topicForProject: topicFor,
    createSession: (_sinks, scope) => {
      const existing = sessions.get(scope.topicId)
      if (existing !== undefined) return existing
      const s = new FixedSession(scope.topicId)
      s.rows = Array.from({ length: n }, (_, i) => row(scope.topicId, i))
      sessions.set(scope.topicId, s)
      return s
    },
  })
  controller.subscribe((vm) => frames.push(vm))
  return { controller, sessions, frames }
}

describe('re-entering a project whose transcript did not change', () => {
  it('REUSES THE ROW OBJECTS AND THE ARRAY, so nothing downstream re-renders', async () => {
    // The render cache used to be ONE map for the whole controller. `computeVm` builds
    // the next map from the ENTERED topic's rows, so on a switch it consulted a map
    // still holding the topic just LEFT — every lookup missed and every row was minted
    // fresh. Nothing looked wrong: the frame was correct, the rows were correct, and
    // the only symptom was that the entire transcript's identities had changed, which
    // is invisible from the outside and is exactly what every downstream memo is keyed
    // on. Keyed by topic, a switch back into an unchanged project reuses both.
    const { controller, frames } = await controllerWith(40)
    controller.start()
    controller.setProject('alpha')
    await tick()
    await tick()
    const onAlpha = frames.at(-1)!
    expect(onAlpha.messages).toHaveLength(40)

    controller.setProject('beta')
    await tick()
    await tick()
    controller.setProject('alpha')
    await tick()
    await tick()

    const backOnAlpha = frames.at(-1)!
    expect(backOnAlpha.projectId).toBe('alpha')
    // The strongest available statement: not "equal rows" but the SAME array.
    expect(backOnAlpha.messages).toBe(onAlpha.messages)
  })

  it('publishes ONCE — the background refresh that changes nothing notifies nobody', async () => {
    // `setProject` paints from cache and then unconditionally kicks a store read. For a
    // project nobody wrote to while the owner was away that read resolves to byte-for-
    // byte what is already on screen, and publishing it forced a SECOND full synchronous
    // render per switch for no visible difference.
    const { controller, frames } = await controllerWith(40)
    controller.start()
    controller.setProject('alpha')
    await tick()
    await tick()
    controller.setProject('beta')
    await tick()
    await tick()

    const before = frames.length
    controller.setProject('alpha')
    await tick()
    await tick()
    expect(frames.length - before).toBe(1)
  })

  it('still publishes when the refresh brings something NEW — suppression is not silence', async () => {
    // The counterpart that makes the assertion above safe rather than merely quiet: a
    // publish is skipped because the frame is identical, never because a switch is in
    // progress. A comparator that over-matches would freeze the transcript instead, and
    // it would pass every test that only counts publishes downward.
    const { controller, sessions, frames } = await controllerWith(40)
    controller.start()
    controller.setProject('alpha')
    await tick()
    await tick()
    controller.setProject('beta')
    await tick()
    await tick()

    const alpha = sessions.get(topicFor('alpha'))!
    alpha.rows = [...alpha.rows, row(topicFor('alpha'), 40)]
    const before = frames.length
    controller.setProject('alpha')
    await tick()
    await tick()
    // Two: the cached frame the owner sees immediately, then the refreshed one.
    expect(frames.length - before).toBe(2)
    expect(frames.at(-1)!.messages).toHaveLength(41)
  })

  it('NEVER reuses one project’s rows in another’s frame', async () => {
    // The whole point of keying the cache by topic is that a hit is scoped. A cache that
    // made a switch fast by serving the wrong project's history would be a far worse bug
    // than the slowness it cured, so this is asserted directly rather than inferred from
    // the key's name.
    const { controller, frames } = await controllerWith(12)
    controller.start()
    controller.setProject('alpha')
    await tick()
    await tick()
    const alphaRows = frames.at(-1)!.messages
    controller.setProject('beta')
    await tick()
    await tick()
    const betaRows = frames.at(-1)!.messages

    expect(betaRows).not.toBe(alphaRows)
    for (const m of betaRows) expect(m.text.startsWith(topicFor('beta'))).toBe(true)
    const alphaIds = new Set(alphaRows.map((m) => m.id))
    for (const m of betaRows) expect(alphaIds.has(m.id)).toBe(false)
  })
})

describe('a switch re-renders the surfaces whose visibility changed, and no others', () => {
  it('leaves every background conversation untouched and converts no message', async () => {
    // `ChatApp` renders EVERY mounted conversation on every publish. Without the memo,
    // each of those re-rendered its whole thread machinery at a cost proportional to ITS
    // message count — so switching to an empty conversation still paid for two 533-row
    // transcripts nobody was looking at. The counter below is per-surface: one
    // `useChatRuntime` call is one surface render.
    const realChat = await import('../useNeutronChat.ts')
    const realAdapter = await import('../message-adapter.ts')
    // SNAPSHOT the originals before mocking, for two separate reasons — both of which
    // produce a confusing failure a long way from here if skipped:
    //   1. `mock.module` REPLACES the registry entry, so a spy that called back through
    //      the namespace object would re-enter itself. Recursion, not delegation.
    //   2. `mock.restore()` does NOT undo a `mock.module`, and `bun test` runs every
    //      file in ONE process — so a spy left installed follows the whole suite into
    //      unrelated files. Re-registering the snapshot in `finally` is the undo.
    const chatPath = new URL('../useNeutronChat.ts', import.meta.url).pathname
    const adapterPath = new URL('../message-adapter.ts', import.meta.url).pathname
    const chatExports = { ...realChat }
    const adapterExports = { ...realAdapter }
    let surfaceRenders = 0
    let conversions = 0
    mock.module(chatPath, () => ({
      ...chatExports,
      useChatRuntime: ((...args: Parameters<typeof chatExports.useChatRuntime>) => {
        surfaceRenders += 1
        return chatExports.useChatRuntime(...args)
      }) as typeof chatExports.useChatRuntime,
    }))
    mock.module(adapterPath, () => ({
      ...adapterExports,
      toThreadMessage: ((...args: Parameters<typeof adapterExports.toThreadMessage>) => {
        conversions += 1
        return adapterExports.toThreadMessage(...args)
      }) as typeof adapterExports.toThreadMessage,
    }))

    const { createRoot } = await import('react-dom/client')
    const React = await import('react')
    const { act } = React
    const { ChatApp } = await import('../ChatApp.tsx')
    const { useNeutronChatVm } = await import('../useNeutronChat.ts')
    const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
    const { controller } = await controllerWith(30)

    const config = {
      wsUrl: 'wss://t/ws/app/chat',
      topicId: topicFor(null),
      userId: 'owner',
      projectId: null,
      projects: PROJECTS,
      origin: 'https://sam.neutron.test',
      deviceId: 'dev-test',
      token: 'dev:owner',
    }

    function Harness(): React.JSX.Element {
      const draft = useAttachmentDraft({ token: config.token })
      const vm = useNeutronChatVm(controller)
      return (
        <ChatApp
          vm={vm}
          controller={controller}
          config={config as never}
          draft={draft}
          // An INLINE arrow, deliberately: this is how `ProjectShell` passes it, and a
          // caller's unstable callback must not be able to defeat the memo. If the
          // stabilization inside `ChatApp` is ever removed, this test is what notices.
          onOpenActivity={() => {}}
        />
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<Harness />)
      })
      // Visit both projects so both surfaces are mounted and warm.
      for (const p of ['alpha', 'beta', 'alpha']) {
        await act(async () => {
          controller.setProject(p)
          await tick()
          await tick()
        })
      }
      await act(async () => {
        await tick()
      })
      expect(container.querySelectorAll('.car-conv').length).toBe(3)

      surfaceRenders = 0
      conversions = 0
      await act(async () => {
        controller.setProject('beta')
        await tick()
        await tick()
      })

      // Exactly the two surfaces whose `active` flipped — alpha out, beta in. General
      // stays mounted and must not render at all. This is `2`, not `<= 2`: an off-by-one
      // here means a surface is re-rendering for a reason nobody intended, which is the
      // whole defect.
      expect(surfaceRenders).toBe(2)
      // And no message is re-converted: beta's rows kept their identities, so
      // assistant-ui's per-identity converter cache holds across the switch.
      expect(conversions).toBe(0)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      mock.module(chatPath, () => chatExports)
      mock.module(adapterPath, () => adapterExports)
    }
    // EXPLICIT BUDGET, well over the default 5 s. This case mounts three real
    // conversation surfaces and drives four switches through `act()`, and
    // `mock.module` invalidates the module graph it then re-imports — so it lands a
    // second or two under the default when run alone and OVER it when run after
    // other files in the same process. It was green in CI purely because the shard
    // split happened to give it a cheap neighbourhood, which is a pass for a reason
    // that has nothing to do with the code under test.
  }, 60_000)
})

describe('the stopwatch reports the switch the owner actually waited for', () => {
  it('a cache-served switch is COMPLETE at the paint, not at the background refresh', async () => {
    const { SwitchTimer } = await import('../switch-timing.ts')
    const records: import('../switch-timing.ts').SwitchRecord[] = []
    let t = 0
    const timer = new SwitchTimer('alpha', 'beta', {
      now: () => t,
      emit: (r) => records.push(r),
      paintSettleMs: 5,
    })
    timer.servedFromCache()
    t = 4
    timer.mark('vm_published')
    t = 9
    timer.mark('frame_rendered')

    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.incomplete).toBe(false)
    expect(r.servedFromCache).toBe(true)
    // 9 ms, not the 8 s a store refresh nobody waited on would have contributed.
    expect(r.total).toBe(9)
    expect(r.marks.transcript).toBeUndefined()
  })

  it('a switch that had nothing cached still WAITS for the transcript', async () => {
    // The discriminating case. Same five marks, same order — only the frame the owner
    // was looking at differs, which is why the timer is TOLD rather than left to infer.
    const { SwitchTimer } = await import('../switch-timing.ts')
    const records: import('../switch-timing.ts').SwitchRecord[] = []
    let t = 0
    const timer = new SwitchTimer('alpha', 'gamma', {
      now: () => t,
      emit: (r) => records.push(r),
      paintSettleMs: 5,
    })
    t = 4
    timer.mark('vm_published')
    t = 9
    timer.mark('frame_rendered')
    expect(records).toHaveLength(0)

    t = 800
    timer.mark('transcript_read')
    t = 820
    timer.mark('transcript')
    expect(records).toHaveLength(1)
    expect(records[0]!.total).toBe(820)
    expect(records[0]!.servedFromCache).toBe(false)
  })
})
