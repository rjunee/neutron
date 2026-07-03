/**
 * Open live project-rail refresh — `projects_changed` app-ws emit wiring.
 *
 * THE BUG (P2 follow-up to #84): the served `/chat` HTML injects the owner's
 * project list ONCE at page-load. A brand-new owner bootstraps with NONE; when
 * onboarding CREATES projects in the SAME session there was no signal to
 * refresh, so the Documents/Tasks/Admin tabs only appeared after a manual
 * reload (`open/composer.ts` projectsBootstrapScript).
 *
 * THE FIX: after each onboarding turn the composer snapshots the `projects`
 * table and, when it changed, fans an `AppWsOutboundProjectsChanged` frame over
 * the owner's `/ws/app/chat` topic so the React client refreshes its rail + tabs
 * live.
 *
 * This boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket (which seeds the empty baseline at connect),
 * inserts a project the way onboarding's wow-moment shells would, drives ONE
 * onboarding turn, and asserts a `projects_changed` frame carrying the new
 * project arrives on the socket — no reload.
 *
 * No ANTHROPIC_API_KEY is set — the box boots LLM-less; the onboarding engine
 * walks its static phase prompts and the emit wiring does not depend on LLM
 * credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import type { AppWsOutbound } from '../../channels/adapters/app-ws/envelope.ts'
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
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-projects-changed-'))
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

describe('Open projects_changed live-refresh wiring', () => {
  test('fans a projects_changed frame after onboarding creates a project', async () => {
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    const events: AppWsOutbound[] = []
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as AppWsOutbound)
    }
    // session_ready triggers on_session_open → the empty projects baseline.
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    // Ensure the baseline snapshot (empty set) is recorded before we insert.
    await sleep(50)

    // Onboarding's wow-moment creates a project shell in the SAME session.
    await harness.db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      ['acme', 'Acme', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )

    // Drive ONE onboarding turn — the composer re-snapshots after the advance
    // and, seeing the set changed, fans projects_changed over this socket.
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c-1' }))

    // PR-6 seeds a projects_changed frame on connect (mobile-rail freshness), so the
    // FIRST frame is the empty pre-insert snapshot; assert on the onboarding frame that
    // actually carries the new project (preserves this test's intent).
    await waitFor(
      () => events.some((e) => e.type === 'projects_changed' && e.projects.some((p) => p.id === 'acme')),
      25_000,
    )
    const frame = events.find((e) => e.type === 'projects_changed' && e.projects.some((p) => p.id === 'acme'))
    if (frame === undefined || frame.type !== 'projects_changed') {
      throw new Error('expected a projects_changed frame')
    }
    // The frame carries the rail-redesign fields alongside id + label.
    expect(frame.projects.map((p) => ({ id: p.id, label: p.label }))).toEqual([
      { id: 'acme', label: 'Acme' },
    ])
    const acme = frame.projects.find((p) => p.id === 'acme')
    expect(typeof acme?.emoji).toBe('string')
    expect((acme?.emoji ?? '').length).toBeGreaterThan(0)
    expect(acme?.unread).toBe(0)
    // Suggests the first project as the one to auto-select (rail→tabs live).
    expect(frame.active_project_id).toBe('acme')

    ws.close()
    await sleep(50)
  }, 30_000)

  // THE BUG (this dispatch): #132 wired the create-project fan, but only to the
  // user-scoped General topic `app:<user>`. The served web client opens ONE
  // socket scoped to whichever project it is viewing (`app:<user>:<project>`),
  // so clicking "Create Project" from INSIDE a project never refreshed the rail
  // until a reload. THE FIX: `fanProjectsChanged` fans the frame to the base
  // topic AND every live per-project topic. This drives the REAL HTTP create
  // endpoint (`POST /api/app/projects`) — the SAME `createProjectAndRefresh` →
  // `emitProjectsChangedNow` path the `create_project` agent tool uses — against
  // BOTH a project-scoped socket and a General socket, and asserts the new
  // project reaches both live, no reload.
  test('POST /api/app/projects fans projects_changed to a project-scoped web socket AND General', async () => {
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')

    // An existing project the client is currently VIEWING (scoped socket).
    await harness.db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      ['acme', 'Acme', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )

    // Socket #1 — inside project 'acme' → topic `app:owner:acme`.
    const scopedEvents: AppWsOutbound[] = []
    const scoped = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web&project_id=acme`)
    // Socket #2 — General → topic `app:owner`.
    const generalEvents: AppWsOutbound[] = []
    const general = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        scoped.onopen = () => resolve()
        scoped.onerror = (e) => reject(new Error(`scoped ws error: ${JSON.stringify(e)}`))
      }),
      new Promise<void>((resolve, reject) => {
        general.onopen = () => resolve()
        general.onerror = (e) => reject(new Error(`general ws error: ${JSON.stringify(e)}`))
      }),
    ])
    scoped.onmessage = (ev) => {
      scopedEvents.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as AppWsOutbound)
    }
    general.onmessage = (ev) => {
      generalEvents.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as AppWsOutbound)
    }
    // Both sockets must be registered before the create fans.
    await waitFor(() => scopedEvents.some((e) => e.type === 'session_ready'))
    await waitFor(() => generalEvents.some((e) => e.type === 'session_ready'))

    // The REAL Create Project button → POST /api/app/projects. Owner-bearer
    // (dev:owner → user_id 'owner' = OWNER_USER_ID). This creates the row + fans
    // the live rail refresh (no reload).
    const res = await fetch(`${harness.base}/api/app/projects`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:owner', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Beta' }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { ok: boolean; project: { id: string; label: string }; created: boolean }
    expect(created.ok).toBe(true)
    expect(created.created).toBe(true)
    expect(created.project).toEqual({ id: 'beta', label: 'Beta' })

    // The scoped socket (viewing 'acme') is where #132 dropped the frame — it
    // MUST now carry the new project so the rail updates without a reload.
    // PR-6 connect-seed emits a projects_changed frame before 'beta' exists; select the
    // frame that carries the newly-created project, not the first (connect) frame.
    await waitFor(
      () => scopedEvents.some((e) => e.type === 'projects_changed' && e.projects.some((p) => p.id === 'beta')),
      25_000,
    )
    const scopedFrame = scopedEvents.find((e) => e.type === 'projects_changed' && e.projects.some((p) => p.id === 'beta'))
    if (scopedFrame === undefined || scopedFrame.type !== 'projects_changed') {
      throw new Error('expected a projects_changed frame on the project-scoped socket')
    }
    expect(scopedFrame.projects.map((p) => p.id).sort()).toEqual(['acme', 'beta'])
    const scopedBeta = scopedFrame.projects.find((p) => p.id === 'beta')
    expect({ id: scopedBeta?.id, label: scopedBeta?.label }).toEqual({ id: 'beta', label: 'Beta' })
    expect((scopedBeta?.emoji ?? '').length).toBeGreaterThan(0)

    // No regression — the General socket still receives the same refresh.
    await waitFor(
      () => generalEvents.some((e) => e.type === 'projects_changed' && e.projects.some((p) => p.id === 'beta')),
      25_000,
    )
    const generalFrame = generalEvents.find((e) => e.type === 'projects_changed' && e.projects.some((p) => p.id === 'beta'))
    if (generalFrame === undefined || generalFrame.type !== 'projects_changed') {
      throw new Error('expected a projects_changed frame on the General socket')
    }
    const generalBeta = generalFrame.projects.find((p) => p.id === 'beta')
    expect({ id: generalBeta?.id, label: generalBeta?.label }).toEqual({ id: 'beta', label: 'Beta' })

    scoped.close()
    general.close()
    await sleep(50)
  }, 30_000)
})
