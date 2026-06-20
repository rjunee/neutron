/**
 * ISSUE #36 — end-to-end persona wiring test for the LlmRouter answer path.
 *
 * Closing condition (from ISSUES.md):
 *   "PATCH SOUL.md via admin → next router-answer turn carries the
 *    new SOUL body (assertable end-to-end via the router's classifier
 *    prompt inspection)."
 *
 * Mirrors `admin-personality-persona-wiring.test.ts` (PR #283 / ISSUE
 * #30) but exercises the LlmRouter classifier surface, not the phase-
 * spec resolver. The full chain the production composer wires:
 *
 *   1. Construct ONE shared `PersonaPromptLoader({ owner_home })`.
 *   2. Pass `onReload: (name) => loader.invalidate(name)` into
 *      `createAdminPersonalitySurface`.
 *   3. Build `buildGatewayLlmRouter({ personaLoader: loader, ... })`
 *      against a stub `AnthropicMessagesClient` that captures every
 *      `messages.create` arg.
 *   4. Call `router.route(...)` once → assert captured `system`
 *      contains the ORIGINAL SOUL body + `# Persona` header.
 *   5. PATCH SOUL.md via the admin surface.
 *   6. Call `router.route(...)` again → assert captured `system`
 *      contains the NEW SOUL body (the patch landed without a
 *      restart).
 *
 * If the production composer ever drops the `personaLoader:
 * personaPromptLoader` thread from `buildGatewayLlmRouter` (or
 * constructs a different loader instance from the one passed to
 * `createAdminPersonalitySurface`), this end-to-end assertion breaks
 * even though every unit test in `onboarding/interview/` would still
 * pass — the router-classifier surface only sees persona when the
 * composer threads the loader through.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { createAdminPersonalitySurface } from '../http/admin-personality-surface.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { buildGatewayLlmRouter } from '../realmode-composer/build-llm-router.ts'
import { PersonaPromptLoader } from '../realmode-composer/persona-loader.ts'
import type {
  AnthropicMessagesClient,
  LlmRouter,
  RouterInput,
} from '../../onboarding/interview/llm-router.ts'

const OWNER = 'router-persona-wiring-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  owner_home: string
  capturedSystemPrompts: string[]
  personaLoader: PersonaPromptLoader
  router: LlmRouter
  callRouter: () => Promise<void>
  close(): Promise<void>
}

function buildStubAnthropic(capture: string[]): AnthropicMessagesClient {
  return {
    messages: {
      async create(args) {
        // Capture the spliced system verbatim for assertion. The
        // wrapper inside `buildGatewayLlmRouter` is the splice site we
        // care about — if it ever dropped the persona block, this
        // capture would not contain it.
        capture.push(args.system ?? '')
        return {
          content: [
            {
              text: JSON.stringify({
                action: 'answer',
                confidence: 0.95,
                choice_value: null,
                freeform_text: null,
                response: 'stub answer',
                state_delta: null,
                reasoning: 'stub',
                candidate_alternatives: [],
              }),
            },
          ],
        }
      },
    },
  }
}

function buildRouterInput(): RouterInput {
  return {
    phase: 'signup',
    active_prompt: {
      body: 'what brings you here?',
      options: [],
      allow_freeform: true,
      pick_only: false,
    },
    user_text: 'why do you need this?',
    knowledge: {
      why_we_ask: 'to set up your agent',
      faqs: { foo: 'bar' },
      expected_tangents: [
        {
          user_text_example: 'why do you need this?',
          expected_action: 'answer',
          summary: 'route to faq',
        },
      ],
      advance_examples: [],
    },
    captured: {},
    recent_turns: [],
    project_slug: OWNER,
    user_id: 'user-1',
  }
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-router-persona-wiring-'))
  const owner_home = join(tmp, 'owner_home')
  mkdirSync(join(owner_home, 'persona'), { recursive: true })
  // Seed the initial SOUL body so the first router turn picks it up.
  writeFileSync(
    join(owner_home, 'persona', 'SOUL.md'),
    'SOUL_INITIAL_VOICE\n',
    'utf8',
  )

  // The SHARED loader — every consumer reads/invalidates this instance.
  const personaLoader = new PersonaPromptLoader({ owner_home, log: () => {} })

  // Admin-personality surface wires onReload → loader.invalidate,
  // EXACTLY as gateway/index.ts does in the production composer.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const personaSurface = createAdminPersonalitySurface({
    auth,
    owner_home,
    project_slug: OWNER,
    onReload: (name) => personaLoader.invalidate(name),
  })

  // Stub Anthropic client that captures the system prompt for assertion.
  const capturedSystemPrompts: string[] = []
  const stubClient = buildStubAnthropic(capturedSystemPrompts)

  // Build the router via the gateway composer — this is the splice
  // site under test. The wrapper inside `buildGatewayLlmRouter`
  // re-composes `system` via `composeSystemPrompt` so the persona
  // block lands above the classifier framing on every turn.
  const router = buildGatewayLlmRouter({
    anthropicClient: stubClient,
    personaLoader,
    // Short timeouts so the test stays fast even if the stub ever
    // takes longer than expected — the stub resolves synchronously
    // so this should never actually fire.
    options: { haiku_timeout_ms: 2000, sonnet_timeout_ms: 2000 },
  })

  const callRouter = async (): Promise<void> => {
    await router.route(buildRouterInput())
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
    owner_home,
    capturedSystemPrompts,
    personaLoader,
    router,
    callRouter,
    close: async (): Promise<void> => {
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function authedFetch(
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

let h: Harness
beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  await h.close()
})

test('PATCH SOUL.md via admin surface → next router LLM call carries the new body', async () => {
  // 1) First router turn — original SOUL body should be spliced.
  await h.callRouter()
  expect(h.capturedSystemPrompts.length).toBe(1)
  expect(h.capturedSystemPrompts[0]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[0]).toContain('# Persona')
  // The classifier framing must still be present below the persona
  // block — composeSystemPrompt prepends, it does not replace.
  expect(h.capturedSystemPrompts[0]).toContain('onboarding router')

  // 2) Read the current mtime so PATCH passes the optimistic-lock check.
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

  // 4) Next router turn — the new body must be spliced. The
  //    onReload→invalidate wire ensures the loader's cache entry got
  //    dropped, so loader.load() re-reads from disk before
  //    composeSystemPrompt prepends it to the classifier framing.
  await h.callRouter()
  expect(h.capturedSystemPrompts.length).toBe(2)
  expect(h.capturedSystemPrompts[1]).toContain('SOUL_AFTER_ADMIN_EDIT')
  expect(h.capturedSystemPrompts[1]).not.toContain('SOUL_INITIAL_VOICE')
})

test('restart-from-scratch unlinks files → next router LLM call drops the persona block', async () => {
  // Seed USER.md too so the persona block is non-empty pre-restart.
  writeFileSync(join(h.owner_home, 'persona', 'USER.md'), 'USER_PRE_RESTART\n', 'utf8')
  await h.callRouter()
  expect(h.capturedSystemPrompts[0]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[0]).toContain('USER_PRE_RESTART')

  const restartRes = await authedFetch(h.base, '/api/app/persona/restart-from-scratch', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  })
  expect(restartRes.status).toBe(200)
  const restartBody = (await restartRes.json()) as { ok: boolean; files_deleted: string[] }
  expect(restartBody.ok).toBe(true)
  expect(restartBody.files_deleted.sort()).toEqual(['SOUL.md', 'USER.md'].sort())

  await h.callRouter()
  // Both seeded bodies must be gone from the next router system
  // prompt — every unlink fires onReload which invalidates the cache
  // entry, and the next loader.load() finds no files →
  // composeSystemPrompt short-circuits to `base` byte-identical so
  // the `# Persona` header disappears entirely.
  expect(h.capturedSystemPrompts[1]).not.toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[1]).not.toContain('USER_PRE_RESTART')
  expect(h.capturedSystemPrompts[1]).not.toContain('# Persona')
})

test('PATCH on USER.md does not bust the SOUL.md cache (per-filename invalidation on the router path)', async () => {
  writeFileSync(join(h.owner_home, 'persona', 'USER.md'), 'USER_INITIAL\n', 'utf8')
  await h.callRouter()
  expect(h.capturedSystemPrompts[0]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[0]).toContain('USER_INITIAL')

  const userFile = await authedFetch(h.base, '/api/app/persona/file?name=USER.md')
  const xMtime = Number(userFile.headers.get('x-mtime'))
  // PATCH USER.md only — SOUL.md cache must survive on the router
  // path (same per-filename invalidation contract the resolver path
  // already enforces).
  await authedFetch(h.base, '/api/app/persona/file?name=USER.md', {
    method: 'PATCH',
    body: JSON.stringify({ content: 'USER_AFTER_PATCH\n', expected_mtime: xMtime }),
  })

  await h.callRouter()
  expect(h.capturedSystemPrompts[1]).toContain('SOUL_INITIAL_VOICE')
  expect(h.capturedSystemPrompts[1]).toContain('USER_AFTER_PATCH')
  expect(h.capturedSystemPrompts[1]).not.toContain('USER_INITIAL')
})

test('no personaLoader threaded → router system prompt has no # Persona header (back-compat)', async () => {
  // Same harness shape but no personaLoader wired — confirms the
  // wrapper is a true no-op when the dep is unset (legacy boot paths,
  // unit tests that care only about the classifier contract).
  const capturedSystemPrompts: string[] = []
  const stubClient = buildStubAnthropic(capturedSystemPrompts)
  const router = buildGatewayLlmRouter({
    anthropicClient: stubClient,
    // personaLoader deliberately omitted.
    options: { haiku_timeout_ms: 2000, sonnet_timeout_ms: 2000 },
  })
  await router.route(buildRouterInput())
  expect(capturedSystemPrompts.length).toBe(1)
  expect(capturedSystemPrompts[0]).not.toContain('# Persona')
  expect(capturedSystemPrompts[0]).toContain('onboarding router')
})

test('personaLoader threaded but persona dir empty → no # Persona header (composeSystemPrompt short-circuit)', async () => {
  // Wipe seeded files so the loader returns empty on every call —
  // composeSystemPrompt then returns `base` byte-identical and the
  // `# Persona` header should NOT appear.
  rmSync(join(h.owner_home, 'persona', 'SOUL.md'), { force: true })
  await h.callRouter()
  expect(h.capturedSystemPrompts[0]).not.toContain('# Persona')
  expect(h.capturedSystemPrompts[0]).toContain('onboarding router')
})
