/**
 * Open per-project OPENING recovery on project-topic entry (item 1 / 4b,
 * 2026-06-30 fresh-install fix).
 *
 * THE BUG: the deterministic per-project opening message was a fire-once side
 * effect of onboarding finalize. When that eager emit raced the project-tab
 * socket, was swallowed, or the whole finalize was delayed under cold-turn load,
 * the project topic was left with ZERO `button_prompts` rows (DB-confirmed on the
 * live box: 6 projects, 0 `app:<user>:<project>` rows) and the client wedged on
 * its empty state — a reload never recovered it (reload only regenerated the
 * GENERAL welcome).
 *
 * THE FIX: on every steady-state connect to a MATERIALIZED project topic that has
 * no message yet, the composer regenerates + persists the SAME deterministic
 * opening (STATUS.md summary + one next move) finalize would have. This test
 * boots the REAL Open composition LLM-less, marks onboarding completed (steady
 * state), inserts a project + writes its STATUS.md, opens the project-topic
 * socket, and asserts a `button_prompts` row carrying the STATUS summary lands on
 * `app:owner:acme` — the exact row Issue 1 says never appears.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
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
  db: ProjectDb
  ownerHome: string
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-opening-recovery-'))
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
    db,
    ownerHome: tmpDir,
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

function countRowsOnTopic(db: ProjectDb, topic_id: string): number {
  const row = db
    .raw()
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM button_prompts WHERE topic_id = ?`)
    .get(topic_id)
  return row?.n ?? 0
}

function bodyOnTopic(db: ProjectDb, topic_id: string): string | null {
  const row = db
    .raw()
    .query<{ body: string }, [string]>(
      `SELECT body FROM button_prompts WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(topic_id)
  return row?.body ?? null
}

describe('Open per-project opening recovery on entry', () => {
  test('seeds the deterministic opening into a materialized project topic with no messages', async () => {
    harness = await startHarness()

    // Steady state: a completed onboarding row, so the composer's
    // `isOnboardingActive` is false and the recovery branch runs.
    await harness.db.run(
      `INSERT INTO onboarding_state (project_slug, user_id, phase, started_at, last_advanced_at)
       VALUES ('owner', 'owner', 'completed', ?, ?)`,
      [Date.now(), Date.now()],
    )
    // A materialized project (the rail's source of truth).
    await harness.db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      ['acme', 'Acme', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )
    // Its materialized STATUS.md — the highest-signal opening source.
    const statusDir = join(harness.ownerHome, 'Projects', 'acme')
    mkdirSync(statusDir, { recursive: true })
    writeFileSync(
      join(statusDir, 'STATUS.md'),
      [
        '---',
        'one_liner: "Acme is the flagship infra rebuild"',
        'status: active',
        'priority: P1',
        '---',
        '',
        '# Acme',
        '',
        'Acme is the flagship infra rebuild.',
        '',
      ].join('\n'),
      'utf8',
    )

    const projectTopic = 'app:owner:acme'
    expect(countRowsOnTopic(harness.db, projectTopic)).toBe(0)

    // Open the PROJECT-topic socket (on_session_open → recovery).
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web&project_id=acme`)
    const events: Array<{ type?: string }> = []
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await waitFor(() => events.some((e) => e.type === 'session_ready'))

    // The deterministic opening row lands on the PROJECT topic.
    await waitFor(() => countRowsOnTopic(harness!.db, projectTopic) >= 1)
    const body = bodyOnTopic(harness.db, projectTopic)
    expect(body).not.toBeNull()
    // Composed from STATUS.md (summary + state), not a generic name re-ask.
    expect(body as string).toContain('Acme is the flagship infra rebuild')
    expect(body as string).toMatch(/Here's where Acme stands/)

    // Codex r1 P2 — the opening must also LIVE-render on the just-connected PROJECT
    // socket (not just hydrate on a future reload): an `agent_message` frame
    // carrying the opening reaches THIS socket after session_ready.
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === 'agent_message' &&
          JSON.stringify(e).includes('Acme is the flagship infra rebuild'),
      ),
    )

    ws.close()
    await sleep(50)
  }, 30_000)

  test('does NOT seed an opening when the project topic already has a message', async () => {
    harness = await startHarness()
    await harness.db.run(
      `INSERT INTO onboarding_state (project_slug, user_id, phase, started_at, last_advanced_at)
       VALUES ('owner', 'owner', 'completed', ?, ?)`,
      [Date.now(), Date.now()],
    )
    await harness.db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      ['acme', 'Acme', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )
    // Pre-seed an existing message on the project topic so the topic is NOT empty.
    const projectTopic = 'app:owner:acme'
    await harness.db.run(
      `INSERT INTO button_prompts
         (prompt_id, topic_id, body, options_json, allow_freeform, expires_at, created_at)
       VALUES (?, ?, ?, '[]', 1, ?, ?)`,
      ['pre-1', projectTopic, 'an earlier turn', Date.now() + 10_000_000, Date.now()],
    )
    expect(countRowsOnTopic(harness.db, projectTopic)).toBe(1)

    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web&project_id=acme`)
    const events: Array<{ type?: string }> = []
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    // Give the recovery a chance to (not) run.
    await sleep(200)
    // No opening was injected above the existing conversation.
    expect(countRowsOnTopic(harness.db, projectTopic)).toBe(1)

    ws.close()
    await sleep(50)
  }, 30_000)
})
