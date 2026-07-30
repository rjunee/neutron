/**
 * ACTIVITY INSPECTOR — the DONE-MEANS-SERVED test (SPEC § WAVE 3.5).
 *
 * The repo's single most recurring defect is a module whose own tests pass while no
 * composer ever calls it (persona-gen: built, never wired, shipped placeholders for
 * months). So this test refuses to mock the middle. It boots the REAL Open composer
 * and drives the full chain a live tool call takes:
 *
 *   the tool-tap hook's POST  →  the loopback sink's `/activity` route
 *                             →  the closure the COMPOSER registered via
 *                                `setReplActivityTap`
 *                             →  the in-memory inspector ring
 *                             →  `GET /api/app/projects/<id>/activity`
 *
 * Nothing in that path is stubbed. If the composer stops constructing the inspector,
 * stops registering the tap, or stops handing the surface to the graph, this fails —
 * which is exactly what "wired but not served does not count" has to mean mechanically.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { getReplSinkInfo } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'

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
let tmpDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-actin-served-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-actin-served'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ready' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

interface ActivityBody {
  scope_key: string
  project_id: string | null
  events: Array<{ seq: number; kind: string; label: string; detail?: string; synthetic?: boolean }>
  state: string
  last_event_age_ms: number | null
  last_real_activity_age_ms: number | null
  turn_in_flight: boolean
}

async function withComposition(
  body: (c: {
    handler: (req: Request) => Promise<Response | null>
    get: (path: string) => Promise<Response | null>
  }) => Promise<void>,
): Promise<void> {
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  try {
    const surface = (composition as unknown as Record<string, unknown>)['app_activity_surface'] as
      | { handler: (req: Request) => Promise<Response | null> }
      | undefined
    // The composer MUST have constructed + supplied the surface. This is the
    // done-means-served gate, not a nicety.
    expect(surface).toBeDefined()
    await body({
      handler: surface!.handler,
      get: (path) =>
        surface!.handler(
          new Request(`http://127.0.0.1${path}`, {
            // The surface is bearer-gated exactly like tabs/work-board; the
            // single-owner dev path accepts the instance slug.
            headers: { authorization: 'Bearer owner' },
          }),
        ),
    })
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
    db.close()
  }
}

/** POST to the loopback sink exactly as the Pre/PostToolUse hook does. */
async function tapPost(payload: Record<string, unknown>): Promise<Response> {
  const info = getReplSinkInfo()
  return fetch(`http://127.0.0.1:${info.port}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sink-Token': info.token },
    body: JSON.stringify(payload),
  })
}

describe('Activity Inspector — served end-to-end through the real Open composer', () => {
  test('the surface answers for a project scope AND the General scope', async () => {
    await withComposition(async ({ get }) => {
      const proj = await get('/api/app/projects/proj-1/activity')
      expect(proj?.status).toBe(200)
      const pb = (await proj!.json()) as ActivityBody
      expect(pb.scope_key).toBe('proj-1')
      expect(pb.project_id).toBe('proj-1')
      // A never-touched scope is empty + idle, never an error and never "wedged".
      expect(pb.events).toEqual([])
      expect(pb.state).toBe('idle')
      expect(pb.last_event_age_ms).toBeNull()

      // General is a first-class scope — mobile and web both model a no-project
      // General chat with its own warm session, so it must be inspectable without a
      // project row existing anywhere.
      const gen = await get('/api/app/activity')
      expect(gen?.status).toBe(200)
      const gb = (await gen!.json()) as ActivityBody
      expect(gb.scope_key).toBe('general')
      expect(gb.project_id).toBeNull()
    })
  })

  test('a tool-tap POST reaches the HTTP snapshot — the whole chain, unmocked', async () => {
    await withComposition(async ({ get }) => {
      // This is what the CC subprocess hook does on a real `Bash` call.
      const pre = await tapPost({
        session_id: 'unregistered',
        phase: 'pre',
        tool_name: 'Bash',
        detail: 'bun test open/',
      })
      expect(pre.status).toBe(200)

      // An unregistered session degrades to the General scope (see the sink route's
      // comment) — assert the row landed THERE, so the test pins real behaviour
      // rather than a hoped-for scope.
      const res = await get('/api/app/activity')
      const body = (await res!.json()) as ActivityBody
      expect(body.events).toHaveLength(1)
      expect(body.events[0]?.kind).toBe('tool_start')
      expect(body.events[0]?.label).toBe('Bash')
      expect(body.events[0]?.detail).toBe('bun test open/')
      // A tool row is REAL activity, so both clocks moved.
      expect(body.last_event_age_ms).not.toBeNull()
      expect(body.last_real_activity_age_ms).not.toBeNull()

      // The finish half arrives as its own row: a `pre` with no `post` is the hang
      // signal, so they must be distinct rows, not a mutation of one.
      await tapPost({ session_id: 'unregistered', phase: 'post', tool_name: 'Bash', detail: '' })
      const res2 = await get('/api/app/activity')
      const body2 = (await res2!.json()) as ActivityBody
      expect(body2.events.map((e) => e.kind)).toEqual(['tool_start', 'tool_end'])
      expect(body2.events.map((e) => e.seq)).toEqual([1, 2])
    })
  })

  test('the surface is bearer-gated and read-only', async () => {
    await withComposition(async ({ handler }) => {
      const noAuth = await handler(new Request('http://127.0.0.1/api/app/activity'))
      expect(noAuth?.status).toBe(401)

      const write = await handler(
        new Request('http://127.0.0.1/api/app/activity', {
          method: 'POST',
          headers: { authorization: 'Bearer owner' },
        }),
      )
      // Read-only: the buffer is produced by the server's own taps, never a client.
      expect(write?.status).toBe(405)
    })
  })

  test('returns null (falls through the ladder) for an unrelated path', async () => {
    await withComposition(async ({ handler }) => {
      const other = await handler(
        new Request('http://127.0.0.1/api/app/projects/p/work-board', {
          headers: { authorization: 'Bearer owner' },
        }),
      )
      expect(other).toBeNull()
    })
  })

  test('rejects a malformed project id rather than mis-scoping the buffer', async () => {
    await withComposition(async ({ get }) => {
      const bad = await get('/api/app/projects/has%20a%20space/activity')
      expect(bad?.status).toBe(400)
    })
  })
})
