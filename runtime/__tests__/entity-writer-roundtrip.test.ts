/**
 * Sprint B — runtime/entity-writer.ts roundtrip + idempotency.
 *
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.3.
 *
 * Acceptance gates covered here:
 *   3. write → read → write same content → byte-identical, `changed:
 *      false`. (Idempotent re-write produces no change.)
 *
 * The roundtrip test reads the written file from disk, then issues an
 * IDENTICAL `writeEntity` call. The second call MUST:
 *   - return the same `path`
 *   - return `changed: false`
 *   - leave the canonical file's contents byte-identical
 *   - leave no `.tmp` siblings
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  writeEntity,
  type EntityWriteInput,
  _renderEntityPage,
  _extractCompiledTruth,
  _diffTriples,
} from '../entity-writer.ts'
import type { Triple } from '../auto-link.ts'

let ownerDir: string

beforeEach(() => {
  ownerDir = mkdtempSync(join(tmpdir(), 'neutron-entity-roundtrip-'))
})

afterEach(() => {
  rmSync(ownerDir, { recursive: true, force: true })
})

function aliceInput(): EntityWriteInput {
  return {
    ownerDataDir: ownerDir,
    kind: 'person',
    slug: 'alice-founder',
    // M2.6 Ph1 (#83) — own-origin attribution so the quarantine guard passes.
    originInstance: 'acme',
    receivingInstanceSlug: 'acme',
    body: {
      frontmatter: {
        slug: 'alice-founder',
        type: 'person',
        tier: 1,
        confidence: 'low',
      },
      compiledTruth:
        '## State\n\n- Role: founder\n- Company: Acme AI\n\n## Notes\n\nAlice founded [[acme-ai]] in 2018.\n',
      timelineAppend: {
        ts: '2026-04-10T14:00:00-07:00',
        source: 'meeting-notes',
        body: 'Discussed Q3 plan with Alice.',
      },
    },
  }
}

describe('runtime/entity-writer — roundtrip', () => {
  test('first write returns changed=true and writes the rendered body to disk', async () => {
    const out = await writeEntity(aliceInput())
    expect(out.changed).toBe(true)
    const onDisk = await fs.readFile(out.path, 'utf8')
    expect(onDisk.length).toBeGreaterThan(0)
    // Body contains the deterministic shape: frontmatter, compiled-truth, timeline.
    expect(onDisk.startsWith('---\n')).toBe(true)
    expect(onDisk).toContain('\n## Timeline\n\n')
    expect(onDisk).toContain('2026-04-10T14:00:00-07:00 | meeting-notes |')
  })

  test('byte-identical second write returns changed=false and leaves no change on disk', async () => {
    const first = await writeEntity(aliceInput())
    const firstBytes = await fs.readFile(first.path, 'utf8')

    const second = await writeEntity(aliceInput())
    expect(second.path).toBe(first.path)
    expect(second.changed).toBe(false)
    const secondBytes = await fs.readFile(second.path, 'utf8')
    expect(secondBytes).toBe(firstBytes)
  })

  test('idempotent re-write produces no .tmp siblings', async () => {
    await writeEntity(aliceInput())
    await writeEntity(aliceInput())
    await writeEntity(aliceInput())
    const peopleDir = resolve(ownerDir, 'entities', 'people')
    const entries = await fs.readdir(peopleDir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })

  describe('RB3 optimistic-concurrency precondition', () => {
    test('ifBodyEquals mismatch → conflict, no write (concurrent change preserved)', async () => {
      const first = await writeEntity(aliceInput())
      const onDisk = await fs.readFile(first.path, 'utf8')
      // Attempt a write whose precondition expects a DIFFERENT (stale) body.
      const stale = aliceInput()
      stale.body.compiledTruth = '## State\n\nStale rewrite.\n'
      stale.precondition = { ifBodyEquals: 'NOT THE CURRENT BODY' }
      const out = await writeEntity(stale)
      expect(out.conflict).toBe(true)
      expect(out.changed).toBe(false)
      // The on-disk body is byte-untouched.
      expect(await fs.readFile(first.path, 'utf8')).toBe(onDisk)
    })

    test('ifBodyEquals match → the write commits', async () => {
      const first = await writeEntity(aliceInput())
      const current = await fs.readFile(first.path, 'utf8')
      const upd = aliceInput()
      upd.body.compiledTruth = '## State\n\nUpdated.\n'
      upd.precondition = { ifBodyEquals: current }
      const out = await writeEntity(upd)
      expect(out.conflict).toBeFalsy()
      expect(out.changed).toBe(true)
      expect(await fs.readFile(first.path, 'utf8')).toContain('Updated.')
    })

    test('ifBodyEquals:null asserts absence → conflict when the page already exists', async () => {
      await writeEntity(aliceInput())
      const fresh = aliceInput()
      fresh.precondition = { ifBodyEquals: null }
      const out = await writeEntity(fresh)
      expect(out.conflict).toBe(true)
      expect(out.changed).toBe(false)
    })

    test('an array timelineAppend folds every row in ONE write (deduped)', async () => {
      const input = aliceInput()
      input.body.timelineAppend = [
        { ts: '2026-04-11T00:00:00Z', source: 's', body: 'row-A' },
        { ts: '2026-04-12T00:00:00Z', source: 's', body: 'row-B' },
        { ts: '2026-04-11T00:00:00Z', source: 's', body: 'row-A' }, // dup → folded once
      ]
      const out = await writeEntity(input)
      const onDisk = await fs.readFile(out.path, 'utf8')
      expect(onDisk).toContain('row-A')
      expect(onDisk).toContain('row-B')
      // Newest-first ordering: row-B (Apr 12) precedes row-A (Apr 11).
      expect(onDisk.indexOf('row-B')).toBeLessThan(onDisk.indexOf('row-A'))
      // The duplicate row-A appears exactly once.
      expect(onDisk.split('row-A').length - 1).toBe(1)
    })
  })

  test('rendering is deterministic: same input → same bytes (lexicographic frontmatter)', () => {
    // The frontmatter renderer sorts keys; the writer renders timeline
    // newest-first. Verify both via the exported render helper.
    const body1 = _renderEntityPage({
      frontmatter: { z: 1, a: 2, m: 3 },
      compiledTruth: 'hello',
      timeline: [
        {
          ts: '2026-04-01T00:00:00Z',
          source: 'old',
          body: 'old entry',
        },
        {
          ts: '2026-04-10T00:00:00Z',
          source: 'new',
          body: 'new entry',
        },
      ],
    })
    const body2 = _renderEntityPage({
      frontmatter: { a: 2, m: 3, z: 1 }, // different key order
      compiledTruth: 'hello',
      timeline: [
        {
          ts: '2026-04-10T00:00:00Z',
          source: 'new',
          body: 'new entry',
        },
        {
          ts: '2026-04-01T00:00:00Z',
          source: 'old',
          body: 'old entry',
        },
      ],
    })
    expect(body1).toBe(body2)
    // Frontmatter ordering: a < m < z
    const aIdx = body1.indexOf('a:')
    const mIdx = body1.indexOf('m:')
    const zIdx = body1.indexOf('z:')
    expect(aIdx).toBeGreaterThan(-1)
    expect(mIdx).toBeGreaterThan(aIdx)
    expect(zIdx).toBeGreaterThan(mIdx)
    // Timeline ordering: newest first
    const newIdx = body1.indexOf('new entry')
    const oldIdx = body1.indexOf('old entry')
    expect(newIdx).toBeLessThan(oldIdx)
  })

  test('appending a new timeline entry changes the file, re-appending the same one does not', async () => {
    const base = aliceInput()
    await writeEntity(base)

    // Add a NEW timeline entry — same compiled-truth + frontmatter.
    const updated: EntityWriteInput = {
      ...base,
      body: {
        ...base.body,
        timelineAppend: {
          ts: '2026-04-12T09:00:00-07:00',
          source: 'email',
          body: 'Email follow-up.',
        },
      },
    }
    const out2 = await writeEntity(updated)
    expect(out2.changed).toBe(true)

    // Re-issue with the SAME new entry — should be a no-op.
    const out3 = await writeEntity(updated)
    expect(out3.changed).toBe(false)

    // File now contains BOTH timeline entries, newest-first.
    const final = await fs.readFile(out2.path, 'utf8')
    const idx12 = final.indexOf('2026-04-12T09:00:00-07:00')
    const idx10 = final.indexOf('2026-04-10T14:00:00-07:00')
    expect(idx12).toBeGreaterThan(-1)
    expect(idx10).toBeGreaterThan(-1)
    expect(idx12).toBeLessThan(idx10) // newest-first ordering
  })

  test('Codex r2 P1: _extractCompiledTruth returns body slice between frontmatter and timeline', async () => {
    const base = aliceInput()
    const out = await writeEntity(base)
    const onDisk = await fs.readFile(out.path, 'utf8')
    const compiled = _extractCompiledTruth(onDisk)
    expect(compiled).toContain('Alice founded [[acme-ai]] in 2018')
    expect(compiled).not.toContain('---')
    expect(compiled).not.toContain('## Timeline')
    expect(compiled).not.toContain('Discussed Q3 plan with Alice')
  })

  test('Codex r2 P1: _extractCompiledTruth is lenient on hand-edited pages', () => {
    // No frontmatter open → returns body as-is rather than throwing.
    expect(_extractCompiledTruth('plain body, no fences')).toBe(
      'plain body, no fences',
    )
    // Frontmatter open but no close → returns body as-is.
    expect(_extractCompiledTruth('---\nkey: v\n\nnever closes')).toBe(
      '---\nkey: v\n\nnever closes',
    )
    // No timeline → compiled-truth extends to end-of-body.
    expect(
      _extractCompiledTruth('---\nslug: a\ntype: person\n---\n\nbody no timeline\n'),
    ).toBe('body no timeline\n')
  })

  test('Codex r2 P1: _diffTriples returns previous-not-in-next keyed on subj/pred/obj', () => {
    const previous: Triple[] = [
      { subject: 'a', predicate: 'met', object: 'b', source: '/p.md' },
      { subject: 'a', predicate: 'founded', object: 'c', source: '/p.md' },
    ]
    const next: Triple[] = [
      { subject: 'a', predicate: 'founded', object: 'c', source: '/p.md' },
      { subject: 'a', predicate: 'advises', object: 'd', source: '/p.md' },
    ]
    const removed = _diffTriples(previous, next)
    expect(removed).toEqual([
      { subject: 'a', predicate: 'met', object: 'b', source: '/p.md' },
    ])
    // Empty / identity cases.
    expect(_diffTriples([], next)).toEqual([])
    expect(_diffTriples(next, next)).toEqual([])
    // Different source — still considered the SAME triple (source is not
    // part of the identity key).
    expect(
      _diffTriples(
        [{ subject: 'a', predicate: 'met', object: 'b', source: '/old.md' }],
        [{ subject: 'a', predicate: 'met', object: 'b', source: '/new.md' }],
      ),
    ).toEqual([])
  })

  test('rewriting compiled-truth while keeping the same timeline entry → changed:true', async () => {
    const base = aliceInput()
    await writeEntity(base)

    const rewritten: EntityWriteInput = {
      ...base,
      body: {
        ...base.body,
        compiledTruth:
          '## State\n\n- Role: CEO (promoted 2026-04-12)\n- Company: Acme AI\n',
        // Re-pass the SAME timeline entry — it dedupes.
      },
    }
    const out = await writeEntity(rewritten)
    expect(out.changed).toBe(true)
    const onDisk = await fs.readFile(out.path, 'utf8')
    expect(onDisk).toContain('CEO (promoted 2026-04-12)')
    // Timeline still has the same one entry.
    const entries = onDisk
      .split('\n')
      .filter((l) => l.startsWith('- 2026-04-10T14:00:00-07:00'))
    expect(entries).toHaveLength(1)
  })
})
