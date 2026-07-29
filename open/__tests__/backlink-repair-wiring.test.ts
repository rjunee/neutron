/**
 * Q2 (overturn 2, tier 1) — WIRING PROOF that backlink repair is not just built but
 * SERVED through the real `wireMemory` composition. A broken-by-hyphenation wikilink
 * written through `wired.gbrainSyncHook` (the composed chain: GBrain → memory-index →
 * backlink-repair, outermost) is REPAIRED ON DISK, event-driven. This is the
 * "wired, not just built" gate for sub-part (a).
 *
 * Mirrors `open-wiring-memory.test.ts` context construction (temp NEUTRON home, the
 * real `wireMemory`), LLM-less (`llmPool: null`) — the hook chain builds without a
 * substrate, and repair is deterministic so it runs on an LLM-less box.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeEntity } from '@neutronai/runtime/entity-writer.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireMemory } from '../wiring/memory.ts'

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-backlink-wiring-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(): OpenWiringContext {
  return {
    llmPool: null,
    owner_handle: 'owner',
    owner_home: tmpDir,
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'],
    prewarmSubstrate: async (): Promise<void> => {},
  } as OpenWiringContext
}

async function runCleanups(cleanups: Array<() => void>): Promise<void> {
  for (const c of cleanups) {
    try {
      await c()
    } catch {
      /* best-effort */
    }
  }
  await Bun.sleep(10)
}

test('wired gbrainSyncHook repairs a broken-by-hyphenation wikilink ON DISK', async () => {
  const w = wireMemory(makeCtx())
  try {
    // Plant the real target page (differs only by hyphen position) + a source page
    // that links to the broken slug — both via the REAL entity writer.
    await writeEntity({
      ownerDataDir: tmpDir,
      kind: 'concept',
      slug: 'whiteboard',
      body: {
        frontmatter: { slug: 'whiteboard', type: 'concept' },
        compiledTruth: 'A shared drawing surface.',
        timelineAppend: { ts: new Date(0).toISOString(), source: 'seed', body: 'planted' },
      },
      originInstance: 'owner',
      receivingInstanceSlug: 'owner',
    })
    const srcOut = await writeEntity({
      ownerDataDir: tmpDir,
      kind: 'person',
      slug: 'ada-lovelace',
      body: {
        frontmatter: { slug: 'ada-lovelace', type: 'person' },
        compiledTruth: 'Ada sketches on a [[white-board]] every morning.',
        timelineAppend: { ts: new Date(0).toISOString(), source: 'seed', body: 'planted' },
      },
      originInstance: 'owner',
      receivingInstanceSlug: 'owner',
    })
    const srcPath = srcOut.path
    const srcBody = readFileSync(srcPath, 'utf8')

    // Drive the event exactly as the entity writer would after committing the page.
    await w.gbrainSyncHook.onEntityWrite({
      path: srcPath,
      body: srcBody,
      newLinks: srcOut.newLinks,
      removedLinks: [],
    })

    // Settle the coalesced repair drain (expose `idle()` via cast) OR poll ≤2s.
    const idle = (w.gbrainSyncHook as unknown as { idle?: () => Promise<void> }).idle
    if (typeof idle === 'function') await idle.call(w.gbrainSyncHook)
    for (let i = 0; i < 40; i++) {
      if (readFileSync(srcPath, 'utf8').includes('[[whiteboard')) break
      await Bun.sleep(50)
    }

    const onDisk = readFileSync(srcPath, 'utf8')
    expect(onDisk).toContain('[[whiteboard|white-board]]')
    expect(onDisk).not.toContain('[[white-board]]')
    expect(onDisk).toContain('backlink-repair:owner')
  } finally {
    await runCleanups(w.cleanups)
  }
}, 15_000)
