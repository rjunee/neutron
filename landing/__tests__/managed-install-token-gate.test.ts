/**
 * #371 (part b — the Open backstop) — the tenant-side OSS install-token /
 * Claude-auth surface must be UNREACHABLE on a MANAGED tenant.
 *
 * Open's landing server serves a SELF-CONTAINED install-token auth screen
 * (`/oauth/max/install-token/*`) + a `/chat` Claude-auth gate because an OSS
 * self-hoster has no control plane and must auth on their own box. On MANAGED
 * the control plane owns auth (the tenant is seeded with the Max token by the
 * control-plane handoff), so the tenant-side screen LEAKED a DUPLICATE auth
 * prompt into the managed flow (#371 — Ryan saw two auth screens).
 *
 * This is the belt-and-suspenders backstop: even if the token isn't seeded, a
 * managed tenant must NOT self-serve its own OSS auth screen — it gets the
 * neutral "workspace is being provisioned" page instead. An OSS/open self-host
 * (the default) is completely unaffected: its only auth path serves normally.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLandingServer, resolveLandingDeploymentMode } from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = dirname(HERE) // landing/ — contains chat-react.html + assets

const FAKE_SERVER = { upgrade: () => true } as unknown as import('bun').Server<unknown>

/**
 * A stub install-token handler that WOULD serve the OSS one-liner screen for
 * any `/oauth/max/install-token/*` path (returns null on a miss, exactly like
 * the real `buildOpenInstallTokenHandler`). Its presence proves the managed
 * gate SHORT-CIRCUITS the handler rather than merely leaving it unwired.
 */
const OSS_INSTALL_TOKEN_MARKER = 'OSS-INSTALL-TOKEN-SCREEN'
const stubInstallTokenHandler = async (req: Request): Promise<Response | null> => {
  const p = new URL(req.url).pathname
  if (p.startsWith('/oauth/max/install-token')) {
    return new Response(OSS_INSTALL_TOKEN_MARKER, { status: 200 })
  }
  return null
}

async function get(
  handler: ReturnType<typeof createLandingServer>,
  path: string,
): Promise<Response> {
  return handler.fetch(new Request(`http://x.test${path}`), FAKE_SERVER)
}

describe('#371 — managed tenant: install-token surface is unreachable', () => {
  const INSTALL_TOKEN_PATHS = [
    '/oauth/max/install-token/state?signup_id=abc',
    '/oauth/max/install-token/initiate',
  ]

  for (const path of INSTALL_TOKEN_PATHS) {
    test(`managed → ${path} → 503 provisioning page, NOT the OSS screen`, async () => {
      const handler = createLandingServer({
        static_dir: STATIC_DIR,
        deploymentMode: 'managed',
        installTokenHandler: stubInstallTokenHandler,
      })
      const res = await get(handler, path)
      expect(res.status).toBe(503)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('cache-control')).toContain('no-store')
      const body = await res.text()
      expect(body).toContain('being provisioned')
      // Crucially: the OSS install-token screen is NEVER reached.
      expect(body).not.toContain(OSS_INSTALL_TOKEN_MARKER)
    })
  }

  test('open (default) → install-token route SERVES the OSS screen (self-host unaffected)', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      deploymentMode: 'open',
      installTokenHandler: stubInstallTokenHandler,
    })
    const res = await get(handler, '/oauth/max/install-token/state?signup_id=abc')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(OSS_INSTALL_TOKEN_MARKER)
  })
})

describe('#371 — managed tenant: /chat auth gate never shows the OSS auth screen', () => {
  test('managed + unauthenticated → 503 provisioning page, NOT "Authenticate Claude"', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      deploymentMode: 'managed',
      chatAuthGate: { isUnauthenticated: () => true },
    })
    const res = await get(handler, '/chat')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toContain('being provisioned')
    // The OSS Claude-auth handoff screen is NOT rendered on a managed tenant.
    expect(body).not.toContain('Authenticate Claude to continue')
    expect(body).not.toContain('/oauth/max/install-token')
  })

  test('open + unauthenticated → the OSS Claude-auth screen still serves', async () => {
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      deploymentMode: 'open',
      chatAuthGate: { isUnauthenticated: () => true },
    })
    const res = await get(handler, '/chat')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toContain('Authenticate Claude to continue')
    expect(body).toContain('/oauth/max/install-token')
    expect(body).not.toContain('being provisioned')
  })
})

describe('#371 — env-derived backstop (deploymentMode option unset)', () => {
  afterEach(() => {
    delete process.env.NEUTRON_ROLE
  })

  test('NEUTRON_ROLE=managed gates the surface even with no explicit option', async () => {
    process.env.NEUTRON_ROLE = 'managed'
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      installTokenHandler: stubInstallTokenHandler,
    })
    const res = await get(handler, '/oauth/max/install-token/state?signup_id=abc')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toContain('being provisioned')
    expect(body).not.toContain(OSS_INSTALL_TOKEN_MARKER)
  })

  test('no NEUTRON_ROLE → defaults to open → OSS surface serves', async () => {
    delete process.env.NEUTRON_ROLE
    const handler = createLandingServer({
      static_dir: STATIC_DIR,
      installTokenHandler: stubInstallTokenHandler,
    })
    const res = await get(handler, '/oauth/max/install-token/state?signup_id=abc')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(OSS_INSTALL_TOKEN_MARKER)
  })
})

describe('resolveLandingDeploymentMode — mirrors gateway/deployment-mode.ts', () => {
  test('normalizes role (trim + lowercase; unknown/unset → open)', () => {
    expect(resolveLandingDeploymentMode({ NEUTRON_ROLE: 'managed' })).toBe('managed')
    expect(resolveLandingDeploymentMode({ NEUTRON_ROLE: ' Managed ' })).toBe('managed')
    expect(resolveLandingDeploymentMode({ NEUTRON_ROLE: 'connect' })).toBe('connect')
    expect(resolveLandingDeploymentMode({ NEUTRON_ROLE: 'bogus' })).toBe('open')
    expect(resolveLandingDeploymentMode({})).toBe('open')
  })
})
