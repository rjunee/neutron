/**
 * @neutronai/landing — the connect-node guest-accept static surface (M2.6 Ph5).
 *
 * Serves the ONE user-facing HTML route a connect node exposes (brief § 2.2,
 * § 5 #6, test #10):
 *   - GET /connect/accept     → connect-accept.html (the guest accept page)
 *   - GET /connect/accept.js  → the bundled connect-accept.ts client (lazy
 *                               Bun.build, cached) referenced by the page
 *
 * Returns `null` for every other path so the boot shell chains it ahead of the
 * 404 default — EVERY other user-facing route still 404s on a connect node
 * (the audited carve-out is EXACTLY these two GETs; brief test #10). Pre-auth +
 * rate-limited at the edge by Caddy; the page itself drives the non-consuming
 * preview before any handshake.
 *
 * Mirrors `landing/server.ts`'s lazy-bundle pattern (resolveInviteJs): the HTML
 * + TS live next to this module, resolved via `import.meta.url`, so a connect
 * node with no landing static dir still serves the page.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface ConnectAcceptHandler {
  fetch: (req: Request) => Promise<Response | null>
}

const ACCEPT_PATH = '/connect/accept'
const ACCEPT_JS_PATH = '/connect/accept.js'

/**
 * Build the connect-accept static handler. Reads the HTML eagerly (a tiny
 * versioned file) and bundles the client TS lazily on first request (cached).
 */
export function buildConnectAcceptHandler(): ConnectAcceptHandler {
  const htmlPath = fileURLToPath(new URL('./connect-accept.html', import.meta.url))
  const tsPath = fileURLToPath(new URL('./connect-accept.ts', import.meta.url))
  let htmlCache: string | null = null
  let jsCache: string | null = null

  const html = (): string => {
    if (htmlCache === null) htmlCache = readFileSync(htmlPath, 'utf8')
    return htmlCache
  }

  const js = async (): Promise<string | null> => {
    if (jsCache !== null) return jsCache
    try {
      const result = await Bun.build({
        entrypoints: [tsPath],
        target: 'browser',
        format: 'esm',
        minify: false,
        sourcemap: 'none',
      })
      if (!result.success || result.outputs.length === 0) return null
      const out = result.outputs[0]
      if (out === undefined) return null
      jsCache = await out.text()
      return jsCache
    } catch {
      return null
    }
  }

  return {
    async fetch(req): Promise<Response | null> {
      const { pathname } = new URL(req.url)
      if (pathname === ACCEPT_PATH && req.method === 'GET') {
        return new Response(html(), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (pathname === ACCEPT_JS_PATH && req.method === 'GET') {
        const body = await js()
        if (body === null) return new Response('connect-accept.js unavailable', { status: 404 })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        })
      }
      return null
    },
  }
}
