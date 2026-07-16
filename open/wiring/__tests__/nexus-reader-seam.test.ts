/**
 * RC3 — the composer's agent-nexus READER seam wiring.
 *
 * Closes the "production wiring untested" gap: the live-agent `nexusSnapshot`
 * seam the composer spreads is BUILT here (`buildNexusReaderSeam`), so this
 * exercises the exact flag-gate + `workBoardScopeKey` scope composition the
 * composer relies on — against a REAL `NexusStore`, no mock past the seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { workBoardScopeKey } from '@neutronai/work-board/store.ts'
import { buildNexusReaderSeam } from '../nexus-reader-seam.ts'

describe('buildNexusReaderSeam (flag gate)', () => {
  it('perfect-recall OFF (null store) → undefined seam (RC3 stays dark)', () => {
    expect(buildNexusReaderSeam(null)).toBeUndefined()
  })

  it('perfect-recall ON (real store) → a wired seam function', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-nx-seam-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(owner_home, { recursive: true })
    const store = new NexusStore({ owner_home })
    try {
      expect(typeof buildNexusReaderSeam(store)).toBe('function')
    } finally {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

interface Harness {
  store: NexusStore
  tmp: string
  cleanup(): void
}

function startStore(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-nx-seam-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const store = new NexusStore({ owner_home })
  return {
    store,
    tmp,
    cleanup: () => {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const OWNER = 'alice'

describe('buildNexusReaderSeam (scope composition, real store)', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('reads the SAME workBoardScopeKey scope RC2 writes to — General (owner slug)', async () => {
    // RC2 files a General event under `workBoardScopeKey(owner, undefined)`.
    await h.store.appendEvent(workBoardScopeKey(OWNER, undefined), {
      actor_kind: 'reflection',
      actor_id: 'corr-1',
      kind: 'learning',
      body: 'Owner correction: prefer concise summaries',
      refs: null,
    })
    const seam = buildNexusReaderSeam(h.store)!
    // The live-agent turn calls the seam with (project_slug, project_id=undefined) on General.
    const out = await seam(OWNER, undefined)
    expect(out).not.toBeNull()
    expect(out).toContain('prefer concise summaries')
  })

  it('a named project reads its OWN scope and does NOT see another project / General', async () => {
    await h.store.appendEvent(workBoardScopeKey(OWNER, 'proj-1'), {
      actor_kind: 'argus',
      actor_id: 'run-9',
      kind: 'decision',
      body: 'Argus verdict for proj-1 work: APPROVE',
      refs: [{ kind: 'run', ref: 'run-9' }],
    })
    await h.store.appendEvent(workBoardScopeKey(OWNER, undefined), {
      actor_kind: 'argus',
      actor_id: 'run-general',
      kind: 'decision',
      body: 'a GENERAL-scope decision',
      refs: null,
    })
    const seam = buildNexusReaderSeam(h.store)!

    const proj = await seam(OWNER, 'proj-1')
    expect(proj).toContain('proj-1 work: APPROVE')
    expect(proj).not.toContain('GENERAL-scope decision')

    const general = await seam(OWNER, undefined)
    expect(general).toContain('GENERAL-scope decision')
    expect(general).not.toContain('proj-1 work')
  })

  it('empty scope → null (the dark/no-op default flows through the seam)', async () => {
    const seam = buildNexusReaderSeam(h.store)!
    expect(await seam(OWNER, 'never-emitted')).toBeNull()
  })
})
