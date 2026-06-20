/**
 * ISSUE #30 — end-to-end persona wiring test.
 *
 * Closing condition (from ISSUES.md):
 *   "edit SOUL.md via the new admin tab → next chat turn renders with
 *    the new persona body".
 *
 * This test exercises the FULL chain the production composer wires:
 *
 *   1. Construct ONE shared `PersonaPromptLoader({ owner_home })`.
 *   2. Pass `onReload: (name) => loader.invalidate(name)` into
 *      `createAdminPersonalitySurface`.
 *   3. Build `buildPhaseSpecResolver({ personaLoader: loader, … })`
 *      against a mocked Anthropic fetch.
 *   4. Resolve once → assert the system prompt contains the ORIGINAL
 *      SOUL body.
 *   5. PATCH SOUL.md via the admin surface.
 *   6. Resolve again → assert the system prompt contains the NEW SOUL
 *      body (the patch landed without a restart).
 *
 * If the production composer ever loses the `onReload` wire (or
 * constructs a different loader instance from the one passed to the
 * resolver), this end-to-end assertion breaks even though every unit
 * test would still pass.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { createAdminPersonalitySurface } from '../http/admin-personality-surface.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { buildPhaseSpecResolver } from '../realmode-composer/build-phase-spec-resolver.ts'
import { PersonaPromptLoader } from '../realmode-composer/persona-loader.ts'
import type { Substrate, AgentSpec } from '../../runtime/substrate.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'

// Sprint cc-substrate-migration-3-sites (2026-05-31) — production code
// now consumes a `Substrate` rather than resolving credentials internally.
// The fake substrate pushes `spec.prompt` into the supplied `captured`
// array so existing tests keep their `capturedSystemPrompts[i].toContain(...)`
// shape. spec.prompt packs `<composed system>\n\n<user>` per the new
// contract — the system body (with the persona splice) is the prefix.
function fakeSubstrate(captured: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      captured.push(spec.prompt)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: JSON.stringify({ body: 'hi' }) }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'persona-wiring-fake',
        }
      })()
      return {
        events,
        respondToTool: async () => {
          throw new Error('fake substrate: respondToTool unused')
        },
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
}

const OWNER = 'persona-wiring-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  db: ProjectDb
  owner_home: string
  capturedSystemPrompts: string[]
  personaLoader: PersonaPromptLoader
  callResolver: () => Promise<void>
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-persona-wiring-'))
  const owner_home = join(tmp, 'owner_home')
  mkdirSync(join(owner_home, 'persona'), { recursive: true })
  // Seed the initial SOUL body so the first agent turn picks it up.
  writeFileSync(
    join(owner_home, 'persona', 'SOUL.md'),
    'SOUL_INITIAL_VOICE\n',
    'utf8',
  )

  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())

  // The SHARED loader — every consumer reads/invalidates this instance.
  const personaLoader = new PersonaPromptLoader({ owner_home, log: () => {} })

  // Admin-personality surface wires onReload → loader.invalidate, EXACTLY
  // as gateway/index.ts does in the production composer.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const personaSurface = createAdminPersonalitySurface({
    auth,
    owner_home,
    project_slug: OWNER,
    onReload: (name) => personaLoader.invalidate(name),
  })

  // The phase-spec resolver wraps every LLM call with a closure that
  // calls personaLoader.load() and splices the bodies via
  // composeSystemPrompt. The fake substrate captures `spec.prompt` per
  // call — which packs `<composed system>\n\n<user>` (the system body
  // containing the SOUL splice is the prefix of every captured string).
  const capturedSystemPrompts: string[] = []
  const resolver = await buildPhaseSpecResolver({
    substrate: fakeSubstrate(capturedSystemPrompts),
    log_slug: OWNER,
    env: {
      NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
    },
    owner_data_dir: null, // isolate from skills/conventions path
    personaLoader,
  })
  if (resolver === null) throw new Error('resolver build returned null — env misconfigured')

  const callResolver = async (): Promise<void> => {
    await resolver.resolve({
      project_slug: OWNER,
      topic_id: 'web:user-1',
      user_id: 'user-1',
      signup_via: 'web',
      telegram_display_name: null,
      phase: 'signup',
      intent: {
        goal: 'g',
        shape: 'free-text',
        allowed_option_values: [],
        max_body_chars: 200,
      },
      captured: {},
      recent_turns: [],
      attempt_count: 0,
      rejection_reason: null,
    })
  }

  const composed = composeHttpHandler({
    appPersona: { handler: personaSurface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    db,
    owner_home,
    capturedSystemPrompts,
    personaLoader,
    callResolver,
    close: async (): Promise<void> => {
      await server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function authedFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:test-user')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

let h: Harness
beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  await h.close()
})

test('PATCH SOUL.md via admin surface → next LLM call carries the new body', async () => {
  // 1) First agent turn — original SOUL body should be spliced.
  await h.callResolver()
  expect(h.capturedSystemPrompts.length).toBe(1)
  expect(h.capturedSystemPrompts[0]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[0]).toContain('# Persona')

  // 2) Read the current mtime so PATCH passes the optimistic-lock check.
  const filesRes = await authedFetch(h.base, '/api/app/persona/files')
  const filesBody = (await filesRes.json()) as {
    ok: boolean
    files: Array<{ filename: string; exists: boolean; last_modified_iso: string | null }>
  }
  const soulEntry = filesBody.files.find((f) => f.filename === 'SOUL.md')
  expect(soulEntry?.exists).toBe(true)
  const fileRes = await authedFetch(h.base, '/api/app/persona/file?name=SOUL.md')
  const xMtime = Number(fileRes.headers.get('x-mtime'))
  expect(xMtime).toBeGreaterThan(0)

  // 3) PATCH SOUL.md with a brand-new body — simulating the admin tab.
  const patchRes = await authedFetch(h.base, '/api/app/persona/file?name=SOUL.md', {
    method: 'PATCH',
    body: JSON.stringify({
      content: 'SOUL_AFTER_ADMIN_EDIT\n',
      expected_mtime: xMtime,
    }),
  })
  expect(patchRes.status).toBe(200)
  const patchBody = (await patchRes.json()) as { ok: boolean; mtime: number }
  expect(patchBody.ok).toBe(true)

  // 4) Next agent turn — the new body must be spliced. The
  //    onReload→invalidate wire ensures the loader's cache entry got
  //    dropped, so loader.load() re-reads from disk.
  await h.callResolver()
  expect(h.capturedSystemPrompts.length).toBe(2)
  expect(h.capturedSystemPrompts[1]).toContain('SOUL_AFTER_ADMIN_EDIT')
  expect(h.capturedSystemPrompts[1]).not.toContain('SOUL_INITIAL_VOICE')
})

test('restart-from-scratch unlinks files → next LLM call drops the persona block', async () => {
  // Seed USER.md too so the persona block is non-empty pre-restart.
  writeFileSync(join(h.owner_home, 'persona', 'USER.md'), 'USER_PRE_RESTART\n', 'utf8')
  await h.callResolver()
  expect(h.capturedSystemPrompts[0]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[0]).toContain('USER_PRE_RESTART')

  const restartRes = await authedFetch(h.base, '/api/app/persona/restart-from-scratch', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  })
  expect(restartRes.status).toBe(200)
  const restartBody = (await restartRes.json()) as { ok: boolean; files_deleted: string[] }
  expect(restartBody.ok).toBe(true)
  // Both seeded files should be in files_deleted.
  expect(restartBody.files_deleted.sort()).toEqual(['SOUL.md', 'USER.md'].sort())

  await h.callResolver()
  // Both seeded bodies must be gone from the next system prompt — every
  // unlink fires onReload which invalidates the cache entry, and the
  // next loader.load() finds no files.
  expect(h.capturedSystemPrompts[1]).not.toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[1]).not.toContain('USER_PRE_RESTART')
  expect(h.capturedSystemPrompts[1]).not.toContain('# Persona')
})

test('PATCH on USER.md does not bust the SOUL.md cache (per-filename invalidation)', async () => {
  writeFileSync(join(h.owner_home, 'persona', 'USER.md'), 'USER_INITIAL\n', 'utf8')
  await h.callResolver()
  expect(h.capturedSystemPrompts[0]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[0]).toContain('USER_INITIAL')

  const userFile = await authedFetch(h.base, '/api/app/persona/file?name=USER.md')
  const xMtime = Number(userFile.headers.get('x-mtime'))
  // PATCH USER.md only — SOUL.md cache must survive.
  await authedFetch(h.base, '/api/app/persona/file?name=USER.md', {
    method: 'PATCH',
    body: JSON.stringify({ content: 'USER_AFTER_PATCH\n', expected_mtime: xMtime }),
  })

  await h.callResolver()
  expect(h.capturedSystemPrompts[1]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[1]).toContain('USER_AFTER_PATCH')
  expect(h.capturedSystemPrompts[1]).not.toContain('USER_INITIAL')
})
