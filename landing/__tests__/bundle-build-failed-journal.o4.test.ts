/**
 * O4 — landing bundle_build_failed degrade journal.
 *
 * When the React chat client bundle fails to build, `/chat-react.js` 404s.
 * Historically that failure was discarded with ZERO log. O4 emits a
 * `bundle_build_failed` system_events row on the failure edge (VISIBILITY
 * ONLY — the 404 degrade behaviour is unchanged).
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { createLandingServer } from '../server.ts'

const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>

function fakeSink(): { rows: SystemEventInput[]; sink: SystemEventSink } {
  const rows: SystemEventInput[] = []
  return {
    rows,
    sink: {
      record(input: SystemEventInput) {
        rows.push(input)
        return { id: String(rows.length) }
      },
    },
  }
}

function makeStaticDir(mainTsx: string | null, prebuiltJs: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'o4-landing-'))
  writeFileSync(join(dir, 'chat-react.html'), '<div id="root"></div><script src="/chat-react.js"></script>')
  if (prebuiltJs !== null) writeFileSync(join(dir, 'chat-react.js'), prebuiltJs)
  if (mainTsx !== null) {
    mkdirSync(join(dir, 'chat-react'), { recursive: true })
    writeFileSync(join(dir, 'chat-react', 'main.tsx'), mainTsx)
  }
  return dir
}

const BROKEN_SRC = `import { nope } from './does-not-exist.ts'\nconsole.log(nope)\n`

const dirs: string[] = []
afterEach(() => {
  registerSystemEventSink(null)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

test('O4 — repeated failing chat-react builds 404 but emit EXACTLY ONE row (edge-latched)', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  // main.tsx imports a module that does not exist → Bun.build fails. The failed
  // build leaves the cache null, so each request REBUILDS — the latch is what
  // keeps the journal to one row per failure episode.
  const dir = makeStaticDir(BROKEN_SRC, null)
  dirs.push(dir)

  const handler = createLandingServer({ static_dir: dir })
  const r1 = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
  const r2 = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
  const r3 = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
  expect([r1.status, r2.status, r3.status]).toEqual([404, 404, 404]) // degrade unchanged

  const fails = rows.filter((r) => r.event === 'bundle_build_failed')
  expect(fails).toHaveLength(1) // three rebuilds, ONE journal row
  expect(fails[0]).toMatchObject({ module: 'landing' })
  expect(fails[0]?.payload).toMatchObject({ bundle: 'chat-react.js' })
}, 30_000)

test('O4 — the invite.js branch is also edge-latched (repeated failure → one row)', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const dir = mkdtempSync(join(tmpdir(), 'o4-invite-'))
  dirs.push(dir)
  // Minimal static dir: chat-react.html is REQUIRED at construction; invite.ts
  // is the broken bundle under test (invite_assets_dir defaults to static_dir).
  writeFileSync(join(dir, 'chat-react.html'), '<div id="root"></div>')
  writeFileSync(join(dir, 'invite.ts'), BROKEN_SRC)

  const handler = createLandingServer({ static_dir: dir })
  const r1 = await handler.fetch(new Request('http://x.test/invite.js'), fakeServer)
  const r2 = await handler.fetch(new Request('http://x.test/invite.js'), fakeServer)
  expect([r1.status, r2.status]).toEqual([404, 404])

  const fails = rows.filter((r) => r.event === 'bundle_build_failed')
  expect(fails).toHaveLength(1)
  expect(fails[0]?.payload).toMatchObject({ bundle: 'invite.js' })
}, 30_000)

test('O4 — a prebuilt bundle (no build) serves 200 and emits NOTHING', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  // Prebuilt js present → resolveChatReactJs returns the cache without building.
  const dir = makeStaticDir(null, 'export const ok = 1\n')
  dirs.push(dir)

  const handler = createLandingServer({ static_dir: dir })
  const res = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
  expect(res.status).toBe(200)
  expect(rows).toHaveLength(0)
})

test('O4 — a throwing journal sink does NOT break the 404 degrade', async () => {
  registerSystemEventSink({
    record() {
      throw new Error('journal write failed')
    },
  })
  const dir = makeStaticDir(`import { nope } from './does-not-exist.ts'\nconsole.log(nope)\n`, null)
  dirs.push(dir)

  const handler = createLandingServer({ static_dir: dir })
  const res = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
  expect(res.status).toBe(404)
}, 30_000)
