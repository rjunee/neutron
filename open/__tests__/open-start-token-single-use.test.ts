/**
 * Open one-shot start-token — single-use at the HTTP cookie-mint gate.
 *
 * THE BUG (P2 follow-up to #84): with the legacy `/ws/chat` onboarding socket
 * deleted, the only place the `?start=` token is consumed is the HTTP
 * `/chat?start=` cookie-mint gate in `open/composer.ts` (`openFetch`). That
 * gate signature-trusted the token but never `claimStartTokenJti`'d it, so the
 * SAME `?start=` URL could re-mint the owner session cookie repeatedly within
 * its 15-min TTL — a leaked URL was a replayable owner-session grant.
 *
 * THE FIX: the gate now verifies AND atomically claims the token's JTI against
 * a shared `InMemoryConsumedTokens` store before minting the cookie, so a given
 * token mints the owner cookie at most ONCE.
 *
 * This boots the REAL Open composition over a live `Bun.serve`, harvests a real
 * one-shot token from the cold-start `/` bounce, then asserts the FIRST no-cookie
 * `/chat?start=<token>` mints the owner cookie and a SECOND use of the SAME token
 * is rejected (no owner cookie minted).
 *
 * No ANTHROPIC_API_KEY is set — the box boots LLM-less; the start-token gate
 * does not depend on LLM credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { SESSION_COOKIE_NAME } from '../../landing/session-cookie.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness {
  base: string
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-start-token-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

/** Harvest a real one-shot start-token from the cold-start `/chat` bounce. A
 *  fresh (no-cookie, no-token) `/chat` GET 302s to `/chat?start=<token>`. */
async function harvestStartToken(base: string): Promise<string> {
  const res = await fetch(`${base}/chat`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const location = res.headers.get('location') ?? ''
  const m = /[?&]start=([^&]+)/.exec(location)
  if (m === null || m[1] === undefined) {
    throw new Error(`cold-start redirect had no ?start= token: ${location}`)
  }
  return decodeURIComponent(m[1])
}

/** Does a fetch Response set the owner session cookie? */
function mintsOwnerCookie(res: Response): boolean {
  // Bun collapses multiple Set-Cookie into one header; substring-match the name.
  const raw = res.headers.get('set-cookie') ?? ''
  return raw.includes(`${SESSION_COOKIE_NAME}=`)
}

describe('Open one-shot start-token single-use', () => {
  test('a fresh `?start=` token mints the owner cookie on first use', async () => {
    harness = await startHarness()
    const token = await harvestStartToken(harness.base)
    const res = await fetch(`${harness.base}/chat?start=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    })
    // The served page status varies (200 chat shell vs the 503 LLM-less auth
    // gate); what matters for the start-token gate is that the cookie is minted.
    expect(mintsOwnerCookie(res)).toBe(true)
  }, 30_000)

  test('a SECOND use of the same token is rejected (no owner cookie minted)', async () => {
    harness = await startHarness()
    const token = await harvestStartToken(harness.base)
    const url = `${harness.base}/chat?start=${encodeURIComponent(token)}`

    // First no-cookie use claims the JTI and mints the cookie.
    const first = await fetch(url, { redirect: 'manual' })
    expect(mintsOwnerCookie(first)).toBe(true)

    // Replaying the SAME token (still inside its 15-min TTL) must NOT re-mint.
    const second = await fetch(url, { redirect: 'manual' })
    expect(mintsOwnerCookie(second)).toBe(false)
  }, 30_000)

  test('a garbage `?start=` token never mints the owner cookie', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/chat?start=not-a-real-token`, {
      redirect: 'manual',
    })
    expect(mintsOwnerCookie(res)).toBe(false)
  }, 30_000)
})
