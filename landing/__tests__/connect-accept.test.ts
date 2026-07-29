/**
 * M2.6 Ph5 test #5 (THE HEADLINE UX TEST) — the data-locality disclosure is
 * mandatory, truthful, and class-graded; the Accept button is gated on
 * acknowledgement.
 *
 *   - The guest accept page renders the RESOLVED owner display + connect host +
 *     privacy tier (not a placeholder) from the invite-preview response.
 *   - The guest warning is the LOUD variant; the trusted variant is calmer.
 *   - The Accept button stays DISABLED until the disclosure is acknowledged AND
 *     both fields are filled — there is NO accept POST without acknowledgement.
 *
 * DOM via happy-dom; fetch + the token hasher are stubbed (no network, no
 * crypto.subtle dependency). Mirrors the Managed connect invite-gate test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://connect.example.com/connect/accept#tok-abc' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let mod: typeof import('../connect-accept.ts')
let disclosureMod: typeof import('../connect-disclosure.ts')
beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  mod = await import('../connect-accept.ts')
  disclosureMod = await import('../connect-disclosure.ts')
})

interface Harness {
  disclosureHost: HTMLElement
  displayNameInput: HTMLInputElement
  guestHandleInput: HTMLInputElement
  acceptButton: HTMLButtonElement
  status: HTMLElement
  title: HTMLElement
  lede: HTMLElement
}

function makeHarness(): Harness {
  document.body.innerHTML = `
    <h1 id="title"></h1>
    <p id="lede"></p>
    <div id="disclosure"></div>
    <input id="display-name" />
    <input id="guest-handle" />
    <button id="btn-accept" disabled></button>
    <div id="status"></div>`
  return {
    disclosureHost: document.getElementById('disclosure') as HTMLElement,
    displayNameInput: document.getElementById('display-name') as HTMLInputElement,
    guestHandleInput: document.getElementById('guest-handle') as HTMLInputElement,
    acceptButton: document.getElementById('btn-accept') as HTMLButtonElement,
    status: document.getElementById('status') as HTMLElement,
    title: document.getElementById('title') as HTMLElement,
    lede: document.getElementById('lede') as HTMLElement,
  }
}

const PREVIEW = {
  project_name: 'Owner Project',
  owner_display: 'sam',
  connect_host: 'connect.example.com',
  privacy_tier: 'private',
  scope: 'write' as const,
}

function previewFetcher(extra: Record<string, () => Response> = {}): typeof fetch {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://connect.example.com')
    if (url.pathname.endsWith('/invite-preview')) {
      return new Response(JSON.stringify(PREVIEW), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const route = extra[url.pathname]
    if (route !== undefined) return route()
    throw new Error(`unexpected fetch ${url.pathname} ${init?.method ?? 'GET'}`)
  }) as unknown as typeof fetch
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('disclosure — unified across all collaborators (test #5)', () => {
  test('always-on trust lead-in + resolved values; NO hosting-graded branch', () => {
    const host = document.createElement('div')
    disclosureMod.renderDisclosure(host, {
      projectName: 'P',
      ownerDisplay: 'sam',
      connectHost: 'connect.example.com',
      privacyTier: 'private',
      scope: 'write',
    })
    // The trust lead-in is always present (shown to every collaborator) and is
    // the calm card, NOT the loud amber alert (which no longer exists).
    expect(host.querySelector('.disclosure-trust')).not.toBeNull()
    expect(host.querySelector('.disclosure-alert')).toBeNull()
    expect(host.textContent).toContain('Only accept invite links from people you trust.')
    // Resolved (never hardcoded) values are rendered as text.
    expect(host.textContent).toContain('sam')
    expect(host.textContent).toContain('connect.example.com')
    // write scope → the write-access caution is present.
    expect(host.querySelector('.disclosure-write')).not.toBeNull()
    // The disclosure does NOT key on a trust class — there is no dataset tier.
    expect(host.dataset['trustClass']).toBeUndefined()

    // The disclosure renders identically regardless of how the collaborator is
    // hosted: there is only ONE code path, so a second render with the same
    // inputs produces the same structure (no guest-vs-trusted variant).
    const host2 = document.createElement('div')
    disclosureMod.renderDisclosure(host2, {
      projectName: 'P',
      ownerDisplay: 'sam',
      connectHost: 'connect.example.com',
      privacyTier: 'workspace',
      scope: 'write',
    })
    expect(host2.querySelector('.disclosure-trust')).not.toBeNull()
    expect(host2.querySelector('.disclosure-alert')).toBeNull()
  })

  test('read scope omits the write-access warning', () => {
    const host = document.createElement('div')
    disclosureMod.renderDisclosure(host, { projectName: 'P', ownerDisplay: 'sam', connectHost: 'c', privacyTier: 'workspace', scope: 'read' })
    expect(host.querySelector('.disclosure-write')).toBeNull()
    expect(host.querySelector('.disclosure-read')).not.toBeNull()
    // The trust lead-in is still always present.
    expect(host.querySelector('.disclosure-trust')).not.toBeNull()
  })
})

describe('Ph5 guest accept page — disclosure mandatory + truthful + gated (test #5)', () => {
  beforeEach(() => {
    makeHarness()
  })

  test('renders resolved values and keeps Accept disabled until acknowledged + fields filled', async () => {
    const h = makeHarness()
    mod.initConnectAccept({
      ...h,
      hash: '#tok-abc',
      fetcher: previewFetcher(),
      hashToken: async () => 'a'.repeat(64),
    })
    await flush()

    // Disclosure shows the RESOLVED host/owner (not a placeholder).
    expect(h.disclosureHost.textContent).toContain('connect.example.com')
    expect(h.disclosureHost.textContent).toContain('sam')
    expect(h.title.textContent).toBe('Join Owner Project')

    const ack = document.getElementById('ack-disclosure') as HTMLInputElement
    expect(ack).not.toBeNull()

    // Initially disabled (nothing acknowledged, no fields).
    expect(h.acceptButton.disabled).toBe(true)

    // Fill fields but DON'T acknowledge → still disabled.
    h.displayNameInput.value = 'Bob'
    h.displayNameInput.dispatchEvent(new Event('input'))
    h.guestHandleInput.value = 'bob.example.com'
    h.guestHandleInput.dispatchEvent(new Event('input'))
    expect(h.acceptButton.disabled).toBe(true)

    // Acknowledge → now enabled.
    ack.checked = true
    ack.dispatchEvent(new Event('change'))
    expect(h.acceptButton.disabled).toBe(false)
  })

  test('no accept POST is possible without acknowledgement', async () => {
    const h = makeHarness()
    let guestAuthCalls = 0
    const fetcher = previewFetcher({
      '/connect/v1/connect/guest-auth': () => {
        guestAuthCalls += 1
        return new Response(JSON.stringify({ token: 't' }), { status: 200 })
      },
    })
    mod.initConnectAccept({ ...h, hash: '#tok-abc', fetcher, hashToken: async () => 'a'.repeat(64) })
    await flush()

    // Try to click while still disabled (no ack) — the handler bails on disabled.
    h.displayNameInput.value = 'Bob'
    h.guestHandleInput.value = 'bob.example.com'
    h.acceptButton.dispatchEvent(new Event('click'))
    await flush()
    expect(guestAuthCalls).toBe(0)
  })

  test('a successful accept posts the handshake and reports joined', async () => {
    const h = makeHarness()
    let posted: unknown = null
    const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://connect.example.com')
      if (url.pathname.endsWith('/invite-preview')) {
        return new Response(JSON.stringify(PREVIEW), { status: 200 })
      }
      if (url.pathname.endsWith('/guest-auth')) {
        posted = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({ token: 'bearer-x', local_slug: 'bob', project_id: 'p' }), { status: 200 })
      }
      throw new Error(`unexpected ${url.pathname}`)
    }) as unknown as typeof fetch

    let accepted = false
    mod.initConnectAccept({ ...h, hash: '#tok-abc', fetcher, hashToken: async () => 'a'.repeat(64), onAccepted: () => { accepted = true } })
    await flush()
    const ack = document.getElementById('ack-disclosure') as HTMLInputElement
    h.displayNameInput.value = 'Bob'
    h.displayNameInput.dispatchEvent(new Event('input'))
    h.guestHandleInput.value = 'bob.example.com'
    h.guestHandleInput.dispatchEvent(new Event('input'))
    ack.checked = true
    ack.dispatchEvent(new Event('change'))
    h.acceptButton.dispatchEvent(new Event('click'))
    await flush()
    await flush()

    expect(accepted).toBe(true)
    expect(posted).toEqual({ invite_token: 'tok-abc', display_name: 'Bob', guest_handle: 'bob.example.com' })
    expect(h.status.className).toBe('success')
  })

  test('an expired invite (410 preview) shows an error and never enables Accept', async () => {
    const h = makeHarness()
    const fetcher = mock(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://connect.example.com')
      if (url.pathname.endsWith('/invite-preview')) return new Response('{}', { status: 410 })
      throw new Error('no')
    }) as unknown as typeof fetch
    mod.initConnectAccept({ ...h, hash: '#tok-abc', fetcher, hashToken: async () => 'a'.repeat(64) })
    await flush()
    expect(h.status.className).toBe('error')
    expect(h.acceptButton.disabled).toBe(true)
    expect(document.getElementById('ack-disclosure')).toBeNull()
  })
})
