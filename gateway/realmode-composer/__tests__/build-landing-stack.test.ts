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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { JwksCache } from '../../../jwt-validator/validator.ts'
import {
  buildLandingStack,
  resolveLandingStaticDir,
} from '../build-landing-stack.ts'

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
// NOTE: the slug-history grace-window shim used to be asserted end-to-end here
// by upgrading `/ws/chat` with an old-slug JWT (history-match → 101,
// cross-instance miss → 401). That landing onboarding socket was removed
// (onboarding + chat are unified on `/ws/app/chat`), so those two
// upgrade-driven tests were deleted. The shim itself (threaded into the bridge
// via `internal_handle` / `slugHistoryStore`) is still constructed by
// `buildLandingStack` and unit-covered at the bridge level in
// `chat-bridge-jwt-shim.test.ts`.
// ---------------------------------------------------------------------------
