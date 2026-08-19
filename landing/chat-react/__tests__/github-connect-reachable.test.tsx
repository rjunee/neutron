/**
 * THE OWNER CAN CONNECT GITHUB FROM THE WEB — by PRESSING the control (#551).
 *
 * THE GAP. `gateway/http/github-connect-surface.ts` has shipped the whole device
 * flow for months: GET reports status, POST starts one, the route slot resolves
 * and a composition-coverage test asserts it is mounted. NO CLIENT CALLED IT, on
 * any surface. So every automated signal said the feature worked, and the only
 * human path to a GitHub token was a shell on the machine — which is how the
 * agent came to answer a failed push with `gh auth login`, on a machine whose
 * owner has no terminal.
 *
 * WHY THIS TEST PRESSES THINGS. Its sibling
 * (`reachability.test.tsx` → the `github-connect` affordance) asks whether the
 * control is REACHABLE from the real shell in every layout. That is necessary
 * and not sufficient: a Connect button whose handler goes nowhere is reachable
 * and useless, and this repo has shipped that exact bug more than once. So every
 * assertion below goes through the real tab — find the control, click it, and
 * check what left over the wire and what the owner is now looking at.
 *
 * THE DEVICE FLOW IS THE PART WORTH TESTING. It is not the redirect the Google
 * rows use. Starting it produces a CODE the owner types somewhere else, so the
 * assertions are: the POST goes out, the code is on screen, it can be copied in
 * one press, the verification page is a real link, and the tab POLLS itself into
 * the connected state without the owner coming back to refresh. The last one is
 * what turns a wall of instructions into a flow.
 *
 * AND WHAT MUST NEVER BE ON SCREEN: the `device_code`. It is the bearer half of
 * the exchange — anyone holding it can complete the flow and take the token — so
 * the surface never returns it and nothing here may render it. That is asserted
 * against a response that carries one anyway, because the interesting failure is
 * a client that dumps whatever the server sent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://owner.example.com/chat?client=react' })
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
})
afterAll(async () => {
  // UNMOUNT FIRST. The last test leaves a tab sitting in `awaiting_owner`, which
  // is a live poll timer; tearing the DOM out from under it makes React commit
  // against a `window` that no longer exists, and the suite reports an unhandled
  // error after every assertion has already passed.
  if (mounted !== null) {
    await mounted.unmount()
    mounted = null
  }
  await GlobalRegistrator.unregister()
})

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

const config = {
  wsUrl: 'wss://owner.example.com/ws/app/chat',
  topicId: 'app:owner',
  userId: 'owner',
  projectId: 'acme',
  projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://owner.example.com',
  deviceId: 'dev-test',
  token: 'dev:owner',
}

/** The public half of a device grant — exactly what the surface returns. */
const USER_CODE = 'WDJB-MJHT'
const VERIFICATION_URI = 'https://github.example.com/login/device'

interface Sent {
  url: string
  method: string
  /** The bearer this request carried. Recorded so a read made by a REBUILT
   *  client (a rotated token) is distinguishable from one the existing poll
   *  would have made anyway — otherwise "a request went out" proves nothing
   *  about WHICH code path sent it. */
  token: string | null
}
let sent: Sent[] = []
/** What GET answers. Mutated by the POST handler and by individual tests. */
let state: Record<string, unknown> = { status: 'not_connected' }
/** Set by a test to make POST fail the way the gateway fails. */
let startFailure: { status: number; body: Record<string, unknown> } | null = null
/** Extra keys the server response carries — used to prove none of them leak. */
let extraOnStart: Record<string, unknown> = {}
/** Set by a test to make every request fail the way an offline server does. */
let networkDown = false

function fetchImpl(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const headers = (init?.headers ?? {}) as Record<string, string>
  sent.push({ url, method, token: headers['authorization'] ?? null })
  if (networkDown) return Promise.reject(new Error('server unreachable'))
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  // The ENVELOPE is the gateway's, not a convenient bare payload: every
  // `gateway/http` surface answers `{ ok: true, ... }` on success and
  // `{ ok: false, code, message }` on failure (`surface-kit.ts`). A fixture that
  // drops it is not the wire, and a client that started reading `ok` would be
  // tested against a shape no server sends.
  if (url.endsWith('/api/app/github-auth')) {
    if (method === 'POST') {
      if (startFailure !== null) {
        return Promise.resolve(json({ ok: false, ...startFailure.body }, startFailure.status))
      }
      state = {
        status: 'awaiting_owner',
        user_code: USER_CODE,
        verification_uri: VERIFICATION_URI,
        expires_in_seconds: 900,
      }
      return Promise.resolve(json({ ok: true, ...state, ...extraOnStart }))
    }
    return Promise.resolve(json({ ok: true, ...state }))
  }
  // Everything else the tab loads on mount, answered as a fresh install would.
  if (url.endsWith('/api/cores/integrations')) {
    return Promise.resolve(json({ ok: true, oauth: [], api_keys: [] }))
  }
  if (url.endsWith('/api/app/codex-auth')) return Promise.resolve(json({ status: 'not_connected' }))
  if (url.includes('/api/app/credentials')) return Promise.resolve(json({ global: [] }))
  if (url.endsWith('/api/app/projects/archived')) return Promise.resolve(json({ archived: [] }))
  return Promise.resolve(new Response('not found', { status: 404 }))
}

/** What `navigator.clipboard.writeText` was handed, in order. */
let copied: string[] = []

let mounted: { unmount(): Promise<void>; root: HTMLElement } | null = null
/** Re-render the MOUNTED tab with a changed config — set by `mountTab`. */
let rerenderTab: (patch: Record<string, unknown>) => Promise<void> = async () => {
  throw new Error('nothing is mounted')
}

/** The interval the MOUNTED tab polls at. Set by `mountTab`, read by `pollTicks`
 *  so a test that needs a poll to be quiet can raise it without the tick helper
 *  silently waiting less than one interval. */
let activePollMs = 5

/** Mount the REAL Admin/Integrations tab and let its mount-time reads settle. */
async function mountTab(pollMs = 5): Promise<HTMLElement> {
  activePollMs = pollMs
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
  const React = await import('react')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (patch: Record<string, unknown> = {}): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(IntegrationsTab, {
          config: { ...config, ...patch } as never,
          fetchImpl,
          githubPollMs: pollMs,
          navigate: () => {},
          confirmImpl: () => true,
        }),
      )
    })
    await act(async () => {
      await tick()
      await tick()
    })
  }
  rerenderTab = render
  await render()
  mounted = {
    root: container,
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
  return container
}

beforeEach(async () => {
  if (mounted !== null) {
    await mounted.unmount()
    mounted = null
  }
  document.body.innerHTML = ''
  sent = []
  copied = []
  state = { status: 'not_connected' }
  startFailure = null
  extraOnStart = {}
  networkDown = false
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (t: string): Promise<void> => {
        copied.push(t)
        return Promise.resolve()
      },
    },
  })
})

const q = (root: HTMLElement, sel: string): HTMLElement | null =>
  root.querySelector(sel) as HTMLElement | null

async function click(root: HTMLElement, sel: string): Promise<void> {
  const { act } = await import('react')
  const el = q(root, sel)
  if (el === null) throw new Error(`control '${sel}' is not on screen`)
  await act(async () => {
    el.click()
    await tick()
  })
}

/** How many requests the tab has made to the GitHub surface so far. */
const githubReqCount = (): number =>
  sent.filter((s) => s.url.endsWith('/api/app/github-auth')).length

/** Let `n` poll intervals elapse, at whatever interval this tab was mounted with. */
async function pollTicks(n: number): Promise<void> {
  const { act } = await import('react')
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, activePollMs + 7))
    })
  }
}

describe('GitHub — the owner can start the flow from the web', () => {
  it('reads the GitHub status on mount', async () => {
    await mountTab()
    // The tab must ASK. Before this, nothing on any client did.
    expect(sent.some((s) => s.url.endsWith('/api/app/github-auth') && s.method === 'GET')).toBe(true)
  })

  it('shows a not-connected state that says what is LOST, plus a live control', async () => {
    const root = await mountTab()
    expect(root.textContent ?? '').toContain('cannot push')
    const btn = q(root, 'button.cint-github-connect') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    // Present AND usable. A Connect stuck disabled is the same dead end as none.
    expect(btn!.disabled).toBe(false)
  })

  it('PRESSING Connect POSTs the flow open and puts the code on screen', async () => {
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    expect(sent.some((s) => s.url.endsWith('/api/app/github-auth') && s.method === 'POST')).toBe(
      true,
    )
    // The code is the interaction — it has to be the thing the owner sees.
    expect(q(root, '.cint-device-code')?.textContent).toBe(USER_CODE)
  })

  it('the verification page is a REAL link, opened safely', async () => {
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    const link = q(root, 'a.cint-github-open') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe(VERIFICATION_URI)
    // A new tab, because leaving this one mid-flow abandons the poll; `noopener`
    // because the opened page must not get a handle on this one.
    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.getAttribute('rel') ?? '').toContain('noopener')
  })

  it('COPY puts the code on the clipboard in one press', async () => {
    // The owner is typically reading this off a phone and typing it into another
    // device. One press to copy is most of the value of the whole screen.
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    await click(root, 'button.cint-github-copy')
    expect(copied).toEqual([USER_CODE])
    expect(q(root, 'button.cint-github-copy')?.textContent).toContain('Copied')
  })

  it('POLLS itself into the connected state — the owner never has to come back and refresh', async () => {
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    const before = sent.filter((s) => s.url.endsWith('/api/app/github-auth')).length
    // The owner approves at GitHub, on some other device. Nothing tells this tab.
    state = { status: 'connected' }
    await pollTicks(3)
    const after = sent.filter((s) => s.url.endsWith('/api/app/github-auth')).length
    expect(after).toBeGreaterThan(before)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'connected',
    )
    expect(q(root, '.cint-device-code')).toBeNull()
  })

  it('STOPS polling once connected — a settled flow must not hammer the server', async () => {
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    // A poll must be RUNNING first. Without this the test certifies a tab whose
    // poll effect never armed: the request count would be flat for the trivial
    // reason that nothing was ever polling.
    const beforeIdle = githubReqCount()
    await pollTicks(3)
    expect(githubReqCount()).toBeGreaterThan(beforeIdle)
    state = { status: 'connected' }
    await pollTicks(3)
    const settled = githubReqCount()
    await pollTicks(5)
    expect(githubReqCount()).toBe(settled)
  })

  it('a DROPPED poll keeps the code on screen instead of blanking the flow', async () => {
    // The owner is at GitHub typing the code when one poll hits a flaky network.
    // Treating that as "not connected" would take the code away AND tear down the
    // poll that was about to see the approval — the flow would look like it had
    // failed at the exact moment it was working. The mobile screen shipped with
    // that bug and was fixed; nothing here held the web side to the same rule, so
    // re-introducing it left this whole file green.
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    networkDown = true
    await pollTicks(3)
    expect(q(root, '.cint-device-code')?.textContent).toBe(USER_CODE)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'awaiting_owner',
    )
    // …and the poll is still armed, so the very next tick on a network that came
    // back still finishes the flow.
    networkDown = false
    state = { status: 'connected' }
    await pollTicks(3)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'connected',
    )
  })

  it('a failed MOUNT-READ mid-flow keeps the code, the way a dropped poll does', async () => {
    // The status read is not a mount-only event: it re-fires whenever the client
    // is rebuilt, and the token rotating under a long-lived tab is enough to do
    // that. If a failed read blanked `awaiting_owner`, a token refresh landing
    // on a flaky moment would take the owner's live code away and tear down the
    // poll — the same defect as a dropped poll, one layer up, and the mobile
    // screen's comment claims this surface follows the same rule.
    //
    // MOUNTED WITH A POLL INTERVAL LONGER THAN THIS TEST'S WHOLE TIMELINE, on
    // purpose. The poll effect lists the client in its deps, so rebuilding the
    // client RE-ARMS the poll with the rotated bearer too — at the 5ms default a
    // tick fires inside the rerender and "a request carried the rotated token"
    // is satisfied by the poll alone, which would leave the mount-read guard
    // deletable with this file still green. At 400ms no tick can fire before the
    // count is taken, so the request below can ONLY be the mount read.
    const root = await mountTab(400)
    await click(root, 'button.cint-github-connect')
    expect(q(root, '.cint-device-code')?.textContent).toBe(USER_CODE)

    networkDown = true
    const before = sent.length
    await rerenderTab({ token: 'dev:owner-rotated' })
    // EXACTLY ONE GitHub read in that window, and it is the rebuilt client's:
    // the re-read really went out, it failed (`networkDown`), and no poll tick
    // is hiding inside the count.
    const afterRotate = sent.slice(before).filter((s) => s.url.endsWith('/api/app/github-auth'))
    expect(afterRotate.map((s) => s.token)).toEqual(['Bearer dev:owner-rotated'])

    expect(q(root, '.cint-device-code')?.textContent).toBe(USER_CODE)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'awaiting_owner',
    )
    // …and the poll survived the failed re-read, so the flow still finishes on
    // the next good tick (two 400ms intervals — slow, but the price of a window
    // in which the assertion above cannot be satisfied by a poll).
    networkDown = false
    state = { status: 'connected' }
    await pollTicks(2)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'connected',
    )
  })

  it('an EXPIRED code is not a dead end — the next good read puts Connect back', async () => {
    // The escape hatch for the rule above. `awaiting_owner` surviving a failed
    // read plus a Connect control gated OFF while a code is live could strand a
    // screen on a code that is no longer good — so the release valve has to be
    // asserted, not argued. The gateway drops a pending grant once it expires
    // (`github-connect-surface.ts` § `expires_at_ms <= now()`) and answers
    // `not_connected`; the very poll armed by `awaiting_owner` is what carries
    // that answer back, with no reload and no Refresh.
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    expect(q(root, '.cint-device-code')?.textContent).toBe(USER_CODE)
    expect(q(root, 'button.cint-github-connect')).toBeNull()

    // The grant expires at GitHub; the gateway forgets it.
    state = { status: 'not_connected' }
    await pollTicks(3)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'not_connected',
    )
    expect(q(root, '.cint-device-code')).toBeNull()
    // A control the owner can actually press, back on screen.
    expect(q(root, 'button.cint-github-connect')).not.toBeNull()
  })

  it('an ALREADY-CONNECTED account renders as connected, with no code and no Connect', async () => {
    state = { status: 'connected' }
    const root = await mountTab()
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'connected',
    )
    expect(q(root, 'button.cint-github-connect')).toBeNull()
    expect(q(root, '.cint-device-code')).toBeNull()
  })

  it('a flow ALREADY in flight shows its code straight away, without a second start', async () => {
    // The gateway is deliberately idempotent here — a reload must show the same
    // code, not mint a rival the server has stopped polling.
    state = {
      status: 'awaiting_owner',
      user_code: USER_CODE,
      verification_uri: VERIFICATION_URI,
      expires_in_seconds: 300,
    }
    const root = await mountTab()
    expect(q(root, '.cint-device-code')?.textContent).toBe(USER_CODE)
    expect(sent.some((s) => s.url.endsWith('/api/app/github-auth') && s.method === 'POST')).toBe(
      false,
    )
  })

  it("surfaces the gateway's message VERBATIM when the flow cannot start", async () => {
    // "No client id is configured" and "GitHub refused the request" need
    // different things from the owner; a generic "failed" leaves them stuck.
    startFailure = {
      status: 503,
      body: {
        code: 'github_client_id_unset',
        message: 'NEUTRON_GITHUB_CLIENT_ID is not configured, so a device code cannot be requested',
      },
    }
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    expect(root.textContent ?? '').toContain('NEUTRON_GITHUB_CLIENT_ID is not configured')
    // And the owner can try again — a failed start must not eat the control.
    expect(q(root, 'button.cint-github-connect')).not.toBeNull()
  })

  it('an unreachable server reads as not-connected, and still offers the control', async () => {
    networkDown = true
    const root = await mountTab()
    // A server it cannot reach must never look like a credential to re-supply,
    // and it must certainly not disconnect anything.
    expect(sent.some((s) => s.method !== 'GET')).toBe(false)
    expect(root.querySelector('[data-github-status]')?.getAttribute('data-github-status')).toBe(
      'not_connected',
    )
    expect(q(root, 'button.cint-github-connect')).not.toBeNull()
  })

  it('NEVER renders the device_code, even when a response carries one', async () => {
    // The bearer half of the exchange. The real surface omits it by construction;
    // this asserts the CLIENT would not dump it if it ever arrived.
    extraOnStart = { device_code: 'bearer-half-must-not-render' }
    const root = await mountTab()
    await click(root, 'button.cint-github-connect')
    expect(root.textContent ?? '').toContain(USER_CODE)
    expect(root.innerHTML).not.toContain('bearer-half-must-not-render')
  })
})
