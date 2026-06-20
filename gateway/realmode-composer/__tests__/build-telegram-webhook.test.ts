/**
 * Sprint 19 Phase 4 — buildTelegramWebhookSurface factory tests.
 *
 * Exercises every branch of the factory against a real SecretsStore over
 * an in-memory ProjectDb:
 *   - all three secrets present → returns handler; POST with right
 *     secret_token + minimal Telegram update body → 200; POST with wrong
 *     secret_token → 403.
 *   - missing bot_token → null + info log
 *   - missing webhook_secret → null + info log
 *   - missing bot_user_id (kind=channel_metadata, label=telegram-bot-user-id)
 *     → null + info log
 *   - malformed bot_user_id ("abc") → null + warn log
 *   - negative bot_user_id ("-5") → null + warn log
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '../../../persistence/index.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { SecretsStore } from '../../../auth/secrets-store.ts'
import type {
  IncomingEvent,
  IncomingEventReceiver,
} from '../../../channels/types.ts'
import { buildTelegramWebhookSurface } from '../build-telegram-webhook.ts'

let workdir: string
let dataDir: string
let db: ProjectDb
let secrets: SecretsStore

const OWNER = 'alice'

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-build-tg-webhook-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  secrets = new SecretsStore({ data_dir: dataDir, db })
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const recordingReceiver = (): IncomingEventReceiver & { events: IncomingEvent[] } => {
  const events: IncomingEvent[] = []
  return { events, receive: async (event) => { events.push(event) } }
}

/** Capture console.info / console.warn calls for the duration of `fn`. */
async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; info: string[]; warn: string[] }> {
  const info: string[] = []
  const warn: string[] = []
  const origInfo = console.info
  const origWarn = console.warn
  console.info = (...args: unknown[]) => {
    info.push(args.map((a) => String(a)).join(' '))
  }
  console.warn = (...args: unknown[]) => {
    warn.push(args.map((a) => String(a)).join(' '))
  }
  try {
    const result = await fn()
    return { result, info, warn }
  } finally {
    console.info = origInfo
    console.warn = origWarn
  }
}

async function seedBotToken(): Promise<void> {
  await secrets.put({
    internal_handle: OWNER,
    kind: 'bot_token',
    label: 'telegram',
    plaintext: 'tok-abc',
  })
}

async function seedWebhookSecret(value = 'super-secret-token-abc123'): Promise<void> {
  await secrets.put({
    internal_handle: OWNER,
    kind: 'webhook_secret',
    label: 'telegram',
    plaintext: value,
  })
}

async function seedBotUserId(value: string): Promise<void> {
  await secrets.put({
    internal_handle: OWNER,
    kind: 'channel_metadata',
    label: 'telegram-bot-user-id',
    plaintext: value,
  })
}

describe('buildTelegramWebhookSurface', () => {
  test('all three secrets present → returns handler; right secret → 200, wrong → 403', async () => {
    await seedBotToken()
    await seedWebhookSecret('super-secret-token-abc123')
    await seedBotUserId('123456789')

    const recv = recordingReceiver()
    const surface = await buildTelegramWebhookSurface({
      internal_handle: OWNER,
      secrets,
      receiver: recv,
    })
    expect(surface).not.toBeNull()
    if (surface === null) return

    // Right secret_token + minimal Telegram update body → 200, delegates
    // to receiver.
    const goodReq = new Request('http://x/webhook/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'super-secret-token-abc123',
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 100,
          from: { id: 42, first_name: 'Tester', username: 'tester' },
          chat: { id: 99, type: 'private' },
          date: 1700000000,
          text: 'hello',
        },
      }),
    })
    const goodRes = await surface.handler(goodReq)
    expect(goodRes.status).toBe(200)
    expect(recv.events.length).toBe(1)

    // Wrong secret_token → 403, no event.
    const badReq = new Request('http://x/webhook/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'WRONG',
      },
      body: JSON.stringify({ update_id: 2 }),
    })
    const badRes = await surface.handler(badReq)
    expect(badRes.status).toBe(403)
    expect(recv.events.length).toBe(1)
  })

  test('missing bot_token → null + info log', async () => {
    // bot_token NOT seeded.
    await seedWebhookSecret()
    await seedBotUserId('123')
    const recv = recordingReceiver()

    const { result, info, warn } = await captureLogs(() =>
      buildTelegramWebhookSurface({
        internal_handle: OWNER,
        secrets,
        receiver: recv,
      }),
    )
    expect(result).toBeNull()
    expect(warn.length).toBe(0)
    expect(info.some((m) => m.includes('bot_token') && m.includes(OWNER))).toBe(true)
  })

  test('missing webhook_secret → null + info log', async () => {
    await seedBotToken()
    // webhook_secret NOT seeded.
    await seedBotUserId('123')
    const recv = recordingReceiver()

    const { result, info, warn } = await captureLogs(() =>
      buildTelegramWebhookSurface({
        internal_handle: OWNER,
        secrets,
        receiver: recv,
      }),
    )
    expect(result).toBeNull()
    expect(warn.length).toBe(0)
    expect(info.some((m) => m.includes('webhook_secret') && m.includes(OWNER))).toBe(true)
  })

  test('missing bot_user_id → null + info log', async () => {
    await seedBotToken()
    await seedWebhookSecret()
    // bot_user_id NOT seeded.
    const recv = recordingReceiver()

    const { result, info, warn } = await captureLogs(() =>
      buildTelegramWebhookSurface({
        internal_handle: OWNER,
        secrets,
        receiver: recv,
      }),
    )
    expect(result).toBeNull()
    expect(warn.length).toBe(0)
    expect(info.some((m) => m.includes('bot_user_id') && m.includes(OWNER))).toBe(true)
  })

  test('malformed bot_user_id ("abc") → null + warn log', async () => {
    await seedBotToken()
    await seedWebhookSecret()
    await seedBotUserId('abc')
    const recv = recordingReceiver()

    const { result, info, warn } = await captureLogs(() =>
      buildTelegramWebhookSurface({
        internal_handle: OWNER,
        secrets,
        receiver: recv,
      }),
    )
    expect(result).toBeNull()
    expect(info.length).toBe(0)
    expect(
      warn.some(
        (m) =>
          m.includes('bot_user_id') &&
          m.includes('not a positive integer') &&
          m.includes(OWNER),
      ),
    ).toBe(true)
  })

  test('negative bot_user_id ("-5") → null + warn log', async () => {
    await seedBotToken()
    await seedWebhookSecret()
    await seedBotUserId('-5')
    const recv = recordingReceiver()

    const { result, info, warn } = await captureLogs(() =>
      buildTelegramWebhookSurface({
        internal_handle: OWNER,
        secrets,
        receiver: recv,
      }),
    )
    expect(result).toBeNull()
    expect(info.length).toBe(0)
    expect(
      warn.some(
        (m) =>
          m.includes('bot_user_id') &&
          m.includes('not a positive integer') &&
          m.includes(OWNER),
      ),
    ).toBe(true)
  })
})
