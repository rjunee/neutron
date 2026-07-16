/**
 * RB1 (perfect-recall) — PRODUCTION-WIRING integration test.
 *
 * Crosses the REAL boundary the composer wires, end to end, through the SAME
 * production code the composer calls — NOT a test-local reconstruction:
 *
 *   real `WorkBoardStore`
 *     → the composer's owner-wide active-work provider (`listAllActive().map`)
 *     → `wireMemory`'s flag-gated `wrapSyncHookWithMemoryIndex` regeneration
 *     → durable `entities/INDEX.md`
 *     → the cold-turn read seam (`memoryIndexRead`) + `<memory_index>` fragment.
 *
 * Nothing is injected synthetically: the hook, the setter, and the cold-turn
 * read all come from `wireMemory(ctx)` exactly as `open/composer.ts` builds them
 * (flag ON), and the handles travel from the store through the SAME provider
 * shape the composer binds into the generated manifest.
 *
 * Locks the OWNER-WIDE aggregation: an active item under GENERAL and one under a
 * real PROJECT scope must BOTH reach the cold prompt. The final block re-binds a
 * GENERAL-ONLY provider and proves the project handle then DISAPPEARS — so
 * `listAllActive()` (not any single-scope read) is demonstrably the thing under
 * test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore, workBoardScopeKey } from '@neutronai/work-board/store.ts'
import { writeEntity, type EntityWriteInput } from '@neutronai/runtime/entity-writer.ts'
import {
  formatMemoryIndexFragment,
  type MemoryIndexWorkHandle,
} from '@neutronai/runtime/memory-index.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireMemory } from '../wiring/memory.ts'

const OWNER = 'acme'
let tmp: string
let ownerDir: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mi-wb-'))
  ownerDir = mkdtempSync(join(tmpdir(), 'neutron-mi-owner-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(ownerDir, { recursive: true, force: true })
})

function personInput(slug: string, name: string): EntityWriteInput {
  return {
    ownerDataDir: ownerDir,
    kind: 'person',
    slug,
    originInstance: OWNER,
    receivingInstanceSlug: OWNER,
    body: {
      frontmatter: { slug, type: 'person', name },
      compiledTruth: `a real person named ${name}`,
      timelineAppend: { ts: '2026-05-01T10:00:00-07:00', source: 'chat', body: 'noted' },
    },
  }
}

/**
 * The minimal REAL `OpenWiringContext` `wireMemory` reads. LLM-less
 * (`llmPool: null`) so scribe / reflection substrates + the Cores fan-out stay
 * off — but `gbrainMemory` and its RB1-wrapped `syncHook` are built
 * UNCONDITIONALLY, so this exercises the full memory-index wiring with the
 * fewest moving parts. Flag ON → the wrapper + cold-turn read seam are live.
 */
function makeCtx(): OpenWiringContext {
  return {
    llmPool: null,
    owner_handle: OWNER,
    owner_home: ownerDir,
    project_slug: OWNER,
    env: { NEUTRON_PERFECT_RECALL: '1' } as NodeJS.ProcessEnv,
    db,
    prewarmSubstrate: async (): Promise<void> => {},
  }
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

describe('RB1 — WorkBoardStore → composer provider → wireMemory → durable INDEX.md → cold prompt', () => {
  test('active work under BOTH General and a project scope reaches the cold-turn manifest', async () => {
    const workBoardStore = new WorkBoardStore(db)
    // Real active items: one General (owner scope), one under a real project_id.
    const general = await workBoardStore.create(workBoardScopeKey(OWNER, undefined), {
      title: 'ship the general roadmap',
    })
    const project = await workBoardStore.create(workBoardScopeKey(OWNER, 'proj-xyz'), {
      title: 'fix the project-xyz bug',
    })

    // The REAL production wiring — same call `open/composer.ts` makes at boot.
    const w = wireMemory(makeCtx())
    try {
      // The flag is ON, so the RB1 read seam + late-bind setter are live.
      expect(w.memoryIndexRead).toBeDefined()

      // Bind the memory-index's active-work provider EXACTLY as the composer does
      // (open/composer.ts, owner-wide `listAllActive().map`).
      w.setMemoryIndexWorkHandles(() =>
        workBoardStore
          .listAllActive()
          .map((item) => ({ id: item.id, title: item.title, status: item.status })),
      )

      // A real entity write drives regeneration through the SAME wrapped syncHook
      // `wireMemory` handed the scribe / onboarding / finalize consumers.
      await writeEntity(personInput('dana', 'Dana'), { syncHook: w.gbrainSyncHook })

      // The composer's cold-turn read seam (forces a coalesced regen, fail-closed).
      const body = (await w.memoryIndexRead!())!
      expect(body).not.toBeNull()
      // The entity…
      expect(body).toContain('`dana`')
      // …AND both active work handles — General AND project-scoped.
      expect(body).toContain('## Active work')
      expect(body).toContain(general.id)
      expect(body).toContain('ship the general roadmap')
      expect(body).toContain(project.id)
      expect(body).toContain('fix the project-xyz bug')

      // …and the cold-prompt wrapping the composer injects carries them too.
      const fragment = formatMemoryIndexFragment(body)!
      expect(fragment).not.toBeNull()
      expect(fragment).toContain('<memory_index>')
      expect(fragment).toContain(general.id)
      expect(fragment).toContain(project.id)

      // Discriminator: re-bind a GENERAL-ONLY provider (single-scope `listActive`)
      // and the project handle DISAPPEARS from the freshly regenerated manifest —
      // proving `listAllActive()`'s owner-wide aggregation is the thing under test,
      // not any single-scope read. (The cold-turn read forces a fresh regen that
      // re-resolves the provider.)
      w.setMemoryIndexWorkHandles(() =>
        workBoardStore
          .listActive(workBoardScopeKey(OWNER, undefined))
          .map((item) => ({ id: item.id, title: item.title, status: item.status })),
      )
      const generalOnly = (await w.memoryIndexRead!())!
      expect(generalOnly).toContain(general.id)
      expect(generalOnly).toContain('ship the general roadmap')
      expect(generalOnly).not.toContain(project.id)
      expect(generalOnly).not.toContain('fix the project-xyz bug')
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 20_000)
})
