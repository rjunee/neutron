/**
 * P7.3 — production-composer reachability guard for the doc-link
 * helper + the channel adapters' rewriter integration.
 *
 * What this test guards: the same anti-pattern Argus has flagged 4× in
 * 6 sprints (chat-send HTTP fallback unreachable from
 * `composeProductionGraph`, PR #222; projects-client method unexercised
 * end-to-end, PR #225; launcher routes in P5.3, PR #227; tasks routes
 * in P5.4, PR #229; reminders routes in P5.5, PR #231; focus surface
 * in P5.6). The doc-link surface is NOT an HTTP route — it's a
 * cross-cutting body-rewrite that fires inside every outgoing message
 * the production channel adapters render. A future composer refactor
 * that broke the rewriter wiring would silently drop deep-link
 * tappability without any unit test failing.
 *
 * Test shape (per `docs/plans/P7.3-doc-link-integration-sprint-brief.md` § 6):
 *
 *   1. Boot `composeProductionGraph` against an in-memory SQLite + a
 *      stub `PlatformAdapter`. Pre-supply the SAME `ChannelRouter` the
 *      production gateway pre-builds for the Telegram webhook handler
 *      so the graph + adapters share one instance.
 *   2. Construct Telegram + AppWs adapters the same way `gateway/index.ts`
 *      does at boot. Register both on the production-composed channel
 *      router.
 *   3. Fire `OutgoingMessage`s carrying `[label](docs:/<proj>/<path>?line=42)`
 *      markers through `ChannelRouter.send(...)` and assert the wire
 *      body emitted by EACH adapter carries the channel-correct rewritten
 *      URL — including the `?line=42` / `&line=42` anchor.
 *   4. Cover the structured `adapter_options.doc_refs` reach-through
 *      (P7.3 § 6.3 row #5) AND the parser-reserved `?range=N-M` round
 *      trip (P7.3 § 6.3 row #6).
 *
 * Mirrors the P5.3-onwards reach-through tests
 * (`launcher-production-composer.test.ts`, `focus-production-composer.test.ts`
 * et al.) — same structural pattern adapted for a cross-channel
 * rewriter instead of an HTTP route.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  ChannelRouter,
  type Topic,
  type OutgoingMessage,
} from '@neutronai/channels/index.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type { AppWsOutbound } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { TelegramAdapter } from '@neutronai/channels/adapters/telegram/index.ts'
import type { TelegramClient } from '@neutronai/channels/adapters/telegram/client.ts'
import {
  NEUTRON_SCHEME,
  VAULT_REDIRECTOR_BASE,
  webAppBase,
} from '@neutronai/runtime/doc-links.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'doc-link-composer-project'

interface CapturedTelegramCall {
  chat_id: number | string
  message_thread_id?: number
  text: string
  parse_mode?: 'MarkdownV2'
  reply_markup?: unknown
}

interface Harness {
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  tmp: string
  router: ChannelRouter
  appWsAdapter: AppWsAdapter
  appWsRegistry: InMemoryAppWsSessionRegistry
  telegramAdapter: TelegramAdapter
  telegramSent: CapturedTelegramCall[]
  close(): Promise<void>
}

function makeFakeTelegramClient(sent: CapturedTelegramCall[]): TelegramClient {
  const fake: Partial<TelegramClient> = {
    sendMessage: async (payload: CapturedTelegramCall) => {
      sent.push(payload)
      return {
        message_id: sent.length,
        chat: { id: typeof payload.chat_id === 'number' ? payload.chat_id : 0, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
      } as Awaited<ReturnType<TelegramClient['sendMessage']>>
    },
    setWebhook: async () => true,
    answerCallbackQuery: async () => true,
  }
  return fake as TelegramClient
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-doc-link-composer-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // Production wires the channel router OUTSIDE composeProductionGraph
  // (so the Telegram webhook can hold the same router reference) and
  // passes it via `channel_router`. We mirror that here so the
  // composer reuses the supplied instance.
  const router = new ChannelRouter(db, OWNER, async () => {})

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    channel_router: router,
  })

  // Sanity: the graph's exposed `channels` module IS the router we
  // supplied. If composeProductionGraph ever drops the reuse seam this
  // breaks at compile + runtime.
  const fromGraph = graph.get<ChannelRouter>('channels')
  if (!Object.is(fromGraph, router)) {
    throw new Error('composeProductionGraph did not reuse the supplied ChannelRouter')
  }

  // Construct the channel adapters the same way `gateway/index.ts`
  // does at boot (see index.ts around L2780-L2808 for AppWs and the
  // wiring's telegram-adapter wiring).
  const appWsRegistry = new InMemoryAppWsSessionRegistry()
  const appWsAdapter = new AppWsAdapter({
    registry: appWsRegistry,
    receiver: router,
  })
  router.registerAdapter(appWsAdapter)

  const telegramSent: CapturedTelegramCall[] = []
  const telegramAdapter = new TelegramAdapter({
    client: makeFakeTelegramClient(telegramSent),
    bot_user_id: 1,
    webhook_secret_token: 'composer-test-secret',
    receiver: router,
  })
  router.registerAdapter(telegramAdapter)

  return {
    graph,
    db,
    tmp,
    router,
    appWsAdapter,
    appWsRegistry,
    telegramAdapter,
    telegramSent,
    close: async () => {
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const telegramTopic: Topic = {
  topic_id: 't-telegram-1',
  channel_kind: 'telegram',
  channel_topic_id: '12345',
  project_id: null,
  privacy_mode: 'regular',
}

const appWsTopic: Topic = {
  topic_id: 't-app-1',
  channel_kind: 'app_socket',
  channel_topic_id: 'app:doc-link-test-user',
  project_id: null,
  privacy_mode: 'regular',
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer: ChannelRouter.send(telegram) rewrites docs:/ marker to neutron:// URL', async () => {
  // P7.3 § 6.3 row #1 — baseline rewrite reach-through.
  const msg: OutgoingMessage = {
    topic: telegramTopic,
    text: 'Read [the launch plan](docs:/acme/launch-plan.md) for context.',
  }
  await harness.router.send(msg)
  expect(harness.telegramSent.length).toBe(1)
  const sent = harness.telegramSent[0]!
  expect(sent.parse_mode).toBe('MarkdownV2')
  // URL ships as a MarkdownV2 inline link payload; `.` inside the URL
  // payload is literal (MarkdownV2 only requires `)`/`\` escaping inside
  // `(...)`). The prose `.` outside the link IS escaped.
  expect(sent.text).toContain(`${NEUTRON_SCHEME}://docs/acme/launch-plan.md`)
  expect(sent.text).toBe(
    `Read [the launch plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md) for context\\.`,
  )
})

test('production composer: telegram body carries the ?line=42 anchor end-to-end', async () => {
  // P7.3 § 6.3 row #2 — line anchor reach-through.
  const msg: OutgoingMessage = {
    topic: telegramTopic,
    text: 'Read [the launch plan](docs:/acme/launch-plan.md?line=42) at line 42.',
  }
  await harness.router.send(msg)
  expect(harness.telegramSent.length).toBe(1)
  const sent = harness.telegramSent[0]!
  expect(sent.parse_mode).toBe('MarkdownV2')
  expect(sent.text).toContain(
    `${NEUTRON_SCHEME}://docs/acme/launch-plan.md?line=42`,
  )
})

test('production composer: app-ws web platform rewrites docs:/ + ?line=42 to https URL + &line=42', async () => {
  // P7.3 § 6.3 row #3 — platform-aware web URL with anchor.
  const captured: AppWsOutbound[] = []
  harness.appWsRegistry.register(
    appWsTopic.channel_topic_id,
    (env) => captured.push(env),
    { platform: 'web' },
  )
  const msg: OutgoingMessage = {
    topic: appWsTopic,
    text: 'See [plan](docs:/acme/launch-plan.md?line=42).',
  }
  await harness.router.send(msg)
  expect(captured.length).toBe(1)
  const env = captured[0]!
  if (env.type !== 'agent_message') throw new Error('expected agent_message')
  // `webAppBase()` (LIVE), not the eagerly-snapshotted `WEB_APP_BASE`
  // constant: the rewriter under test recomputes the base per call (see
  // `wire-types/doc-links.ts:127`), while the constant froze at THIS file's
  // module load. A sibling file that sets the base env at ITS module load
  // and never restores it (`runtime/__tests__/doc-links.test.ts:32`,
  // `runtime/__tests__/doc-links-parity.test.ts:21`) therefore made the
  // expected and produced values disagree purely on execution ORDER.
  // Resolving both sides the same way pins the identical rewrite shape
  // under any ambient env — nothing is relaxed.
  expect(env.body).toBe(
    `See [plan](${webAppBase()}/projects/acme/docs?path=launch-plan.md&line=42).`,
  )
})

test('production composer: app-ws native platform keeps neutron:// + ?line=42', async () => {
  // P7.3 § 6.3 row #4 — platform-aware native URL with anchor.
  const captured: AppWsOutbound[] = []
  harness.appWsRegistry.register(
    appWsTopic.channel_topic_id,
    (env) => captured.push(env),
    { platform: 'native' },
  )
  const msg: OutgoingMessage = {
    topic: appWsTopic,
    text: 'See [plan](docs:/acme/launch-plan.md?line=42).',
  }
  await harness.router.send(msg)
  expect(captured.length).toBe(1)
  const env = captured[0]!
  if (env.type !== 'agent_message') throw new Error('expected agent_message')
  expect(env.body).toBe(
    `See [plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md?line=42).`,
  )
})

test('production composer: vault-legacy doc_ref (project_id null) resolves to vault.example.test', async () => {
  // P7.3 § 6.3 row #5 — structured doc_refs reach-through, both
  // adapters. Vault-legacy refs are whole-file; the URL is identical
  // across channels.
  // (a) AppWs side
  const captured: AppWsOutbound[] = []
  harness.appWsRegistry.register(
    appWsTopic.channel_topic_id,
    (env) => captured.push(env),
    { platform: 'web' },
  )
  await harness.router.send({
    topic: appWsTopic,
    text: 'vault ref',
    adapter_options: {
      doc_refs: [{ project_id: null, path: 'Projects/neutron/STATUS.md' }],
    },
  })
  const env = captured[0]!
  if (env.type !== 'agent_message') throw new Error('expected agent_message')
  expect(env.doc_refs).toEqual([
    {
      label: 'STATUS',
      url: `${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md`,
      project_id: null,
      path: 'Projects/neutron/STATUS.md',
    },
  ])

  // (b) Telegram side
  await harness.router.send({
    topic: telegramTopic,
    text: 'see refs',
    adapter_options: {
      doc_refs: [{ project_id: null, path: 'Projects/neutron/STATUS.md' }],
    },
  })
  const telSent = harness.telegramSent[0]!
  expect(telSent.parse_mode).toBe('MarkdownV2')
  // Telegram appends a "Linked docs:" trailer block with the resolved URL.
  // The URL ships INSIDE a `[label](url)` MarkdownV2 link payload —
  // per Telegram MarkdownV2 spec only `)` and `\` need escaping
  // inside `(...)`, so the URL's `.` chars stay literal. Bullet `•`
  // and the prefixing label `STATUS` are emitted unescaped (the
  // label's `.`-free).
  expect(telSent.text).toContain(
    `${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md`,
  )
  expect(telSent.text).toContain('Linked docs:')
})

test('production composer: ?range=N-M marker survives the rewriter (P7.2 reserve)', async () => {
  // P7.3 § 6.3 row #6 — reserved range syntax. The rewriter MUST round-
  // trip range_start/range_end through buildDocLink so P7.2's inline-
  // comment side-pane can consume the URL when that work ships without
  // a parser migration.
  const captured: AppWsOutbound[] = []
  harness.appWsRegistry.register(
    appWsTopic.channel_topic_id,
    (env) => captured.push(env),
    { platform: 'native' },
  )
  await harness.router.send({
    topic: appWsTopic,
    text: 'highlight [block](docs:/acme/launch-plan.md?range=10-20).',
  })
  const env = captured[0]!
  if (env.type !== 'agent_message') throw new Error('expected agent_message')
  expect(env.body).toBe(
    `highlight [block](${NEUTRON_SCHEME}://docs/acme/launch-plan.md?range=10-20).`,
  )

  // And on Telegram — the rewriter still emits the URL with the range
  // query intact so a tap fires the deep-link with the anchor.
  await harness.router.send({
    topic: telegramTopic,
    text: 'highlight [block](docs:/acme/launch-plan.md?range=10-20).',
  })
  const sent = harness.telegramSent[0]!
  expect(sent.parse_mode).toBe('MarkdownV2')
  expect(sent.text).toContain(
    `${NEUTRON_SCHEME}://docs/acme/launch-plan.md?range=10-20`,
  )
})
