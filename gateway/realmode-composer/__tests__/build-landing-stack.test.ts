/**
 * Sprint 19 Phase 3 — landing-stack factory tests.
 *
 * Two surfaces under test:
 *   - `resolveLandingStaticDir` — env override + repo-fallback + the
 *     two error paths (env points at a non-existent dir; env unset and
 *     fallback missing).
 *   - `buildLandingStack` — the factory wires real ButtonStore +
 *     SqliteOnboardingStateStore + TranscriptWriter + sender registry +
 *     bridge, then returns a `LandingStack` (`{ fetch, websocket }`).
 *     The construction itself is the unit test; the Phase 6 e2e exercises
 *     the engine.start path end-to-end.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportJWK, type KeyLike } from 'jose'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { JwksCache } from '../../../jwt-validator/validator.ts'
import {
  issueStartToken,
  verifyStartToken,
  claimStartTokenJti,
  buildStartTokenTestPlatform,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'
import type { SlugHistoryShimStore } from '../../http/chat-bridge.ts'
import {
  buildLandingStack,
  resolveLandingStaticDir,
} from '../build-landing-stack.ts'

// C2 OSS-split (2026-06-10) — start-token auth is injection-only now:
// chat-bridge's lazy dynamic-import fallback of the Managed start-token
// module was DELETED (a dynamic import is still an open→managed edge),
// so a stack built without `input.platform` rejects every `?start=`
// token with `reason=start-token-auth-unwired` (401). WS-upgrade tests
// mirror the production Managed composer
// (the managed realmode-composer), which threads the start-token
// verify/claim primitives through the platform adapter →
// `platform.verifyStartToken` / `platform.claimStartTokenJti`. The Open
// testkit's `buildStartTokenTestPlatform` wires the same seam pair onto
// a Local adapter, reaching the identical bridge auth path without an
// import edge on the Managed shim (ISSUES #219).
function makeStartTokenPlatform(): PlatformAdapter {
  return buildStartTokenTestPlatform({ verifyStartToken, claimStartTokenJti })
}

const HERE = dirname(fileURLToPath(import.meta.url))
// `<repo>/gateway/realmode-composer/__tests__/build-landing-stack.test.ts`
//   ../../..  =  <repo>/
const REPO_ROOT = join(HERE, '..', '..', '..')
const REPO_LANDING_DIR = join(REPO_ROOT, 'landing')

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-landing-stack-'))
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function makeJwks(): JwksCache {
  // Stub fetch — the factory only wires `buildJwksResolveKey(jwks)` into
  // the bridge; nothing in the construction path actually calls
  // `jwks.get()`. A test that hits the WS upgrade would need real keys
  // (covered by the Sprint 18 e2e + Phase 6 e2e).
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ keys: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return new JwksCache('https://auth.example.test/.well-known/jwks.json', {
    fetch: fetchImpl,
  })
}

// ---------------------------------------------------------------------------
// resolveLandingStaticDir
// ---------------------------------------------------------------------------

test('resolveLandingStaticDir: env override honored when path exists', () => {
  // Use the in-repo landing dir as a known-good path so we exercise the
  // "env present + exists" branch deterministically.
  expect(existsSync(REPO_LANDING_DIR)).toBe(true)
  const env = { NEUTRON_LANDING_STATIC_DIR: REPO_LANDING_DIR } as NodeJS.ProcessEnv
  expect(resolveLandingStaticDir(env)).toBe(REPO_LANDING_DIR)
})

test('resolveLandingStaticDir: falls back to <repo>/landing when env unset', () => {
  // Sanity-check the in-repo fallback the factory expects in dev/tests.
  expect(existsSync(REPO_LANDING_DIR)).toBe(true)
  expect(existsSync(join(REPO_LANDING_DIR, 'chat-react.html'))).toBe(true)
  const env = {} as NodeJS.ProcessEnv
  expect(resolveLandingStaticDir(env)).toBe(REPO_LANDING_DIR)
})

test('resolveLandingStaticDir: throws when env points at a non-existent dir', () => {
  const missing = join(workdir, 'no-such-landing-dir')
  expect(existsSync(missing)).toBe(false)
  const env = { NEUTRON_LANDING_STATIC_DIR: missing } as NodeJS.ProcessEnv
  expect(() => resolveLandingStaticDir(env)).toThrow(
    /NEUTRON_LANDING_STATIC_DIR=.*does not exist/,
  )
})

test('resolveLandingStaticDir: empty env value falls through to repo fallback', () => {
  // The factory treats `length === 0` as "unset" so an accidentally empty
  // env value still resolves via the in-repo fallback rather than
  // throwing about an empty path.
  const env = { NEUTRON_LANDING_STATIC_DIR: '' } as NodeJS.ProcessEnv
  expect(resolveLandingStaticDir(env)).toBe(REPO_LANDING_DIR)
})

// ---------------------------------------------------------------------------
// buildLandingStack
// ---------------------------------------------------------------------------

// Argus r2 [BLOCKING #1] — the JWT slug-history shim now requires both
// `internal_handle` and `slugHistoryStore`. A no-op shim that always
// returns null is sufficient for construction-shape tests; the actual
// shim behavior is exercised by `chat-bridge-jwt-shim.test.ts` and the
// new wiring regression test below.
const NOOP_SHIM_STORE = { lookup: async () => null }

test('buildLandingStack: returns { fetch, websocket } against a real ProjectDb', () => {
  const ownerHome = join(workdir, 'project-home')
  const stack = buildLandingStack({
    db,
    project_slug: 'alice',
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
  })
  expect(typeof stack.fetch).toBe('function')
  expect(stack.websocket).toBeDefined()
  expect(typeof stack.websocket.message).toBe('function')
  expect(typeof stack.websocket.open).toBe('function')
})

test('buildLandingStack: TranscriptWriter materializes <owner_home>/persona/onboarding-transcript.jsonl', () => {
  const ownerHome = join(workdir, 'project-home')
  buildLandingStack({
    db,
    project_slug: 'alice',
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
  })
  // TranscriptWriter's constructor mkdir-recurses the parent dir AND
  // touches an empty file (transcript.ts:51-53). Asserting the file
  // exists pins both behaviors so a future refactor that drops the
  // touch (or the mkdir) trips this test rather than silently breaking
  // the engine's first-write path.
  expect(existsSync(join(ownerHome, 'persona', 'onboarding-transcript.jsonl'))).toBe(true)
})

test('buildLandingStack: throws when static_dir is missing chat-react.html', () => {
  // Defense-in-depth — the factory delegates the chat-react.html existence
  // check to `createLandingServer`, but since the realmode-composer is
  // the canonical caller we want to know the failure mode is loud.
  const emptyDir = join(workdir, 'empty-landing')
  // mkdtempSync returns a real dir; reuse `workdir` as the empty parent.
  expect(() =>
    buildLandingStack({
      db,
      project_slug: 'alice',
      owner_home: join(workdir, 'project-home'),
      jwks: makeJwks(),
      static_dir: emptyDir,
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: NOOP_SHIM_STORE,
    }),
  ).toThrow(/landing static_dir missing chat-react\.html/)
})

// Argus r2 [BLOCKING #1] regression — the factory must REJECT an empty
// internal_handle at boot rather than silently disabling the JWT shim
// in the bridge. Without this assertion, a misconfigured composer
// would 401 every old-slug JWT post-rename and the failure mode would
// only surface after a production rename.
test('buildLandingStack: throws when internal_handle is empty (P1.5 § 1.5.5 shim guard)', () => {
  expect(() =>
    buildLandingStack({
      db,
      project_slug: 'alice',
      owner_home: join(workdir, 'project-home'),
      jwks: makeJwks(),
      static_dir: REPO_LANDING_DIR,
      internal_handle: '',
      slugHistoryStore: NOOP_SHIM_STORE,
    }),
  ).toThrow(/internal_handle is required/)
})

// ---------------------------------------------------------------------------
// Argus r2 [BLOCKING #1] end-to-end regression
//
// The earlier shape of `buildLandingStack` constructed `buildWebChatBridge`
// without `internal_handle` / `slugHistoryStore`; the bridge's typed
// fall-through then `return null`'d from `validateStartToken` whenever
// the JWT's project_slug differed from `expected_project_slug` — defeating
// the entire P1.5 § 1.5.5 grace-window shim in production. After any
// rename, every old-slug JWT 401'd on reconnect.
//
// Locked behavior we MUST preserve:
//   - JWT.project_slug == expected_project_slug → upgrade succeeds (101)
//   - JWT.project_slug != expected_project_slug AND shim matches    → 101
//   - JWT.project_slug != expected_project_slug AND shim says null  → 401
//   - JWT.project_slug != expected_project_slug AND shim throws     → 401
//     (fail-closed; matches `chat-bridge-jwt-shim.test.ts` semantics)
// ---------------------------------------------------------------------------

async function makeKeysAndJwks(kid: string): Promise<{
  signing: { kid: string; privateKey: KeyLike }
  jwks: JwksCache
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  const jwksBody = { keys: [{ ...pubJwk, kid, alg: 'EdDSA', use: 'sig' }] }
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(jwksBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return {
    signing: { kid, privateKey: privateKey as KeyLike },
    jwks: new JwksCache('https://auth.example.test/.well-known/jwks.json', {
      fetch: fetchImpl,
    }),
  }
}

function fakeUpgradeServer(): import('bun').Server<unknown> {
  return {
    upgrade: () => true,
  } as unknown as import('bun').Server<unknown>
}

function ensureChatHtml(staticDir: string): void {
  const target = join(staticDir, 'chat-react.html')
  if (!existsSync(target)) {
    writeFileSync(target, '<html><div id="root"></div></html>')
  }
}

test('buildLandingStack: shim wired — old-slug JWT + history match → /ws/chat upgrades 101', async () => {
  ensureChatHtml(REPO_LANDING_DIR)
  const { signing, jwks } = await makeKeysAndJwks('k1')
  const issued = await issueStartToken({
    project_slug: 'sam', // OLD slug, pre-rename
    user_id: 'u-1',
    signup_via: 'web',
    signing_key: signing,
  })

  // Shim matches ('sam', 't-aaaaaaaa') with a non-expired window.
  const shim: SlugHistoryShimStore = {
    async lookup({ old_slug, internal_handle }) {
      if (old_slug === 'sam' && internal_handle === 't-aaaaaaaa') {
        return { expires_at_ms: Date.now() + 60_000 }
      }
      return null
    },
  }

  const stack = buildLandingStack({
    db,
    project_slug: 'nova', // CURRENT slug after rename
    owner_home: join(workdir, 'project-home'),
    jwks,
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: shim,
    // C2 — injection-only start-token auth (see makeStartTokenPlatform).
    platform: makeStartTokenPlatform(),
  })

  const res = await stack.fetch(
    new Request(`http://x/ws/chat?start=${issued.token}`),
    fakeUpgradeServer(),
  )
  // 101 == validateStartToken returned a non-null claim AND server.upgrade fired.
  // If wiring regresses (shim disabled), validateStartToken returns null → 401.
  expect(res.status).toBe(101)
})

test('buildLandingStack: shim wired — old-slug JWT + cross-instance miss → /ws/chat 401', async () => {
  ensureChatHtml(REPO_LANDING_DIR)
  const { signing, jwks } = await makeKeysAndJwks('k1')
  const issued = await issueStartToken({
    project_slug: 'sam',
    user_id: 'u-1',
    signup_via: 'web',
    signing_key: signing,
  })

  // Shim returns null for THIS internal_handle ('t-aaaaaaaa') — the slug
  // 'sam' belongs to some other instance's history, not ours. The bridge
  // must reject (cross-instance safety) even though shim wiring is alive.
  const shim: SlugHistoryShimStore = {
    async lookup() {
      return null
    },
  }

  const stack = buildLandingStack({
    db,
    project_slug: 'nova',
    owner_home: join(workdir, 'project-home'),
    jwks,
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: shim,
    // C2 — wire real start-token auth so this 401 asserts the
    // cross-instance rejection path, not the unwired-auth rejection.
    platform: makeStartTokenPlatform(),
  })

  const res = await stack.fetch(
    new Request(`http://x/ws/chat?start=${issued.token}`),
    fakeUpgradeServer(),
  )
  expect(res.status).toBe(401)
})
