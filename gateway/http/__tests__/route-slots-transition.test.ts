/**
 * C4 transition test — the GENERATED ladder === the pre-C4 literal ladder.
 *
 * The literal arrays/tables in this file are a SNAPSHOT of the hand-rolled
 * `dispatchRequest` ladder, `buildComposedHttpFromComposition` mapping, and
 * `hasAnyChainedSurface` gate as they stood at `main@b723a42` (the C4 base).
 * The registry (`gateway/http/route-slots.ts`) must keep generating exactly
 * that routing order + mapping + gate membership. Any reorder / drop / add
 * of a rung, any change to a slot's match condition, mapping shape, or gate
 * flag fails here and must be an EXPLICIT, separately-reasoned change to
 * this snapshot.
 *
 * Four layers:
 *   1. registry snapshot — rung order + per-slot metadata (key, composition
 *      field, gate flag, ws flag, static match) as literal tables;
 *   2. behavioral ladder order — recording stubs prove the composed handler
 *      consults surfaces in exactly the snapshot order, first-match-wins;
 *   3. static match conditions — each match-gated rung fires ONLY under its
 *      pre-C4 literal `(path|prefix, method)` / predicate condition;
 *   4. generated mapping + gate — `buildComposeSurfaces` reproduces the
 *      pre-C4 field-by-field promotion (incl. the `{handler}` plucks and
 *      the admin-respawn wrap) and `hasAnyChainedSurface` equals the
 *      pre-C4 31-field gate PLUS the four documented divergence-fix
 *      fields (`chat_history_surface` / `chat_topics_surface` /
 *      `import_resume_handler` / `auth_gate` were mapped-but-not-gating
 *      before C4 — the one intended §C4 behavior change).
 */

import { describe, expect, test } from 'bun:test'
import type { Server, WebSocketHandler } from 'bun'

import { composeHttpHandler, type ComposeHttpHandlerInput } from '../compose.ts'
import {
  buildComposeSurfaces,
  CHAINED_SURFACE_COMPOSITION_KEYS,
  hasAnyChainedSurface,
  ROUTE_SLOTS,
  type RouteSlotComposition,
  type SurfaceHandler,
} from '../route-slots.ts'

const FAKE_SERVER = {} as unknown as Server<unknown>
const NOOP_WS = {
  open(): void {},
  message(): void {},
  close(): void {},
} as unknown as WebSocketHandler<unknown>

// ─────────────────────────────────────────────────────────────────────────
// 1. Registry snapshot — the pre-C4 ladder, literally.
// ─────────────────────────────────────────────────────────────────────────

/** [rung, input key, composition field (or null), gated] in LADDER ORDER. */
const EXPECTED_LADDER: ReadonlyArray<[string, string, string | null, boolean]> = [
  ['dev-mint-session', 'devMintSession', null, false],
  ['internal-cache-invalidate', 'internalCacheInvalidateHandler', 'internal_cache_invalidate', true],
  ['admin-respawn', 'adminRespawn', 'admin_respawn_handler', true],
  ['slug-check', 'slugCheckHandler', 'slug_check_handler', true],
  // C4 divergence fix (the one intended §C4 behavior change): chat-history /
  // chat-topics / import-resume were MAPPED but missing from the pre-C4
  // hand-maintained gate; every mapped surface now chain-gates.
  ['chat-history', 'chatHistory', 'chat_history_surface', true],
  ['chat-topics', 'chatTopics', 'chat_topics_surface', true],
  ['avatar', 'avatarHandler', 'avatar_handler', true],
  ['profile-pic-candidate', 'candidateHandler', 'candidate_handler', true],
  ['chunked-upload', 'chunkedUploadHandler', 'chunked_upload_handler', true],
  ['import-resume', 'importResumeHandler', 'import_resume_handler', true],
  ['import-upload', 'importUploadHandler', 'import_upload_handler', true],
  ['app-ws', 'appWs', 'app_ws_surface', true],
  ['app-upload', 'appUpload', 'app_upload_surface', true],
  ['app-launcher', 'appLauncher', 'app_launcher_surface', true],
  ['app-tasks', 'appTasks', 'app_tasks_surface', true],
  ['app-reminders', 'appReminders', 'app_reminders_surface', true],
  ['app-tabs', 'appTabs', 'app_tabs_surface', true],
  ['app-work-board', 'appWorkBoard', 'app_work_board_surface', true],
  ['app-project-credentials', 'appProjectCredentials', 'app_project_credentials_surface', true],
  ['app-codex-credential', 'appCodexCredential', 'app_codex_credential_surface', true],
  ['app-projects', 'appProjects', 'app_projects_surface', true],
  ['app-connect-auth', 'appConnectAuth', 'app_connect_auth_surface', true],
  ['app-focus-current', 'appFocusCurrent', 'app_focus_current_surface', true],
  ['app-focus', 'appFocus', 'app_focus_surface', true],
  ['app-diagnostics', 'appDiagnostics', 'app_diagnostics_surface', true],
  ['app-admin', 'appAdmin', 'app_admin_surface', true],
  ['app-persona', 'appPersona', 'app_persona_surface', true],
  ['app-devices', 'appDevices', 'app_devices_surface', true],
  ['app-docs', 'appDocs', 'app_docs_surface', true],
  ['app-backups', 'appBackups', 'app_backups_surface', true],
  ['cores-oauth', 'coresOAuth', 'cores_oauth_surface', true],
  ['cores-integrations', 'coresIntegrations', 'cores_integrations_surface', true],
  ['cores', 'cores', 'cores_surface', true],
  ['telegram-webhook', 'telegramWebhookHandler', 'telegram_webhook', true],
  ['landing.pathset', 'landing', 'landing_server', true],
  ['landing.spa', 'landing', null, false],
  ['connect', 'connectHandler', 'connect_api', true],
]

/** The pre-C4 static match conditions, literally (rung → match spec). */
const EXPECTED_MATCHES: Record<
  string,
  { path?: string; prefix?: string; method?: string } | 'predicate' | undefined
> = {
  'dev-mint-session': undefined,
  'internal-cache-invalidate': { path: '/internal/cache-invalidate', method: 'POST' },
  'admin-respawn': undefined,
  'slug-check': { path: '/api/v1/slug/check', method: 'GET' },
  'chat-history': undefined,
  'chat-topics': undefined,
  avatar: { path: '/avatar.png', method: 'GET' },
  'profile-pic-candidate': { prefix: '/profile-pic/candidate/', method: 'GET' },
  'chunked-upload': undefined,
  'import-resume': undefined,
  'import-upload': { prefix: '/api/upload/', method: 'POST' },
  'telegram-webhook': { path: '/webhook/telegram', method: 'POST' },
  'landing.pathset': 'predicate',
  'landing.spa': 'predicate',
  connect: undefined,
}

describe('C4 transition — registry snapshot equals the pre-C4 literal ladder', () => {
  test('rung order + keys + composition fields + gate flags match the b723a42 snapshot', () => {
    const actual = ROUTE_SLOTS.map(
      (s) => [s.rung, s.key, s.composition, s.gated] as [string, string, string | null, boolean],
    )
    expect(actual).toEqual([...EXPECTED_LADDER])
  })

  test('rung labels are unique (the transition snapshot addresses rungs by label)', () => {
    const rungs = ROUTE_SLOTS.map((s) => s.rung)
    expect(new Set(rungs).size).toBe(rungs.length)
  })

  test('static match conditions match the b723a42 snapshot', () => {
    for (const s of ROUTE_SLOTS) {
      const expected = EXPECTED_MATCHES[s.rung]
      if (expected === undefined) {
        expect(s.match).toBeUndefined()
      } else if (expected === 'predicate') {
        expect(typeof s.match?.when).toBe('function')
      } else {
        expect({
          ...(s.match?.path !== undefined ? { path: s.match.path } : {}),
          ...(s.match?.prefix !== undefined ? { prefix: s.match.prefix } : {}),
          ...(s.match?.method !== undefined ? { method: s.match.method } : {}),
        }).toEqual(expected)
      }
    }
  })

  test('exactly the landing + app-ws slots contribute websocket handlers', () => {
    expect(ROUTE_SLOTS.filter((s) => s.ws === true).map((s) => s.rung)).toEqual([
      'app-ws',
      'landing.pathset',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2 + 3. Behavioral ladder order — recording stubs through the REAL handler.
// ─────────────────────────────────────────────────────────────────────────

/** Rungs with no static match (their surface disclaims via `null`), in
 *  ladder order — the consultation sequence every request walks. */
const DISCLAIMING_ORDER = [
  'dev-mint-session',
  'admin-respawn',
  'chat-history',
  'chat-topics',
  'chunked-upload',
  'import-resume',
  'app-ws',
  'app-upload',
  'app-launcher',
  'app-tasks',
  'app-reminders',
  'app-tabs',
  'app-work-board',
  'app-project-credentials',
  'app-codex-credential',
  'app-projects',
  'app-connect-auth',
  'app-focus-current',
  'app-focus',
  'app-diagnostics',
  'app-admin',
  'app-persona',
  'app-devices',
  'app-docs',
  'app-backups',
  'cores-oauth',
  'cores-integrations',
  'cores',
  'connect',
] as const

function sentinel(name: string): Response {
  return new Response(JSON.stringify({ surface: name }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function answered(res: Response): Promise<string | number> {
  if (res.status !== 200) return res.status
  try {
    const body = (await res.json()) as { surface?: unknown }
    return typeof body.surface === 'string' ? body.surface : res.status
  } catch {
    return res.status
  }
}

/** Wire EVERY compose-input surface: null-disclaiming rungs record + fall
 *  through; match-gated rungs record + answer (they only run when their
 *  static match passed, so answering pins the match position). */
function fullyWiredInput(calls: string[]): ComposeHttpHandlerInput {
  const disclaim = (name: string): SurfaceHandler => ({
    handler: async (): Promise<Response | null> => {
      calls.push(name)
      return null
    },
  })
  const answer =
    (name: string): ((req: Request) => Promise<Response>) =>
    async (): Promise<Response> => {
      calls.push(name)
      return sentinel(name)
    }
  return {
    defaultHandler: (): Response => {
      calls.push('default')
      return new Response('Not Found', { status: 404 })
    },
    devMintSession: disclaim('dev-mint-session'),
    internalCacheInvalidateHandler: {
      invalidateOwnerHandle: (): void => {},
      expectedToken: 'transition-secret',
    },
    adminRespawn: disclaim('admin-respawn'),
    slugCheckHandler: answer('slug-check'),
    chatHistory: disclaim('chat-history'),
    chatTopics: disclaim('chat-topics'),
    avatarHandler: answer('avatar'),
    candidateHandler: answer('profile-pic-candidate'),
    chunkedUploadHandler: async (): Promise<Response | null> => {
      calls.push('chunked-upload')
      return null
    },
    importResumeHandler: async (): Promise<Response | null> => {
      calls.push('import-resume')
      return null
    },
    importUploadHandler: answer('import-upload'),
    appWs: {
      handler: async (): Promise<Response | null> => {
        calls.push('app-ws')
        return null
      },
      websocket: NOOP_WS,
    },
    appUpload: disclaim('app-upload'),
    appLauncher: disclaim('app-launcher'),
    appTasks: disclaim('app-tasks'),
    appReminders: disclaim('app-reminders'),
    appTabs: disclaim('app-tabs'),
    appWorkBoard: disclaim('app-work-board'),
    appProjectCredentials: disclaim('app-project-credentials'),
    appCodexCredential: disclaim('app-codex-credential'),
    appProjects: disclaim('app-projects'),
    appConnectAuth: disclaim('app-connect-auth'),
    appFocusCurrent: disclaim('app-focus-current'),
    appFocus: disclaim('app-focus'),
    appDiagnostics: disclaim('app-diagnostics'),
    appAdmin: disclaim('app-admin'),
    appPersona: disclaim('app-persona'),
    appDevices: disclaim('app-devices'),
    appDocs: disclaim('app-docs'),
    appBackups: disclaim('app-backups'),
    coresOAuth: disclaim('cores-oauth'),
    coresIntegrations: disclaim('cores-integrations'),
    cores: disclaim('cores'),
    telegramWebhookHandler: answer('telegram-webhook'),
    landing: {
      fetch: (): Response => {
        calls.push('landing')
        return sentinel('landing')
      },
      websocket: NOOP_WS,
    },
    connectHandler: async (): Promise<Response | null> => {
      calls.push('connect')
      return null
    },
  }
}

function fire(
  input: ComposeHttpHandlerInput,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const handler = composeHttpHandler(input)
  return Promise.resolve(handler.fetch(new Request(`http://127.0.0.1${path}`, init), FAKE_SERVER))
}

describe('C4 transition — behavioral ladder order (fully wired, recording)', () => {
  test('an unowned path walks EVERY disclaiming rung in the literal pre-C4 order, then default', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/definitely-unowned')
    expect(res.status).toBe(404)
    // Match-gated rungs (cache-invalidate, slug-check, avatar, candidate,
    // import-upload, telegram, landing, SPA) are skipped — their static
    // conditions don't match — exactly like the pre-C4 inline guards.
    expect(calls).toEqual([...DISCLAIMING_ORDER, 'default'])
  })

  test('POST /webhook/telegram — telegram answers AFTER cores, BEFORE landing/connect', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/webhook/telegram', { method: 'POST' })
    expect(await answered(res)).toBe('telegram-webhook')
    // Every disclaiming rung ahead of telegram was consulted (connect is the
    // only disclaiming rung BEHIND it and must be absent).
    expect(calls).toEqual([
      ...DISCLAIMING_ORDER.filter((r) => r !== 'connect'),
      'telegram-webhook',
    ])
  })

  test('GET /chat — landing path-set answers after every earlier rung disclaimed', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/chat')
    expect(await answered(res)).toBe('landing')
    expect(calls).toEqual([...DISCLAIMING_ORDER.filter((r) => r !== 'connect'), 'landing'])
  })

  test('GET /projects/p1 — SPA catch-all delegates to landing (single fetch, before connect)', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/projects/p1')
    expect(await answered(res)).toBe('landing')
    // landing.fetch ran exactly ONCE (via the SPA rung; the path-set rung
    // did not match /projects/p1) and connect was never reached.
    expect(calls).toEqual([...DISCLAIMING_ORDER.filter((r) => r !== 'connect'), 'landing'])
  })

  test('GET /?invite=abc — root-with-invite is a landing path-set match', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/?invite=abc')
    expect(await answered(res)).toBe('landing')
  })

  test('POST /internal/cache-invalidate without token → 403 from the cache-invalidate rung (mounted, token-gated)', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/internal/cache-invalidate', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    // Only dev-mint-session precedes it in the ladder.
    expect(calls).toEqual(['dev-mint-session'])
  })

  test('GET /api/v1/slug/check — slug-check answers; only earlier rungs consulted', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/api/v1/slug/check')
    expect(await answered(res)).toBe('slug-check')
    expect(calls).toEqual(['dev-mint-session', 'admin-respawn', 'slug-check'])
  })

  test('GET /avatar.png + GET /profile-pic/candidate/c1.png fire their exact/prefix rungs', async () => {
    expect(await answered(await fire(fullyWiredInput([]), '/avatar.png'))).toBe('avatar')
    expect(
      await answered(await fire(fullyWiredInput([]), '/profile-pic/candidate/c1.png')),
    ).toBe('profile-pic-candidate')
  })

  test('POST /api/upload/chatgpt — chunked disclaims FIRST, then import-resume, then legacy answers', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/api/upload/chatgpt', { method: 'POST' })
    expect(await answered(res)).toBe('import-upload')
    expect(calls).toEqual([
      'dev-mint-session',
      'admin-respawn',
      'chat-history',
      'chat-topics',
      'chunked-upload',
      'import-resume',
      'import-upload',
    ])
  })

  // Static-condition negatives — the pre-C4 inline guards, preserved.
  const NEGATIVES: ReadonlyArray<[string, string, RequestInit | undefined]> = [
    ['GET /webhook/telegram (POST-only rung)', '/webhook/telegram', undefined],
    ['POST /avatar.png (GET-only rung)', '/avatar.png', { method: 'POST' }],
    ['POST /api/v1/slug/check (GET-only rung)', '/api/v1/slug/check', { method: 'POST' }],
    ['GET /internal/cache-invalidate (POST-only rung)', '/internal/cache-invalidate', undefined],
    ['GET /api/upload/chatgpt (POST-only rung)', '/api/upload/chatgpt', undefined],
    ['GET / without ?invite (not a landing path)', '/', undefined],
  ]
  for (const [label, path, init] of NEGATIVES) {
    test(`${label} falls through to default 404`, async () => {
      const calls: string[] = []
      const res = await fire(fullyWiredInput(calls), path, init)
      expect(res.status).toBe(404)
      expect(calls[calls.length - 1]).toBe('default')
    })
  }

  test('POST /projects/p1 is NOT an SPA route — falls through landing to connect, then default', async () => {
    const calls: string[] = []
    const res = await fire(fullyWiredInput(calls), '/projects/p1', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(calls).toEqual([...DISCLAIMING_ORDER, 'default'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Generated mapping + gate === the pre-C4 literal mapping + gate.
// ─────────────────────────────────────────────────────────────────────────

/** A full composition stub with DISTINCT function identities per field so
 *  the mapping assertions can verify exact promotion (incl. plucks/wraps). */
function fullComposition(): RouteSlotComposition {
  const h = (): ((req: Request) => Promise<Response | null>) => async () => null
  return {
    landing_server: { fetch: () => new Response('x'), websocket: NOOP_WS },
    telegram_webhook: { handler: async () => new Response('x') },
    internal_cache_invalidate: {
      invalidateOwnerHandle: (): void => {},
      expectedToken: 't',
    },
    slug_check_handler: async () => new Response('x'),
    admin_respawn_handler: h(),
    chat_history_surface: { handler: h() },
    chat_topics_surface: { handler: h() },
    avatar_handler: () => new Response('x'),
    candidate_handler: () => new Response('x'),
    import_upload_handler: async () => new Response('x'),
    chunked_upload_handler: h(),
    import_resume_handler: h(),
    app_ws_surface: { handler: async () => null, websocket: NOOP_WS },
    app_upload_surface: { handler: h() },
    app_launcher_surface: { handler: h() },
    app_tasks_surface: { handler: h() },
    app_reminders_surface: { handler: h() },
    app_projects_surface: { handler: h() },
    app_connect_auth_surface: { handler: h() },
    app_focus_surface: { handler: h() },
    app_focus_current_surface: { handler: h() },
    app_diagnostics_surface: { handler: h() },
    app_admin_surface: { handler: h() },
    app_persona_surface: { handler: h() },
    app_devices_surface: { handler: h() },
    app_docs_surface: { handler: h() },
    app_tabs_surface: { handler: h() },
    app_work_board_surface: { handler: h() },
    app_project_credentials_surface: { handler: h() },
    app_codex_credential_surface: { handler: h() },
    app_backups_surface: { handler: h() },
    cores_surface: { handler: h() },
    cores_oauth_surface: { handler: h() },
    cores_integrations_surface: { handler: h() },
    connect_api: {},
    auth_gate: {},
  }
}

/**
 * The `hasAnyChainedSurface` gate list: the pre-C4 literal 31 fields PLUS
 * the four divergence-fix fields (C4's one intended behavior change —
 * `chat_history_surface`, `chat_topics_surface`, `import_resume_handler`,
 * `auth_gate` were mapped-but-missing in the pre-C4 hand-maintained gate).
 */
const GATE_FIELDS: readonly (keyof RouteSlotComposition)[] = [
  'landing_server',
  'telegram_webhook',
  'connect_api',
  'internal_cache_invalidate',
  'slug_check_handler',
  'admin_respawn_handler',
  'avatar_handler',
  'candidate_handler',
  'import_upload_handler',
  'chunked_upload_handler',
  'app_ws_surface',
  'app_upload_surface',
  'app_launcher_surface',
  'app_tasks_surface',
  'app_reminders_surface',
  'app_projects_surface',
  'app_connect_auth_surface',
  'app_focus_surface',
  'app_focus_current_surface',
  'app_diagnostics_surface',
  'app_admin_surface',
  'app_persona_surface',
  'app_devices_surface',
  'app_docs_surface',
  'app_tabs_surface',
  'app_work_board_surface',
  'app_project_credentials_surface',
  'app_codex_credential_surface',
  'app_backups_surface',
  'cores_surface',
  'cores_oauth_surface',
  'cores_integrations_surface',
  // ── C4 divergence-fix additions (RATCHET CHANGE, documented) ──────────
  // These four were MAPPED into the chain but omitted from the pre-C4
  // hand-maintained gate, so a composition supplying only one of them
  // silently served nothing (graph.fetch === undefined). The C4 registry
  // makes every mapped surface chain-gating; the pre-C4 drift was pinned by
  // open-route-matrix.test.ts Part 3, updated in the same commit.
  'chat_history_surface',
  'chat_topics_surface',
  'import_resume_handler',
  'auth_gate',
]

describe('C4 — generated gate = pre-C4 literal gate + the documented divergence fix', () => {
  test('gate membership is exactly the pre-C4 31-field list + O5 app_diagnostics_surface + the 4 divergence-fix fields', () => {
    expect(new Set(CHAINED_SURFACE_COMPOSITION_KEYS)).toEqual(new Set(GATE_FIELDS))
  })

  test('empty composition → no chain', () => {
    expect(hasAnyChainedSurface({})).toBe(false)
  })

  for (const field of GATE_FIELDS) {
    test(`supplying ONLY ${String(field)} builds the chain`, () => {
      const full = fullComposition()
      expect(hasAnyChainedSurface({ [field]: full[field] } as RouteSlotComposition)).toBe(true)
    })
  }
})

describe('C4 transition — generated mapping equals the pre-C4 literal mapping', () => {
  test('every composition surface promotes onto its pre-C4 compose-input field (exact shapes)', () => {
    const c = fullComposition()
    const out = buildComposeSurfaces(c)

    // Identity promotions.
    expect(out.landing).toBe(c.landing_server)
    expect(out.internalCacheInvalidateHandler).toBe(c.internal_cache_invalidate)
    expect(out.slugCheckHandler).toBe(c.slug_check_handler)
    expect(out.avatarHandler).toBe(c.avatar_handler)
    expect(out.candidateHandler).toBe(c.candidate_handler)
    expect(out.importUploadHandler).toBe(c.import_upload_handler)
    expect(out.chunkedUploadHandler).toBe(c.chunked_upload_handler)
    expect(out.importResumeHandler).toBe(c.import_resume_handler)

    // `.handler` pluck (bare function on the compose side).
    expect(out.telegramWebhookHandler).toBe(c.telegram_webhook!.handler)

    // Bare-function → `{handler}` wrap.
    expect(out.adminRespawn?.handler).toBe(c.admin_respawn_handler!)

    // `{handler}` re-plucks (fresh object, same handler identity).
    expect(out.chatHistory?.handler).toBe(c.chat_history_surface!.handler)
    expect(out.chatTopics?.handler).toBe(c.chat_topics_surface!.handler)
    expect(out.appUpload?.handler).toBe(c.app_upload_surface!.handler)
    expect(out.appLauncher?.handler).toBe(c.app_launcher_surface!.handler)
    expect(out.appTasks?.handler).toBe(c.app_tasks_surface!.handler)
    expect(out.appReminders?.handler).toBe(c.app_reminders_surface!.handler)
    expect(out.appTabs?.handler).toBe(c.app_tabs_surface!.handler)
    expect(out.appWorkBoard?.handler).toBe(c.app_work_board_surface!.handler)
    expect(out.appProjectCredentials?.handler).toBe(c.app_project_credentials_surface!.handler)
    expect(out.appCodexCredential?.handler).toBe(c.app_codex_credential_surface!.handler)
    expect(out.appProjects?.handler).toBe(c.app_projects_surface!.handler)
    expect(out.appConnectAuth?.handler).toBe(c.app_connect_auth_surface!.handler)
    expect(out.appFocusCurrent?.handler).toBe(c.app_focus_current_surface!.handler)
    expect(out.appFocus?.handler).toBe(c.app_focus_surface!.handler)
    expect(out.appAdmin?.handler).toBe(c.app_admin_surface!.handler)
    expect(out.appPersona?.handler).toBe(c.app_persona_surface!.handler)
    expect(out.appDevices?.handler).toBe(c.app_devices_surface!.handler)
    expect(out.appDocs?.handler).toBe(c.app_docs_surface!.handler)
    expect(out.appBackups?.handler).toBe(c.app_backups_surface!.handler)
    expect(out.cores?.handler).toBe(c.cores_surface!.handler)
    expect(out.coresOAuth?.handler).toBe(c.cores_oauth_surface!.handler)
    expect(out.coresIntegrations?.handler).toBe(c.cores_integrations_surface!.handler)

    // app-ws carries BOTH handler + websocket through.
    expect(out.appWs?.handler).toBe(c.app_ws_surface!.handler)
    expect(out.appWs?.websocket).toBe(c.app_ws_surface!.websocket)

    // NOT promoted here, exactly like pre-C4:
    //   - devMintSession has no composition seam (pinned negative space);
    //   - connectHandler requires the dynamic import in composition.ts;
    //   - authGate is a non-rung promotion in composition.ts.
    expect(out.devMintSession).toBeUndefined()
    expect(out.connectHandler).toBeUndefined()
    expect('authGate' in out).toBe(false)
  })

  test('omitted composition fields promote NOTHING (no key materializes)', () => {
    const out = buildComposeSurfaces({})
    expect(Object.keys(out)).toEqual([])
  })
})
