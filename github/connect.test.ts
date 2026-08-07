import { describe, expect, test } from 'bun:test'
import { connectGitHub, type PresentableGrant } from './connect.ts'
import type { PollDeps } from './device-flow.ts'
import type { OwnerHandle } from '@neutronai/persistence/index.ts'

const OWNER = 'juno' as OwnerHandle
const CLIENT_ID = 'Iv1.testclientid'
const TOKEN = 'gho_reallysecrettokenvalue'

const DEVICE_BODY = {
  device_code: 'DEVICE-SECRET-HALF',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  interval: 5,
  expires_in: 900,
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Records every call in ORDER so the present-before-poll property is testable. */
function harness(opts?: { tokenResponses?: unknown[] }) {
  const events: string[] = []
  const stored: string[] = []
  const presented: PresentableGrant[] = []
  const tokenResponses = opts?.tokenResponses ?? [{ access_token: TOKEN, token_type: 'bearer' }]
  let tokenCall = 0

  const deps: PollDeps = {
    fetchImpl: async (url) => {
      if (String(url).includes('/login/device/code')) {
        events.push('device-code')
        return jsonRes(DEVICE_BODY)
      }
      events.push('poll')
      const body = tokenResponses[Math.min(tokenCall, tokenResponses.length - 1)]
      tokenCall += 1
      return jsonRes(body)
    },
    now: () => 0,
    sleep: async () => {},
  }

  const store = {
    put: async (row: { plaintext: string }) => {
      events.push('store')
      stored.push(row.plaintext)
    },
  } as unknown as Parameters<typeof connectGitHub>[0]['store']

  const present = async (g: PresentableGrant): Promise<void> => {
    events.push('present')
    presented.push(g)
  }

  return { events, stored, presented, deps, store, present }
}

describe('connectGitHub', () => {
  test('shows the owner the code BEFORE it starts polling', async () => {
    const h = harness()
    const res = await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })

    expect(res).toEqual({ connected: true })
    // The ORDER is the property. A flow that polls first is broken against a
    // real person even though it passes a stub-approves-instantly test.
    expect(h.events).toEqual(['device-code', 'present', 'poll', 'store'])
    expect(h.events.indexOf('present')).toBeLessThan(h.events.indexOf('poll'))
  })

  test('the owner is never shown the device_code — only the short user_code', async () => {
    const h = harness()
    await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })

    expect(h.presented).toHaveLength(1)
    const shown = h.presented[0]!
    expect(shown.user_code).toBe('ABCD-1234')
    expect(shown.verification_uri).toBe('https://github.com/login/device')
    expect(shown.expires_in_seconds).toBe(900)
    // The bearer half must be absent by construction, not merely unused: whatever
    // renders this into chat can only render what the object carries.
    expect(Object.keys(shown).sort()).toEqual([
      'expires_in_seconds',
      'user_code',
      'verification_uri',
    ])
    expect(JSON.stringify(shown)).not.toContain('DEVICE-SECRET-HALF')
  })

  test('stores the token on success', async () => {
    const h = harness()
    await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })
    expect(h.stored).toEqual([TOKEN])
  })

  test('a declined flow stores NOTHING and reports the reason', async () => {
    const h = harness({ tokenResponses: [{ error: 'access_denied' }] })
    const res = await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })

    expect(res).toEqual({ connected: false, reason: 'access_denied' })
    // Unconnected must stay unconnected — otherwise readGitHubToken starts
    // returning a credential that cannot authenticate.
    expect(h.stored).toEqual([])
    expect(h.events).not.toContain('store')
  })

  test('an expired flow stores nothing either', async () => {
    const h = harness({ tokenResponses: [{ error: 'expired_token' }] })
    const res = await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })
    expect(res).toEqual({ connected: false, reason: 'expired_token' })
    expect(h.stored).toEqual([])
  })

  test('no failure result carries token material', async () => {
    const h = harness({ tokenResponses: [{ error: 'access_denied' }] })
    const res = await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })
    const serialised = JSON.stringify(res)
    expect(serialised).not.toContain(TOKEN)
    expect(serialised).not.toContain('DEVICE-SECRET-HALF')
  })

  test('a presenter failure aborts before polling and is not flattened into a device-flow reason', async () => {
    const h = harness()
    const boom = new Error('chat delivery is down')
    await expect(
      connectGitHub({
        client_id: CLIENT_ID,
        store: h.store,
        owner_handle: OWNER,
        present: async () => {
          h.events.push('present')
          throw boom
        },
        deps: h.deps,
      }),
    ).rejects.toThrow('chat delivery is down')

    // Never polled: waiting out a 15-minute expiry for a code the owner never
    // saw is pure latency. And nothing stored.
    expect(h.events).toEqual(['device-code', 'present'])
    expect(h.stored).toEqual([])
  })

  test('pending is normal — it keeps polling and still lands connected', async () => {
    const h = harness({
      tokenResponses: [
        { error: 'authorization_pending' },
        { error: 'authorization_pending' },
        { access_token: TOKEN, token_type: 'bearer' },
      ],
    })
    const res = await connectGitHub({
      client_id: CLIENT_ID,
      store: h.store,
      owner_handle: OWNER,
      present: h.present,
      deps: h.deps,
    })
    expect(res).toEqual({ connected: true })
    expect(h.events.filter((e) => e === 'poll')).toHaveLength(3)
    expect(h.stored).toEqual([TOKEN])
  })
})
