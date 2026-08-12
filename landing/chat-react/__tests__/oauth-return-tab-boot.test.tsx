/**
 * ISSUES #495 — a completed Google grant lands ON the connected-accounts view.
 *
 * The owner reported this twice: finishing a Google OAuth connect dropped him on
 * a static "Connected — you can close this tab" page, and getting back to his
 * accounts meant navigating there by hand. The broker now 303s to
 * `<instance>/chat?tab=admin` (`gateway/http/cores-oauth-broker-surface.ts`),
 * which only helps if the shell can actually OPEN on that tab — it could not:
 * the active tab was `useState(CHAT_KEY)` with no URL input anywhere in the
 * client.
 *
 * WHY A COMPONENT TEST AND NOT A UNIT TEST ON THE PARSER. `config.test.ts`
 * already covers `initialTabKeyFromLocation` in isolation, and it would keep
 * passing if the parsed key were never wired into the shell — the exact
 * built-but-not-wired shape this repo keeps getting burned by. So this renders
 * the REAL `ProjectShell` in the REAL General scope and asserts the integrations
 * surface is on screen with NO user interaction. It also pins the reason the
 * naive implementation fails: the tab resolver runs on mount and unconditionally
 * resets the active tab to Chat, so a seeded `useState` value never survives.
 *
 * MUTATIONS, each confirmed RED against this file:
 *   - the shell never applies the boot tab → 2 reds;
 *   - the NAIVE `useState(config.initialTabKey ?? CHAT_KEY)` seed → 2 reds,
 *     which is the evidence for the effect rather than an initial value;
 *   - remove the one-shot latch → the scope-change test reds;
 *   - remove `resolvedActiveKey`'s unknown-key clamp → the degrade test reds,
 *     so that test is not vacuous.
 * A ninth mutation is the reason the implementation is shaped the way it is: an
 * earlier draft screened the boot key against the resolved tab set, and deleting
 * that guard stayed GREEN — the clamp was already doing the work. The guard was
 * removed rather than the mutation excused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({
    url: 'https://sam.example.com/chat?tab=admin',
    settings: { disableIframePageLoading: true },
  })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((q: string) => ({
      matches: false,
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

const TOPIC = 'app:sam'
const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))
const ready = (): Record<string, unknown> => ({
  v: 1,
  type: 'session_ready',
  user_id: 'sam',
  topic_id: TOPIC,
  ts: 0,
})

/** The GLOBAL tab set the engine resolves for General — Chat is injected by the
 *  shell; `admin` is the descriptor `tabs/registry.ts` emits at global scope. */
const GLOBAL_TABS = [
  {
    key: 'admin',
    label: 'Admin',
    scope: 'global',
    source: 'builtin',
    order: 0,
    mount: { kind: 'builtin', target: 'admin' },
  },
]

/** One connected Google account — what the owner came back to SEE. */
const INTEGRATIONS = {
  ok: true,
  oauth: [
    {
      kind: 'oauth',
      label: 'google_calendar#a1b2c3d4',
      connected: true,
      scopes: ['calendar.readonly'],
      email: 'owner@example.com',
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: 'ok',
      expires_at: null,
      scope: 'calendar.readonly',
      core_slugs: ['calendar-core'],
    },
  ],
  api_keys: [],
}

/** The PROJECT-scope tab set — no Admin, by design (`ProjectShell` folds the
 *  global tabs into General only). */
const PROJECT_TABS = [
  {
    key: 'chat',
    label: 'Chat',
    scope: 'project',
    source: 'builtin',
    order: 0,
    mount: { kind: 'builtin', target: 'chat' },
  },
  {
    key: 'settings',
    label: 'Settings',
    scope: 'project',
    source: 'builtin',
    order: 15,
    mount: { kind: 'builtin', target: 'settings' },
  },
]

interface MountResult {
  container: HTMLElement
  unmount: () => Promise<void>
  /** Switch scope and let the new tab set resolve, as the project rail does. */
  switchTo: (projectId: string | null) => Promise<void>
}

/** Render `ProjectShell` in General scope with the given bootstrap extras. */
async function mountShell(configExtra: Record<string, unknown>): Promise<MountResult> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { AssistantRuntimeProvider } = await import('@assistant-ui/react')
  const { InMemoryStore, WebChatSession } = await import('@neutronai/chat-core')
  const { NeutronChatController } = await import('../controller.ts')
  const { useNeutronChat } = await import('../useNeutronChat.ts')
  const { useAttachmentDraft } = await import('../useAttachmentDraft.ts')
  const { ProjectShell } = await import('../ProjectShell.tsx')
  const React = await import('react')

  const sockets: Array<{
    open: () => void
    deliver: (o: unknown) => void
    onopen: (() => void) | null
    onmessage: ((ev: { data: unknown }) => void) | null
    onclose: (() => void) | null
    onerror: (() => void) | null
    send: (d: string) => void
    close: () => void
  }> = []
  const makeSocket = (): never => {
    const s = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((ev: { data: unknown }) => void),
      onclose: null as null | (() => void),
      onerror: null as null | (() => void),
      send: () => {},
      close: () => {},
      open() {
        this.onopen?.()
      },
      deliver(o: unknown) {
        this.onmessage?.({ data: JSON.stringify(o) })
      },
    }
    sockets.push(s)
    return s as never
  }

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.endsWith('/api/app/tabs')) return json({ ok: true, scope: 'global', tabs: GLOBAL_TABS })
    if (url.endsWith('/api/app/projects/acme/tabs')) {
      return json({ ok: true, scope: 'project', project_id: 'acme', tabs: PROJECT_TABS })
    }
    if (url.includes('/api/cores/integrations')) return json(INTEGRATIONS)
    if (url.includes('/api/app/credentials')) return json({ ok: true, credentials: [] })
    if (url.includes('/api/app/usage')) return json({ ok: true })
    return new Response(JSON.stringify({ ok: false, code: 'request_failed' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const controller = new NeutronChatController({
    projectId: null,
    createSession: (sinks) =>
      new WebChatSession({
        url: 'wss://t/ws/app/chat',
        topic_id: TOPIC,
        store: new InMemoryStore(),
        createSocket: makeSocket,
        onChange: sinks.onChange,
        onStatus: sinks.onStatus,
        onFrame: sinks.onFrame,
      }),
  })

  const config = {
    wsUrl: 'wss://t/ws/app/chat',
    topicId: TOPIC,
    userId: 'sam',
    projectId: null,
    projects: [{ id: 'acme', label: 'Acme' }],
    origin: 'https://sam.example.com',
    deviceId: 'dev-test',
    token: 'dev:sam',
    ...configExtra,
  }

  function Harness(): React.JSX.Element {
    const draft = useAttachmentDraft({ token: config.token })
    const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ProjectShell
          vm={vm}
          controller={controller}
          config={config}
          draft={draft}
          fetchImpl={fetchImpl}
        />
      </AssistantRuntimeProvider>
    )
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  await act(async () => {
    sockets[0]!.open()
    sockets[0]!.deliver(ready())
    await tick()
  })
  // Let the global tab set resolve and the boot-tab effect run (no click).
  await act(async () => {
    await tick()
    await tick()
    await tick()
  })

  return {
    container,
    switchTo: async (next: string | null) => {
      await act(async () => {
        controller.setProject(next)
        await tick()
      })
      await act(async () => {
        await tick()
        await tick()
        await tick()
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('OAuth return → the shell opens on the connected-accounts view', () => {
  it('lands on Admin with the connected account visible, with no click', async () => {
    const { container, unmount } = await mountShell({ initialTabKey: 'admin' })

    // The account the owner just connected is on screen — the whole point of
    // the redirect. Asserting the tab BUTTON looked selected would pass against
    // a shell that highlighted Admin while still rendering Chat.
    expect(container.textContent).toContain('owner@example.com')
    // …and the CHAT panel is hidden, which is the discriminator the comment above
    // is about: a shell that merely highlighted Admin while still rendering Chat
    // would fail here.
    //
    // This used to assert the Admin TAB BUTTON was aria-selected. Admin left the tab
    // band on 2026-08-07 — settings-shaped views moved into the top-right ☰ so web
    // and mobile agree about what settings is (owner ask) — so there is no button to
    // be selected, and the assertion moved to the outcome rather than being dropped.
    const chatPanel = container.querySelector('.car-tabpanel') as HTMLElement
    expect(chatPanel.hasAttribute('hidden')).toBe(true)
    // And no band button claims to be Admin, so the move is asserted, not just the
    // absence of the old assertion.
    const bandLabels = Array.from(container.querySelectorAll('button[role="tab"]')).map(
      (b) => b.textContent ?? '',
    )
    expect(bandLabels).not.toContain('Admin')

    await unmount()
  })

  it('applies the boot tab ONCE — a later scope change is not hijacked by it', async () => {
    // The latch is why the boot key is a boot key. Without it the effect re-runs
    // on every scope resolve, so leaving General and coming back would yank the
    // owner to Admin again — and with a per-project key it would re-select that
    // tab on every project he opened, forever. Nothing in the visible outcome
    // distinguishes the two implementations until a scope actually changes,
    // which is why this test exists rather than an assertion on the ref.
    const { container, switchTo, unmount } = await mountShell({ initialTabKey: 'admin' })
    expect(container.textContent).toContain('owner@example.com')

    await switchTo('acme')
    expect(container.textContent).not.toContain('owner@example.com')

    await switchTo(null)
    expect(container.textContent).not.toContain('owner@example.com')
    const active = container.querySelector('[aria-selected="true"], [aria-current="page"]')
    expect(active?.textContent ?? '').toContain('Chat')

    await unmount()
  })

  it('a bare /chat boot still opens on Chat — no `?tab=` means nothing changes', async () => {
    const { container, unmount } = await mountShell({})

    expect(container.textContent).not.toContain('owner@example.com')

    await unmount()
  })

  it('an unknown tab key degrades to Chat rather than a blank pane', async () => {
    // The shell does NOT screen the key itself — `resolvedActiveKey` clamps any
    // active key that is not in the visible set. Asserting the outcome here
    // rather than the guard is deliberate: a guard in the boot effect was
    // written first and a mutation deleting it stayed green, because this clamp
    // was already doing the work. Mutating the clamp reds this test.
    const { container, unmount } = await mountShell({ initialTabKey: 'no-such-tab' })

    expect(container.textContent).not.toContain('owner@example.com')
    const active = container.querySelector('[aria-selected="true"], [aria-current="page"]')
    expect(active?.textContent ?? '').toContain('Chat')

    await unmount()
  })
})
