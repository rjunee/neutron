/**
 * THE TELEGRAM INBOUND WEBHOOK — reachable through the real router, and closed
 * to everyone who does not hold the secret.
 *
 * `POST /webhook/telegram` is the ONLY way a Telegram message enters this
 * product. The slot was declared in `gateway/http/route-slots.ts` and served by
 * nobody, because `buildTelegramWebhookSurface` carried a docblock asserting it
 * was "called only by the Managed composer" — and no such composer exists, the
 * hosting overlay spawns this same `open/server.ts` per instance. Verified live
 * 2026-08-02 against a running instance: the path answered 404, byte-identical
 * to a control path invented on the spot, while `/healthz` on the same server
 * answered 200. A configured bot would have been silently deaf: Telegram reads
 * a 404 as delivered and stops retrying, so every message vanishes with no
 * error surfaced anywhere.
 *
 * WHY STATUS CODES ALONE PROVE NOTHING HERE. On this ladder an unmounted route
 * and a rejected request are both 4xx, and the two claims this file has to
 * separate — "the route is absent" and "the handler refused you" — are exactly
 * the pair that a bare status check conflates. So every assertion keys on
 * something ONLY the mounted handler emits: the literal body `forbidden` on a
 * refusal and `ok` on an accepted update (`channels/adapters/telegram/
 * webhook-server.ts`). The ladder's default 404 emits neither.
 *
 * THE GATE IS STATE, NOT A FLAG. The surface exists iff this instance's
 * SecretsStore holds a bot token, a webhook secret and a bot user id. That is
 * not a toggle and not a second code path — it is the only honest answer for an
 * unauthenticated endpoint whose sole auth is comparing a header against a
 * stored secret: with no secret stored there is nothing to compare, so serving
 * the route would BE the vulnerability. Both halves are pinned below, by
 * booting the composer twice: CONFIGURED serves and refuses correctly,
 * UNCONFIGURED serves nothing at all. Nothing in this repo writes those
 * secrets, so unconfigured is what every default Open install is.
 *
 * MUTATION TESTS (all run, all observed to fail as described):
 *   - Delete the `telegram_webhook` assignment from `open/composer.ts` → every
 *     test in the CONFIGURED block reds (403/200 become 404), as does
 *     `route-slot-coverage.test.ts`.
 *   - Weaken the secret check in `webhook-server.ts` (drop the empty-token
 *     guard and seed an empty secret) → "an empty stored secret authenticates
 *     nobody" reds.
 *   - Delete the empty-secret refusal in `build-telegram-webhook.ts` → the same
 *     test reds one layer further out.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const OWNER_SLUG = 'owner'
/** Synthetic throughout — no real bot, no network, nothing to leak. */
const WEBHOOK_SECRET = 'synthetic-webhook-secret-telegram-served'
const BOT_TOKEN = '111111:synthetic-telegram-served'
const BOT_USER_ID = '111111'
const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let configured: Harness
let unconfigured: Harness

interface Harness {
  base: string
  dir: string
  close(): Promise<void>
}

/** A substrate that answers immediately and starts no `claude` process. */
function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/**
 * Boot a real Open composition on its own NEUTRON_HOME, optionally with a
 * configured Telegram bot. The env is per-boot because the composer reads it at
 * call time and the two harnesses must not share a data dir — the SecretsStore
 * keyfile and the DB both live there.
 */
async function startHarness(withTelegramSecrets: boolean): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-telegram-webhook-'))
  process.env['NEUTRON_HOME'] = dir
  process.env['OWNER_HOME'] = dir
  process.env['NEUTRON_DB_PATH'] = join(dir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = OWNER_SLUG
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'telegram-webhook-served-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-telegram-webhook-served'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']

  const db = openMigratedDbAt(join(dir, 'project.db'))
  if (withTelegramSecrets) {
    const secrets = new SecretsStore({ data_dir: dir, db })
    const owner_handle = asOwnerHandle(OWNER_SLUG)
    await secrets.put({ owner_handle, kind: 'bot_token', label: 'telegram', plaintext: BOT_TOKEN })
    await secrets.put({
      owner_handle,
      kind: 'webhook_secret',
      label: 'telegram',
      plaintext: WEBHOOK_SECRET,
    })
    await secrets.put({
      owner_handle,
      kind: 'channel_metadata',
      label: 'telegram-bot-user-id',
      plaintext: BOT_USER_ID,
    })
  }

  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => mockSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: OWNER_SLUG })
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
    dir,
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
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * POST the way Telegram does. `secret` omitted → no header at all, which is the
 * shape a public-internet prober sends and the one an empty stored secret would
 * have wrongly authenticated. `raw` sends a body verbatim so a malformed
 * envelope can be exercised.
 */
async function post(
  h: Harness,
  opts: { path?: string; secret?: string; raw?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret !== undefined) headers[SECRET_HEADER] = opts.secret
  const res = await fetch(`${h.base}${opts.path ?? '/webhook/telegram'}`, {
    method: opts.method ?? 'POST',
    headers,
    ...(opts.method === 'GET' ? {} : { body: opts.raw ?? JSON.stringify({ update_id: 1 }) }),
  })
  return { status: res.status, body: await res.text() }
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  configured = await startHarness(true)
  unconfigured = await startHarness(false)
}, 180_000)

afterAll(async () => {
  await configured?.close()
  await unconfigured?.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('POST /webhook/telegram — configured instance', () => {
  test('an update carrying the right secret REACHES the handler', async () => {
    // `{update_id}` with no message decodes to null, so the handler answers
    // without touching the receiver — this pins ROUTING, not chat behaviour.
    // `ok` is the handler's own body; the ladder's 404 does not say it.
    const res = await post(configured, { secret: WEBHOOK_SECRET })
    expect(res.status).toBe(200)
    expect(res.body).toBe('ok')
  })

  test('NO secret header is refused BY THE HANDLER, not 404d past', async () => {
    // The discriminating assertion in this file. An unmounted route and a
    // refused request are both 4xx; only a mounted handler says `forbidden`.
    // It is also the proof that the owner gate does not shadow this path —
    // an unauthenticated POST that reached the gate would 302 to signin.
    const res = await post(configured, {})
    expect(res.status).toBe(403)
    expect(res.body).toBe('forbidden')
  })

  test('a WRONG secret is refused, and refusal leaks nothing about the real one', async () => {
    const wrongSameLength = 'x'.repeat(WEBHOOK_SECRET.length)
    const wrongShort = 'x'
    for (const secret of [wrongSameLength, wrongShort, '']) {
      const res = await post(configured, { secret })
      expect(res.status).toBe(403)
      // Identical response whatever the guess — no length hint, no partial-match
      // hint, and never the expected value.
      expect(res.body).toBe('forbidden')
      expect(res.body).not.toContain(WEBHOOK_SECRET)
    }
  })

  test('a malformed body is a clean 200, not a crash and not a 5xx', async () => {
    // Deliberate, and load-bearing: Telegram retries non-2xx for hours, so a
    // 500 on one bad update becomes a retry storm. The handler logs and
    // absorbs. What must NOT happen is the process erroring out.
    for (const raw of ['not json at all', '{"update_id":', '', '[]', 'null']) {
      const res = await post(configured, { secret: WEBHOOK_SECRET, raw })
      expect(res.status).toBe(200)
      expect(res.body).toBe('ok')
    }
  })

  test('a malformed body WITHOUT the secret is still refused first', async () => {
    // Auth precedes parsing: garbage from an unauthenticated caller must never
    // reach the decoder.
    const res = await post(configured, { raw: 'not json at all' })
    expect(res.status).toBe(403)
    expect(res.body).toBe('forbidden')
  })

  test('GET does not reach the handler — the slot matches POST only', async () => {
    const res = await post(configured, { method: 'GET', secret: WEBHOOK_SECRET })
    expect(res.body).not.toBe('ok')
    expect(res.status).not.toBe(200)
  })

  test('an invented sibling path still 404s — the prefix is not swallowed', async () => {
    const res = await post(configured, {
      path: '/webhook/telegram-not-a-real-route',
      secret: WEBHOOK_SECRET,
    })
    expect(res.status).toBe(404)
    expect(res.body).not.toBe('ok')
    expect(res.body).not.toBe('forbidden')
  })
})

describe('POST /webhook/telegram — UNCONFIGURED instance (every default Open install)', () => {
  test('the route is ABSENT, not merely refusing', async () => {
    // The safety half of the state gate. Nothing in this repo writes Telegram
    // secrets, so this is the shape a self-hoster actually boots: no secret
    // configured, therefore no unauthenticated command surface exposed. The
    // body checks are what make this stronger than "4xx" — neither of the
    // handler's two utterances appears, so the handler is not there at all.
    for (const secret of [undefined, WEBHOOK_SECRET, '']) {
      const res = await post(unconfigured, secret === undefined ? {} : { secret })
      expect(res.status).toBe(404)
      expect(res.body).not.toBe('ok')
      expect(res.body).not.toBe('forbidden')
    }
  })

  test('an empty stored secret authenticates NOBODY', async () => {
    // The hole this PR closes. `SecretsStore.put` does not constrain plaintext,
    // so a webhook secret of '' is storable state, and it passes the factory's
    // null check. If it were allowed through, the handler's constant-time
    // compare would run Buffer('') against Buffer('') for a request sending NO
    // header — equal lengths, equal contents, ACCEPTED — turning the endpoint
    // into an open command surface for the whole internet. Two independent
    // guards refuse it: the factory declines to build (so the route is absent,
    // asserted here), and the handler fails closed even if some other caller
    // hands it an empty token.
    const dir = mkdtempSync(join(tmpdir(), 'neutron-telegram-empty-'))
    const db = openMigratedDbAt(join(dir, 'project.db'))
    const secrets = new SecretsStore({ data_dir: dir, db })
    const owner_handle = asOwnerHandle(OWNER_SLUG)
    await secrets.put({ owner_handle, kind: 'bot_token', label: 'telegram', plaintext: BOT_TOKEN })
    await secrets.put({ owner_handle, kind: 'webhook_secret', label: 'telegram', plaintext: '' })
    await secrets.put({
      owner_handle,
      kind: 'channel_metadata',
      label: 'telegram-bot-user-id',
      plaintext: BOT_USER_ID,
    })
    const { buildTelegramWebhookSurface } = await import(
      '@neutronai/gateway/wiring/build-telegram-webhook.ts'
    )
    const surface = await buildTelegramWebhookSurface({
      owner_handle: OWNER_SLUG,
      secrets,
      receiver: { receive: async (): Promise<void> => {} },
    })
    expect(surface).toBeNull()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
