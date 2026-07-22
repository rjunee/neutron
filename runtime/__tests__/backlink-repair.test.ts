/**
 * @neutronai/runtime — deterministic backlink-repair tests (Q2 overturn 2, tier 1).
 *
 * Proves the event-driven repair: a broken-by-hyphenation wikilink written through
 * the sync hook is REPAIRED (unique strip-hyphen candidate → rewrite + provenance
 * timeline row), while orphan (no candidate) and ambiguous (>1 candidate) links are
 * LOGGED and LEFT UNTOUCHED. Both a `toHaveBeenCalled()` spy assertion AND an
 * artifact-on-disk assertion, per sub-part.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeEntity as realWriteEntity } from '../entity-writer.ts'
import type { EntityWriteInput, EntityWriteOutput } from '../entity-writer.ts'
import {
  wrapSyncHookWithBacklinkRepair,
  rewriteLinks,
  type BacklinkWriteEntity,
} from '../backlink-repair.ts'

let ownerDir: string

beforeEach(() => {
  ownerDir = mkdtempSync(join(tmpdir(), 'neutron-backlink-'))
})
afterEach(() => {
  rmSync(ownerDir, { recursive: true, force: true })
})

/** Plant a concept page by BASENAME (filename-only enumeration is what repair
 *  reads) — a minimal valid entity page. */
function plantConcept(slug: string, compiled = 'A concept.'): void {
  const dir = join(ownerDir, 'entities', 'concepts')
  mkdirSync(dir, { recursive: true })
  const body = [
    '---',
    `slug: ${slug}`,
    'type: concept',
    '---',
    '',
    compiled,
    '',
    '---',
    '',
    '## Timeline',
    '',
    `- ${new Date(0).toISOString()} · seed — planted`,
    '',
  ].join('\n')
  writeFileSync(join(dir, `${slug}.md`), body, 'utf8')
}

/** Create a REAL source page whose compiled-truth carries `[[white-board]]`, and
 *  return its on-disk path + body + the writer-extracted newLinks. */
async function makeSourcePage(compiledTruth: string): Promise<{
  path: string
  body: string
  newLinks: EntityWriteOutput['newLinks']
}> {
  const input: EntityWriteInput = {
    ownerDataDir: ownerDir,
    kind: 'person',
    slug: 'ada-lovelace',
    body: {
      frontmatter: { slug: 'ada-lovelace', type: 'person' },
      compiledTruth,
      timelineAppend: { ts: new Date(0).toISOString(), source: 'seed', body: 'planted' },
    },
    originInstance: 'owner',
    receivingInstanceSlug: 'owner',
  }
  const out = await realWriteEntity(input)
  return { path: out.path, body: readFileSync(out.path, 'utf8'), newLinks: out.newLinks }
}

describe('backlink-repair — unique hyphen-position candidate → repaired', () => {
  test('spy: onEntityWrite drives ONE repair write with the rewritten wikilink + CAS on the event body', async () => {
    plantConcept('whiteboard')
    const src = await makeSourcePage('Ada uses a [[white-board]] daily.')
    // The writer extracted a triple for the broken slug.
    expect(src.newLinks.some((t) => t.object === 'white-board')).toBe(true)

    const spy = mock(
      async (): Promise<{ path: string; changed: boolean; newLinks: unknown[] }> => ({
        path: src.path,
        changed: true,
        newLinks: [],
      }),
    )
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
    })

    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()

    expect(spy).toHaveBeenCalledTimes(1)
    const [input] = spy.mock.calls[0] as unknown as [Parameters<BacklinkWriteEntity>[0]]
    expect(input.slug).toBe('ada-lovelace')
    expect(input.body.compiledTruth).toContain('[[whiteboard|white-board]]')
    expect(input.body.compiledTruth).not.toContain('[[white-board]]')
    expect(input.precondition?.ifBodyEquals).toBe(src.body)
    expect(hook.stats.repaired).toBe(1)
  })

  test('artifact: the repaired wikilink + provenance row land ON DISK (real writeEntity)', async () => {
    plantConcept('whiteboard')
    const src = await makeSourcePage('Ada uses a [[white-board]] daily.')

    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
    })
    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()

    const onDisk = readFileSync(src.path, 'utf8')
    expect(onDisk).toContain('[[whiteboard|white-board]]')
    // The original broken target is gone from compiled truth.
    expect(onDisk).not.toContain('[[white-board]]')
    // Provenance timeline row.
    expect(onDisk).toContain('backlink-repair:owner')
    expect(onDisk).toContain('Repaired broken link(s): white-board → whiteboard')
    expect(hook.stats.repaired).toBe(1)
  })

  test('wikilink WITH alias preserves the display text', async () => {
    plantConcept('whiteboard')
    const src = await makeSourcePage('Ada uses a [[white-board|big board]] daily.')
    const spy = mock(
      async (): Promise<{ path: string; changed: boolean; newLinks: unknown[] }> => ({
        path: src.path,
        changed: true,
        newLinks: [],
      }),
    )
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
    })
    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()
    const [input] = spy.mock.calls[0] as unknown as [Parameters<BacklinkWriteEntity>[0]]
    expect(input.body.compiledTruth).toContain('[[whiteboard|big board]]')
  })
})

describe('backlink-repair — always-safe holds (orphan / ambiguous)', () => {
  test('orphan (no candidate) → no write, stats.orphaned++, logFailure', async () => {
    // No matching page at all.
    const src = await makeSourcePage('Ada mentions [[nonexistent-thing]] once.')
    const spy = mock(async () => ({ path: src.path, changed: true, newLinks: [] as unknown[] }))
    const logs: string[] = []
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
      logFailure: (m) => logs.push(m),
    })
    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()
    expect(spy).toHaveBeenCalledTimes(0)
    expect(hook.stats.orphaned).toBe(1)
    expect(hook.stats.repaired).toBe(0)
    expect(logs.some((m) => m.includes('backlink orphan'))).toBe(true)
  })

  test('ambiguous (two strip-hyphen candidates) → no write, stats.ambiguous++, logFailure', async () => {
    plantConcept('whiteboard')
    plantConcept('whit-eboard')
    const src = await makeSourcePage('Ada uses a [[white-board]] daily.')
    const spy = mock(async () => ({ path: src.path, changed: true, newLinks: [] as unknown[] }))
    const logs: string[] = []
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
      logFailure: (m) => logs.push(m),
    })
    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()
    expect(spy).toHaveBeenCalledTimes(0)
    expect(hook.stats.ambiguous).toBe(1)
    expect(hook.stats.repaired).toBe(0)
    expect(logs.some((m) => m.includes('backlink ambiguous'))).toBe(true)
  })
})

describe('backlink-repair — Argus r1 minor: shared per-drain enumeration', () => {
  test('a BURST of jobs coalesced into one drain all repair correctly (shared existing-slug set)', async () => {
    // Plant three distinct targets. A write burst enqueues three repair jobs that a
    // single drain processes; the existing-slug corpus is now enumerated ONCE per
    // drain (not once per job), so this proves the shared set still repairs every job.
    plantConcept('whiteboard')
    plantConcept('sailboat')
    plantConcept('keyboard')

    const makeFor = async (slug: string, compiled: string) => {
      const out = await realWriteEntity({
        ownerDataDir: ownerDir,
        kind: 'person',
        slug,
        body: {
          frontmatter: { slug, type: 'person' },
          compiledTruth: compiled,
          timelineAppend: { ts: new Date(0).toISOString(), source: 'seed', body: 'planted' },
        },
        originInstance: 'owner',
        receivingInstanceSlug: 'owner',
      })
      return { path: out.path, body: readFileSync(out.path, 'utf8'), newLinks: out.newLinks }
    }
    const a = await makeFor('person-a', 'Uses a [[white-board]].')
    const b = await makeFor('person-b', 'Sails a [[sail-boat]].')
    const c = await makeFor('person-c', 'Types on a [[key-board]].')

    const spy = mock(
      async (input: Parameters<BacklinkWriteEntity>[0], deps?: Parameters<BacklinkWriteEntity>[1]) =>
        realWriteEntity(input as unknown as EntityWriteInput, deps as never) as unknown as ReturnType<
          BacklinkWriteEntity
        >,
    )
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
    })

    // Fire the burst WITHOUT awaiting between calls so all three land in one drain.
    hook.onEntityWrite({ path: a.path, body: a.body, newLinks: a.newLinks, removedLinks: [] })
    hook.onEntityWrite({ path: b.path, body: b.body, newLinks: b.newLinks, removedLinks: [] })
    hook.onEntityWrite({ path: c.path, body: c.body, newLinks: c.newLinks, removedLinks: [] })
    await hook.idle()

    // Every job repaired against the shared enumeration.
    expect(hook.stats.repaired).toBe(3)
    expect(readFileSync(a.path, 'utf8')).toContain('[[whiteboard|white-board]]')
    expect(readFileSync(b.path, 'utf8')).toContain('[[sailboat|sail-boat]]')
    expect(readFileSync(c.path, 'utf8')).toContain('[[keyboard|key-board]]')
    expect(spy).toHaveBeenCalledTimes(3)
  })
})

describe('backlink-repair — inner-hook isolation + re-entrancy + conflict', () => {
  test('a rejecting inner hook still schedules repair (finally) AND propagates its rejection', async () => {
    plantConcept('whiteboard')
    const src = await makeSourcePage('Ada uses a [[white-board]] daily.')
    const spy = mock(async () => ({ path: src.path, changed: true, newLinks: [] as unknown[] }))
    const inner = {
      onEntityWrite: async (): Promise<void> => {
        throw new Error('inner boom')
      },
    }
    const hook = wrapSyncHookWithBacklinkRepair(inner, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
    })
    await expect(
      hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] }),
    ).rejects.toThrow('inner boom')
    // …but the repair was still scheduled in the finally block.
    await hook.idle()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('re-entrancy: the repair write self-re-enters the chain but produces NO second repair write', async () => {
    plantConcept('whiteboard')
    const src = await makeSourcePage('Ada uses a [[white-board]] daily.')
    // Count real writes; the real writer fires syncHook=self on commit → re-entry.
    const spy = mock(
      async (input: Parameters<BacklinkWriteEntity>[0], deps?: Parameters<BacklinkWriteEntity>[1]) =>
        realWriteEntity(input as unknown as EntityWriteInput, deps as never) as unknown as ReturnType<
          BacklinkWriteEntity
        >,
    )
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
    })
    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()
    // Structural termination: the re-entrant pass sees the resolved link → no work.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(readFileSync(src.path, 'utf8')).toContain('[[whiteboard|white-board]]')
  })

  test('CAS conflict → no throw, logged, stats.repaired stays 0 (committed-only)', async () => {
    plantConcept('whiteboard')
    const src = await makeSourcePage('Ada uses a [[white-board]] daily.')
    const spy = mock(async () => ({ path: src.path, changed: false, newLinks: [] as unknown[], conflict: true }))
    const logs: string[] = []
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
      logFailure: (m) => logs.push(m),
    })
    await hook.onEntityWrite({ path: src.path, body: src.body, newLinks: src.newLinks, removedLinks: [] })
    await hook.idle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(hook.stats.repaired).toBe(0)
    expect(logs.some((m) => m.includes('conflict'))).toBe(true)
  })

  test('unrecognised entity path → logged, no write, no throw', async () => {
    plantConcept('whiteboard')
    const spy = mock(async () => ({ path: 'x', changed: true, newLinks: [] as unknown[] }))
    const logs: string[] = []
    const hook = wrapSyncHookWithBacklinkRepair(undefined, {
      ownerDataDir: ownerDir,
      ownSlug: 'owner',
      writeEntity: spy as unknown as BacklinkWriteEntity,
      logFailure: (m) => logs.push(m),
    })
    await hook.onEntityWrite({
      path: '/not/an/entity/path.txt',
      body: 'x',
      newLinks: [{ subject: 's', predicate: 'mentions', object: 'white-board', source: 's' }],
      removedLinks: [],
    })
    await hook.idle()
    expect(spy).toHaveBeenCalledTimes(0)
    expect(logs.some((m) => m.includes('unrecognised entity path'))).toBe(true)
    expect(existsSync(ownerDir)).toBe(true)
  })
})

describe('rewriteLinks — Argus r2 minors: code-fence skip + mdlink title preserved', () => {
  // repairs is keyed by the normalised BROKEN target slug → the fixed slug.
  const repairs = new Map<string, string>([['white-board', 'whiteboard']])

  test('minor 1: a wikilink INSIDE a fenced code block is NOT rewritten', () => {
    const body = [
      'See the [[white-board]] page.',
      '',
      '```md',
      'literal example: [[white-board]]',
      '```',
    ].join('\n')
    const out = rewriteLinks(body, repairs)
    // Prose occurrence rewritten (display text preserved)...
    expect(out).toContain('[[whiteboard|white-board]]')
    // ...but the literal code-fence example is untouched.
    expect(out).toContain('literal example: [[white-board]]')
  })

  test('minor 1: a wikilink INSIDE an inline code span is NOT rewritten', () => {
    const body = 'Prose [[white-board]] and code `[[white-board]]` span.'
    const out = rewriteLinks(body, repairs)
    expect(out).toContain('Prose [[whiteboard|white-board]] and')
    expect(out).toContain('`[[white-board]]`') // inline code literal preserved
  })

  test('minor 2: the optional mdlink title is preserved, not dropped', () => {
    const body = '[the board](white-board "Hover Title")'
    const out = rewriteLinks(body, repairs)
    expect(out).toBe('[the board](whiteboard "Hover Title")')
  })

  test('minor 2: an mdlink WITHOUT a title still rewrites cleanly', () => {
    const body = '[the board](white-board)'
    expect(rewriteLinks(body, repairs)).toBe('[the board](whiteboard)')
  })
})
