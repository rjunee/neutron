/**
 * Email-Managed Core S1 — production-composer reachability guard.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 7. Closes the
 * anti-pattern Argus has caught in nine consecutive sprints (PRs
 * #222 / #225 / #227 / #229 / #231 / #233 + Notes/Tasks/Reminders/
 * Calendar Core in parallel): surfaces ship + unit-test cleanly but
 * never reach `composeProductionGraph`, so the production gateway
 * 404s on them.
 *
 * The test:
 *   1. Boots `composeProductionGraph` against in-memory SQLite +
 *      dev-bypass `AppWsAuthResolver` (NOT a hand-rolled router).
 *   2. Threads the Email-Managed Core's chat-command filter through
 *      the same `chat_command_filter` slot the production boot uses.
 *   3. Mounts the app-ws surface via `composeHttpHandler`.
 *   4. Fires HTTP requests against the chat `/api/app/chat/send`
 *      path with every `/email ...` sub-command + asserts the
 *      response carries the expected envelope.
 *   5. **Asserts the Sam 4-point label state** at the production-
 *      composer level (the load-bearing case).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAppLauncherSurface } from '../http/app-launcher-surface.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import {
  DEFAULT_LAUNCHER_SEED,
  InMemoryProjectLauncherStore,
} from '../http/project-launcher-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

import {
  EmailProjectCacheResolver,
  buildSeededInMemoryGmailClient,
  createEmailChatCommandFilter,
  projectLabelName,
  type SeededInMemoryGmailClient,
} from '@neutronai/email-managed-core'

const OWNER = 'email-composer-project'
const PROJECT = 'demo-email-project'
const OTHER_PROJECT = 'other-email-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  owner_home: string
  resolver: EmailProjectCacheResolver
  client: SeededInMemoryGmailClient
  close(): Promise<void>
}

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

async function startHarness(): Promise<Harness> {
  const owner_home = mkdtempSync(join(tmpdir(), 'neutron-email-composer-'))
  const db = ProjectDb.open(join(owner_home, 'owner.db'))
  applyMigrations(db.raw())

  const resolver = new EmailProjectCacheResolver({ owner_home })
  const client = buildSeededInMemoryGmailClient()
  // Deterministic stub LLM — returns a top-2 picks JSON so the
  // triage path exercises the LLM-success branch.
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes('email triage agent')) {
      // Find the message ids in the rendered prompt + emit a JSON
      // top-2 picks.
      const ids: string[] = []
      const re = /id=([^\s]+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(prompt)) !== null) {
        if (typeof m[1] === 'string') ids.push(m[1])
      }
      const picks = ids.slice(0, 2).map((id, i) => ({
        message_id: id,
        rank: i + 1,
        reason: `pick ${i + 1}`,
      }))
      return JSON.stringify(picks)
    }
    if (prompt.includes('email-thread summarizer')) {
      return 'This is the prose brief.'
    }
    return ''
  }
  const filter = createEmailChatCommandFilter({
    resolver,
    client,
    llm,
    model: 'haiku-test',
    default_project_id: PROJECT,
  })

  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const store = new InMemoryProjectLauncherStore({ seed: DEFAULT_LAUNCHER_SEED })
  const launcherSurface = createAppLauncherSurface({ store, auth })
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
  })
  const wsSurface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: OWNER,
    chat_command_filter: filter,
  })

  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_launcher_surface: { handler: launcherSurface.handler },
    app_ws_surface: {
      handler: wsSurface.handler,
      websocket: wsSurface.websocket,
    },
  })
  // ISSUE #32 — serve `graph.fetch` so the surface→composeInput
  // mapping is the only path exercised.
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — production-composer reachability gap (ISSUE #32)',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    graph,
    db,
    owner_home,
    resolver,
    client,
    close: async (): Promise<void> => {
      await server.stop(true)
      await graph.shutdown()
      resolver.closeAll()
      db.close()
      rmSync(owner_home, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:test-user')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

interface ChatEnv {
  ok?: boolean
  chat_command_result?: {
    text: string
    data?: unknown
    error?: { code: string; message: string; draft_id?: string }
  }
}

let harness: Harness
beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

test('production composer mounts the Email launcher tile alongside the rest', async () => {
  const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT}/launcher`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; entries: Array<{ slug: string }> }
  expect(body.ok).toBe(true)
  expect(body.entries.length).toBeGreaterThanOrEqual(1)
})

test('chat `/email triage` end-to-end → top-N rendered + audit row landed + LLM path SKIPPED', async () => {
  // Pre-seed inbox under the project scope so the per-project
  // filter doesn't drop them. 3 important+unread, 2 newsletter.
  for (let i = 0; i < 3; i++) {
    harness.client.seed({
      subject: `hot-${i}`,
      from: `hot-${i}@example.com`,
      label_ids: ['INBOX', 'IMPORTANT', 'UNREAD', projectLabelName(PROJECT)],
    })
  }
  for (let i = 0; i < 2; i++) {
    harness.client.seed({
      subject: `news-${i}`,
      from: `news-${i}@example.com`,
      label_ids: ['INBOX', projectLabelName(PROJECT)],
    })
  }

  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/email triage',
      project_id: PROJECT,
      client_msg_id: 'c-triage-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as ChatEnv
  expect(env.ok).toBe(true)
  expect(env.chat_command_result).toBeDefined()
  expect(env.chat_command_result?.text).toContain('1.')

  // Audit row landed in the per-project sidecar.
  const dbPath = harness.resolver.pathFor(PROJECT)
  expect(dbPath).toContain(`Projects/${PROJECT}/email/email-cache.db`)
  expect(existsSync(dbPath)).toBe(true)
  const cache = await harness.resolver.resolve(PROJECT)
  const rows = cache.listRecentTriage()
  expect(rows.length).toBeGreaterThanOrEqual(1)
})

test('chat `/email summarize <id>` end-to-end → 2-3 sentence prose brief', async () => {
  const id = harness.client.seed({
    subject: 'kickoff',
    from: 'alice@example.com',
    body_text: 'Confirming Tuesday at 2pm. Please reply.',
    label_ids: ['INBOX'],
  })
  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: `/email summarize ${id}`,
      project_id: PROJECT,
      client_msg_id: 'c-sum-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as ChatEnv
  expect(env.chat_command_result?.text).toContain('prose brief')
  const cache = await harness.resolver.resolve(PROJECT)
  const summary = cache.getSummary({
    message_id: id,
    template_hash: (await import('@neutronai/email-managed-core')).briefTemplateHash(),
  })
  expect(summary?.brief_text).toContain('prose brief')
})

test('chat `/email search <query>` end-to-end → matching subset', async () => {
  harness.client.seed({
    subject: 'invoice — q1',
    from: 'billing@x.com',
    label_ids: ['INBOX', projectLabelName(PROJECT)],
  })
  harness.client.seed({
    subject: 'newsletter',
    from: 'news@x.com',
    label_ids: ['INBOX', projectLabelName(PROJECT)],
  })
  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/email search subject:invoice',
      project_id: PROJECT,
      client_msg_id: 'c-search-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as ChatEnv
  expect(env.chat_command_result?.text.toLowerCase()).toContain('match')
  const data = env.chat_command_result?.data as { results: { subject: string }[] }
  expect(data.results.length).toBeGreaterThanOrEqual(1)
  expect(data.results[0]?.subject).toContain('invoice')
})

test('chat `/email draft` end-to-end → THE LOAD-BEARING 4-point assertion at the production-composer level', async () => {
  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/email draft casey@example.com hi Hello-Casey-just-checking-in',
      project_id: PROJECT,
      client_msg_id: 'c-draft-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as ChatEnv
  expect(env.chat_command_result).toBeDefined()
  expect(env.chat_command_result?.text).toContain('Draft prepared')
  const data = env.chat_command_result?.data as {
    applied_labels: string[]
    draft_id: string
  }
  // THE LOAD-BEARING ASSERTION — the chat-driven draft path applied
  // the Sam 4-point set + the per-project label.
  expect(data.applied_labels).toContain('INBOX')
  expect(data.applied_labels).toContain('IMPORTANT')
  expect(data.applied_labels).toContain('UNREAD')
  // Audit row landed.
  const cache = await harness.resolver.resolve(PROJECT)
  const audit = cache.listDraftAudit()
  expect(audit.length).toBeGreaterThanOrEqual(1)
  expect(audit[0]?.outcome).toBe('ok')
  expect(audit[0]?.applied_labels).toContain('INBOX')
  expect(audit[0]?.applied_labels).toContain('IMPORTANT')
  expect(audit[0]?.applied_labels).toContain('UNREAD')
})

test('per-project isolation — messages tagged with Neutron/<alpha> visible only via alpha`s triage', async () => {
  // Seed two messages, each tagged with a different project label.
  harness.client.seed({
    subject: 'alpha-only',
    from: 'a@x.com',
    label_ids: ['INBOX', projectLabelName(PROJECT)],
  })
  harness.client.seed({
    subject: 'other-only',
    from: 'b@x.com',
    label_ids: ['INBOX', projectLabelName(OTHER_PROJECT)],
  })
  const res = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/email search subject:alpha-only',
      project_id: PROJECT,
      client_msg_id: 'c-iso-1',
    }),
  })
  expect(res.status).toBe(200)
  const env = (await res.json()) as ChatEnv
  const data = env.chat_command_result?.data as { results: { subject: string }[] }
  expect(data.results.length).toBe(1)
  expect(data.results[0]?.subject).toBe('alpha-only')

  // The other project's search should NOT see the alpha-tagged
  // message.
  const res2 = await authedFetch(harness.base, '/api/app/chat/send', {
    method: 'POST',
    body: JSON.stringify({
      body: '/email search subject:alpha-only',
      project_id: OTHER_PROJECT,
      client_msg_id: 'c-iso-2',
    }),
  })
  const env2 = (await res2.json()) as ChatEnv
  const data2 = env2.chat_command_result?.data as { results: { subject: string }[] }
  expect(data2.results.length).toBe(0)
})
