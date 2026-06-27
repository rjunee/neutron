/**
 * Smoke test: landing page renders the single Google sign-up CTA.
 *
 * Per Sam-decision 2026-05-22 the "Sign up with Telegram" button was
 * removed: Telegram is not an IDP in this stack — the button used to
 * route through Google OAuth anyway, which read as misleading UX. The
 * Telegram-as-chat-substrate option re-enters the flow in a later
 * onboarding phase ("chat_surface_picker"), not on the landing.
 *
 * The `/api/v1/sign-up?via=tg` server route stays for that future
 * surface — coverage lives in landing/__tests__/server.test.ts and
 * landing/__tests__/boot.test.ts. This file only asserts the rendered
 * landing HTML.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const indexHtml = readFileSync(join(import.meta.dir, '..', 'index.html'), 'utf8')

describe('landing/chat-react.html (Codex r4 P1)', () => {
  const chatHtml = readFileSync(join(import.meta.dir, '..', 'chat-react.html'), 'utf8')

  test('contains the URL-scrub bootstrap before the React bundle loads', () => {
    expect(chatHtml).toContain('history.replaceState')
    expect(chatHtml).toContain('__neutron_start_token')
    // The scrub script MUST appear before the `<script type="module" src="/chat-react.js"`
    // loader so the bundle fetch's same-origin Referer does not leak the token.
    const scrubIdx = chatHtml.indexOf('history.replaceState')
    const moduleIdx = chatHtml.indexOf('type="module" src="/chat-react.js"')
    expect(scrubIdx).toBeGreaterThan(0)
    expect(moduleIdx).toBeGreaterThan(scrubIdx)
  })

  test('mounts the React app into #root', () => {
    expect(chatHtml).toContain('id="root"')
  })
})

describe('landing/index.html', () => {
  // The OSS open-surface cleanup (2026-06-13) rebuilt this page as a
  // self-hosted, LOCAL-FIRST first-run surface. There is no hosted SaaS,
  // no auth/OAuth, and no signup funnel — the page informs and points at
  // the quickstart. These tests assert that new reality.

  test('leads with the agent-harness headline', () => {
    expect(indexHtml).toContain('Your agent harness is ready')
  })

  test('carries NO auth / signup CTA', () => {
    // No hosted signup funnel of any kind. Guards against the old
    // Google CTA, the server sign-up route, and the deprecated
    // Telegram button (which implied Telegram-as-IDP — never existed).
    expect(indexHtml).not.toContain('Sign up with Google')
    expect(indexHtml).not.toContain('/api/v1/sign-up')
    expect(indexHtml).not.toContain('id="btn-tg"')
    expect(indexHtml).not.toContain('Sign up with Telegram')
  })

  test('strips every hosted-domain reference', () => {
    // Self-hosters have no hosted domain. The canonical link, og:url, and
    // og/twitter image tags that pointed at it were deleted. The forbidden
    // host is built dynamically so this guard file carries no literal copy
    // of it (the armed leak-gate scans test files too).
    const hostedDomain = ['neutron', 'computer'].join('.')
    expect(indexHtml.toLowerCase()).not.toContain(hostedDomain)
  })

  test('declares viewport meta for mobile', () => {
    expect(indexHtml).toContain('viewport')
    expect(indexHtml).toContain('width=device-width')
  })
})
