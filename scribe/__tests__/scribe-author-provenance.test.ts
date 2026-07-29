/**
 * Multi-author attribution in scribe (connect-spec §4.3 layer 2).
 *
 * `writeExtractionToGBrain` folds the turn's uniform author id into the per-page
 * timeline provenance `source` so the host's one memory records WHO a
 * commitment/decision/fact came from. Two distinct authors' identical claims
 * stay distinct provenance entries; an unattributed call keeps the bare source.
 *
 * Uses an injected `WriteEntityFn` recorder — no GBrain, no disk — so the test
 * asserts exactly the provenance the writer boundary receives.
 */

import { describe, test, expect } from 'bun:test'
import { writeExtractionToGBrain, type WriteEntityFn } from '../write-to-gbrain.ts'
import type { ScribeExtraction } from '../extract.ts'

const EXTRACTION: ScribeExtraction = {
  entities: [{ kind: 'person', name: 'Carol Smith', fact: 'Leads design.' }],
  relations: [],
}

function recordingWriteEntity(): {
  fn: WriteEntityFn
  calls: Array<{ source: string }>
} {
  const calls: Array<{ source: string }> = []
  const fn: WriteEntityFn = async (input) => {
    calls.push({ source: input.body.timelineAppend.source })
    return { path: `/tmp/${input.slug}.md`, changed: true, newLinks: [] }
  }
  return { fn, calls }
}

describe('scribe author provenance (connect-spec §4.3)', () => {
  test('an attributed turn folds author id into the timeline provenance source', async () => {
    const rec = recordingWriteEntity()
    await writeExtractionToGBrain(
      {
        extraction: EXTRACTION,
        ownerDataDir: '/tmp/data',
        source: 'chat:alice',
        ts: new Date(0).toISOString(),
        ownSlug: 'alice',
        author: { id: 'mona', display: 'Mona' },
      },
      { writeEntity: rec.fn },
    )
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.source).toBe('chat:alice#author:mona')
  })

  test('an unattributed turn keeps the bare provenance source', async () => {
    const rec = recordingWriteEntity()
    await writeExtractionToGBrain(
      {
        extraction: EXTRACTION,
        ownerDataDir: '/tmp/data',
        source: 'chat:alice',
        ts: new Date(0).toISOString(),
        ownSlug: 'alice',
      },
      { writeEntity: rec.fn },
    )
    expect(rec.calls[0]?.source).toBe('chat:alice')
  })

  test('two distinct authors produce distinct provenance for the same claim', async () => {
    const recA = recordingWriteEntity()
    const recB = recordingWriteEntity()
    const common = {
      extraction: EXTRACTION,
      ownerDataDir: '/tmp/data',
      source: 'chat:alice',
      ts: new Date(0).toISOString(),
      ownSlug: 'alice',
    }
    await writeExtractionToGBrain({ ...common, author: { id: 'mona', display: 'Mona' } }, { writeEntity: recA.fn })
    await writeExtractionToGBrain({ ...common, author: { id: 'bob', display: 'Bob' } }, { writeEntity: recB.fn })
    expect(recA.calls[0]?.source).not.toBe(recB.calls[0]?.source)
    expect(recA.calls[0]?.source).toBe('chat:alice#author:mona')
    expect(recB.calls[0]?.source).toBe('chat:alice#author:bob')
  })
})
