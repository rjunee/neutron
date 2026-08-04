/**
 * Tests for the dead-Google-grant chat notice (`../oauth-reconnect-notice.ts`).
 *
 * The suite is built around the one property that decides whether the feature is
 * usable at all: `onInvalidGrant` fires on a REFRESH ATTEMPT, so a dead grant is
 * retried by every Core that touches it. A notice that does not suppress
 * duplicates buries the chat; one that suppresses them forever tells the owner
 * once and is then silent through every future expiry. Both arms are asserted,
 * and both are mutation-checked (see the PR body for the red runs).
 */

import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'

import type { DeliveryEnvelope, DeliveryResult } from '../../http/deliver.ts'
import { OAuthTokenManager, serviceAccountLabel } from '../oauth-token-manager.ts'
import {
  buildReconnectNoticeBody,
  createOAuthReconnectNotifier,
  serviceTitle,
} from '../oauth-reconnect-notice.ts'

const OWNER_TOPIC = 'app:owner'
const OWNER_BASE = 'https://instance.example.com'
/** A composite label — the shape a keyed grant actually has. */
const LABEL = serviceAccountLabel('gmail_compose', 'a1b2c3d4e5f6')
const OTHER_LABEL = serviceAccountLabel('google_calendar', '0f0f0f0f0f0f')
const ADDRESS = 'owner@example.com'

interface Sent {
  topic_id: string
  envelope: DeliveryEnvelope
}

/** A `deliver` double that records calls and can be made to fail. */
function makeDeliver(): {
  sent: Sent[]
  fail: { now: boolean }
  deliver: () => (topic_id: string, envelope: DeliveryEnvelope) => Promise<DeliveryResult>
} {
  const sent: Sent[] = []
  const fail = { now: false }
  return {
    sent,
    fail,
    deliver: () => async (topic_id, envelope) => {
      if (fail.now) throw new Error('durable persist failed')
      sent.push({ topic_id, envelope })
      return { prompt_id: `p${sent.length}`, persisted: true, delivered_live: true }
    },
  }
}

function makeNotifier(opts?: {
  email?: string | null
  owner_base_url?: string | null
}): ReturnType<typeof makeDeliver> & {
  notifier: ReturnType<typeof createOAuthReconnectNotifier>
} {
  const d = makeDeliver()
  const notifier = createOAuthReconnectNotifier({
    deliver: d.deliver,
    owner_topic_id: OWNER_TOPIC,
    readAccountEmail: async () => (opts?.email === undefined ? ADDRESS : opts.email),
    owner_base_url: opts?.owner_base_url === undefined ? OWNER_BASE : opts.owner_base_url,
  })
  return { ...d, notifier }
}

// ── The message ──────────────────────────────────────────────────────────────

test('the notice names the ACCOUNT, not just "a token"', () => {
  const body = buildReconnectNoticeBody({
    label: LABEL,
    email: ADDRESS,
    integrations_url: `${OWNER_BASE}/chat?tab=admin`,
  })
  expect(body).toContain(ADDRESS)
  // The account key is a hex digest — it must never reach the owner's eyes.
  expect(body).not.toContain('a1b2c3d4e5f6')
  expect(body).toContain('Gmail Compose')
})

test('the notice carries a markdown link, which is what makes it tappable', () => {
  const body = buildReconnectNoticeBody({
    label: LABEL,
    email: ADDRESS,
    integrations_url: `${OWNER_BASE}/chat?tab=admin`,
  })
  // Both clients render `[text](https://…)`; a BARE url is inert on mobile
  // (`app/lib/markdown-grammar.ts` has no autolink candidate), so the bracket
  // form is load-bearing, not cosmetic.
  expect(body).toContain(`](${OWNER_BASE}/chat?tab=admin)`)
})

test('an unreadable address degrades to the SERVICE, never to an anonymous notice', () => {
  const body = buildReconnectNoticeBody({
    label: LABEL,
    email: null,
    integrations_url: `${OWNER_BASE}/chat?tab=admin`,
  })
  expect(body).toContain('Gmail Compose')
  expect(body).not.toContain('undefined')
  expect(body).not.toContain('null')
})

test('no instance origin degrades to naming the page, never a fabricated link', () => {
  const body = buildReconnectNoticeBody({ label: LABEL, email: ADDRESS, integrations_url: null })
  expect(body).not.toContain('http')
  expect(body).toContain('Integrations')
})

test('serviceTitle strips the account key and humanises the service', () => {
  expect(serviceTitle(LABEL)).toBe('Gmail Compose')
  // A legacy un-keyed label is already the service.
  expect(serviceTitle('google_calendar')).toBe('Google Calendar')
})

// ── Delivery ─────────────────────────────────────────────────────────────────

test('a dead grant posts ONE durable inert notice to the owner topic', async () => {
  const { sent, notifier } = makeNotifier()
  await notifier.onInvalidGrant(LABEL)

  expect(sent).toHaveLength(1)
  expect(sent[0]!.topic_id).toBe(OWNER_TOPIC)
  // 'inert' — a system statement that persists but never becomes the topic's
  // active prompt. 'none' would vanish for an owner who was not connected,
  // which is every owner at the moment a scheduled refresh fails.
  expect(sent[0]!.envelope.durability).toBe('inert')
  expect(sent[0]!.envelope.body).toContain(ADDRESS)
})

// ── Dedup: the guard this feature lives or dies on ────────────────────────────

test('MUTATION TARGET — three refresh attempts on one dead grant post exactly ONE notice', async () => {
  const { sent, notifier } = makeNotifier()
  await notifier.onInvalidGrant(LABEL)
  await notifier.onInvalidGrant(LABEL)
  await notifier.onInvalidGrant(LABEL)

  expect(sent).toHaveLength(1)
})

test('MUTATION TARGET — concurrent refreshes on one dead grant post exactly ONE notice', async () => {
  const { sent, notifier } = makeNotifier()
  // Two Cores hitting the same dead grant in the same instant. `candidates`
  // hands the same uncommitted incident to both callers, so only the in-flight
  // guard separates this from a double post.
  await Promise.all([
    notifier.onInvalidGrant(LABEL),
    notifier.onInvalidGrant(LABEL),
    notifier.onInvalidGrant(LABEL),
  ])

  expect(sent).toHaveLength(1)
})

test('MUTATION TARGET — after a reconnect, the NEXT death notifies again', async () => {
  const { sent, notifier } = makeNotifier()
  await notifier.onInvalidGrant(LABEL)
  expect(sent).toHaveLength(1)

  // Suppressed while still dead…
  await notifier.onInvalidGrant(LABEL)
  expect(sent).toHaveLength(1)

  // …the owner reconnects…
  notifier.onGrantHealthy(LABEL)

  // …and next week's expiry is a FRESH incident. A latch that never resets is a
  // feature that works once and then goes quiet forever.
  await notifier.onInvalidGrant(LABEL)
  expect(sent).toHaveLength(2)
})

test('a healthy signal for an unrelated label does not clear this one', async () => {
  const { sent, notifier } = makeNotifier()
  await notifier.onInvalidGrant(LABEL)
  notifier.onGrantHealthy(OTHER_LABEL)
  await notifier.onInvalidGrant(LABEL)

  expect(sent).toHaveLength(1)
})

// ── No batching — the owner asked for one message per expired thing ──────────

test('two grants dying post TWO separate messages, never a digest', async () => {
  const { sent, notifier } = makeNotifier()
  await notifier.onInvalidGrant(LABEL)
  await notifier.onInvalidGrant(OTHER_LABEL)

  expect(sent).toHaveLength(2)
  expect(sent[0]!.envelope.body).toContain('Gmail Compose')
  expect(sent[1]!.envelope.body).toContain('Google Calendar')
})

// ── Commit-on-success ────────────────────────────────────────────────────────

test('a failed delivery is RE-ATTEMPTED, not silently swallowed', async () => {
  const { sent, fail, notifier } = makeNotifier()
  fail.now = true
  await notifier.onInvalidGrant(LABEL)
  expect(sent).toHaveLength(0)

  // The incident stayed uncommitted, so the next refresh tries again. Committing
  // before the durable row lands would lose the one message that mattered.
  fail.now = false
  await notifier.onInvalidGrant(LABEL)
  expect(sent).toHaveLength(1)
})

test('no deliver seam yet (pre-boot) posts nothing and does not throw', async () => {
  const notifier = createOAuthReconnectNotifier({
    deliver: () => undefined,
    owner_topic_id: OWNER_TOPIC,
    readAccountEmail: async () => ADDRESS,
    owner_base_url: OWNER_BASE,
  })
  await notifier.onInvalidGrant(LABEL)
  // …and the incident is not committed, so it still notifies once wired.
  const { sent, notifier: live } = makeNotifier()
  await live.onInvalidGrant(LABEL)
  expect(sent).toHaveLength(1)
})

// ── The reset arm is actually WIRED to a real token write ─────────────────────

let workdir: string
let db: ProjectDb
let secretsStore: SecretsStore

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-oauth-reconnect-notice-'))
  const dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  secretsStore = new SecretsStore({ data_dir: dataDir, db, now: () => Date.now() })
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

test('OAuthTokenManager.put fires onGrantHealthy — the reset arm is not just a field', async () => {
  const healthy: string[] = []
  const mgr = new OAuthTokenManager({
    secretsStore,
    owner_handle: asOwnerHandle('owner'),
    client_id: 'cid',
    client_secret: 'csec',
    onGrantHealthy: (label) => {
      healthy.push(label)
    },
  })

  await mgr.put({
    label: LABEL,
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scopes: ['https://www.googleapis.com/auth/gmail.compose'],
    email: ADDRESS,
  })

  // `put` IS the reconnect edge: the OAuth ingest reaches it through
  // `exchangeAndPersist`. If this stops firing, the notice goes silent forever
  // after the first expiry.
  expect(healthy).toEqual([LABEL])
})

test('a listener that throws never fails a persisted grant', async () => {
  const mgr = new OAuthTokenManager({
    secretsStore,
    owner_handle: asOwnerHandle('owner'),
    client_id: 'cid',
    client_secret: 'csec',
    onGrantHealthy: () => {
      throw new Error('notifier exploded')
    },
  })

  await mgr.put({
    label: LABEL,
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scopes: [],
    email: ADDRESS,
  })

  const status = await mgr.getStatus(LABEL)
  expect(status.connected).toBe(true)
})
