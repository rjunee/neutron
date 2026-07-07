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

test('buildLandingStack: returns { fetch, websocket } against a real ProjectDb', () => {
  const ownerHome = join(workdir, 'project-home')
  const stack = buildLandingStack({
    db,
    project_slug: 'alice',
    owner_home: ownerHome,
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
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
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
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
      static_dir: emptyDir,
      internal_handle: 't-aaaaaaaa',
    }),
  ).toThrow(/landing static_dir missing chat-react\.html/)
})

// Argus r2 [BLOCKING #1] regression — the factory must REJECT an empty
// internal_handle at boot. The field pins per-instance identity; the guard
// keeps a misconfigured composer from booting with an empty handle.
test('buildLandingStack: throws when internal_handle is empty (P1.5 § 1.5.5 guard)', () => {
  expect(() =>
    buildLandingStack({
      db,
      project_slug: 'alice',
      owner_home: join(workdir, 'project-home'),
      static_dir: REPO_LANDING_DIR,
      internal_handle: '',
    }),
  ).toThrow(/internal_handle is required/)
})

// ---------------------------------------------------------------------------
// NOTE: the slug-history grace-window shim used to be asserted end-to-end here
// by upgrading `/ws/chat` with an old-slug JWT. That landing onboarding socket
// was removed (onboarding + chat are unified on `/ws/app/chat`) and its
// `buildWebChatBridge` driver was excised in K11b0, so the JWT-shim wiring that
// lived on it is gone. The retained slug-history shim helpers are unit-covered
// in `chat-bridge-jwt-shim.test.ts`.
// ---------------------------------------------------------------------------
