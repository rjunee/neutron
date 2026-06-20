/**
 * Admin-personality-surface PATCH-vs-restart race regression
 * (ISSUE #33, 2026-05-22).
 *
 * Background: `handleRestart` iterates `ALLOWED_PERSONA_FILENAMES`
 * calling `unlink` on each. Without serialization, a parallel PATCH on
 * USER.md can interleave between two of restart's `unlink` calls: the
 * mtime guard sees the file still exists, PATCH commits the new content,
 * then restart's next loop iteration nukes the just-written file. The
 * PATCH response returns 200 — silent data loss.
 *
 * Fix (option (b) from ISSUE #33): a per-instance mutex shared by
 * `handlePatchFile` + `handleRestart`. Whichever acquires the lock first
 * runs to completion before the other begins.
 *
 * What this test asserts:
 *   1. Across N concurrent (PATCH, restart) pairs, the post-race state
 *      is always ONE of two deterministic outcomes:
 *        (a) PATCH-won-the-lock-first: PATCH 200, restart 200, file
 *            ABSENT (restart unlinked PATCH's write, by design — the
 *            user explicitly confirmed restart, so loss after the
 *            user-visible commit is expected).
 *        (b) restart-won-the-lock-first: restart 200, PATCH 200, file
 *            PRESENT with PATCH's content (PATCH wrote fresh into the
 *            cleared state via expected_mtime=-1).
 *   2. The pre-seed body "v0" NEVER survives the race. Surviving "v0"
 *      would indicate a non-atomic mid-state where restart's unlink and
 *      PATCH's rename overlapped without serialization.
 *   3. PATCH's response code is 200 in BOTH branches (we use
 *      expected_mtime=-1 so the mtime conflict never matters).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../../channels/index.ts'
import {
  createAdminPersonalitySurface,
  type PersonaFilename,
} from '../admin-personality-surface.ts'
import { composeHttpHandler } from '../compose.ts'

const PROJECT_SLUG = 'demo'
const USER_FILE: PersonaFilename = 'USER.md'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  tmp: string
  owner_home: string
  reloadCalls: PersonaFilename[]
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-admin-persona-race-'))
  const owner_home = join(tmp, 'owner_home')
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const reloadCalls: PersonaFilename[] = []
  const surface = createAdminPersonalitySurface({
    auth,
    owner_home,
    project_slug: PROJECT_SLUG,
    onReload: (name): void => {
      reloadCalls.push(name)
    },
  })
  const composed = composeHttpHandler({
    appPersona: { handler: surface.handler },
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
    tmp,
    owner_home,
    reloadCalls,
    close: async (): Promise<void> => {
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function bearer(): Headers {
  return new Headers({
    authorization: 'Bearer dev:test-user',
    'content-type': 'application/json',
  })
}

function seedFile(owner_home: string, name: PersonaFilename, body: string): void {
  const dir = join(owner_home, 'persona')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body, 'utf8')
}

let h: Harness
beforeEach(async () => {
  h = await startGateway()
})
afterEach(async () => {
  await h.close()
})

describe('ISSUE #33 — PATCH-vs-restart concurrency', () => {
  it('serializes a single concurrent (PATCH, restart) pair to one of two clean terminal states', async () => {
    seedFile(h.owner_home, USER_FILE, 'v0')
    const target = join(h.owner_home, 'persona', USER_FILE)
    const patch = fetch(`${h.base}/api/app/persona/file?name=${USER_FILE}`, {
      method: 'PATCH',
      headers: bearer(),
      body: JSON.stringify({ content: 'v1', expected_mtime: -1 }),
    })
    const restart = fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ confirm: true }),
    })
    const [patchRes, restartRes] = await Promise.all([patch, restart])
    expect(patchRes.status).toBe(200)
    expect(restartRes.status).toBe(200)

    // Two clean terminal states are acceptable:
    //   (a) PATCH won the lock first → restart ran after → file absent.
    //   (b) restart won the lock first → PATCH wrote fresh → file = "v1".
    // The pre-seed "v0" surviving would be a non-atomic mid-state.
    if (existsSync(target)) {
      expect(readFileSync(target, 'utf8')).toBe('v1')
    } else {
      // File absent — PATCH-then-restart ordering. Nothing else to assert.
    }
  })

  it('runs 50 concurrent (PATCH, restart) pairs and never observes a stale "v0" mid-state', async () => {
    const target = join(h.owner_home, 'persona', USER_FILE)
    const outcomes = { absent: 0, patch_won: 0 }
    for (let i = 0; i < 50; i++) {
      seedFile(h.owner_home, USER_FILE, 'v0')
      seedFile(h.owner_home, 'SOUL.md', 'soul-v0')
      seedFile(h.owner_home, 'priority-map.md', 'pm-v0')
      const patch = fetch(`${h.base}/api/app/persona/file?name=${USER_FILE}`, {
        method: 'PATCH',
        headers: bearer(),
        body: JSON.stringify({ content: `v1-${i}`, expected_mtime: -1 }),
      })
      const restart = fetch(`${h.base}/api/app/persona/restart-from-scratch`, {
        method: 'POST',
        headers: bearer(),
        body: JSON.stringify({ confirm: true }),
      })
      const [patchRes, restartRes] = await Promise.all([patch, restart])
      // PATCH used -1 (force overwrite) so it always writes. restart's
      // confirm:true is set so it always proceeds.
      expect(patchRes.status).toBe(200)
      expect(restartRes.status).toBe(200)

      if (existsSync(target)) {
        const body = readFileSync(target, 'utf8')
        // The only acceptable surviving content is PATCH's `v1-i`. The
        // pre-seed "v0" surviving = silent mid-state — fail loudly.
        expect(body).toBe(`v1-${i}`)
        outcomes.patch_won += 1
      } else {
        outcomes.absent += 1
      }
    }
    expect(outcomes.absent + outcomes.patch_won).toBe(50)
    // Pin that PATCH actually ran in every iteration regardless of
    // which side won the lock — otherwise an implementation that
    // dropped every PATCH on the floor would still pass the
    // file-absent / file-equals-`v1-i` invariants. The onReload hook
    // fires once per successful PATCH write AND once per file restart
    // actually deleted. Per iteration: ≥1 PATCH success + ≥1 unlink-
    // delete (at minimum on the pre-seed) = ≥2 hook fires. Across 50
    // iterations that is ≥100 — anything less means PATCH or restart
    // skipped work the test thought happened.
    expect(h.reloadCalls.length).toBeGreaterThanOrEqual(50 * 2)
  })

  it('serializes two concurrent PATCH writes (PATCH-vs-PATCH) so neither write is lost', async () => {
    // Side regression: per-instance mutex must also serialize sibling
    // PATCH writes. If both target USER.md with expected_mtime=-1,
    // the LAST one to acquire the lock wins; both return 200.
    //
    // ISSUE #35 residual tie-in (Argus r1 fix-pass 2026-05-23): the
    // FD-level changes from ISSUE #35 ground each PATCH's mtime
    // check in a real inode (held FD across stat + write + rename),
    // and ISSUE #33's mutex makes the per-instance critical section
    // serial. Together they make the "concurrent PATCH-vs-PATCH
    // dir-entry interleave between A's open and B's rename" failure
    // mode structurally impossible: B cannot acquire the mutex until
    // A's `withLock` callback fully resolves, which only happens
    // after A's `await rename(tmp, target)` (and the FD-close in
    // the finally) completes. The final on-disk content is exactly
    // one of {'A', 'B'} — never a tmp-file artifact, never an empty
    // file, never a partial overlap.
    const target = join(h.owner_home, 'persona', USER_FILE)
    const p1 = fetch(`${h.base}/api/app/persona/file?name=${USER_FILE}`, {
      method: 'PATCH',
      headers: bearer(),
      body: JSON.stringify({ content: 'A', expected_mtime: -1 }),
    })
    const p2 = fetch(`${h.base}/api/app/persona/file?name=${USER_FILE}`, {
      method: 'PATCH',
      headers: bearer(),
      body: JSON.stringify({ content: 'B', expected_mtime: -1 }),
    })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(existsSync(target)).toBe(true)
    const final = readFileSync(target, 'utf8')
    // The final content is whichever PATCH acquired the lock SECOND.
    // The non-atomic failure mode would be `A` and `B` both opening
    // their tmp file in parallel and one rename clobbering the other
    // mid-write — Node's atomic rename actually makes this safe even
    // without the mutex, but the mutex makes the ordering explicit.
    expect(['A', 'B']).toContain(final)
    // ISSUE #35 residual: the served body is exactly one of the two
    // PATCH contents, NEVER a tmp-file leftover (`.tmp` suffix would
    // indicate the rename half-landed) and NEVER an empty/partial
    // write. With the FD pinned across write + rename inside the
    // mutex, neither failure mode is reachable.
    expect(final).not.toContain('.tmp')
    expect(final.length).toBeGreaterThan(0)
    // Body length matches exactly one of the two payloads (single
    // ASCII char). A mid-write or post-rename truncation would
    // surface as a 0-length file or a mid-byte cut.
    expect([1]).toContain(final.length)
  })
})
