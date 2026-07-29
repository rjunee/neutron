/**
 * #354 BLANK-SCREEN CRASH — snapshot-cache regression guard.
 *
 * The crash was an assistant-ui `useExternalStoreRuntime` notify-storm: when the
 * external-store ADAPTER object is a fresh literal every render, `setAdapter`'s
 * `if (this._store === adapter) return` guard never fires, so it calls
 * `_notifySubscribers()` on every commit → the runtime's `getState()` snapshots
 * churn → a real browser's concurrent renderer loops ("Maximum update depth" /
 * "Tried to unmount a fiber that is already unmounted") → `ChatErrorBoundary`
 * trips → blank screen. The load-bearing fix (`useChatAdapter`'s `useMemo`) keeps
 * the adapter IDENTITY stable across unrelated re-renders so `setAdapter`
 * early-returns and the storm can't start.
 *
 * This is a browser-only failure — jsdom + `act()` runs React synchronously and
 * does NOT reproduce the concurrent-mode loop (verified: un-memoizing the adapter
 * still passes a jsdom crash-repro). So we pin the underlying INVARIANT directly:
 * the adapter's reference is stable while `messages`/`isRunning` are unchanged and
 * changes only when they do. Un-memoizing `useChatAdapter` fails this test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

// Minimal ChatViewModel-shaped object — `useChatAdapter` only reads `messages`
// and `isRunning`; the rest is inert padding so the cast is honest at the seam.
function makeVm(messages: unknown[], isRunning: boolean): unknown {
  return {
    messages,
    isRunning,
    projectId: null,
    pending: null,
    systemNotice: null,
    awaitingFirstToken: false,
    hasActiveWork: false,
    importProgress: undefined,
  }
}

describe('#354 guard — useChatAdapter identity is stable across unrelated re-renders', () => {
  it('returns the SAME adapter reference until messages/isRunning actually change', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act, useState, useEffect } = await import('react')
    const { useChatAdapter } = await import('../useNeutronChat.ts')
    const React = await import('react')

    // A stub controller — `onNew` closes over `controller.send`; identity only.
    const controller = { send: async () => {} } as never

    const msgsA = [{ render_id: 'a1' }, { render_id: 'a2' }] as unknown[]
    const adapters: unknown[] = []
    let bump: (n: number) => void = () => {}
    let setMessages: (m: unknown[]) => void = () => {}
    let setRunning: (r: boolean) => void = () => {}

    function Probe(): React.JSX.Element {
      const [, setN] = useState(0)
      const [messages, _setMessages] = useState<unknown[]>(msgsA)
      const [isRunning, _setRunning] = useState(false)
      bump = setN
      setMessages = _setMessages
      setRunning = _setRunning
      const adapter = useChatAdapter(
        controller,
        makeVm(messages, isRunning) as never,
        'https://sam.neutron.test',
      )
      useEffect(() => {
        adapters.push(adapter)
      })
      return React.createElement('div')
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(Probe))
    })

    // 10 UNRELATED re-renders (messages + isRunning unchanged) → identity must
    // stay pinned. An un-memoized adapter would push a fresh object each time.
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        bump(i + 1)
        await tick()
      })
    }
    const stable = adapters[0]
    expect(adapters.length).toBeGreaterThanOrEqual(11)
    for (const a of adapters) expect(a).toBe(stable)

    // A REAL messages change → the adapter identity MUST change (else the runtime
    // would never see the new transcript).
    await act(async () => {
      setMessages([{ render_id: 'a1' }, { render_id: 'a2' }, { render_id: 'a3' }])
      await tick()
    })
    const afterMessages = adapters[adapters.length - 1]
    expect(afterMessages).not.toBe(stable)

    // Another batch of unrelated re-renders → identity re-pins on the new value.
    const pinned = afterMessages
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        bump(100 + i)
        await tick()
      })
    }
    expect(adapters[adapters.length - 1]).toBe(pinned)

    // A REAL isRunning change → identity changes again.
    await act(async () => {
      setRunning(true)
      await tick()
    })
    expect(adapters[adapters.length - 1]).not.toBe(pinned)

    await act(async () => {
      root.unmount()
    })
  })
})
