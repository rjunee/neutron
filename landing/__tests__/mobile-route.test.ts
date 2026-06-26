/**
 * ISSUES #208 — the wow handoff's "Get the mobile app" button pointed at a
 * `/mobile` URL that had NO route anywhere in the landing surface (the
 * web-app host is served by the signup-landing process — verified live
 * 2026-06-11: `GET <host>/mobile` → 404 while `GET <host>/` → 200 via the
 * same process).
 *
 * Reproduce-first contract (RED before GREEN):
 *   1. GET /mobile on the signup-landing boot surface returns the install
 *      page (was: 404 fall-through).
 *   2. The wow action's MOBILE_APP_URL constant points at a path that
 *      RESOLVES on the landing surface (constant ↔ route coupling — a
 *      future URL change that forgets the route regresses this test, the
 *      exact failure mode Sam hit).
 *   3. The per-instance landing server (`createLandingServer`) serves the
 *      same page so `<slug>.<instance-host>/mobile` doesn't fall through
 *      to the composed gateway's default 404 (ISSUES #59 bug class).
 *
 * Honesty contract: no native app exists yet (app/ is unpublished Expo —
 * EAS binding is a pending operator step). The page must NOT claim App
 * Store / Play availability: store links render as greyed coming-soon
 * placeholders until the config constants in
 * `landing/mobile-install-config.ts` are filled in.
 */

import { describe, expect, test, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootSignup } from '../boot.ts'
import { createLandingServer, type ChatBridge, type PendingChatClaim } from '../server.ts'
import {
  MOBILE_INSTALL_LINKS,
  STORE_LINKS_TOKEN,
  renderMobileInstallHtml,
} from '../mobile-install-config.ts'
import { MOBILE_APP_URL } from '../../onboarding/interview/final-handoff-config.ts'
import { buildFinalHandoffMobileAppFollowupPromptSpec } from '../../onboarding/interview/final-handoff-prompts.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

function makeBridge(overrides: Partial<ChatBridge> = {}): ChatBridge {
  return {
    validateStartToken: mock(async ({ start_token }: { start_token: string }) =>
      start_token === 'good'
        ? ({
            project_slug: 'alice',
            user_id: 'u-1',
            jti: 'jti-1',
            expires_at_ms: Date.now() + 60_000,
          } satisfies PendingChatClaim)
        : null,
    ),
    startSession: mock(async () => true),
    handleInbound: mock(async () => {}),
    ...overrides,
  }
}

const FAKE_SERVER = { upgrade: () => true } as unknown as import('bun').Server<unknown>

describe('GET /mobile — signup-landing boot surface (web-app host apex)', () => {
  test('returns 200 text/html with the install page (was: 404)', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mobile`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const body = await res.text()
      expect(body).toContain('Neutron')
      // The honest install path that exists TODAY: phone-browser +
      // Add to Home Screen.
      expect(body).toContain('Add to Home Screen')
    } finally {
      await handle.stop()
    }
  })

  test('the wow MOBILE_APP_URL constant resolves against the landing surface', async () => {
    // Constant ↔ route coupling: whatever path the wow button points at
    // must be served. This is the regression Sam hit live (dead 404 in
    // every delivered handoff message).
    // MOBILE_APP_URL is env-derived (NEUTRON_WEB_APP_BASE) with no default —
    // empty on an unconfigured Open install. The constant↔route coupling is
    // the invariant under test: whatever path the configured URL points at
    // must be served. When the host is unset the canonical path is `/mobile`.
    const path = MOBILE_APP_URL.length > 0 ? new URL(MOBILE_APP_URL).pathname : '/mobile'
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
    } finally {
      await handle.stop()
    }
  })

  test('store links render as coming-soon placeholders while config is empty (no fabricated store URLs)', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mobile`)
      const body = await res.text()
      // Greyed placeholders, clearly labeled.
      expect(body.toLowerCase()).toContain('coming soon')
      // No live store anchors and no fabricated store domains.
      expect(body).not.toContain('apps.apple.com')
      expect(body).not.toContain('play.google.com')
      expect(body).not.toContain('testflight.apple.com')
    } finally {
      await handle.stop()
    }
  })
})

describe('GET /mobile — per-instance landing server (<slug>.<instance-host>)', () => {
  test('createLandingServer serves the same install page', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const res = await handler.fetch(new Request('http://x.test/mobile'), FAKE_SERVER)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('Add to Home Screen')
  })

  test('serves the PWA/brand assets so the chat surface is installable', async () => {
    // chat.html links manifest + icons (see below); without these routes
    // the per-instance gateway 404s them and Add-to-Home-Screen falls back
    // to an icon-less screenshot shortcut.
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    for (const [path, type] of [
      ['/site.webmanifest', 'application/manifest+json'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/apple-touch-icon.png', 'image/png'],
    ] as const) {
      const res = await handler.fetch(new Request(`http://x.test${path}`), FAKE_SERVER)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(type)
    }
  })
})

describe('chat-react.html — PWA installability links (ISSUES #208)', () => {
  test('links the manifest + icons the install instructions rely on', () => {
    const html = readFileSync(join(dirname(HERE), 'chat-react.html'), 'utf8')
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Neutron" />')
  })
})

describe('renderMobileInstallHtml — store-link flip (single editable config)', () => {
  const TEMPLATE = `<div class="stores">\n${STORE_LINKS_TOKEN}\n</div>`

  test('empty config (today) → greyed coming-soon placeholders, no anchors, TestFlight hidden', () => {
    const out = renderMobileInstallHtml(TEMPLATE, {
      app_store_url: '',
      play_store_url: '',
      testflight_url: '',
    })
    expect(out).toContain('App Store')
    expect(out).toContain('Google Play')
    expect(out).toContain('coming soon')
    expect(out).not.toContain('<a class="store"')
    expect(out).not.toContain('TestFlight')
  })

  test('filling the constants flips the links live without markup changes', () => {
    const out = renderMobileInstallHtml(TEMPLATE, {
      app_store_url: 'https://apps.apple.com/app/id123456',
      play_store_url: 'https://play.google.com/store/apps/details?id=computer.neutron.app',
      testflight_url: 'https://testflight.apple.com/join/abc123',
    })
    expect(out).toContain('href="https://apps.apple.com/app/id123456"')
    expect(out).toContain(
      'href="https://play.google.com/store/apps/details?id=computer.neutron.app"',
    )
    expect(out).toContain('href="https://testflight.apple.com/join/abc123"')
    expect(out).not.toContain('coming soon')
  })

  test('URLs are attribute-escaped', () => {
    const out = renderMobileInstallHtml(TEMPLATE, {
      app_store_url: 'https://apps.apple.com/app?a=1&b="x"',
      play_store_url: '',
      testflight_url: '',
    })
    expect(out).toContain('href="https://apps.apple.com/app?a=1&amp;b=&quot;x&quot;"')
  })

  test('a $-sequence in a pasted URL is not treated as a replace() substitution pattern', () => {
    // String-form String.prototype.replace interprets $& / $' / $$ in
    // the replacement — a pasted store URL containing one would splice
    // template text into the page. The renderer uses a function
    // replacer; this pins it.
    const out = renderMobileInstallHtml(TEMPLATE, {
      app_store_url: "https://apps.apple.com/app?p=$&c=$'x$$",
      play_store_url: '',
      testflight_url: '',
    })
    expect(out).toContain("href=\"https://apps.apple.com/app?p=$&amp;c=$&#39;x$$\"")
    expect(out).not.toContain(STORE_LINKS_TOKEN)
  })

  test('the shipped config is all-empty (no fabricated store URLs while nothing is published)', () => {
    expect(MOBILE_INSTALL_LINKS).toEqual({
      app_store_url: '',
      play_store_url: '',
      testflight_url: '',
    })
  })
})

describe('wow follow-up copy — honest about what exists (ISSUES #208)', () => {
  test('points at the install page without claiming native apps are available', () => {
    // MOBILE_APP_URL is '' under the test harness (no NEUTRON_WEB_APP_BASE),
    // which makes the builder return null (suppressed). Pass an explicit
    // configured URL to exercise the populated copy.
    const url = 'https://app.test.neutron.example/mobile'
    const spec = buildFinalHandoffMobileAppFollowupPromptSpec(url)
    expect(spec).not.toBeNull()
    expect(spec!.body).toContain(url)
    // The honest path that exists today:
    expect(spec!.body.toLowerCase()).toContain('home screen')
    // The old over-claim ("grab the iOS / Android apps") must not return:
    expect(spec!.body).not.toContain('grab the iOS / Android apps')
  })

  test('suppressed entirely when no web-app host is configured (Open default)', () => {
    // Self-hosted Open install with no NEUTRON_WEB_APP_BASE → empty URL →
    // no follow-up spec, never a dangling "Open that link" with no link.
    expect(buildFinalHandoffMobileAppFollowupPromptSpec('')).toBeNull()
    expect(buildFinalHandoffMobileAppFollowupPromptSpec('   ')).toBeNull()
  })
})
