/**
 * landing — brand-asset (favicon) serving, LIVE PATH.
 *
 * 2026-07-18 favicon sprint. Ryan saw NO favicon on his tenant chat tab at
 * `https://<slug>.neutron.computer/chat`, and a hard refresh did not help.
 * Four distinct defects were behind it; this file pins all four against the
 * REAL servers (`createLandingServer` for the per-instance tenant surface,
 * `bootLandingServer` for the apex/control-plane surface) by asserting actual
 * RESPONSES — never route-table bookkeeping, which is what let the gaps hide.
 *
 *   1. ROOT CAUSE (why the tab looked empty even though the asset served):
 *      `landing/favicon.svg` was rewritten in 233e0c1b (2026-07-03) from an
 *      opaque tile + solid core to a TRANSPARENT stroke-only outline in the
 *      fixed light-theme accent #007aff at stroke-width 1.6 on a 24×24 box.
 *      At a 16px tab slot that is a ~1.07px mid-blue hairline on transparent —
 *      invisible against Chrome's near-black dark tab strip. Hence "it used to
 *      work fine": the pre-233e0c1b icon carried a #0b0e14 background rect.
 *   2. `GET /favicon.ico` 404'd (no .ico existed, and the path was absent from
 *      `LANDING_ROUTE_MANIFEST` so the gateway never routed it to landing).
 *      Browsers probe it unprompted and negatively-cache the 404 in a store a
 *      hard refresh does not clear — which is the "hard refresh doesn't help"
 *      half of the report.
 *   3. `HEAD /favicon.svg` 404'd — the brand-asset handler was GET-only.
 *   4. The apex/control-plane surface served no .ico either.
 */

import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { createLandingServer } from '../server.ts'
import { LANDING_ROUTE_MANIFEST } from '../routes.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = dirname(HERE) // the landing/ package dir

const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>

function fetchLanding(url: string, init?: RequestInit) {
  const handler = createLandingServer({ static_dir: STATIC_DIR })
  return handler.fetch(new Request(url, init), fakeServer)
}

// ── (a) GET /favicon.ico serves real image bytes ─────────────────────────
describe('GET /favicon.ico — the automatic browser fallback', () => {
  test('200 with an image content-type (was 404: no .ico existed)', async () => {
    const res = await fetchLanding('http://x.test/favicon.ico')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\//)
  })

  test('serves the real on-disk .ico bytes, and they are a valid ICO container', async () => {
    const res = await fetchLanding('http://x.test/favicon.ico')
    const served = Buffer.from(await res.arrayBuffer())
    expect(served.equals(readFileSync(join(STATIC_DIR, 'favicon.ico')))).toBe(true)
    // ICO header: reserved=0, type=1 (icon), then the image count. Guards
    // against someone "fixing" a 404 by aliasing the SVG bytes at this path —
    // an SVG served as image/x-icon renders as a broken icon, not a favicon.
    expect(served.readUInt16LE(0)).toBe(0)
    expect(served.readUInt16LE(2)).toBe(1)
    expect(served.readUInt16LE(4)).toBeGreaterThan(0)
  })

  test('is in the landing route manifest — without it the gateway never routes here', () => {
    // Bookkeeping assertion ON PURPOSE, and only as a companion to the response
    // assertions above: the manifest is a genuine routing precondition in
    // Managed (gateway/http/route-slots.ts re-exports isLandingRoute), so a
    // green response test against the bare landing server would still ship a
    // 404 on the real tenant if the path were missing here.
    expect(LANDING_ROUTE_MANIFEST).toContain('/favicon.ico')
  })
})

// ── (b) HEAD on brand assets ─────────────────────────────────────────────
describe('HEAD on brand assets — parity with GET', () => {
  for (const path of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/site.webmanifest']) {
    test(`HEAD ${path} → 200 with GET's headers and an empty body`, async () => {
      const head = await fetchLanding(`http://x.test${path}`, { method: 'HEAD' })
      const get = await fetchLanding(`http://x.test${path}`)
      expect(head.status).toBe(200)
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
      expect(head.headers.get('cache-control')).toBe(get.headers.get('cache-control'))
      expect((await head.arrayBuffer()).byteLength).toBe(0)
      // …and the equivalent GET really does have a body, so the empty HEAD
      // body above is RFC-correct rather than an empty asset.
      expect((await get.arrayBuffer()).byteLength).toBeGreaterThan(0)
    })
  }

  test('HEAD on an unknown path still 404s (the branch did not widen the allowlist)', async () => {
    const res = await fetchLanding('http://x.test/not-an-asset.ico', { method: 'HEAD' })
    expect(res.status).toBe(404)
  })
})

// ── (c) the served /chat markup actually carries the icon tags ───────────
describe('GET /chat — the served shell carries the icon link tags', () => {
  test('body contains icon, apple-touch-icon and manifest links', async () => {
    const res = await fetchLanding('http://x.test/chat')
    expect(res.status).toBe(200)
    const body = await res.text()
    // This is the assertion the orchestrator could not make against the live
    // tenant (authenticated /chat 302s for an anonymous fetch). Asserted here
    // against the same `serveChatReactShell()` an authenticated Managed request
    // reaches: the Managed auth gate is a DECISION-only gate that either 302s
    // or calls through to this exact handler (gateway/http/compose.ts), so the
    // authenticated body is byte-identical modulo the `?v=` bundle hash.
    expect(body).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />')
    expect(body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(body).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(body).toContain('<link rel="manifest" href="/site.webmanifest" />')
  })

  test('every icon href the shell declares actually serves 200', async () => {
    const body = await (await fetchLanding('http://x.test/chat')).text()
    const hrefs = [...body.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest|mask-icon)"[^>]*href="([^"]+)"/g)]
      .map((m) => m[1])
    // Guards the class of bug where the markup is right but points at a path
    // nothing serves — the inverse of the bug that was actually shipped.
    expect(hrefs.length).toBeGreaterThanOrEqual(4)
    for (const href of new Set(hrefs)) {
      const res = await fetchLanding(`http://x.test${href}`)
      expect(`${href} → ${res.status}`).toBe(`${href} → 200`)
    }
  })
})

// ── (d) the SVG is legible at 16px ───────────────────────────────────────
describe('landing/favicon.svg — 16px legibility (the actual root cause)', () => {
  // Comments STRIPPED before asserting: the file documents the old broken
  // values (#007aff, stroke-width 1.6) in prose, and a naive source-text match
  // would read the explanation as the implementation. Assert on paint markup.
  const svg = readFileSync(join(STATIC_DIR, 'favicon.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

  test('carries an opaque background tile so it never composites onto the tab strip', () => {
    // The regression: 233e0c1b dropped the background rect, leaving a
    // transparent mark that vanished on Chrome's dark tab strip.
    expect(svg).toMatch(/<rect[^>]*fill="#[0-9a-fA-F]{6}"/)
  })

  test('stroke resolves to at least 1.2 device px in a 16px tab slot', () => {
    const viewBox = svg.match(/viewBox="0 0 (\d+) \1"/)
    const stroke = svg.match(/stroke-width="([\d.]+)"/)
    expect(viewBox).not.toBeNull()
    expect(stroke).not.toBeNull()
    const devicePx = (Number(stroke![1]) * 16) / Number(viewBox![1])
    // The shipped-broken value was 1.6 * 16 / 24 = 1.067 — a hairline.
    expect(devicePx).toBeGreaterThanOrEqual(1.2)
  })

  test('does not use the low-contrast #007aff that vanished on a dark tab strip', () => {
    expect(svg).not.toContain('#007aff')
  })
})

// ── (e) the apex / control-plane host serves the brand assets ────────────
describe('apex / control-plane host — brand assets', () => {
  test('serves favicon.svg, favicon.ico and apple-touch-icon over GET and HEAD', async () => {
    const { bootSignup } = await import('../boot-impl.ts')
    const booted = await bootSignup({ port: 0, staticDir: STATIC_DIR })
    try {
      const base = `http://127.0.0.1:${booted.port}`
      for (const path of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/site.webmanifest']) {
        const get = await fetch(`${base}${path}`)
        expect(`GET ${path} → ${get.status}`).toBe(`GET ${path} → 200`)
        expect(get.headers.get('content-type')).not.toBeNull()
        await get.arrayBuffer()

        const head = await fetch(`${base}${path}`, { method: 'HEAD' })
        expect(`HEAD ${path} → ${head.status}`).toBe(`HEAD ${path} → 200`)
      }
    } finally {
      // force: true so the keep-alive idle timer cannot hang the suite.
      await booted.stop({ force: true })
    }
  })
})
