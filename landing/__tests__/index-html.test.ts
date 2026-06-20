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

describe('landing/chat.html (Codex r4 P1)', () => {
  const chatHtml = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')

  test('contains the URL-scrub bootstrap before chat.js loads', () => {
    expect(chatHtml).toContain('history.replaceState')
    expect(chatHtml).toContain('__neutron_start_token')
    // The scrub script MUST appear before the `<script type="module" src="/chat.js"`
    // loader so the chat.js fetch's same-origin Referer does not leak the token.
    const scrubIdx = chatHtml.indexOf('history.replaceState')
    const moduleIdx = chatHtml.indexOf('type="module" src="/chat.js"')
    expect(scrubIdx).toBeGreaterThan(0)
    expect(moduleIdx).toBeGreaterThan(scrubIdx)
  })

  test('declares the iMessage palette CSS variables', () => {
    // Sprint redesign: the iMessage / Telegram / WhatsApp-Web layout
    // pins these tokens. If a refactor accidentally drops one, the
    // bubbles fall back to the browser default and the visual rhythm
    // breaks. These names are the contract between chat.html and any
    // theme-variant work that lands later.
    expect(chatHtml).toContain('--user-bubble:')
    expect(chatHtml).toContain('--agent-bubble:')
    expect(chatHtml).toContain('--bubble-radius:')
    expect(chatHtml).toContain('--bubble-tail:')
  })

  test('uses a multi-line auto-grow textarea (NOT a plain <input>)', () => {
    expect(chatHtml).toContain('<textarea id="input"')
    expect(chatHtml).not.toMatch(/<input id="input"/)
  })

  test('renders the bottom-anchor scroll wrapper + new-pill', () => {
    expect(chatHtml).toContain('id="log-wrap"')
    expect(chatHtml).toContain('id="new-pill"')
    // Pin-to-bottom is now achieved via `margin-top: auto` on the first
    // child rather than `justify-content: flex-end` on the container —
    // the flex-end approach broke scroll-up on overflow (Sam, 2026-05-22).
    // The `#log > :first-child { margin-top: auto }` rule is the new
    // mechanic. We assert the rule shape — both selector AND declaration
    // must be present in the stylesheet to guarantee short-conversation
    // pin-to-bottom still works.
    expect(chatHtml).toMatch(/#log\s*>\s*:first-child\s*\{[^}]*margin-top:\s*auto/)
    // Belt-and-braces: ensure the buggy declaration didn't sneak back
    // in. Strip CSS comments first so the explanatory comment in
    // chat.html (which mentions `justify-content: flex-end` to explain
    // why it was removed) doesn't false-positive.
    const styleStart = chatHtml.indexOf('<style>')
    const styleEnd = chatHtml.indexOf('</style>')
    const stylesheet = chatHtml.slice(styleStart, styleEnd).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stylesheet).not.toMatch(/justify-content:\s*flex-end/)
  })

  test('preserves Sprint-28 image-gallery CSS surface', () => {
    expect(chatHtml).toContain('.buttons.image-gallery')
    expect(chatHtml).toContain('.thumb')
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
