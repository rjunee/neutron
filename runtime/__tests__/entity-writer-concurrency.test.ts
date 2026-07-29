/**
 * RA1 — `writeEntity` per-(kind,slug) serialization (lost-update regression).
 *
 * Plan: docs/plans/2026-07-02-world-class-refactor-plan.md § RA1.
 *
 * The writer's read(existing)→mergeTimeline→render→tmp+rename pipeline is
 * atomic (byte-equal short-circuit + atomic rename) but was NOT isolated:
 * two concurrent same-slug writers (e.g. chat scribe + a Cores calendar
 * scribe) each read the same base page, each merge only their OWN
 * timelineAppend, and the second rename silently dropped the first's
 * timeline row — a classic lost update. writeEntity now chains same-key
 * writes on a per-`${kind}/${slug}` async lock (the `withLock` idiom from
 * `persistence/db.ts`), so both rows must survive.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEntity, type EntityWriteInput } from '../entity-writer.ts'

let ownerDir: string

beforeEach(() => {
  ownerDir = mkdtempSync(join(tmpdir(), 'neutron-entity-writer-conc-'))
})

afterEach(() => {
  rmSync(ownerDir, { recursive: true, force: true })
})

function makeInput(
  timelineAppend: { ts: string; source: string; body: string },
  overrides: Partial<EntityWriteInput> = {},
): EntityWriteInput {
  return {
    ownerDataDir: ownerDir,
    kind: 'person',
    slug: 'alice-founder',
    body: {
      frontmatter: {
        slug: 'alice-founder',
        type: 'person',
        confidence: 'low',
      },
      compiledTruth: '## State\n\n- Role: founder\n- Company: Acme AI\n',
      timelineAppend,
    },
    originInstance: 'acme',
    receivingInstanceSlug: 'acme',
    ...overrides,
  }
}

describe('runtime/entity-writer — concurrent same-slug writes (RA1)', () => {
  test('two concurrent writes to the same (kind,slug) both land their timeline rows', async () => {
    // Seed the page so both concurrent writers merge against the same base.
    await writeEntity(
      makeInput({
        ts: '2026-07-01T09:00:00-07:00',
        source: 'meeting-notes',
        body: 'Seed row: kickoff sync.',
      }),
    )

    const rowA = {
      ts: '2026-07-02T10:00:00-07:00',
      source: 'chat-scribe',
      body: 'Row A: discussed the Q3 plan.',
    }
    const rowB = {
      ts: '2026-07-02T11:00:00-07:00',
      source: 'calendar-scribe',
      body: 'Row B: scheduled the follow-up.',
    }

    // Fire both writes WITHOUT awaiting in between — this is the exact
    // scribe-vs-scribe interleave from the plan. Pre-RA1 both read the
    // seeded page, each rendered seed+own-row, and the second rename
    // clobbered the first row.
    const [outA, outB] = await Promise.all([
      writeEntity(makeInput(rowA)),
      writeEntity(makeInput(rowB)),
    ])
    expect(outA.path).toBe(outB.path)

    const final = await fs.readFile(outA.path, 'utf8')
    expect(final).toContain('Row A: discussed the Q3 plan.')
    expect(final).toContain('Row B: scheduled the follow-up.')
    expect(final).toContain('Seed row: kickoff sync.')
  })

  test('writes to DIFFERENT slugs are not serialized against each other', async () => {
    // A deadlocked/globally-serialized implementation would wedge or
    // needlessly chain these; both must simply succeed independently.
    const [a, b] = await Promise.all([
      writeEntity(
        makeInput(
          {
            ts: '2026-07-02T10:00:00-07:00',
            source: 'chat-scribe',
            body: 'Alice row.',
          },
          {
            slug: 'alice-founder',
            body: {
              frontmatter: {
                slug: 'alice-founder',
                type: 'person',
                confidence: 'low',
              },
              compiledTruth: '## State\n\n- Role: founder\n',
              timelineAppend: {
                ts: '2026-07-02T10:00:00-07:00',
                source: 'chat-scribe',
                body: 'Alice row.',
              },
            },
          },
        ),
      ),
      writeEntity(
        makeInput(
          {
            ts: '2026-07-02T10:00:00-07:00',
            source: 'chat-scribe',
            body: 'Bob row.',
          },
          {
            slug: 'bob-engineer',
            body: {
              frontmatter: {
                slug: 'bob-engineer',
                type: 'person',
                confidence: 'low',
              },
              compiledTruth: '## State\n\n- Role: engineer\n',
              timelineAppend: {
                ts: '2026-07-02T10:00:00-07:00',
                source: 'chat-scribe',
                body: 'Bob row.',
              },
            },
          },
        ),
      ),
    ])
    expect(a.changed).toBe(true)
    expect(b.changed).toBe(true)
    const alice = await fs.readFile(a.path, 'utf8')
    const bob = await fs.readFile(b.path, 'utf8')
    expect(alice).toContain('Alice row.')
    expect(bob).toContain('Bob row.')
  })
})
