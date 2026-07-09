/**
 * Focused unit coverage for `open/wiring/uploads.ts` (C3b carve).
 *
 * Constructs `wireUploads` with a fake wiring context + a fake `landing` bag,
 * then pins the CARE invariants the carve must preserve:
 *   - the bare `import_upload_handler` + chunked `chunked_upload_handler` are
 *     built (functions) and the `import_resume_handler` is mounted when the
 *     engine surfaced a runner + payload resolver;
 *   - the null-guard: NO `import_resume_handler` when the runner OR resolver is
 *     null (parity with the composer's `!== null && !== null` guard);
 *   - the `ChunkedUploadSweeper` teardown (`stop()`) is collected into the
 *     returned `cleanups` (NOT pushed onto a global) so the composer re-registers
 *     it at the carve site;
 *   - the COMPOSER-OWNED late-bound `importWatchHolder` is shared by reference:
 *     the handler (READER) fires `importWatchHolder.watch?.(user_id)` after the
 *     engine advance, and a `.watch` SET on the SAME holder AFTER `wireUploads`
 *     returns is the one that fires — proving reader + setter close over one
 *     object (the late-bind pattern, NOT a `late<T>` seam).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { appWsTopicId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireUploads } from '../wiring/uploads.ts'

// First two bytes are the ZIP local-file-header magic (`PK`); the single-shot
// handler checks the magic + reads the assembled bytes, so the fixture is > 4B.
const ZIP_FIXTURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x01])

let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-wiring-uploads-'))
  db = ProjectDb.open(join(tmpDir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(): OpenWiringContext {
  return {
    llmPool: null,
    internal_handle: 'owner',
    owner_home: tmpDir,
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db,
    prewarmSubstrate: async (): Promise<void> => {},
  }
}

/**
 * A fake landing bag exposing only what `wireUploads` reads: the engine's
 * `notifyImportUpload` (recorded), and the resume runner / resolver / store.
 */
function makeLanding(opts: {
  onNotify: (input: { user_id: string }) => void
  runner?: unknown
  resolver?: unknown
}): LandingStackWithEngine {
  return {
    engine: {
      notifyImportUpload: async (input: { user_id: string }) => {
        opts.onNotify(input)
        return { was_new: false } as never
      },
    },
    importJobRunner: ('runner' in opts ? opts.runner : {}) as never,
    importPayloadResolver: ('resolver' in opts ? opts.resolver : {}) as never,
    stateStore: {} as never,
  } as unknown as LandingStackWithEngine
}

describe('wireUploads — handler wiring + sweeper cleanup + resume null-guard', () => {
  test('builds both upload handlers, mounts resume handler, collects sweeper stop into cleanups', async () => {
    const importWatchHolder: { watch?: (user_id: string) => void } = {}
    const w = await wireUploads(makeCtx(), {
      landing: makeLanding({ onNotify: () => {} }),
      uploadUid: process.getuid?.() ?? 0,
      uploadGid: process.getgid?.() ?? 0,
      importWatchHolder,
    })
    expect(typeof w.import_upload_handler).toBe('function')
    expect(typeof w.chunked_upload_handler).toBe('function')
    // Runner + resolver present → the resume handler is mounted.
    expect(typeof w.import_resume_handler).toBe('function')
    // EXACTLY the sweeper stop() hook is collected (composer re-registers it).
    expect(w.cleanups.length).toBe(1)
    // The collected teardown runs cleanly (idempotent best-effort stop()).
    expect(() => w.cleanups[0]!()).not.toThrow()
  })

  test('resume handler is NOT mounted when the runner is null (null-guard parity)', async () => {
    const importWatchHolder: { watch?: (user_id: string) => void } = {}
    const w = await wireUploads(makeCtx(), {
      landing: makeLanding({ onNotify: () => {}, runner: null }),
      uploadUid: process.getuid?.() ?? 0,
      uploadGid: process.getgid?.() ?? 0,
      importWatchHolder,
    })
    expect(w.import_resume_handler).toBeUndefined()
    // The upload surface is still fully wired regardless of the resume guard.
    expect(typeof w.import_upload_handler).toBe('function')
    expect(typeof w.chunked_upload_handler).toBe('function')
    for (const c of w.cleanups) c()
  })

  test('resume handler is NOT mounted when the payload resolver is null (other half of the two-sided guard)', async () => {
    // The guard is `runner !== null && resolver !== null` — the runner-null case
    // above covers one arm; this covers the OTHER (runner present, resolver null)
    // so a future refactor cannot accidentally mount resume with a missing resolver.
    const importWatchHolder: { watch?: (user_id: string) => void } = {}
    const w = await wireUploads(makeCtx(), {
      landing: makeLanding({ onNotify: () => {}, resolver: null }),
      uploadUid: process.getuid?.() ?? 0,
      uploadGid: process.getgid?.() ?? 0,
      importWatchHolder,
    })
    expect(w.import_resume_handler).toBeUndefined()
    // The upload surface is still fully wired regardless of the resume guard.
    expect(typeof w.import_upload_handler).toBe('function')
    expect(typeof w.chunked_upload_handler).toBe('function')
    for (const c of w.cleanups) c()
  })
})

describe('wireUploads — late-bound importWatchHolder reader/setter share one reference', () => {
  test('a .watch set on the holder AFTER wireUploads fires when the upload handler advances the engine', async () => {
    // The COMPOSER creates the holder; wireUploads is only the READER.
    const importWatchHolder: { watch?: (user_id: string) => void } = {}
    const notified: string[] = []
    const w = await wireUploads(makeCtx(), {
      landing: makeLanding({ onNotify: (input) => notified.push(input.user_id) }),
      uploadUid: process.getuid?.() ?? 0,
      uploadGid: process.getgid?.() ?? 0,
      importWatchHolder,
    })

    // SET the watch LATE — exactly as the composer does far downstream, on the
    // SAME holder object it passed into wireUploads.
    const watched: string[] = []
    importWatchHolder.watch = (user_id: string): void => {
      watched.push(user_id)
    }

    // Drive the REAL bare `import_upload_handler` with a minimal valid Claude
    // ZIP. Its `x-neutron-topic-id: app:owner` derives user_id `owner`.
    const form = new FormData()
    const ab = new ArrayBuffer(ZIP_FIXTURE.byteLength)
    new Uint8Array(ab).set(ZIP_FIXTURE)
    form.append('file', new File([ab], 'claude.zip', { type: 'application/zip' }))
    const res = await w.import_upload_handler(
      new Request('http://localhost/api/upload/claude', {
        method: 'POST',
        headers: { 'x-neutron-topic-id': appWsTopicId('owner') },
        body: form,
      }),
    )
    expect(res.status).toBe(200)
    // The zip landed on disk (owner_home/imports/claude.zip).
    expect(existsSync(join(tmpDir, 'imports', 'claude.zip'))).toBe(true)
    // The wrapper called the engine AND fanned to the late-bound holder — same
    // user_id through both, proving the reader + setter share one reference.
    expect(notified).toEqual(['owner'])
    expect(watched).toEqual(['owner'])
  })
})
