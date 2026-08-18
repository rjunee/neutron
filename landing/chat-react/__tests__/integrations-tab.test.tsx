/**
 * Component test for the web ADMIN / INTEGRATIONS tab. Renders `IntegrationsTab`
 * in happy-dom over an injected `fetchImpl` serving the integrations surface.
 * Asserts:
 *   - the OAuth accounts + API-key slots render from GET /api/cores/integrations;
 *   - typing a value + Save POSTs to /api/cores/api-keys/<label> and the slot
 *     flips to "Stored";
 *   - Clear DELETEs and the slot flips back to "Not set";
 *   - a load failure surfaces the error state;
 *   - SHARED CREDENTIALS (ISSUES #486) — the global-scope credential store is
 *     authored HERE, on the global surface, and the writes it emits address the
 *     project-less `/api/app/credentials` routes.
 *
 * ── The OAuth connect/disconnect block ─────────────────────────────────────
 * The Admin tab rendered OAuth accounts READ-ONLY: a badge and nothing to
 * click, so the owner could not connect Google from the web at all. These
 * tests pin the WIRING, not the markup — asserting a Connect button exists
 * would still pass against a button whose handler goes nowhere, which is
 * precisely the defect. So each one asserts the ROUND TRIP:
 *   - Connect fetches the bearer-gated `/api/cores/oauth/google/start` (never
 *     renders it as a link, which would 401) and then NAVIGATES to the
 *     `authorize_url` it returned — observable through the injected `navigate`
 *     seam, which is the only way to see the hand-off actually happen;
 *   - Disconnect POSTs the row's FULL composite label and re-reads the list;
 *   - multi-account: three Google accounts on one service each get their own
 *     Disconnect, the service still offers "Add another account", and no raw
 *     hex account key is ever rendered at the owner.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: 'app:sam',
  userId: 'sam',
  projectId: 'acme',
  projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://sam.neutron.test',
  deviceId: 'dev-test',
  token: 'dev:sam',
}

/** One connected account under a COMPOSITE grant label — the shape the server
 *  actually returns once a service holds a keyed grant
 *  (`buildIntegrationsStatus` → `<service>#<account_key>`). */
function account(
  label: string,
  email: string | null,
  connected = true,
): Record<string, unknown> {
  return {
    kind: 'oauth',
    label,
    connected,
    scopes: connected ? ['gmail.readonly'] : [],
    email,
    connected_at: connected ? 1 : null,
    last_refresh_at: null,
    last_refresh_outcome: connected ? 'ok' : null,
    expires_at: null,
    scope: 'gmail.readonly',
    core_slugs: ['gmail-core'],
  }
}

const STATUS = {
  ok: true,
  scope: {
    kind: 'cores',
    description: 'This list covers bundled Core credential slots only.',
  },
  oauth: [account('google_calendar#a1b2c3d4', 'sam@example.com')],
  api_keys: [
    {
      kind: 'api_key',
      label: 'openai',
      name: 'OpenAI API Key',
      core_slugs: ['llm-core'],
      required: true,
      install_prompt: 'Paste your OpenAI key.',
      connected: false,
    },
  ],
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | null

interface MountOpts {
  /** Confirmation answer for a destructive action. Defaults to accepting. */
  confirm?: boolean
}

async function mount(
  handler: Handler,
  opts: MountOpts = {},
): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
  act: (cb: () => void | Promise<void>) => Promise<void>
  calls: string[]
  /** Every URL the tab handed to the browser (the OAuth consent hand-off). */
  navigations: string[]
  /** Every message the tab asked the owner to confirm. */
  confirmed: string[]
  /** Every request, with its parsed JSON body — the wire, not the DOM. */
  requests: Array<{ method: string; url: string; body: unknown }>
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    requests.push({
      method: init?.method ?? 'GET',
      url,
      body:
        typeof init?.body === 'string'
          ? ((): unknown => {
              try {
                return JSON.parse(init.body as string)
              } catch {
                return init.body
              }
            })()
          : undefined,
    })
    const res = handler(url, init)
    if (res !== null) return await res
    return new Response(JSON.stringify({ ok: false, code: 'request_failed' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const navigations: string[] = []
  const confirmed: string[] = []
  const navigate = (url: string): void => void navigations.push(url)
  const confirmImpl = (message: string): boolean => {
    confirmed.push(message)
    return opts.confirm !== false
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <React.StrictMode>
        <IntegrationsTab
          projectId="acme"
          config={config}
          fetchImpl={fetchImpl}
          navigate={navigate}
          confirmImpl={confirmImpl}
        />
      </React.StrictMode>,
    )
  })
  await act(async () => {
    await tick()
    await tick()
  })
  return {
    container,
    root: root as unknown as { unmount: () => void },
    act,
    calls,
    navigations,
    confirmed,
    requests,
  }
}

/** Find a button by its accessible name. */
function btn(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (found === undefined) {
    throw new Error(
      `no button with aria-label='${label}'; saw: ${Array.from(
        container.querySelectorAll('button'),
      )
        .map((b) => b.getAttribute('aria-label') ?? b.textContent)
        .join(' | ')}`,
    )
  }
  return found as HTMLButtonElement
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('IntegrationsTab render (happy-dom)', () => {
  it('lists OAuth accounts + API-key slots and reflects connected state', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/api/cores/integrations') ? json(STATUS) : null,
    )
    // Humanised SERVICE title — never the raw composite label, whose account
    // key is a hex digest.
    expect(container.textContent).toContain('This list covers bundled Core credential slots only.')
    expect(container.textContent).toContain('Google Calendar')
    expect(container.textContent).not.toContain('a1b2c3d4')
    expect(container.textContent).toContain('sam@example.com')
    expect(container.textContent).toContain('OpenAI API Key')
    expect(container.textContent).toContain('Paste your OpenAI key.')
    // OAuth slot connected → badge "Connected"; API-key slot not set → "Not set".
    expect(container.textContent).toContain('Connected')
    expect(container.textContent).toContain('Not set')
    root.unmount()
  })

  it('Save POSTs the typed value and flips the slot to Stored', async () => {
    const posted: Array<{ url: string; body: unknown }> = []
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/cores/api-keys/openai') && init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body as string) })
        return json({ ok: true, label: 'openai', connected: true })
      }
      return null
    })

    const input = container.querySelector('.cint-key-input') as HTMLInputElement
    const setVal = (Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set as (v: string) => void) ?? (() => {})
    await act(async () => {
      setVal.call(input, 'sk-secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
      await tick()
      await tick()
    })

    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toEqual({ value: 'sk-secret' })
    expect(calls.some((c) => c === 'POST https://sam.neutron.test/api/cores/api-keys/openai')).toBe(
      true,
    )
    // Slot flipped to Stored after the successful POST.
    expect(container.textContent).toContain('Stored')
    root.unmount()
  })

  it('Clear DELETEs a stored key and flips the slot to Not set', async () => {
    const connected = { ...STATUS, api_keys: [{ ...STATUS.api_keys[0]!, connected: true }] }
    let deleted = false
    const { container, root, act } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(connected)
      if (url.endsWith('/api/cores/api-keys/openai') && init?.method === 'DELETE') {
        deleted = true
        return json({ ok: true, label: 'openai', deleted: true })
      }
      return null
    })

    expect(container.textContent).toContain('Stored')
    const clearBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear',
    ) as HTMLButtonElement
    await act(async () => {
      clearBtn.click()
      await tick()
      await tick()
    })
    expect(deleted).toBe(true)
    expect(container.textContent).toContain('Not set')
    root.unmount()
  })

  it('shows an error state when the status load fails', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/api/cores/integrations')
        ? json({ ok: false, code: 'unauthorized', message: 'nope' }, 401)
        : null,
    )
    expect(container.textContent).toContain('unauthorized')
    root.unmount()
  })

  it('lists archived projects and restores one (POST /restore) removing it from the list', async () => {
    let restored = false
    const archivedBody = {
      archived: [
        { id: 'summer', name: 'Summer Trip', emoji: '🏖️', archived_at: '2026-06-30T12:00:00.000Z' },
      ],
    }
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/app/projects/archived')) return json(archivedBody)
      if (url.endsWith('/api/app/projects/summer/restore') && init?.method === 'POST') {
        restored = true
        return json({ ok: true, restored: true })
      }
      return null
    })

    expect(container.textContent).toContain('Archived projects')
    expect(container.textContent).toContain('Summer Trip')

    const restoreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restore',
    ) as HTMLButtonElement
    await act(async () => {
      restoreBtn.click()
      await tick()
      await tick()
    })

    expect(restored).toBe(true)
    expect(calls.some((c) => c === 'POST https://sam.neutron.test/api/app/projects/summer/restore')).toBe(true)
    // Dropped from the archived list after a successful restore.
    expect(container.textContent).not.toContain('Summer Trip')
    root.unmount()
  })

  it('renders the GLOBAL Codex section and Connect POSTs to /api/app/codex-auth', async () => {
    const posted: Array<{ url: string; body: unknown }> = []
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      // Global codex status starts not_connected.
      if (url.endsWith('/api/app/codex-auth') && (init?.method ?? 'GET') === 'GET') {
        return json({ ok: true, status: 'not_connected', scope: null })
      }
      if (url.endsWith('/api/app/codex-auth') && init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body as string) })
        return json({ ok: true, status: 'connected', scope: 'global' }, 201)
      }
      return null
    })

    // The section renders under the account-wide Admin surface.
    expect(container.textContent).toContain('Codex cross-model review')
    // NOT 'account-wide credential' — that singular framing is what made a button
    // which now removes EVERY seat read as if it cleared one thing. The copy must
    // say seats are plural and must warn that reusing one account kills both.
    expect(container.textContent).toContain('one or more ChatGPT')
    expect(container.textContent).toContain('revoke each')
    expect(container.textContent).toContain('○ Not connected')

    const textarea = container.querySelector('#cint-codex-auth') as HTMLTextAreaElement
    const setVal = (Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set as (v: string) => void) ?? (() => {})
    await act(async () => {
      setVal.call(textarea, '{"tokens":{"access_token":"a","refresh_token":"r"}}')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })

    const connectBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Connect Codex',
    ) as HTMLButtonElement
    await act(async () => {
      connectBtn.click()
      await tick()
      await tick()
    })

    expect(posted).toHaveLength(1)
    expect((posted[0]!.body as { auth: string }).auth).toContain('refresh_token')
    expect(calls.some((c) => c === 'POST https://sam.neutron.test/api/app/codex-auth')).toBe(true)
    // Status flips to connected after the successful global connect.
    expect(container.textContent).toContain('✓ Connected')
    root.unmount()
  })

  it('shows an empty state when there are no archived projects', async () => {
    const { container, root } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      return null
    })
    expect(container.textContent).toContain('No archived projects.')
    root.unmount()
  })
})

const START_PREFIX = 'https://sam.neutron.test/api/cores/oauth/google/start'
const CONSENT_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&state=st&prompt=consent'

/** A service with nothing connected yet — the server's bare placeholder row. */
const DISCONNECTED = {
  ok: true,
  oauth: [account('google_calendar', null, false)],
  api_keys: [],
}

describe('IntegrationsTab — Google connect / disconnect wiring', () => {
  it('Connect hits the bearer-gated /start and NAVIGATES to the authorize_url it returns', async () => {
    const { container, root, act, calls, navigations } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(DISCONNECTED)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.startsWith(START_PREFIX)) {
        return json({ ok: true, authorize_url: CONSENT_URL, state: 'st', expires_at: 9 })
      }
      return null
    })

    // A not-connected row offers Connect (this is what was missing entirely).
    await act(async () => {
      btn(container, 'Connect Google Calendar').click()
      await tick()
      await tick()
    })

    // (1) It went through the AUTHENTICATED start route with the SERVICE label
    //     — not the composite one, which /start rejects as unknown_label.
    const start = calls.find((c) => c.includes('/api/cores/oauth/google/start'))
    expect(start).toBe(
      `GET ${START_PREFIX}?labels=${encodeURIComponent('google_calendar')}`,
    )
    // (2) …and then actually handed the browser to Google's consent page. This
    //     is the assertion that fails if the button is wired to nothing.
    expect(navigations).toEqual([CONSENT_URL])
    root.unmount()
  })

  it('never renders /start as a link — a browser navigation to it carries no bearer and 401s', async () => {
    const { container, root } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(DISCONNECTED)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      return null
    })
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.some((h) => h.includes('/api/cores/oauth/google/start'))).toBe(false)
    root.unmount()
  })

  it('Disconnect confirms, POSTs the row FULL composite label, and re-reads the list', async () => {
    // Reads AFTER the disconnect see the account gone — the server falls back
    // to the bare placeholder row. Gated on the POST (not a read counter):
    // StrictMode double-invokes the mount effect, so reads are not 1:1 with
    // user-visible loads.
    let readsAfterDisconnect = 0
    let disconnected = false
    const posted: string[] = []
    const { container, root, act, confirmed } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) {
        if (disconnected) readsAfterDisconnect += 1
        return json(disconnected ? DISCONNECTED : STATUS)
      }
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.includes('/api/cores/oauth/google/disconnect/') && init?.method === 'POST') {
        posted.push(url)
        disconnected = true
        return json({ ok: true, disconnected: ['google_calendar#a1b2c3d4'], affected_cores: [] })
      }
      return null
    })

    await act(async () => {
      btn(container, 'Disconnect Google Calendar (sam@example.com)').click()
      await tick()
      await tick()
      await tick()
    })

    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toContain('Disconnect Google Calendar')
    // The FULL composite label is what identifies ONE account; percent-encoded
    // because a literal `#` would be read as a URL fragment and never sent.
    expect(posted).toEqual([
      `https://sam.neutron.test/api/cores/oauth/google/disconnect/${encodeURIComponent('google_calendar#a1b2c3d4')}`,
    ])
    // The list was re-read AFTER the disconnect, so the row reflects the new
    // state rather than the stale pre-disconnect one.
    expect(readsAfterDisconnect).toBeGreaterThan(0)
    expect(container.textContent).toContain('Not connected')
    root.unmount()
  })

  it('declining the confirmation disconnects nothing', async () => {
    const posted: string[] = []
    const { container, root, act, confirmed } = await mount(
      (url, init) => {
        if (url.endsWith('/api/cores/integrations')) return json(STATUS)
        if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
        if (url.includes('/disconnect/') && init?.method === 'POST') {
          posted.push(url)
          return json({ ok: true, disconnected: [], affected_cores: [] })
        }
        return null
      },
      { confirm: false },
    )

    await act(async () => {
      btn(container, 'Disconnect Google Calendar (sam@example.com)').click()
      await tick()
      await tick()
    })
    expect(confirmed).toHaveLength(1)
    expect(posted).toEqual([])
    root.unmount()
  })

  it('THREE accounts on one service: each gets its own Disconnect, and Add another account still connects', async () => {
    const three = {
      ok: true,
      oauth: [
        account('google_calendar#aaa11111', 'one@example.com'),
        account('google_calendar#bbb22222', 'two@example.com'),
        account('google_calendar#ccc33333', 'three@example.com'),
      ],
      api_keys: [],
    }
    const posted: string[] = []
    const { container, root, act, calls, navigations } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(three)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.startsWith(START_PREFIX)) {
        return json({ ok: true, authorize_url: CONSENT_URL, state: 'st', expires_at: 9 })
      }
      if (url.includes('/disconnect/') && init?.method === 'POST') {
        posted.push(url)
        return json({ ok: true, disconnected: [], affected_cores: [] })
      }
      return null
    })

    // All three accounts render, addressed by their own full labels…
    const labels = Array.from(container.querySelectorAll('[data-oauth-label]')).map(
      (el) => el.getAttribute('data-oauth-label'),
    )
    expect(labels).toEqual([
      'google_calendar#aaa11111',
      'google_calendar#bbb22222',
      'google_calendar#ccc33333',
    ])
    // …under ONE humanised service title, with no hex digest shown to the owner.
    expect(container.textContent).toContain('one@example.com')
    expect(container.textContent).toContain('three@example.com')
    for (const key of ['aaa11111', 'bbb22222', 'ccc33333']) {
      expect(container.textContent).not.toContain(key)
    }

    // Disconnecting the MIDDLE one addresses exactly that account.
    await act(async () => {
      btn(container, 'Disconnect Google Calendar (two@example.com)').click()
      await tick()
      await tick()
    })
    expect(posted).toEqual([
      `https://sam.neutron.test/api/cores/oauth/google/disconnect/${encodeURIComponent('google_calendar#bbb22222')}`,
    ])

    // A service that already has accounts STILL offers a way to add the next
    // one — otherwise the 2nd and 3rd account could never be connected — and it
    // starts from the SERVICE label, not any composite one.
    await act(async () => {
      btn(container, 'Add another Google Calendar account').click()
      await tick()
      await tick()
    })
    expect(
      calls.filter((c) => c === `GET ${START_PREFIX}?labels=${encodeURIComponent('google_calendar')}`),
    ).toHaveLength(1)
    expect(navigations).toEqual([CONSENT_URL])
    root.unmount()
  })

  it('a failing /start surfaces the error and does NOT navigate; the control re-enables', async () => {
    const { container, root, act, navigations } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(DISCONNECTED)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.startsWith(START_PREFIX)) {
        return json(
          { ok: false, code: 'identity_register_failed', message: 'identity returned 502' },
          502,
        )
      }
      return null
    })

    await act(async () => {
      btn(container, 'Connect Google Calendar').click()
      await tick()
      await tick()
    })

    expect(navigations).toEqual([])
    expect(container.textContent).toContain('identity returned 502')
    // Not left stuck spinning.
    expect(btn(container, 'Connect Google Calendar').disabled).toBe(false)
    root.unmount()
  })

  it('an ok:false /start body with a 200 still refuses to navigate', async () => {
    const { container, root, act, navigations } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(DISCONNECTED)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.startsWith(START_PREFIX)) return json({ ok: false, authorize_url: '' })
      return null
    })

    await act(async () => {
      btn(container, 'Connect Google Calendar').click()
      await tick()
      await tick()
    })
    expect(navigations).toEqual([])
    expect(container.textContent).toContain('could not start the Google consent flow')
    root.unmount()
  })

  it('the control is DISABLED while the connect round-trip is in flight, and re-enables after', async () => {
    let release: (r: Response) => void = () => {}
    const held = new Promise<Response>((r) => {
      release = r
    })
    const { container, root, act, navigations } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(DISCONNECTED)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.startsWith(START_PREFIX)) return held
      return null
    })

    expect(btn(container, 'Connect Google Calendar').disabled).toBe(false)

    await act(async () => {
      btn(container, 'Connect Google Calendar').click()
      await tick()
    })

    // Mid-flight: disabled + showing progress, so a double-click can't mint a
    // second grant.
    const inFlight = btn(container, 'Connect Google Calendar')
    expect(inFlight.disabled).toBe(true)
    expect(inFlight.textContent).toBe('Connecting…')
    expect(navigations).toEqual([])

    await act(async () => {
      release(json({ ok: true, authorize_url: CONSENT_URL, state: 'st', expires_at: 9 }))
      await tick()
      await tick()
    })
    expect(navigations).toEqual([CONSENT_URL])
    root.unmount()
  })
})

/**
 * ISSUES #486 — the Admin tab is where instance-wide credentials are AUTHORED.
 * The project Settings tab lost that power; these assert it landed here rather
 * than disappearing, and that what reaches the server is the global route (no
 * project id anywhere in it), not a project route with a scope flag.
 */
describe('IntegrationsTab shared (global) credentials (happy-dom)', () => {
  const GLOBAL_CREDS = 'https://sam.neutron.test/api/app/credentials'

  const SHARED = [
    {
      id: 'g1',
      owner_slug: 'sam',
      project_id: '',
      scope: 'global',
      service: 'openai',
      label: 'shared key',
      created_at: '2026-06-20T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
      expires_at: null,
    },
  ]

  function handler(state: { rows: unknown[] }): Handler {
    return (url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url === GLOBAL_CREDS && (init?.method ?? 'GET') === 'GET') {
        return json({ ok: true, global: state.rows })
      }
      if (url === GLOBAL_CREDS && init?.method === 'POST') {
        state.rows = [...state.rows, { ...SHARED[0], id: 'g2', service: 'stripe', label: null }]
        return json({ ok: true, credential: SHARED[0] }, 201)
      }
      if (url.startsWith(`${GLOBAL_CREDS}/`) && init?.method === 'DELETE') {
        state.rows = []
        return json({ ok: true, deleted: 'openai', scope: 'global' })
      }
      return null
    }
  }

  function input(container: HTMLElement, label: string): HTMLInputElement {
    const el = Array.from(container.querySelectorAll('input')).find(
      (i) => i.getAttribute('aria-label') === label,
    )
    if (el === undefined) throw new Error(`no input labelled '${label}'`)
    return el as HTMLInputElement
  }

  function setInputValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      ?.set as ((v: string) => void) | undefined
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function textBtn(container: HTMLElement, text: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === text,
    )
    if (found === undefined) throw new Error(`no button reading '${text}'`)
    return found as HTMLButtonElement
  }

  it('lists the instance-wide defaults from the project-less GET', async () => {
    const { container, root, calls } = await mount(handler({ rows: SHARED }))
    expect(container.textContent).toContain('Shared credentials')
    expect(container.textContent).toContain('openai')
    expect(container.textContent).toContain('shared key')
    expect(calls).toContain(`GET ${GLOBAL_CREDS}`)
    root.unmount()
  })

  it('adding one POSTs the GLOBAL route — no project id, no scope flag', async () => {
    const state = { rows: [] as unknown[] }
    const { container, root, act, requests } = await mount(handler(state))
    expect(container.textContent).toContain('No shared credentials yet.')

    await act(async () => {
      setInputValue(input(container, 'Service'), 'stripe')
      setInputValue(input(container, 'Shared credential value'), 'sk-live-xxx')
      setInputValue(input(container, 'Label (optional)'), 'billing')
      await tick()
    })
    await act(async () => {
      textBtn(container, 'Add shared credential').click()
      await tick()
      await tick()
    })

    const posts = requests.filter((r) => r.method === 'POST' && r.url.includes('/credentials'))
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(GLOBAL_CREDS)
    expect(posts[0]!.url).not.toContain('/projects/')
    expect(posts[0]!.body).toEqual({ service: 'stripe', token: 'sk-live-xxx', label: 'billing' })
    // The write landed AND the list re-read, so the new row is on screen.
    expect(container.textContent).toContain('stripe')
    root.unmount()
  })

  it('removing one DELETEs the GLOBAL route and the row goes away', async () => {
    const state = { rows: SHARED as unknown[] }
    const { container, root, act, requests } = await mount(handler(state))
    await act(async () => {
      btn(container, 'Remove shared openai credential').click()
      await tick()
      await tick()
    })
    const deletes = requests.filter((r) => r.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toBe(`${GLOBAL_CREDS}/openai`)
    expect(container.textContent).toContain('No shared credentials yet.')
    root.unmount()
  })

  it('the shared-credential fetches never touch a project-scoped path', async () => {
    const { root, act, requests, container } = await mount(handler({ rows: SHARED }))
    await act(async () => {
      setInputValue(input(container, 'Service'), 'stripe')
      setInputValue(input(container, 'Shared credential value'), 'sk-live-xxx')
      await tick()
    })
    await act(async () => {
      textBtn(container, 'Add shared credential').click()
      await tick()
      await tick()
    })
    for (const r of requests.filter((x) => x.url.includes('/credentials'))) {
      expect(r.url).not.toContain('/api/app/projects/')
    }
    root.unmount()
  })
})

describe('Codex seats — the web pane can destroy them, so it must say so', () => {
  /** A two-seat pool, the shape the gateway has been sending all along. */
  const TWO_SEATS = {
    ok: true,
    status: 'connected',
    scope: 'global',
    next: 'default',
    accounts: [
      {
        slot: 'default',
        label: null,
        status: 'connected',
        cooling: false,
        cooling_until: null,
        cooling_reason: null,
        used_percent: 12,
        window_minutes: 10080,
        plan_type: 'pro',
        active: true,
      },
      {
        slot: 'work',
        label: null,
        status: 'connected',
        cooling: true,
        cooling_until: 99,
        cooling_reason: 'rate_limited',
        used_percent: 99,
        window_minutes: 300,
        plan_type: 'pro',
        active: false,
      },
    ],
  }

  const seatHandler =
    (onDelete: (url: string) => void, onPost?: (body: unknown) => void): Handler =>
    (url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      if (url.includes('/api/app/codex-auth') && (init?.method ?? 'GET') === 'GET') {
        return json(TWO_SEATS)
      }
      if (url.includes('/api/app/codex-auth') && init?.method === 'DELETE') {
        onDelete(url)
        return json({ ok: true })
      }
      if (url.includes('/api/app/codex-auth') && init?.method === 'POST') {
        onPost?.(JSON.parse(init.body as string))
        return json(TWO_SEATS, 201)
      }
      return null
    }

  it('renders every seat, its cooling state, and which one runs next', async () => {
    // The gateway has always sent `accounts`; the WEB type simply never declared
    // the field, so this pane showed one opaque "Connected" line for a pool of
    // seats and no way to act on any of them.
    const { container, root } = await mount(seatHandler(() => {}))
    expect(container.textContent).toContain('default')
    expect(container.textContent).toContain('work')
    expect(container.textContent).toContain('cooling')
    expect(container.textContent).toContain('next')
    root.unmount()
  })

  it('DISCONNECT-ALL confirms first, names the count, and sends NOTHING when declined', async () => {
    // This button became destructive without changing: before rotation it removed
    // one credential, and a bare DELETE now maps to disconnectAllAccounts. An owner
    // clicking it to re-paste one seat would lose every subscription he has.
    const deletes: string[] = []
    const { container, root, act, confirmed } = await mount(seatHandler((u) => deletes.push(u)), {
      confirm: false,
    })
    const btn = container.querySelector(
      '[data-testid="cint-codex-disconnect-all"]',
    ) as HTMLButtonElement
    expect(btn.textContent).toContain('2 seats')
    await act(async () => {
      btn.click()
      await tick()
    })
    expect(confirmed.join(' ')).toContain('ALL 2')
    // Declined means NO request. The assertion that matters: the confirmation is a
    // gate, not a notification shown after the fact.
    expect(deletes).toHaveLength(0)
    root.unmount()
  })

  it('REMOVE on one seat deletes that seat only, never the unqualified route', async () => {
    const deletes: string[] = []
    const { container, root, act } = await mount(seatHandler((u) => deletes.push(u)))
    const btn = container.querySelector(
      '[data-testid="cint-codex-seat-remove-work"]',
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
      await tick()
      await tick()
    })
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toContain('account=work')
    root.unmount()
  })

  it('ADD SEAT sends the seat name, and refuses a blank one while a seat exists', async () => {
    // Omitting `account` is not neutral: the server resolves it to the default slot
    // and OVERWRITES seat 1. This client could not send the field at all, so the web
    // pane could only ever replace the first seat while reporting success.
    const posted: unknown[] = []
    const { container, root, act } = await mount(seatHandler(() => {}, (b) => posted.push(b)))
    const auth = container.querySelector('#cint-codex-auth') as HTMLTextAreaElement
    const setValue = (el: HTMLTextAreaElement | HTMLInputElement, v: string): void => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value')?.set
      setter?.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => {
      setValue(auth, '{"tokens":{}}')
      await tick()
    })
    const submit = container.querySelector('[data-testid="cint-codex-connect"]') as HTMLButtonElement
    // A pasted bundle with NO seat name, while two seats exist: refused.
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toContain('Add seat')

    await act(async () => {
      setValue(container.querySelector('#cint-codex-account') as HTMLInputElement, 'laptop')
      await tick()
    })
    expect(submit.disabled).toBe(false)
    await act(async () => {
      submit.click()
      await tick()
      await tick()
    })
    expect(posted).toHaveLength(1)
    expect((posted[0] as { account?: string }).account).toBe('laptop')
    root.unmount()
  })
})
